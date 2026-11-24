// The orchestrator's logic (Fase 8A), pure: what the main model is asked, how its plan is read
// and validated, what a worker receives (a brief, never the whole conversation), the decision
// log and the conversation file. No runtime imports besides other pure modules (node --test).
//
// Everything that leaves Brisa goes through the secret redaction of the AI layer (redact.ts)
// piece by piece; the caller then applies Rust's pass over sensitive environment variables.
import type { AgentInfo, Denial, ModelInfo, ProjectCommand, TaskDiff, ToolAction, Usage } from './agentsApi.ts';
import { cleanTitle } from './orchestratorChats.ts';
import { redact } from './redact.ts';

// ---------------------------------------------------------------- conversation

export interface Plan {
  task: string;
  agent: string;
  model: string;
  effort: string | null;
  why: string;
  /** Files the planner thinks matter (they go in the brief). */
  files: string[];
  /** A title for the chat, asked only with its first message (in the same answer: no other call). */
  title?: string | null;
}

export interface ActivityItem {
  id: string;
  action: ToolAction;
  tool: string;
  target: string;
  /** null while running. */
  ok: boolean | null;
}

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface Sent {
  kind: 'plan' | 'task';
  agent: string;
  model: string;
  effort: string | null;
  system: string | null;
  prompt: string;
  redactions: Record<string, number>;
  envNames: string[];
  /** Images that went with the brief (paths of Brisa's PNGs). */
  images?: string[];
}

export interface RunInfo {
  status: RunStatus;
  model: string;
  effort: string | null;
  activity: ActivityItem[];
  text: string;
  result: string | null;
  sessionId: string | null;
  usage: Usage | null;
  denials: Denial[];
  diff: TaskDiff | null;
  error: { code: string; message: string } | null;
  sent: Sent | null;
  /** This run continues another one (after a permission). */
  resumed: boolean;
  /** The worker said AGENTS.md went out of date: the offer to update it (with confirmation). */
  agentsStale?: { reason: string; status: 'offered' | 'dismissed' | 'done' } | null;
}

export type PlanStatus = 'thinking' | 'proposed' | 'approved' | 'cancelled' | 'error';

export type OrchMessage =
  | {
      id: string;
      kind: 'user';
      at: number;
      text: string;
      forced: string | null;
      /** Pasted images (PNGs Brisa saved in its temporary folder): they go to the worker. */
      images?: string[];
    }
  | {
      id: string;
      kind: 'plan';
      at: number;
      status: PlanStatus;
      plan: Plan | null;
      /** The model the user chose (forced with @ or changed on the card). */
      chosen: boolean;
      usage: Usage | null;
      error: { code: string; message: string } | null;
      sent: Sent | null;
      text: string;
    }
  | ({ id: string; kind: 'run'; at: number; planId: string | null } & RunInfo)
  | { id: string; kind: 'note'; at: number; text: string };

export interface Decision {
  at: number;
  task: string;
  model: string;
  effort: string | null;
  why: string;
  outcome: 'done' | 'error' | 'cancelled';
  summary: string;
  files: string[];
  costUsd: number;
}

export interface ProjectPrefs {
  dir: string;
  /** The main model chosen in this project's selector (null: `orchestrator.mainModel`). */
  mainModel: string | null;
  /** "Permitir siempre" from a denial: command patterns for this project only. */
  allowed: string[];
}

export const CONVERSATION_VERSION = 1;
/** Kept in the conversation file (older messages drop out; the decision log keeps the gist). */
export const MAX_MESSAGES = 200;
export const MAX_DECISIONS = 200;

/** Messages as stored: running work becomes cancelled (the app closed meanwhile). */
export function serializeConversation(messages: readonly OrchMessage[]): string {
  const settled = messages.slice(-MAX_MESSAGES).map((m): OrchMessage => {
    if (m.kind === 'plan' && m.status === 'thinking') return { ...m, status: 'cancelled' };
    if (m.kind === 'run' && m.status === 'running') return { ...m, status: 'cancelled' };
    return m;
  });
  return `${JSON.stringify({ version: CONVERSATION_VERSION, messages: settled }, null, 1)}\n`;
}

