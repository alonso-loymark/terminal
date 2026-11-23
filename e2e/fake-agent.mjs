#!/usr/bin/env node
// Fake AI-agent CLI for tests. It never talks to any service or model.
//
// It mimics what matters to the terminal in Claude Code / Gemini CLI: a raw-mode line editor,
// bracketed paste, the agent's own "newline" sequence (what its /terminal-setup installs in
// VS Code) and "Ctrl+C twice to exit". The flavor comes from the executable name, so running it
// through a node.exe linked as claude.exe / gemini.exe also exercises the terminal's agent
// detection. Usage: claude.exe fake-agent.mjs   (or: node fake-agent.mjs <claude|codex|gemini>)
//
// Lines it understands (to test the terminal's agent indicators and notifications):
//   /work N [plain]      a spinner for N seconds (output all the time: "working") with Claude
//                        Code's working hint "(Ns · esc to interrupt)" (`plain`: without it),
//                        erased when done, like the real one; then quiet
//   /redraw MS|off       while idle, repaints its prompt line every MS ms (a TUI's timers)
//   /lag MS|off          echoes what is typed MS ms late (a TUI in a long conversation)
//   /bell                rings the terminal bell (BEL)
//   /osc9 text           an OSC 9 notification (iTerm2 / Windows Terminal style)
//   /osc777 title|text   an OSC 777 notify (Ghostty / urxvt style)
//   /after N <line>      runs one of the above N seconds later
//   /tui S N [calm]      S seconds of a TUI like Claude Code in a long conversation (see startTui)
//
// The clipboard image key of each agent in Windows (what Brisa forwards when an image is pasted):
// Claude Code reads it on Alt+V (ESC v), Codex on Ctrl+V (0x16), Gemini and agy on either. On its
// key it prints "IMAGEN <key>"; on the other one, "TECLA <key> sin efecto".
//
// Print mode (`claude -p`, what Brisa's AI layer runs): `node fake-agent.mjs print <args>`, usually
// through a .cmd wrapper given to the app as its claude (BRISA_CLAUDE_PATH / ai.claudePath).
// It speaks claude 2.1.x's stream-json (captured from the real CLI), checks that every isolation
// flag is there, and logs each run (argv, cwd, environment, system prompt, stdin) as one JSON
// line to FAKE_CLAUDE_LOG. FAKE_CLAUDE_STATE (a JSON file, read on each run) says whether it is
// "logged in". Words in the prompt pick a behavior:
//   FAKE_AUTH_ERROR       not logged in (the real CLI's output)
//   FAKE_LIMIT            usage limit reached
//   FAKE_CRASH            dies with a message on stderr and no result
//   FAKE_UNKNOWN_OPTION   an older CLI that does not know a flag
//   FAKE_SLOW             streams for ~30 s (to test cancelling)
//   FAKE_DESTRUCTIVE      proposes a recursive delete
//
// Orchestrator (Fase 8A), same print mode:
// - `--input-format stream-json` + an `initialize` control request: answers with the models
//   (the real list's shape: value, displayName, description with prices, effort levels).
// - A system prompt of the orchestrator's planner ("Sos el orquestador de Brisa"): a JSON plan
//   (haiku/low for trivial work, opus/high for architecture or hard bugs, sonnet/medium else;
//   the model the user chose if the prompt says so). FAKE_BAD_PLAN: not JSON the first time.
// - `--restricted` = a worker: checks the permission flags (dontAsk, the tool list, never
//   anything that turns permissions off, secrets denied), streams tool calls and REALLY edits
//   the project in its folder (src/app.js gets a line; without it, NOTAS.md is written),
//   "runs" `npm run build` if allowed, and ends with usage and cost. Sessions are kept in
//   `<FAKE_CLAUDE_STATE>.sessions.json` (`--resume` of an unknown one fails like the real CLI).
//   Words in the brief: FAKE_DENIED (tries `curl -s https://example.com`: denied unless
//   allowed), FAKE_SECRET (tries to read .env), FAKE_SLOW (~60 s, with a child process, to test
//   that cancelling kills the tree), FAKE_WORK_ERROR (usage limit after spending a little).
//   Analysis (`--tools Read,Glob,Grep`): reads and answers an AGENTS.md draft.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exeName = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase();
const flavor = (process.argv[2] ?? exeName).toLowerCase();
// Verified from each agent: Claude Code's /terminal-setup sends ESC CR; Gemini CLI's sends "\" CR LF.
const NEWLINE = flavor === 'gemini' ? '\\\r\n' : '\x1b\r';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const ALT_V = '\x1bv';
const CTRL_V = '\x16';
// Verified in each agent's code (see lib/imagePasteModel.ts).
const IMAGE_KEYS = { claude: [ALT_V], codex: [CTRL_V], gemini: [CTRL_V, ALT_V], agy: [CTRL_V, ALT_V] }[flavor] ?? [];
const log = process.env.FAKE_AGENT_LOG;

