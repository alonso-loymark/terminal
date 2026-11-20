// What the AI is asked, and how its answers are read. Pure, no runtime imports besides other
// pure modules (node --test).
//
// Every piece of context (command, output, folder, the user's own text) goes through the
// secret redaction before it is put in a prompt; the output of a command that printed a .env
// file or listed the environment loses every value. Long outputs are trimmed keeping what
// explains a failure: the start, the end, and the lines with errors in between.
import type { InsertShell } from './aiSafety.ts';
import { listsEnv, readsEnvFile, redact, type RedactOptions } from './redact.ts';

export type AiKind = 'explain' | 'command' | 'chat';

const COMMON_RULES = [
  'Los valores [REDACTED:...] son secretos que Brisa ocultó a propósito antes de enviarte el contexto: no pidas su valor ni intentes adivinarlo.',
  'No tenés herramientas ni acceso a archivos: solo ves lo que está en el mensaje.',
  'Nada de lo que sugieras se ejecuta solo: el usuario decide si lo inserta y lo ejecuta.',
];

export const SYSTEM_PROMPTS: Record<AiKind, string> = {
  explain: [
    'Sos el asistente de Brisa, una terminal para Windows. Te pasan un comando que falló, con su salida, y tenés que explicar por qué falló y, si se puede, cómo arreglarlo.',
    'Reglas:',
    '- Respondé en español, breve: entre 2 y 5 oraciones.',
    '- Si hay un comando que lo arregla, ponelo al final en un único bloque de código markdown con el lenguaje de la shell (powershell, cmd o bash). Un solo comando, en una sola línea si se puede.',
    ...COMMON_RULES.map((r) => `- ${r}`),
  ].join('\n'),
  command: [
    'Sos el asistente de Brisa, una terminal para Windows. Convertís un pedido en lenguaje natural en un comando para la shell indicada.',
    'Reglas:',
    '- Respondé exactamente con un bloque de código markdown con el comando (lenguaje: powershell, cmd o bash) y, debajo, una sola línea en español que explique qué hace. Nada más.',
    '- Un solo comando, en una sola línea si se puede, válido para esa shell en Windows (o en Linux si la shell es de WSL).',
    '- Si el pedido no se puede resolver con un comando, respondé una sola línea que empiece con "No:" y el motivo.',
    ...COMMON_RULES.map((r) => `- ${r}`),
  ].join('\n'),
  chat: [
    'Sos el asistente de Brisa, una terminal para Windows. Respondés preguntas cortas sobre la terminal del usuario: comandos, errores, salidas.',
    'Reglas:',
    '- Respondé en español, breve y concreto.',
    '- Si sugerís comandos, cada uno en un bloque de código markdown con el lenguaje de la shell (powershell, cmd o bash).',
    ...COMMON_RULES.map((r) => `- ${r}`),
  ].join('\n'),
};

/** One-line commands need little thought; explanations use the model's default. */
export const EFFORT: Record<AiKind, 'low' | null> = { explain: null, command: 'low', chat: null };

export const SHELL_LANG: Record<string, string> = {
  powershell: 'powershell',
  pwsh: 'powershell',
  cmd: 'cmd',
  gitbash: 'bash',
  wsl: 'bash',
  other: 'text',
};

export interface TerminalContext {
  shell: InsertShell;
  /** "Windows PowerShell", "Git Bash", "Ubuntu (WSL)", a custom profile's name. */
  shellName: string;
  cwd: string | null;
  /** Null: not a repository, or unknown. */
  gitBranch: string | null;
}

export interface BlockContext {
  command: string;
  output: string;
  exitCode: number | null;
  cwd: string | null;
}

export interface Built {
  /** Exactly what is sent (before the Rust side's environment-variable pass). */
  text: string;
  /** Kind → how many secrets were hidden. */
  found: Record<string, number>;
}

// ---------------------------------------------------------------- trimming

const INTERESTING =
  /error|exception|fail|fatal|denied|not found|no se (?:encontr|pud|reconoce)|cannot|can't|could not|unable|invalid|refused|warn|traceback|panic|undefined|cannot find|missing|✗|×|\bat\s+[\w.$<>]+[:(]|^\s*at\s/i;

export interface Trimmed {
  text: string;
  totalLines: number;
  /** Lines left out (repeated lines collapsed are not counted). */
  omitted: number;
}