export function parseConversation(text: string | null): OrchMessage[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as { version?: unknown; messages?: unknown };
    if (value.version !== CONVERSATION_VERSION || !Array.isArray(value.messages)) return [];
    return (value.messages as OrchMessage[]).filter((m) => typeof m === 'object' && m !== null && typeof m.id === 'string' && typeof m.kind === 'string');
  } catch {
    return [];
  }
}

export function parseDecisions(text: string | null): Decision[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as { decisions?: unknown };
    return Array.isArray(value.decisions) ? (value.decisions as Decision[]).filter((d) => typeof d?.task === 'string') : [];
  } catch {
    return [];
  }
}

export const serializeDecisions = (decisions: readonly Decision[]) => `${JSON.stringify({ version: 1, decisions: decisions.slice(-MAX_DECISIONS) }, null, 1)}\n`;

export function parsePrefs(text: string | null, dir: string): ProjectPrefs {
  const fallback: ProjectPrefs = { dir, mainModel: null, allowed: [] };
  if (!text) return fallback;
  try {
    const value = JSON.parse(text) as Partial<ProjectPrefs>;
    return {
      dir,
      mainModel: typeof value.mainModel === 'string' && value.mainModel ? value.mainModel : null,
      allowed: Array.isArray(value.allowed) ? value.allowed.filter((a): a is string => typeof a === 'string') : [],
    };
  } catch {
    return fallback;
  }
}

export const serializePrefs = (prefs: ProjectPrefs) => `${JSON.stringify(prefs, null, 1)}\n`;

// ---------------------------------------------------------------- models

export type Tier = 'rápido' | 'medio' | 'potente' | 'máximo';

export interface RankedModel {
  value: string;
  displayName: string;
  description: string;
  efforts: string[];
  /** Output price per million tokens, if the CLI said it. */
  outputPrice: number | null;
  tier: Tier;
}

/** "$2/$10 per Mtok" → 10 (output price). */
export function outputPrice(description: string): number | null {
  const match = /\$(\d+(?:\.\d+)?)\s*\/\s*\$(\d+(?:\.\d+)?)/.exec(description);
  return match ? Number(match[2]) : null;
}

const FAMILY_ORDER = ['haiku', 'sonnet', 'opus', 'fable'];

/**
 * The models to choose from, cheapest first, with a tier: the cheapest is "rápido", the most
 * expensive "máximo" (if there are 4+) and "potente" the one below; the rest "medio". The CLI's
 * own "default" is an alias, not a choice.
 */
export function rankModels(models: readonly ModelInfo[]): RankedModel[] {
  const choices = models.filter((m) => m.value !== 'default');
  const rank = (m: ModelInfo) => {
    const price = outputPrice(m.description);
    const family = FAMILY_ORDER.findIndex((f) => m.value.toLowerCase().includes(f));
    return [price ?? Number.POSITIVE_INFINITY, family < 0 ? 99 : family] as const;
  };
  const sorted = [...choices].sort((a, b) => {
    const [pa, fa] = rank(a);
    const [pb, fb] = rank(b);
    return pa - pb || fa - fb;
  });
  const n = sorted.length;
  return sorted.map((m, i) => {
    let tier: Tier = 'medio';
    if (i === 0 && n > 1) tier = 'rápido';
    else if (i === n - 1 && n >= 4) tier = 'máximo';
    else if ((i === n - 1 && n >= 2) || (i === n - 2 && n >= 4)) tier = 'potente';
    return { value: m.value, displayName: m.displayName, description: m.description, efforts: m.efforts, outputPrice: outputPrice(m.description), tier };
  });
}

/** `@opus arreglá…` → the forced model and the rest of the message. Only models the CLI offers. */
export function parseForcedModel(text: string, models: readonly { value: string }[]): { model: string | null; rest: string } {
  const match = /^\s*@([A-Za-z][\w.[\]-]*)\s*/.exec(text);
  if (!match?.[1]) return { model: null, rest: text.trim() };
  const wanted = match[1].toLowerCase();
  const found = models.find((m) => m.value.toLowerCase() === wanted && m.value !== 'default');
  return found ? { model: found.value, rest: text.slice(match[0].length).trim() } : { model: null, rest: text.trim() };
}