let buffer = '';
let pending = '';
let pasting = false;
let lastCtrlC = 0;
let flushTimer;

const out = (text) => process.stdout.write(text);
const prompt = () => out('\r\n› ');

function newline() {
  buffer += '\n';
  out('\r\n  ');
}

let working = null;

/**
 * A spinner for `seconds`: output all the time, like an agent at work, with Claude Code's working
 * hint (unless `plain`). The line is erased when done: the real ones leave no hint behind.
 */
function work(seconds, plain = false) {
  const frames = '|/-\\';
  const started = Date.now();
  const until = started + seconds * 1000;
  let i = 0;
  clearInterval(working);
  working = setInterval(() => {
    if (Date.now() >= until) {
      clearInterval(working);
      working = null;
      out('\r\x1b[2Klisto');
      prompt();
      return;
    }
    const hint = plain ? '' : ` (${Math.floor((Date.now() - started) / 1000)}s · esc to interrupt)`;
    out(`\r${frames[i++ % frames.length]} trabajando${hint}`);
  }, 100);
}

/** `/redraw MS`: repaints the prompt line while idle (some TUIs do, on timers). */
let redrawing = null;
function redraw(ms) {
  clearInterval(redrawing);
  redrawing = ms > 0 ? setInterval(() => !working && !tui && out(`\r\x1b[2K› ${buffer.split('\n').at(-1)}`), ms) : null;
}

/** `/lag MS`: echo typed characters this late. */
let lag = 0;
const echo = (text) => (lag > 0 ? setTimeout(() => out(text), lag) : out(text));

function imageKey(seq) {
  const name = seq === ALT_V ? 'alt+v' : 'ctrl+v';
  out(IMAGE_KEYS.includes(seq) ? `\r\nIMAGEN ${name}` : `\r\nTECLA ${name} sin efecto`);
  prompt();
  out(buffer);
}

// ---------------------------------------------------------------- TUI load (performance)

/**
 * `/tui SECONDS LINES [calm]`: the output pattern of a TUI like Claude Code (Ink) in a long
 * conversation. A transcript of LINES colored lines is printed first (scrollback); then every
 * 50 ms the dynamic region at the bottom is erased line by line and drawn again (spinner,
 * the answer being streamed, status, input box), and the title changes (OSC 0). When the answer
 * grows taller than the screen, Ink can no longer erase it and repaints everything: clear the
 * screen and the scrollback (ESC[2J ESC[3J ESC[H) and write the whole transcript again, every
 * frame, until the answer ends and joins the transcript. "calm": never that full repaint.
 * Frames are wrapped in synchronized output (DEC 2026) unless FAKE_TUI_SYNC=0. Keys typed
 * meanwhile echo at once in the input box, Enter clears it; Ctrl+C stops it.
 */
let tui = null;
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const WORDS = 'const value await function return render buffer terminal output agent stream token cache index layout'.split(' ');
const sgr = (n) => `\x1b[38;5;${n}m`;
function coloredLine(i, width) {
  let line = `${sgr(244)}${String(i).padStart(5)} ${sgr(39 + (i % 6) * 6)}`;
  let len = 6;
  for (let w = 0; len < width - 12; w++) {
    const word = WORDS[(i * 7 + w * 3) % WORDS.length];
    line += `${w % 4 === 0 ? '\x1b[1m' : ''}${word}\x1b[22m `;
    len += word.length + 1;
    if (w % 5 === 4) line += sgr(70 + ((i + w) % 9) * 12);
  }
  return `${line}\x1b[0m`;
}

