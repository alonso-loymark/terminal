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
//   /work N              a spinner for N seconds (output all the time: "working"), then quiet
//   /bell                rings the terminal bell (BEL)
//   /osc9 text           an OSC 9 notification (iTerm2 / Windows Terminal style)
//   /osc777 title|text   an OSC 777 notify (Ghostty / urxvt style)
//   /after N <line>      runs one of the above N seconds later
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
import fs from 'node:fs';
import path from 'node:path';

const exeName = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase();
const flavor = (process.argv[2] ?? exeName).toLowerCase();
// Verified from each agent: Claude Code's /terminal-setup sends ESC CR; Gemini CLI's sends "\" CR LF.
const NEWLINE = flavor === 'gemini' ? '\\\r\n' : '\x1b\r';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
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

/** A spinner for `seconds`: output all the time, like an agent at work. */
function work(seconds) {
  const frames = '|/-\\';
  const until = Date.now() + seconds * 1000;
  let i = 0;
  clearInterval(working);
  working = setInterval(() => {
    if (Date.now() >= until) {
      clearInterval(working);
      working = null;
      out('\r\nlisto');
      prompt();
      return;
    }
    out(`\r${frames[i++ % frames.length]} trabajando`);
  }, 100);
}

/** A test command; true if it prints its own prompt later. */
function act(line) {
  const [name, ...words] = line.split(' ');
  const rest = words.join(' ');
  if (name === '/work') {
    work(Number(words[0]) || 3);
    return true;
  }
  if (name === '/after') {
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
  if (ch === '\r') submit();
  else if (ch === '\x03') ctrlC();
  else if (ch === '\x7f' || ch === '\b') {
    if (buffer) {
      buffer = buffer.slice(0, -1);
      out('\b \b');
    }
  } else if (ch >= ' ') {
    buffer += ch;
    out(ch);
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
    } else if (!final && (NEWLINE.startsWith(pending) || PASTE_START.startsWith(pending))) {
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

function fakeAnswer(system, prompt) {
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
  const slow = prompt.includes('FAKE_SLOW');
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
  jsonLine({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: text });
  return 0;
}

if (process.argv[2] === 'print') {
  process.exitCode = await printMode(process.argv.slice(3));
} else {
  interactive();
}