/**
 * `@op` at the start of the message with the caret right after it: the models it may be (the
 * input's autocomplete). Only at the start: that is where `@modelo` forces the model.
 */
export function modelMention(beforeCaret: string, models: readonly { value: string }[]): { query: string; start: number; items: string[] } | null {
  const m = /^(\s*)@([A-Za-z0-9._[\]-]*)$/.exec(beforeCaret);
  if (!m) return null;
  const query = m[2] ?? '';
  const items = models.map((x) => x.value).filter((v) => v !== 'default' && v.toLowerCase().startsWith(query.toLowerCase()));
  if (!items.length || (items.length === 1 && items[0] === query)) return null;
  return { query, start: (m[1] ?? '').length, items };
}

// ---------------------------------------------------------------- plan

export const PLANNER_SYSTEM = [
  'Sos el orquestador de Brisa, una terminal para Windows que coordina agentes de IA que programan (trabajadores). No programás vos: por cada mensaje del usuario decidís UNA tarea para un trabajador y con qué modelo y esfuerzo.',
  'Criterios para elegir modelo y esfuerzo (pensá en costo y en qué tan difícil es):',
  '- Trivial o mecánico (renombrar, una errata, mover algo, un cambio de una línea, una pregunta simple sobre el código): el modelo rápido (el más barato) con esfuerzo bajo.',
  '- Normal (una función, un bug acotado, un test, un cambio en pocos archivos): el modelo medio con esfuerzo medio.',
  '- Arquitectura, bugs difíciles o cambios en muchos archivos: el modelo más potente con esfuerzo alto.',
  'Respondé SOLO con un bloque de código json, sin texto antes ni después, con esta forma:',
  '```json',
  '{"task": "la tarea para el trabajador, concreta y completa (qué hacer, dónde, cómo verificarlo)", "agent": "claude", "model": "<value de un modelo de la lista>", "effort": "<un nivel de esfuerzo de ese modelo>", "why": "una línea: por qué ese modelo y ese esfuerzo", "files": ["rutas relativas de archivos relevantes, si las sabés"]}',
  '```',
  'Reglas:',
  '- "agent", "model" y "effort" tienen que ser valores de la lista que te pasan.',
  '- Si el usuario eligió el modelo, usalo igual (elegí solo el esfuerzo).',
  '- La tarea va en español. El trabajador no ve esta conversación: incluí en "task" lo que necesite saber.',
  '- Los valores [REDACTED:...] son secretos que Brisa ocultó a propósito: no los pidas ni los adivines.',
  '- Solo si te lo piden en "## Título del chat", agregá "title": un título de 2 a 6 palabras, en español, para la conversación.',
].join('\n');

export interface PlanContext {
  message: string;
  forced: string | null;
  projectName: string;
  agents: readonly AgentInfo[];
  commands: readonly string[];
  hasAgentsMd: boolean;
  decisions: readonly Decision[];
  recent: readonly OrchMessage[];
  /** Why the previous answer was not a valid plan (one retry). */
  correction?: string | null;
  /** The chat's first message: ask for a title in the same answer. */
  needsTitle?: boolean;
  /** Images pasted in the message (the worker receives them; the planner does not). */
  images?: number;
}

export interface Built {
  text: string;
  found: Record<string, number>;
}

/** Redacts each piece and counts what was hidden. */
export class Redactor {
  found: Record<string, number> = {};
  private readonly extra: readonly string[];

  constructor(extra: readonly string[] = []) {
    this.extra = extra;
  }

  run(text: string): string {
    const result = redact(text, { extra: this.extra });
    for (const [kind, n] of Object.entries(result.found)) this.found[kind] = (this.found[kind] ?? 0) + n;
    return result.text;
  }
}

const oneLine = (text: string, max = 300) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The last decisions, one line each (what the planner and the workers get, not the chat). */
export function decisionsSummary(decisions: readonly Decision[], keep = 8): string {
  const last = decisions.slice(-keep);
  if (!last.length) return '(ninguna todavía)';
  return last
    .map((d) => {
      const files = d.files.length ? ` Archivos: ${d.files.slice(0, 8).join(', ')}${d.files.length > 8 ? '…' : ''}.` : '';
      const outcome = d.outcome === 'done' ? 'hecha' : d.outcome === 'error' ? 'falló' : 'cancelada';
      return `- [${outcome}] ${oneLine(d.task, 200)} (${d.model}${d.effort ? `, ${d.effort}` : ''}). ${oneLine(d.summary, 240)}${files}`;
    })
    .join('\n');
}