function startTui(seconds, lines, calm) {
  const sync = process.env.FAKE_TUI_SYNC !== '0';
  const width = () => Math.max(40, (process.stdout.columns || 100) - 1);
  const rows = () => process.stdout.rows || 30;
  const transcript = [];
  for (let i = 0; i < lines; i++) transcript.push(coloredLine(i, width()));
  out(`\r\n${transcript.join('\r\n')}\r\n`);
  let answer = [];
  let drawn = 0;
  let frame = 0;
  let typed = '';
  const dynamic = () => [
    `${sgr(208)}${SPIN[frame % SPIN.length]} Pensando… ${sgr(244)}(${frame} frames · esc para interrumpir)\x1b[0m`,
    ...answer,
    `${sgr(240)}${'─'.repeat(width())}\x1b[0m`,
    `${sgr(15)}> ${typed}\x1b[0m`,
    `${sgr(240)}${'─'.repeat(width())}\x1b[0m`,
    `${sgr(244)}  ? para atajos · ${transcript.length} líneas\x1b[0m`,
  ];
  const draw = () => {
    frame++;
    answer.push(coloredLine(transcript.length + answer.length, width()));
    const next = dynamic();
    let data = sync ? '\x1b[?2026h' : '';
    data += `\x1b]0;${SPIN[frame % SPIN.length]} Tarea larga\x07`;
    // When the frame was written (a private OSC no terminal handles): the perf e2e measures how
    // stale the screen is (this time vs when xterm parses it).
    data += `\x1b]5379;${Date.now()}\x07`;
    if (!calm && next.length >= rows()) {
      // Taller than the screen: what scrolled away cannot be erased, so everything again.
      data += `\x1b[2J\x1b[3J\x1b[H${transcript.join('\r\n')}\r\n${next.join('\r\n')}`;
    } else {
      // Erase the previous frame line by line (Ink's eraseLines) and draw the new one.
      data += drawn ? `${'\x1b[2K\x1b[1A'.repeat(drawn - 1)}\x1b[2K\r` : '';
      data += next.join('\r\n');
    }
    drawn = next.length;
    if (sync) data += '\x1b[?2026l';
    out(data);
    // The answer ends (taller than the screen for a while, or long enough when calm).
    if (answer.length > rows() + 25 || (calm && answer.length > 12)) {
      out(`${'\x1b[2K\x1b[1A'.repeat(drawn - 1)}\x1b[2K\r${answer.join('\r\n')}\r\n`);
      transcript.push(...answer);
      answer = [];
      drawn = 0;
    }
  };
  const timer = setInterval(draw, 50);
  const stop = setTimeout(() => endTui(), seconds * 1000);
  tui = {
    timer,
    stop,
    key(ch) {
      if (ch === '\x03') return endTui();
      if (ch === '\r') {
        // Enter clears the input box (the perf e2e types several rounds).
        typed = '';
        out(`\x1b7\x1b[${rows() - 2};3H\x1b[K\x1b8`);
        return;
      }
      if (ch >= ' ') {
        typed += ch;
        // The echo right away, in the input box (two lines above the bottom), with when the key
        // got here (OSC 5379-like private stamp: the perf e2e splits the echo latency in two).
        out(`\x1b]5380;${Date.now()}\x07\x1b7\x1b[${rows() - 2};3H${typed}\x1b8`);
      }
    },
  };
}

function endTui() {
  if (!tui) return;
  clearInterval(tui.timer);
  clearTimeout(tui.stop);
  tui = null;
  out('\r\n\x1b]0;fake-agent\x07listo');
  prompt();
}

