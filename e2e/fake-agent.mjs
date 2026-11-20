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

process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  if (log) fs.appendFileSync(log, `${[...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ')}\n`);
  pending += chunk.toString('utf8');
  consume(false);
});
out(`\x1b[?2004hFAKE-AGENT ${flavor} listo`);
prompt();