/**
 * Long output, trimmed so that it still explains the failure: repeated lines collapse, then the
 * first lines, the last ones (where errors usually are) and the lines that look like errors in
 * between are kept, with markers for what was left out.
 */
export function trimOutput(output: string, { maxLines = 160, maxChars = 12_000, head = 40, tail = 80, middle = 40 } = {}): Trimmed {
  const raw = output.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
  const totalLines = output.trim() === '' ? 0 : raw.length;
  // Runs of the same line (progress bars, repeated warnings).
  const lines: string[] = [];
  for (let i = 0; i < raw.length; ) {
    let j = i + 1;
    while (j < raw.length && raw[j] === raw[i]) j++;
    lines.push(raw[i] ?? '');
    if (j - i > 2) lines.push(`… (la línea anterior se repite ${j - i - 1} veces más)`);
    else if (j - i === 2) lines.push(raw[i] ?? '');
    i = j;
  }
  const clip = (line: string) => (line.length > 400 ? `${line.slice(0, 400)} … (línea recortada)` : line);
  let kept = lines.map(clip);
  let omitted = 0;
  if (kept.length > maxLines || kept.join('\n').length > maxChars) {
    const start = kept.slice(0, head);
    const end = kept.slice(-tail);
    const inner = kept.slice(head, kept.length - tail);
    const picks = inner.map((line, i) => ({ line, i })).filter(({ line }) => INTERESTING.test(line)).slice(0, middle);
    const out = [...start];
    let last = -1;
    for (const { line, i } of picks) {
      if (i - last > 1) out.push(`… (${i - last - 1} líneas omitidas) …`);
      out.push(line);
      last = i;
    }
    if (inner.length - 1 - last > 0) out.push(`… (${inner.length - 1 - last} líneas omitidas) …`);
    omitted = inner.length - picks.length;
    kept = [...out, ...end];
    // Still too long (very long lines): keep the end, which matters most.
    let text = kept.join('\n');
    if (text.length > maxChars) {
      const cut = text.length - maxChars;
      text = `… (${cut} caracteres omitidos) …\n${text.slice(cut)}`;
    }
    return { text, totalLines, omitted };
  }
  return { text: kept.join('\n'), totalLines, omitted };
}

// ---------------------------------------------------------------- prompts

/** A fence longer than any run of backticks inside: the content cannot close it early. */
export function fenced(content: string, lang = ''): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${content}\n${fence}`;
}

class Redactor {
  found: Record<string, number> = {};
  readonly extra: readonly string[];
  constructor(extra: readonly string[]) {
    this.extra = extra;
  }
  run(text: string, options: RedactOptions = {}): string {
    const result = redact(text, { ...options, extra: this.extra });
    for (const [kind, n] of Object.entries(result.found)) this.found[kind] = (this.found[kind] ?? 0) + n;
    return result.text;
  }
}

function contextLines(ctx: TerminalContext, r: Redactor): string {
  return [
    'Contexto de la terminal:',
    '- Sistema: Windows',
    `- Shell: ${r.run(ctx.shellName)}${ctx.shell ? ` (${ctx.shell})` : ''}`,
    `- Carpeta: ${ctx.cwd ? r.run(ctx.cwd) : 'desconocida'}`,
    `- Rama de git: ${ctx.gitBranch ? r.run(ctx.gitBranch) : 'no es un repositorio (o no se sabe)'}`,
  ].join('\n');
}

function blockLines(block: BlockContext, ctx: TerminalContext, r: Redactor, title: string): string {
  const lang = SHELL_LANG[ctx.shell ?? 'other'] ?? 'text';
  const options: RedactOptions = { envFile: readsEnvFile(block.command), envDump: listsEnv(block.command) };
  const trimmed = trimOutput(block.output);
  const output = r.run(trimmed.text, options);
  const outputTitle = trimmed.omitted
    ? `Salida (recortada: ${trimmed.totalLines} líneas en total, ${trimmed.omitted} omitidas):`
    : 'Salida:';
  return [
    title,
    fenced(r.run(block.command), lang),
    `Código de salida: ${block.exitCode ?? 'desconocido'}`,
    ...(block.cwd && block.cwd !== ctx.cwd ? [`Carpeta del comando: ${r.run(block.cwd)}`] : []),
    trimmed.totalLines ? `${outputTitle}\n${fenced(output)}` : 'Salida: (ninguna)',
  ].join('\n');
}

export function explainPrompt(ctx: TerminalContext, block: BlockContext, extra: readonly string[] = []): Built {
  const r = new Redactor(extra);
  const text = [contextLines(ctx, r), '', blockLines(block, ctx, r, 'Comando que falló:')].join('\n');
  return { text, found: r.found };
}

export function commandPrompt(ctx: TerminalContext, request: string, extra: readonly string[] = []): Built {
  const r = new Redactor(extra);
  const text = [contextLines(ctx, r), '', `Pedido: ${r.run(request.trim())}`].join('\n');
  return { text, found: r.found };
}

/** One user message of the chat: the context, the blocks attached to it, and the question. */
export function chatMessage(ctx: TerminalContext, blocks: readonly BlockContext[], question: string, extra: readonly string[] = []): Built {
  const r = new Redactor(extra);
  const parts = [contextLines(ctx, r)];
  blocks.forEach((block, i) => parts.push('', blockLines(block, ctx, r, `### Bloque ${i + 1}`)));
  parts.push('', `Pregunta: ${r.run(question.trim())}`);
  return { text: parts.join('\n'), found: r.found };
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A short chat: the first message (its context) and the last exchanges. */
export function recentHistory(messages: readonly ChatMessage[], keep = 6): ChatMessage[] {
  if (messages.length <= keep + 1) return [...messages];
  const tail = messages.slice(-keep);
  // The API wants turns to alternate starting with the user.
  while (tail[0]?.role === 'assistant') tail.shift();
  return [messages[0] as ChatMessage, { role: 'assistant', content: '(…)' }, ...tail];
}