/** A test command; true if it prints its own prompt later. */
function act(line) {
  const [name, ...words] = line.split(' ');
  const rest = words.join(' ');
  if (name === '/work') {
    work(Number(words[0]) || 3, words[1] === 'plain');
    return true;
  }
  if (name === '/redraw') redraw(Number(words[0]) || 0);
  else if (name === '/lag') lag = Number(words[0]) || 0;
  if (name === '/tui') {
    startTui(Number(words[0]) || 20, Number(words[1]) || 3000, words[2] === 'calm');
    return true;
  }
  else if (name === '/after') {
    // "/after N /bell": the same N seconds later (the test meanwhile hides the pane).
    setTimeout(() => act(words.slice(1).join(' ')), (Number(words[0]) || 1) * 1000);
  } else if (name === '/bell') out('\x07');
  else if (name === '/osc9') out(`\x1b]9;${rest}\x07`);
  else if (name === '/osc777') {
    const [title, text = ''] = rest.split('|');
    out(`\x1b]777;notify;${title};${text}\x07`);
  }
  return false;
}

function submit() {
  const line = buffer.trim();
  out(`\r\nSUBMIT ${JSON.stringify(buffer)}`);
  buffer = '';
  if (!act(line)) prompt();
}

function ctrlC() {
  if (buffer) {
    buffer = '';
    out('\r\n(input borrado)');
    prompt();
  } else if (Date.now() - lastCtrlC < 3000) {
    out('\r\nbye\r\n\x1b[?2004l');
    process.exit(0);
  } else {
    lastCtrlC = Date.now();
    out('\r\nPress Ctrl-C again to exit');
    prompt();
  }
}

function key(ch) {
  if (tui) return tui.key(ch);
  if (ch === '\r') submit();
  else if (ch === '\x03') ctrlC();
  else if (ch === CTRL_V) imageKey(CTRL_V);
  else if (ch === '\x7f' || ch === '\b') {
    if (buffer) {
      buffer = buffer.slice(0, -1);
      out('\b \b');
    }
  } else if (ch >= ' ') {
    buffer += ch;
    echo(ch);
  }
}

function consume(final) {
  clearTimeout(flushTimer);
  while (pending) {
    if (pending.startsWith(PASTE_START)) {
      pasting = true;
      pending = pending.slice(PASTE_START.length);
    } else if (pending.startsWith(PASTE_END)) {
      pasting = false;
      pending = pending.slice(PASTE_END.length);
    } else if (pasting) {
      // Pasted text never submits: line breaks become newlines in the input.
      const ch = pending[0];
      pending = pending.slice(1);
      if (ch === '\r' || ch === '\n') {
        if (!(ch === '\n' && buffer.endsWith('\n'))) newline();
      } else key(ch);
    } else if (pending.startsWith(NEWLINE)) {
      pending = pending.slice(NEWLINE.length);
      newline();
    } else if (pending.startsWith(ALT_V)) {
      pending = pending.slice(ALT_V.length);
      if (!tui) imageKey(ALT_V);
    } else if (!final && (NEWLINE.startsWith(pending) || PASTE_START.startsWith(pending) || ALT_V.startsWith(pending))) {
      // Possibly the first half of a split sequence: give the rest a moment to arrive.
      flushTimer = setTimeout(() => consume(true), 50);
      return;
    } else {
      const ch = pending[0];
      pending = pending.slice(1);
      key(ch);
    }
  }
}

function interactive() {
  process.stdin.setRawMode(true);
  process.stdin.on('data', (chunk) => {
    if (log) fs.appendFileSync(log, `${[...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ')}\n`);
    pending += chunk.toString('utf8');
    consume(false);
  });
  out(`\x1b[?2004hFAKE-AGENT ${flavor} listo`);
  prompt();
}

// ---------------------------------------------------------------- print mode (claude -p)