/** The last exchanges, short (the planner's view of the conversation). */
function recentSummary(messages: readonly OrchMessage[], keep = 6): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.kind === 'user') lines.push(`Usuario: ${oneLine(m.text, 400)}`);
    else if (m.kind === 'run' && m.result) lines.push(`Trabajador: ${oneLine(m.result, 400)}`);
  }
  return lines.slice(-keep).join('\n') || '(nada todavía)';
}

function modelsList(agents: readonly AgentInfo[]): string {
  return agents
    .filter((a) => a.installed && a.models.length)
    .map((a) => {
      const models = rankModels(a.models)
        .map((m) => `  - ${m.value} (${m.displayName}; ${m.tier}): ${m.description}. Esfuerzos: ${m.efforts.join(', ') || 'no admite'}.`)
        .join('\n');
      return `- agent "${a.id}" (${a.name}):\n${models}`;
    })
    .join('\n');
}

function imagesNote(n: number): string {
  const one = n === 1;
  return `## Imágenes\nEl usuario adjuntó ${one ? 'una imagen' : `${n} imágenes`}: el trabajador ${one ? 'la recibe' : 'las recibe'} junto con la tarea (vos no ${one ? 'la ves' : 'las ves'}). Indicá en "task" que tiene que ${one ? 'mirarla' : 'mirarlas'}.`;
}

export function plannerPrompt(ctx: PlanContext, extra: readonly string[] = []): Built {
  const r = new Redactor(extra);
  const parts = [
    `## Proyecto\n${r.run(ctx.projectName)}${ctx.hasAgentsMd ? ' (tiene AGENTS.md con sus instrucciones; el trabajador lo lee)' : ''}`,
    `## Agentes y modelos disponibles\n${modelsList(ctx.agents) || '(ninguno detectado)'}`,
    `## Comandos que el trabajador puede ejecutar\n${ctx.commands.length ? ctx.commands.map((c) => `- ${c}`).join('\n') : '(ninguno: solo leer y editar archivos)'}`,
    `## Decisiones anteriores del proyecto\n${r.run(decisionsSummary(ctx.decisions))}`,
    `## Conversación reciente\n${r.run(recentSummary(ctx.recent))}`,
    ...(ctx.forced ? [`## Modelo\nModelo elegido por el usuario: ${ctx.forced}`] : []),
    `## Mensaje del usuario\n${r.run(ctx.message)}`,
    ...(ctx.images ? [imagesNote(ctx.images)] : []),
    ...(ctx.needsTitle ? ['## Título del chat\nEs el primer mensaje de esta conversación: agregá "title" al JSON.'] : []),
    ...(ctx.correction ? [`## Corrección\nTu respuesta anterior no era un plan válido (${ctx.correction}). Respondé solo con el bloque json pedido.`] : []),
  ];
  return { text: parts.join('\n\n'), found: r.found };
}

/** The JSON object of an answer: a ```json block, or the first {...} in it. */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  const candidates = [fence?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export type PlanResult = { plan: Plan } | { error: string };

/**
 * A plan the app can run: a known agent, one of its models (`forced` wins), an effort that model
 * accepts (else its closest), a task and a reason.
 */
export function validatePlan(value: unknown, agents: readonly AgentInfo[], forced: string | null = null): PlanResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'no es un objeto JSON' };
  const v = value as Record<string, unknown>;
  const text = (key: string) => (typeof v[key] === 'string' ? (v[key] as string).trim() : '');
  const task = text('task');
  if (!task) return { error: 'falta "task"' };
  if (task.length > 8000) return { error: '"task" es demasiado larga' };
  const agent = agents.find((a) => a.id === (text('agent') || 'claude') && a.installed);
  if (!agent) return { error: `agente desconocido: "${text('agent')}"` };
  const choices = agent.models.filter((m) => m.value !== 'default');
  const modelName = forced ?? text('model');
  const model = choices.find((m) => m.value === modelName);
  if (!model) return { error: `modelo desconocido: "${modelName}"` };
  let effort: string | null = text('effort') || null;
  if (model.efforts.length === 0) effort = null;
  else if (!effort || !model.efforts.includes(effort)) {
    // A level the model lacks: the nearest it has, by the usual order.
    const order = ['low', 'medium', 'high', 'xhigh', 'max'];
    const wanted = Math.max(0, order.indexOf(effort ?? 'medium'));
    effort = [...model.efforts].sort((a, b) => Math.abs(order.indexOf(a) - wanted) - Math.abs(order.indexOf(b) - wanted))[0] ?? null;
  }
  const files = Array.isArray(v.files) ? v.files.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).slice(0, 30) : [];
  return { plan: { task, agent: agent.id, model: model.value, effort, why: text('why') || '(sin motivo)', files, title: cleanTitle(v.title) } };
}