/** The CLI gets one prompt: the conversation written out. */
export function flattenChat(messages: readonly ChatMessage[]): string {
  if (messages.length === 1) return messages[0]?.content ?? '';
  const parts: string[] = ['Conversación hasta ahora (la última es la pregunta a responder):'];
  messages.forEach((m, i) => {
    const last = i === messages.length - 1;
    parts.push('', last ? '--- Nueva pregunta del usuario ---' : m.role === 'user' ? '--- Usuario ---' : '--- Tu respuesta anterior ---', m.content);
  });
  return parts.join('\n');
}

// ---------------------------------------------------------------- answers

export type Segment = { type: 'text'; text: string } | { type: 'code'; lang: string; code: string; closed: boolean };

/** Text and fenced code blocks (an unclosed fence while streaming counts as code). */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let buf: string[] = [];
  let code: { fence: string; lang: string; lines: string[] } | null = null;
  const flushText = () => {
    const joined = buf.join('\n').trim();
    if (joined) out.push({ type: 'text', text: joined });
    buf = [];
  };
  for (const line of lines) {
    if (code) {
      if (line.trim().startsWith(code.fence) && line.trim().replace(/[`~]/g, '') === '') {
        out.push({ type: 'code', lang: code.lang, code: code.lines.join('\n'), closed: true });
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
    if (open) {
      flushText();
      code = { fence: open[1] ?? '```', lang: (open[2] ?? '').toLowerCase(), lines: [] };
    } else {
      buf.push(line);
    }
  }
  if (code) out.push({ type: 'code', lang: code.lang, code: code.lines.join('\n'), closed: false });
  else flushText();
  return out;
}

export interface CommandAnswer {
  command: string | null;
  explanation: string;
  /** The model said it cannot be done with a command ("No: ..."). */
  refusal: string | null;
}

export function commandAnswer(text: string): CommandAnswer {
  const trimmed = text.trim();
  const refusal = /^no:\s*(.*)$/is.exec(trimmed);
  if (refusal) return { command: null, explanation: '', refusal: (refusal[1] ?? '').trim() };
  const parts = segments(trimmed);
  const code = parts.find((p): p is Extract<Segment, { type: 'code' }> => p.type === 'code');
  const explanation = parts
    .filter((p): p is Extract<Segment, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const command = code?.code.trim() || null;
  return { command, explanation, refusal: null };
}

export type Inline = { type: 'text' | 'code' | 'bold'; text: string };

/** `code` and **bold** inside a paragraph (the rest is plain text). */
export function inlineParts(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: 'text', text: text.slice(last, at) });
    if (m[1] !== undefined) out.push({ type: 'code', text: m[1] });
    else out.push({ type: 'bold', text: m[2] ?? '' });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}