const ISOLATION_FLAGS = ['-p', '--verbose', '--include-partial-messages', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'];
const ISOLATION_VALUES = { '--output-format': 'stream-json', '--tools': '', '--permission-mode': 'dontAsk', '--setting-sources': 'user', '--max-turns': '1' };

const jsonLine = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FENCE = '```';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const FAKE_MODELS = [
  ['default', 'claude-opus-5-5', 'Default (recommended)', 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok'],
  ['opus', 'claude-opus-5-5', 'Opus', 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok'],
  ['fable', 'claude-fable-5-2', 'Fable', 'Fable 5.2 · Most capable for your hardest and longest-running tasks · $8/$40 per Mtok'],
  ['sonnet', 'claude-sonnet-5-5', 'Sonnet', 'Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok'],
  ['haiku', 'claude-haiku-5-5', 'Haiku', 'Haiku 5.5 · Fastest for quick answers · $1/$5 per Mtok'],
].map(([value, resolvedModel, displayName, description]) => ({
  value,
  resolvedModel,
  displayName,
  description,
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportsAdaptiveThinking: true,
}));
const COST = { haiku: 0.0042, sonnet: 0.0123, opus: 0.0456, fable: 0.0912 };

function fakePlan(prompt) {
  const message = /## Mensaje del usuario\n([\s\S]*?)(?:\n## |$)/.exec(prompt)?.[1]?.trim() ?? prompt.trim();
  if (message.includes('FAKE_BAD_PLAN') && !prompt.includes('## Corrección')) return 'Creo que habría que mirar el código primero.';
  const forced = /Modelo elegido por el usuario: (\S+)/.exec(prompt)?.[1];
  const lower = message.toLowerCase();
  let model = 'sonnet';
  let effort = 'medium';
  let why = 'Cambio normal: modelo de costo medio.';
  if (/trivial|renombr|typo|errata/.test(lower)) [model, effort, why] = ['haiku', 'low', 'Tarea trivial y mecánica: modelo rápido con esfuerzo bajo.'];
  else if (/arquitectura|bug dif[ií]cil|muchos archivos/.test(lower)) [model, effort, why] = ['opus', 'high', 'Arquitectura o un bug difícil: el modelo más potente con esfuerzo alto.'];
  if (forced) [model, why] = [forced, `El usuario eligió ${forced}.`];
  const plan = { task: `Tarea: ${message}`, agent: 'claude', model, effort, why, files: ['src/app.js'] };
  return `${FENCE}json\n${JSON.stringify(plan, null, 2)}\n${FENCE}`;
}

function fakeAnswer(system, prompt) {
  if (system.includes('Sos el orquestador de Brisa')) return fakePlan(prompt);
  if (system.includes('Convertís un pedido')) {
    if (prompt.includes('FAKE_DESTRUCTIVE')) return `${FENCE}powershell\nRemove-Item -Recurse -Force .\\build\n${FENCE}\nBorra la carpeta build y todo su contenido.`;
    if (prompt.includes('puerto 3000')) {
      return `${FENCE}powershell\nGet-NetTCPConnection -LocalPort 3000 | ForEach-Object { Stop-Process -Id $_.OwningProcess }\n${FENCE}\nTermina el proceso que escucha en el puerto 3000.`;
    }
    return `${FENCE}powershell\nGet-ChildItem -Force\n${FENCE}\nLista los archivos de la carpeta, también los ocultos.`;
  }
  if (system.includes('comando que falló')) {
    const code = /Código de salida: (-?\d+)/.exec(prompt)?.[1] ?? '?';
    return `Explicación falsa: el comando terminó con código ${code} a propósito.\n\nPara probar de nuevo sin error:\n\n${FENCE}powershell\nWrite-Output arreglado\n${FENCE}`;
  }
  const blocks = (prompt.match(/^### Bloque/gm) ?? []).length;
  return `Respuesta falsa del chat (bloques adjuntos: ${blocks}).\n\n${FENCE}powershell\nGet-Location\n${FENCE}`;
}

async function printMode(args) {
  const state = (() => {
    try {
      return JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_STATE ?? '', 'utf8'));
    } catch {
      return { loggedIn: true };
    }
  })();
  if (args[0] === '--version') {
    process.stdout.write('2.1.329 (Claude Code) [falso]\n');
    return 0;
  }
  if (args[0] === 'auth' && args[1] === 'status') {
    process.stdout.write(`${JSON.stringify({ loggedIn: !!state.loggedIn, authMethod: state.loggedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty' }, null, 2)}\n`);
    return state.loggedIn ? 0 : 1;
  }
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const prompt = await readStdin();
  let system = '';
  try {
    system = fs.readFileSync(value('--system-prompt-file') ?? '', 'utf8');
  } catch {
    // reported below as a missing flag
  }
  const env = Object.fromEntries(
    ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'].map((k) => [k, process.env[k] ?? null]),
  );
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), env, system, prompt, at: Date.now() })}\n`);
  }
  const missing = [
    ...ISOLATION_FLAGS.filter((f) => !args.includes(f)),
    ...Object.entries(ISOLATION_VALUES)
      .filter(([f, v]) => value(f) !== v)
      .map(([f, v]) => `${f} ${JSON.stringify(v)}`),
    ...(system ? [] : ['--system-prompt-file']),
  ];
  if (prompt.includes('FAKE_UNKNOWN_OPTION')) {
    process.stderr.write("error: unknown option '--safe-mode'\n");
    return 1;
  }
  if (prompt.includes('FAKE_CRASH')) {
    process.stderr.write('fake crash: algo se rompió\n');
    return 3;
  }
  const model = value('--model') ?? 'default';
  jsonLine({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [], mcp_servers: [], model, permissionMode: value('--permission-mode'), slash_commands: [], apiKeySource: 'none', claude_code_version: '2.1.329' });
  const fail = (kind, text) => {
    jsonLine({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', type: 'message', content: [{ type: 'text', text }] }, error: kind });
    jsonLine({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, result: text, terminal_reason: 'api_error' });
    return 1;
  };
  if (missing.length) return fail('invalid_request', `FAKE: faltan flags de aislamiento: ${missing.join(', ')}`);
  if (!state.loggedIn || prompt.includes('FAKE_AUTH_ERROR')) return fail('authentication_failed', 'Not logged in · Please run /login');
  if (prompt.includes('FAKE_LIMIT')) return fail('rate_limit', "You've hit your usage limit · resets 3pm");
  // The orchestrator's plan of a FAKE_SLOW task is not itself slow (the worker is).
  const slow = prompt.includes('FAKE_SLOW') && !system.includes('Sos el orquestador de Brisa');
  const text = slow ? 'Pensando despacio. '.repeat(100) : fakeAnswer(system, prompt);
  jsonLine({ type: 'stream_event', event: { type: 'message_start', message: { model } } });
  jsonLine({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (let i = 0; i < text.length; i += 6) {
    jsonLine({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 6) } } });
    await wait(slow ? 300 : 8);
  }
  jsonLine({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  jsonLine({ type: 'stream_event', event: { type: 'message_stop' } });
  jsonLine({ type: 'assistant', message: { model, role: 'assistant', type: 'message', content: [{ type: 'text', text }] } });
  const cost = (COST[model] ?? 0.01) / 4;
  jsonLine({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: text, session_id: newSessionId(), total_cost_usd: cost, duration_ms: 900, usage: { input_tokens: 800, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: { [model]: { inputTokens: 800, outputTokens: 120, costUSD: cost } }, permission_denials: [] });
  return 0;
}

// ---------------------------------------------------------------- orchestrator modes

const newSessionId = () => `${Math.random().toString(16).slice(2, 10)}-fake-${Date.now().toString(16)}`;
const sessionsFile = () => `${process.env.FAKE_CLAUDE_STATE || path.join(os.tmpdir(), 'fake-claude')}.sessions.json`;
function sessions() {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveSession(id, data) {
  const all = sessions();
  all[id] = { ...all[id], ...data };
  fs.writeFileSync(sessionsFile(), JSON.stringify(all));
}

/** Values of a variadic flag (`--allowedTools a b c --next`). */
function listAfter(args, flag) {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  return out;
}

function logRun(entry) {
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), at: Date.now(), ...entry })}\n`);
}