// ---------------------------------------------------------------- worker brief

export interface BriefContext {
  plan: Plan;
  projectName: string;
  decisions: readonly Decision[];
  hasAgentsMd: boolean;
  commands: readonly string[];
}

/** What a worker receives: the task, the gist of past decisions and the relevant files. */
export function buildBrief(ctx: BriefContext, extra: readonly string[] = []): Built {
  const r = new Redactor(extra);
  const parts = [
    `## Tarea\n${r.run(ctx.plan.task)}`,
    `## Proyecto\n${r.run(ctx.projectName)}. ${ctx.hasAgentsMd ? 'Leé primero AGENTS.md: son las instrucciones del proyecto.' : 'No tiene AGENTS.md: seguí las convenciones que veas en el código.'}`,
    `## Decisiones anteriores (resumen)\n${r.run(decisionsSummary(ctx.decisions))}`,
    ...(ctx.plan.files.length ? [`## Archivos relevantes\n${ctx.plan.files.map((f) => `- ${r.run(f)}`).join('\n')}`] : []),
    `## Comandos permitidos\n${ctx.commands.length ? ctx.commands.map((c) => `- ${c}`).join('\n') : '(ninguno)'}\nSi necesitás otro comando, no busques rodeos: terminá y explicá cuál y por qué.`,
  ];
  return { text: parts.join('\n\n'), found: r.found };
}

/** The line a worker adds when the task left AGENTS.md out of date (Brisa's worker rules). */
export const AGENTS_STALE_MARKER = 'AGENTS.md desactualizado:';