async function initMode(args) {
  const input = await readStdin();
  logRun({ kind: 'init', args, prompt: input });
  const request = input
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((m) => m.type === 'control_request' && m.request?.subtype === 'initialize');
  if (!request) return 1;
  jsonLine({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { models: FAKE_MODELS, claude_code_version: '2.1.329', commands: [], agents: [] } } });
  return 0;
}

const WORK_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash,PowerShell';
const ANALYZE_TOOLS = 'Read,Glob,Grep';

async function workMode(args, state) {
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const prompt = await readStdin();
  // Behaviors come from the task itself (a brief also summarizes past tasks, which may name them).
  const asked = /## Tarea\n([\s\S]*?)(?:\n## |$)/.exec(prompt)?.[1] ?? prompt;
  const allowed = listAfter(args, '--allowedTools');
  const denied = listAfter(args, '--disallowedTools');
  let rules = '';
  try {
    rules = fs.readFileSync(value('--append-system-prompt-file') ?? '', 'utf8');
  } catch {
    // reported below
  }
  const tools = value('--tools') ?? '';
  const resume = value('--resume');
  const model = value('--model') ?? 'default';
  const env = Object.fromEntries(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'].map((k) => [k, process.env[k] ?? null]));
  logRun({ kind: 'work', args, allowed, denied, rules, prompt, model, effort: value('--effort') ?? null, resume: resume ?? null, tools, env });
  const problems = [
    ...['-p', '--verbose', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--include-partial-messages'].filter((f) => !args.includes(f)),
    ...(value('--output-format') === 'stream-json' ? [] : ['--output-format stream-json']),
    ...(value('--permission-mode') === 'dontAsk' ? [] : ['--permission-mode dontAsk']),
    ...([WORK_TOOLS, ANALYZE_TOOLS].includes(tools) ? [] : [`--tools ${tools}`]),
    ...(rules ? [] : ['--append-system-prompt-file']),
    ...(denied.includes('Read(.env)') ? [] : ['Read(.env) denegado']),
    ...args.filter((a) => /dangerously|bypassPermissions|acceptEdits|^--settings$|^--add-dir$/.test(a)).map((a) => `prohibido: ${a}`),
    ...(tools === WORK_TOOLS && !allowed.includes('Edit') ? ['--allowedTools Edit'] : []),
  ];
  const sessionId = resume ?? newSessionId();
  if (resume && !sessions()[resume]) {
    jsonLine({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: resume, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [] });
    process.stderr.write(`No conversation found with session ID: ${resume}\n`);
    return 1;
  }
  jsonLine({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, tools: tools.split(',').filter((t) => t !== 'PowerShell').sort(), mcp_servers: [], model, permissionMode: value('--permission-mode'), claude_code_version: '2.1.329' });
  const fail = (kind, text, usage = { input_tokens: 0, output_tokens: 0 }, cost = 0) => {
    jsonLine({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', type: 'message', content: [{ type: 'text', text }] }, error: kind, session_id: sessionId });
    jsonLine({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, result: text, session_id: sessionId, total_cost_usd: cost, usage, permission_denials: [] });
    return 1;
  };
  if (problems.length) return fail('invalid_request', `FAKE: flags de permisos incorrectos: ${problems.join(', ')}`);
  if (!state.loggedIn || asked.includes('FAKE_AUTH_ERROR')) return fail('authentication_failed', 'Not logged in · Please run /login');
  saveSession(sessionId, { cwd: process.cwd(), model });

  let n = 0;
  const say = async (text) => {
    for (let i = 0; i < text.length; i += 8) {
      jsonLine({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 8) } }, session_id: sessionId });
      await wait(4);
    }
    jsonLine({ type: 'assistant', message: { model, content: [{ type: 'text', text }] }, session_id: sessionId });
  };
  const denials = [];
  const ruleAllows = (tool, command) =>
    allowed.some((rule) => {
      const m = /^(\w+)\((.*)\)$/.exec(rule);
      if (!m || m[1] !== tool) return false;
      const pattern = m[2];
      if (pattern.endsWith(' *')) return command === pattern.slice(0, -2) || command.startsWith(pattern.slice(0, -1));
      return command === pattern;
    });
  const call = async (name, input, run) => {
    const id = `toolu_fake_${++n}`;
    jsonLine({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id, name, input }] }, session_id: sessionId });
    await wait(30);
    const base = path.basename(input.file_path ?? '');
    const isDenied =
      (name === 'Bash' && !ruleAllows('Bash', input.command)) ||
      (name === 'Read' && denied.includes(`Read(${base})`)) ||
      ((name === 'Edit' || name === 'Write') && denied.includes(`Edit(${base})`));
    if (isDenied) {
      const denial = { tool_name: name, tool_use_id: id, tool_input: input };
      denials.push(denial);
      jsonLine({ type: 'system', subtype: 'permission_denied', ...denial, session_id: sessionId });
      jsonLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Permission to use ${name} has been denied.`, is_error: true }] }, session_id: sessionId });
      return false;
    }
    const content = run ? run() : 'ok';
    jsonLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, session_id: sessionId });
    return true;
  };
  const resolved = FAKE_MODELS.find((m) => m.value === model)?.resolvedModel ?? model;
  const finish = async (text, turns = 3) => {
    await say(text);
    const cost = COST[model] ?? 0.01;
    jsonLine({ type: 'result', subtype: 'success', is_error: false, num_turns: turns, duration_ms: 2100, result: text, session_id: sessionId, total_cost_usd: cost, usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5000, cache_creation_input_tokens: 800 }, modelUsage: { [resolved]: { inputTokens: 1200, outputTokens: 340, costUSD: cost } }, permission_denials: denials });
    return 0;
  };

  await say(resume ? 'Continúo la tarea anterior.' : 'Voy a revisar el proyecto.');
  const firstFile = ['package.json', 'README.md', 'src/app.js'].find((f) => fs.existsSync(f));
  if (firstFile) await call('Read', { file_path: path.join(process.cwd(), firstFile) }, () => fs.readFileSync(firstFile, 'utf8').slice(0, 200));
  if (tools === ANALYZE_TOOLS) {
    await call('Glob', { pattern: '**/*' });
    return finish('# AGENTS.md\n\nInstrucciones para agentes de IA en este proyecto (borrador falso).\n\n## Stack\n- Node.js (package.json)\n\n## Comandos\n- Build: `npm run build`\n- Tests: `npm test`\n\n## Convenciones\n- Código en inglés, documentación en español.\n\n## Estructura\n- `src/`: código de la app.\n');
  }
  if (asked.includes('FAKE_SLOW')) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    logRun({ kind: 'child', child: child.pid });
    for (let i = 0; i < 200; i++) {
      jsonLine({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '.' } }, session_id: sessionId });
      await wait(300);
    }
    return finish('Terminé despacio.');
  }
  if (asked.includes('FAKE_WORK_ERROR')) return fail('rate_limit', "You've hit your usage limit · resets 3pm", { input_tokens: 300, output_tokens: 20 }, 0.002);
  if (asked.includes('FAKE_SECRET')) await call('Read', { file_path: path.join(process.cwd(), '.env') }, () => fs.readFileSync('.env', 'utf8'));
  const task = /## Tarea\n(.+)/.exec(prompt)?.[1]?.trim() ?? 'tarea';
  let edited;
  if (fs.existsSync('src/app.js')) {
    edited = 'src/app.js';
    await call('Edit', { file_path: path.join(process.cwd(), edited), old_string: '', new_string: `// ${task}` }, () => {
      fs.appendFileSync(edited, `// ${task}\n`);
      return 'The file has been updated.';
    });
  } else {
    edited = 'NOTAS.md';
    await call('Write', { file_path: path.join(process.cwd(), edited), content: `# ${task}\n` }, () => {
      fs.writeFileSync(edited, `# ${task}\n`);
      return 'File created.';
    });
  }
  let curl = true;
  if (asked.includes('FAKE_DENIED') || (resume && sessions()[resume]?.wantedCurl)) {
    curl = await call('Bash', { command: 'curl -s https://example.com', description: 'Descargar' }, () => '<html>falso</html>');
    saveSession(sessionId, { wantedCurl: !curl });
  }
  const built = await call('Bash', { command: 'npm run build', description: 'Build' }, () => 'build ok (falso)');
  const notes = [`edité ${edited}`, built ? 'verifiqué con npm run build' : 'no pude correr el build', curl ? null : 'necesito permiso para ejecutar curl -s https://example.com'].filter(Boolean);
  return finish(`Listo: ${notes.join('; ')}.`);
}

if (process.argv[2] === 'print') {
  const args = process.argv.slice(3);
  const state = (() => {
    try {
      return JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_STATE ?? '', 'utf8'));
    } catch {
      return { loggedIn: true };
    }
  })();
  if (args.includes('--input-format')) process.exitCode = await initMode(args);
  else if (args.includes('--restricted')) process.exitCode = await workMode(args, state);
  else process.exitCode = await printMode(args);
} else {
  interactive();
}