/** The worker's final answer: its summary, and the line that says AGENTS.md went out of date. */
export function parseWorkerResult(result: string): { body: string; agentsStale: string | null } {
  let agentsStale: string | null = null;
  const kept = result.split(/\r?\n/).filter((line) => {
    const at = line.indexOf(AGENTS_STALE_MARKER);
    // Only a line of its own (maybe a list item or in bold), never a mention inside a sentence.
    if (at < 0 || line.slice(0, at).replace(/[\s*_>`-]/g, '') !== '') return true;
    agentsStale =
      line
        .slice(at + AGENTS_STALE_MARKER.length)
        .replace(/^[\s*_]+|[\s*_]+$/g, '')
        .trim() || 'sin detalle';
    return false;
  });
  return { body: kept.join('\n').trim(), agentsStale };
}

/** Asks a read-only worker for the whole AGENTS.md updated after a task (shown before writing). */
export function agentsUpdatePrompt(reason: string): string {
  return [
    `AGENTS.md de este proyecto quedó desactualizado después de una tarea: ${reason}`,
    'Leé AGENTS.md y lo que haga falta del proyecto (solo lectura) y escribí el contenido completo de AGENTS.md actualizado: cambiá solo lo necesario y conservá el resto tal cual (mismo orden, mismo estilo).',
    'No incluyas secretos ni el contenido de archivos .env.',
    'Respondé SOLO con el markdown del archivo.',
  ].join('\n');
}

/** After the user allowed what was denied: continue the same session. */
export function continuePrompt(allowed: readonly string[]): string {
  return `El usuario permitió: ${allowed.map((a) => `\`${a}\``).join(', ')}. Continuá la tarea desde donde quedó.`;
}

/** The analysis that drafts AGENTS.md (read-only worker). */
export const AGENTS_DRAFT_PROMPT = [
  'Analizá este proyecto (solo lectura) y escribí el contenido completo de un archivo AGENTS.md: las instrucciones que cualquier agente de IA (Claude Code, Codex, Gemini) tiene que seguir para trabajar en él.',
  'Incluí, breve y concreto, lo que sea cierto para ESTE proyecto (miralo en sus archivos, no supongas):',
  '- Stack (lenguajes, frameworks, versiones importantes).',
  '- Comandos: instalar, build, tests, lint/formato, cómo correr la app.',
  '- Convenciones de código (estilo, nombres, idioma de comentarios y textos, cómo se escriben los tests).',
  '- Estructura: carpetas principales y qué hay en cada una.',
  '- Cuidados: lo que no hay que tocar o hacer.',
  'No incluyas secretos ni el contenido de archivos .env. Escribilo en el idioma de la documentación del proyecto (español si no hay).',
  'Respondé SOLO con el markdown del archivo, empezando por "# AGENTS.md" o el título del proyecto.',
].join('\n');

/** Strips a code fence around a markdown answer. */
export function markdownAnswer(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(trimmed);
  return `${(fence?.[1] ?? trimmed).trim()}\n`;
}

export const MINIMAL_CLAUDE_MD = '# CLAUDE.md\n\nLas instrucciones del proyecto para agentes están en AGENTS.md:\n\n@AGENTS.md\n';

/** An existing CLAUDE.md with the AGENTS.md import added at the top (the rest untouched). */
export function withAgentsImport(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // After a leading title, if there is one.
  const at = /^#\s/.test(lines[0] ?? '') ? 1 : 0;
  const insert = at === 1 ? ['', '@AGENTS.md'] : ['@AGENTS.md', ''];
  lines.splice(at, 0, ...insert);
  return lines.join(eol);
}

// ---------------------------------------------------------------- after a task

/** Paths the worker edited or wrote (from its tool calls). */
export function touchedFiles(activity: readonly ActivityItem[]): string[] {
  return [...new Set(activity.filter((a) => (a.action === 'edit' || a.action === 'write') && a.ok !== false && a.target).map((a) => a.target))];
}

export function decisionOf(plan: Plan, run: Pick<RunInfo, 'status' | 'result' | 'error' | 'diff' | 'usage' | 'activity' | 'model' | 'effort'>, at: number): Decision {
  const files = run.diff?.git ? run.diff.files.map((f) => f.path) : (run.diff?.touched ?? touchedFiles(run.activity));
  const summary = run.status === 'done' ? (run.result ?? '') : run.status === 'cancelled' ? 'Cancelada por el usuario.' : (run.error?.message ?? 'Falló.');
  return {
    at,
    task: plan.task,
    model: run.model,
    effort: run.effort,
    why: plan.why,
    outcome: run.status === 'done' ? 'done' : run.status === 'cancelled' ? 'cancelled' : 'error',
    summary: oneLine(summary, 500),
    files,
    costUsd: run.usage?.costUsd ?? 0,
  };
}

/** A path for the activity list: relative to the project when it is inside. */
export function relativeTo(dir: string, path: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const base = norm(dir).replace(/\/+$/, '');
  const full = norm(path);
  return full.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? full.slice(base.length + 1) : full;
}

export function formatCost(usd: number): string {
  if (usd <= 0) return 'US$0';
  if (usd < 0.01) return `US$${usd.toFixed(4)}`;
  return `US$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} k`;
  return `${(n / 1_000_000).toFixed(1)} M`;
}

/** Input + cache + output. */
export const totalTokens = (usage: Usage): number => usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.outputTokens;

/** The small footer of an answer: cost and tokens. */
export function usageShort(usage: Usage): string {
  return `${formatCost(usage.costUsd)} · ${formatTokens(totalTokens(usage))} tokens`;
}

/** The detail on hover: one line per figure. */
export function usageDetail(usage: Usage, label = ''): string {
  const lines = [
    ...(label ? [label] : []),
    `Entrada: ${formatTokens(usage.inputTokens)} tokens`,
    ...(usage.cacheReadTokens ? [`Caché leída: ${formatTokens(usage.cacheReadTokens)}`] : []),
    ...(usage.cacheCreationTokens ? [`Caché escrita: ${formatTokens(usage.cacheCreationTokens)}`] : []),
    `Salida: ${formatTokens(usage.outputTokens)} tokens`,
    `Costo: ${formatCost(usage.costUsd)} (según Claude Code; con suscripción, lo que costaría a precio de API)`,
    ...(usage.turns ? [`Turnos: ${usage.turns}`] : []),
    ...(usage.durationMs ? [`Duración: ${(usage.durationMs / 1000).toFixed(1)} s`] : []),
    ...(usage.models.length ? [`Modelo: ${usage.models.join(', ')}`] : []),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------- activity

const VERBS: Record<ToolAction, { past: string; noun: [string, string] | null; now: string }> = {
  read: { past: 'leyó', noun: ['archivo', 'archivos'], now: 'Leyendo' },
  write: { past: 'creó', noun: null, now: 'Creando' },
  edit: { past: 'editó', noun: null, now: 'Editando' },
  command: { past: 'ejecutó', noun: ['comando', 'comandos'], now: 'Ejecutando' },
  search: { past: 'buscó', noun: ['vez', 'veces'], now: 'Buscando' },
  other: { past: 'usó', noun: ['herramienta', 'herramientas'], now: 'Usando' },
};
const ORDER: ToolAction[] = ['read', 'write', 'edit', 'command', 'search', 'other'];
const FILES: ToolAction[] = ['read', 'write', 'edit'];

/**
 * "Leyó 2 archivos, creó 1, editó 1 y ejecutó 1 comando": the whole activity in one line (files
 * counted once; commands and searches each time). Empty when nothing happened.
 */
export function activitySummary(activity: readonly ActivityItem[]): string {
  const parts: string[] = [];
  let namedFiles = false;
  for (const action of ORDER) {
    const items = activity.filter((a) => a.action === action);
    if (!items.length) continue;
    const isFile = FILES.includes(action);
    const n = isFile ? new Set(items.map((a) => a.target || a.tool)).size : items.length;
    const verb = VERBS[action];
    // Files name the noun once ("leyó 2 archivos, creó 1, editó 1").
    let noun = '';
    if (isFile && !namedFiles) noun = n === 1 ? ' archivo' : ' archivos';
    else if (!isFile && verb.noun) noun = ` ${n === 1 ? verb.noun[0] : verb.noun[1]}`;
    if (isFile) namedFiles = true;
    parts.push(`${verb.past} ${n}${noun}`);
  }
  if (!parts.length) return '';
  const failed = activity.filter((a) => a.ok === false).length;
  const line = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`;
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}${failed ? ` (${failed} con error)` : ''}`;
}

/** What the worker is doing right now: the tool still running, else the last line it wrote. */
export function activityNow(activity: readonly ActivityItem[], text: string): string {
  const running = [...activity].reverse().find((a) => a.ok === null);
  if (running) return `${VERBS[running.action].now} ${running.target || running.tool}…`;
  const last = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (!last) return 'Pensando…';
  const flat = last.replace(/[*_`#>]/g, '').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

export function usageLine(usage: Usage): string {
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const cache = usage.cacheReadTokens ? ` (${formatTokens(usage.cacheReadTokens)} de caché)` : '';
  return `${formatTokens(input)} tokens de entrada${cache} · ${formatTokens(usage.outputTokens)} de salida · ${formatCost(usage.costUsd)}`;
}

/** Commands a worker may run: the project's, the settings', the ones allowed for this project. */
export function allowedCommands(detected: readonly ProjectCommand[], settings: readonly string[], project: readonly string[]): string[] {
  return [...new Set([...detected.map((c) => c.pattern), ...settings.map((s) => s.trim()).filter(Boolean), ...project])];
}

export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

/**
 * Line diff of a file Brisa is about to rewrite (AGENTS.md updated after a task), to show what
 * changes before confirming. Longest common subsequence; huge files fall back to "all changed".
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const b = after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ type: 'del' as const, text })), ...b.map((text) => ({ type: 'add' as const, text }))];
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ type: 'del', text: a[i++]! });
    else out.push({ type: 'add', text: b[j++]! });
  }
  while (i < n) out.push({ type: 'del', text: a[i++]! });
  while (j < m) out.push({ type: 'add', text: b[j++]! });
  return out;
}
