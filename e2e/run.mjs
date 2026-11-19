// End-to-end checks against the real app (dev build) through WebView2's CDP endpoint.
//
//   npm run e2e                      launches `tauri dev`, runs every stage, closes the app
//   npm run e2e -- colors,clipboard  runs only some stages ("close" always runs last if listed)
//   E2E_ATTACH=1 npm run e2e         attaches to an app already started with CDP on E2E_CDP_PORT
//
// Rules (see CLAUDE.md): never send input to a real AI agent (claude, codex, gemini...); use
// e2e/fake-agent.mjs. Never type unless the shell prompt is idle (`run` enforces it).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'e2e', 'artifacts');
const WIN = path.join(ROOT, 'e2e', 'win.ps1');
const FAKE_AGENT = path.join(ROOT, 'e2e', 'fake-agent.mjs');
const GIT_BIN = 'C:\\Program Files\\Git\\usr\\bin';
const CDP_PORT = Number(process.env.E2E_CDP_PORT ?? 9223);
const ATTACH = process.env.E2E_ATTACH === '1';
const STARTED = Date.now();
/**
 * `npm run e2e:smoke`: the essentials in under 2 minutes, for every change. `npm run e2e`: all
 * stages, to close a phase (CLAUDE.md, "Regla de fases").
 */
const SMOKE = process.argv.includes('--smoke');
const SMOKE_STAGES = ['startup', 'ctrlc', 'shiftenter', 'tabs', 'panes', 'cwd', 'typing', 'explorercd', 'close'];
const only = SMOKE ? SMOKE_STAGES : process.argv[2]?.split(',').filter(Boolean);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-e2e-'));
fs.mkdirSync(ARTIFACTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}${ok ? '' : ` [${time}]`}`);
};
const skip = (name, why) => console.log(`SKIP ${name} — ${why}`);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const powershell = (command) =>
  execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim();
const win = (action, pid, ...size) =>
  execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN,
    '-Action', action, '-ProcessId', String(pid), ...size.flatMap((v, i) => [i ? '-Height' : '-Width', String(v)]),
  ]);
const portInUse = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

// ---------------------------------------------------------------- app lifecycle
let dev;
if (!ATTACH) {
  for (const port of [1420, CDP_PORT]) {
    if (await portInUse(port)) {
      console.error(`El puerto ${port} está ocupado: cerrá la otra instancia de dev o usá E2E_ATTACH=1.`);
      process.exit(2);
    }
  }
  // Agent session variables must not leak into the shells under test.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k)));
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${CDP_PORT}`;
  const logFd = fs.openSync(path.join(ARTIFACTS, 'tauri-dev.log'), 'w');
  dev = spawn('npm run tauri dev', { cwd: ROOT, env, shell: true, stdio: ['ignore', logFd, logFd] });
  console.log(`tauri dev lanzado (log en e2e/artifacts/tauri-dev.log); esperando la app...`);
}

let browser;
for (let i = 0; i < 300 && !browser; i++) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  } catch {
    await sleep(1000);
  }
}
if (!browser) throw new Error('El endpoint CDP nunca apareció (¿falló la compilación? ver tauri-dev.log)');
const page = browser.contexts()[0].pages()[0];
/** Console warnings/errors of the page, e.g. Chromium's "Too many active WebGL contexts". */
const consoleLog = [];
page.on('console', (message) => {
  if (['warning', 'error'].includes(message.type())) consoleLog.push(message.text());
});
// If the page goes away mid-run, say how (renderer crash, window closed, CDP lost) and when.
const stamp = () => new Date().toTimeString().slice(0, 8);
page.on('crash', () => console.log(`!! ${stamp()} la página crasheó (renderer)`));
page.on('close', () => {
  console.log(`!! ${stamp()} la página se cerró (app viva: ${alive(appPid)})`);
  for (const line of consoleLog.slice(-6)) console.log(`!!   consola: ${line.slice(0, 300)}`);
});
page.on('pageerror', (error) => console.log(`!! ${stamp()} error no atrapado en la página: ${String(error).slice(0, 300)}`));
browser.on('disconnected', () => console.log(`!! ${stamp()} CDP desconectado`));
await page.waitForFunction(() => window.__terminal, null, { timeout: 60000 });
// The user may keep working in other windows while the suite runs. Chromium does not fire
// focus events in an unfocused window, which made focus checks flaky; CDP's focus emulation
// (meant for automation) keeps the page behaving as focused without stealing the real focus.
const cdp = await page.context().newCDPSession(page);
const emulateFocus = () => cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
await emulateFocus();
const targetDir = path.join(ROOT, 'src-tauri', 'target').replace(/'/g, "''");
const appPid = Number(
  powershell(
    `Get-CimInstance Win32_Process -Filter "Name='terminal.exe'" | Where-Object { $_.ExecutablePath -like '${targetDir}\\*' } | Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty ProcessId`,
  ),
);
if (!appPid) throw new Error('No encontré el proceso terminal.exe de este repo');

// ---------------------------------------------------------------- helpers
/** Whole buffer, with soft-wrapped rows joined back into logical lines. */
const text = () =>
  page.evaluate(() => {
    const b = window.__terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      const s = line?.translateToString(true) ?? '';
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += s;
      else lines.push(s);
    }
    return lines.join('\n');
  });
const screen = () =>
  page.evaluate(() => {
    const t = window.__terminal;
    const b = t.buffer.active;
    const out = [];
    for (let i = 0; i < t.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
    return out.join('\n');
  });
const prompts = (s) => (s.match(/^PS [A-Za-z]:\\[^\n]*>/gm) ?? []).length;
const count = (s, needle) => s.split(needle).length - 1;
const bufferType = () => page.evaluate(() => window.__terminal.buffer.active.type);
const termInfo = () =>
  page.evaluate(() => {
    const t = window.__terminal;
    return { cols: t.cols, rows: t.rows, fontSize: t.options.fontSize, windowsPty: t.options.windowsPty };
  });
const shot = (name) => page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
const getClipboard = () => page.evaluate(() => navigator.clipboard.readText().catch(() => null));
const setClipboard = (value) => page.evaluate((v) => navigator.clipboard.writeText(v), value);

async function waitFor(pred, { timeout = 15000, source = text } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const s = await source();
    if (typeof pred === 'string' ? s.includes(pred) : pred instanceof RegExp ? pred.test(s) : pred(s)) return s;
    await sleep(100);
  }
  throw new Error(`timeout esperando ${pred}\n--- pantalla ---\n${await screen()}`);
}
async function waitUntil(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}
/** True only when the cursor sits on an idle PowerShell prompt in the main buffer. */
const atShellPrompt = () =>
  page.evaluate(() => {
    const b = window.__terminal.buffer.active;
    const line = b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? '';
    return b.type === 'normal' && /^PS [A-Za-z]:\\.*>\s*$/.test(line);
  });
/** The active terminal owns the keyboard (the app focuses it one frame after a tab switch). */
const terminalFocused = () =>
  page.evaluate(() => !!window.__terminal && document.activeElement === window.__terminal.textarea);
/** Where the keyboard focus is, for failure messages. */
const focusReport = () =>
  page.evaluate(() => {
    const el = document.activeElement;
    const pane = el?.closest?.('[data-pane-id]')?.getAttribute('data-pane-id');
    const ws = window.__workspace.getState();
    const activePane = ws.tabs[ws.activeTabId]?.activePaneId;
    return `foco=${el?.tagName}.${String(el?.className).slice(0, 30)} panel=${pane} activo=${activePane} vis=${document.visibilityState} hasFocus=${document.hasFocus()} ui=${JSON.stringify(window.__ui.getState(), (k, v) => (typeof v === 'function' ? undefined : v))}`;
  });
/** Types a command at the shell prompt. Refuses to type anywhere else (e.g. into a TUI). */
async function run(cmd, { waitPrompt = true } = {}) {
  if (!(await waitUntil(atShellPrompt, 5000))) throw new Error(`sin prompt de PowerShell; no se tipea: ${cmd}`);
  if (!(await waitUntil(terminalFocused, 3000))) {
    throw new Error(`la terminal activa no tiene el foco (${await focusReport()}); no se tipea: ${cmd}`);
  }
  const before = prompts(await text());
  await page.keyboard.type(cmd);
  await page.keyboard.press('Enter');
  if (waitPrompt) return waitFor((s) => prompts(s) > before, { timeout: 20000 });
}
async function value(expr, key) {
  const s = await run(`'${key}=' + (${expr}) + (';' + 'end')`);
  return [...s.matchAll(new RegExp(`${key}=(.*?);end`, 'g'))].at(-1)?.[1];
}
const ptySize = () => value("[string][Console]::WindowWidth + 'x' + [Console]::WindowHeight", 'size');
const shellPid = async () => Number(await value('$PID', 'pid'));
/** Leaves a TUI with Ctrl+C until the shell prompt is back. */
async function exitToPrompt(tries = 4) {
  for (let i = 0; i < tries && !(await atShellPrompt()); i++) {
    await page.keyboard.press('Control+c');
    await sleep(700);
  }
  return waitUntil(atShellPrompt, 5000);
}
// ---------------------------------------------------------------- tab helpers
const wsState = () =>
  page.evaluate(() => {
    const s = window.__workspace.getState();
    return { order: s.tabOrder, active: s.activeTabId, tabs: s.tabs, groups: s.groups, panes: s.panes };
  });
const tabSel = (id) => `[data-tab-id="${id}"]`;
const tabLabel = (id) => page.locator(`${tabSel(id)} .tab-title`).textContent({ timeout: 3000 });
const tabAttr = (id, name) => page.locator(tabSel(id)).getAttribute(name, { timeout: 3000 });
/** New tab via Ctrl+Shift+T, waiting for its shell prompt. Returns its id. */
async function openTab() {
  const before = (await wsState()).order.length;
  await page.keyboard.press('Control+Shift+T');
  await waitUntil(async () => (await wsState()).order.length >= before + 1, 5000);
  await sleep(150);
  const after = await wsState();
  if (after.order.length !== before + 1) {
    // Seen once (Fase 4, full run): an extra tab and no focus. Fail with evidence, not later.
    throw new Error(`Ctrl+Shift+T: ${before} → ${after.order.length} tabs (${after.order.join(',')}); ${await focusReport()}`);
  }
  await waitUntil(atShellPrompt, 20000);
  return (await wsState()).active;
}
/** The element's box once it stops moving (two equal measurements 100 ms apart). */
async function settledBox(selector) {
  let previous = await page.locator(selector).boundingBox();
  for (let i = 0; i < 15; i++) {
    await sleep(100);
    const current = await page.locator(selector).boundingBox();
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  return previous;
}
/** Drags with the real pointer (past dnd-kit's 6 px activation distance) and drops on `to`. */
async function drag(fromSelector, toSelector) {
  // The strip animates after every reorder (dnd-kit transitions): measure once it settles, or
  // the drop lands where a tab was a moment ago.
  const a = await settledBox(fromSelector);
  const b = await settledBox(toSelector);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 });
  await sleep(150);
  await page.mouse.up();
  await sleep(350);
}
/**
 * After a failed stage the terminal may be left anywhere (a half-typed line, vim, an agent).
 * Instead of sending keys to an unknown program, start over in a fresh tab and close the rest,
 * which also kills whatever the failed stage left running.
 */
async function isolateAfterFailure() {
  await page.evaluate(() => {
    const ui = window.__ui.getState();
    ui.closeMenu();
    ui.closeConfirm();
    ui.closeSearch();
    ui.stopRename();
    const s = window.__workspace.getState();
    const fresh = s.newTab({ cwd: null });
    s.closeTabs(s.tabOrder.filter((id) => id !== fresh));
  });
  await waitUntil(atShellPrompt, 20000);
}
/** Leaves only the active tab, closing the rest without confirmation dialogs. */
async function closeOtherTabsNow() {
  await page.evaluate(() => {
    const s = window.__workspace.getState();
    s.closeTabs(s.tabOrder.filter((id) => id !== s.activeTabId));
  });
  await sleep(300);
}
const groupMembers = (st, groupId) => st.order.filter((id) => st.tabs[id].groupId === groupId);
const contiguous = (st) =>
  Object.keys(st.groups).every((g) => {
    const at = st.order.map((id, i) => (st.tabs[id].groupId === g ? i : -1)).filter((i) => i >= 0);
    return at.length > 0 && at.at(-1) - at[0] + 1 === at.length;
  });

// ---------------------------------------------------------------- pane helpers
const leaves = (layout) => (layout.type === 'pane' ? [layout.paneId] : layout.children.flatMap(leaves));
const activeTab = async () => {
  const st = await wsState();
  return st.tabs[st.active];
};
const activePane = async () => (await activeTab()).activePaneId;
const paneSel = (id) => `[data-pane-id="${id}"]`;
const paneBox = (id) => page.locator(paneSel(id)).boundingBox();
const paneAttr = (id, name) => page.getAttribute(paneSel(id), name);
const paneSize = (id) =>
  page.evaluate((id) => {
    const t = window.__paneTerminal(id);
    return t ? `${t.cols}x${t.rows}` : null;
  }, id);
const paneMark = (id) => page.evaluate((id) => window.__paneTerminal(id)?.__e2eMark ?? null, id);
/** Clicks a pane (real pointer) so it becomes the active one and takes the keyboard. */
async function clickPane(id) {
  const box = await paneBox(id);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitUntil(async () => (await activePane()) === id, 3000);
  await waitUntil(terminalFocused, 3000);
}
/** The PTY size seen by the pane's own shell equals its xterm grid. */
async function ptyMatches(id) {
  await clickPane(id);
  await sleep(300);
  const pty = await ptySize();
  const grid = await paneSize(id);
  return { ok: pty === grid, detail: `pty ${pty} / xterm ${grid}` };
}
/** Starts from a single fresh tab in the home folder (closing the rest, without dialogs). */
async function freshTab() {
  await page.evaluate(() => {
    const s = window.__workspace.getState();
    const fresh = s.newTab({ cwd: null });
    s.closeTabs(s.tabOrder.filter((id) => id !== fresh));
  });
  await waitUntil(atShellPrompt, 20000);
  await waitUntil(terminalFocused, 3000);
}
async function waitPanes(count) {
  await waitUntil(async () => leaves((await activeTab()).layout).length === count, 5000);
  await waitUntil(atShellPrompt, 20000);
  await waitUntil(terminalFocused, 3000);
}

// ---------------------------------------------------------------- shell integration helpers
const paneState = (id) => page.evaluate((id) => window.__workspace.getState().panes[id] ?? null, id);
const homeDir = () => page.evaluate(() => window.__system.getState().homeDir);
/**
 * The pane's shell reported its integration and sits at its prompt (no command running). The
 * "loaded" mark comes before the first prompt (sometimes in another batch): the folder that
 * prompt reports (OSC 7) is the sign that the prompt is there.
 */
const idle = async (id) => {
  const p = await paneState(id);
  return !!p && p.status === 'running' && p.integration === 'ok' && !p.commandRunning && p.cwd !== null;
};
/**
 * Records the raw marks a terminal receives. Handlers added later run first; returning false
 * passes the sequence on to the app's own handler.
 */
const spy = (id) =>
  page.evaluate((id) => {
    const t = window.__paneTerminal(id);
    if (!t || t.__e2eSpy) return;
    const log = { osc7: [], ends: 0 };
    t.__e2eSpy = log;
    t.parser.registerOscHandler(7, (data) => (log.osc7.push(data), false));
    t.parser.registerOscHandler(133, (data) => {
      // D: the command finished (also when a redefined prompt is wrapped again).
      if (data.startsWith('D')) log.ends++;
      return false;
    });
  }, id);
const spied = (id) => page.evaluate((id) => window.__paneTerminal(id)?.__e2eSpy ?? null, id);
/**
 * The logical line the cursor is on (the prompt plus whatever is being typed), with the rows it
 * wraps over joined back. `id`: a pane; default the active one.
 */
const paneCursorLine = (id = null) =>
  page.evaluate((id) => {
    const b = (id ? window.__paneTerminal(id) : window.__terminal).buffer.active;
    const end = b.baseY + b.cursorY;
    let start = end;
    while (start > 0 && b.getLine(start)?.isWrapped) start--;
    let line = '';
    for (let y = start; y <= end; y++) line += b.getLine(y)?.translateToString(y === end) ?? '';
    return line.trimEnd();
  }, id);
const cursorLine = () => paneCursorLine();
/** The cursor line matches (waits a little: the prompt is drawn right after the end mark). */
const lineMatches = (re) => waitUntil(async () => re.test(await cursorLine()), 3000);
/**
 * Types a command when the shell integration says the shell is idle at its prompt (any prompt,
 * any shell) and waits for the next prompt. Refuses to type anywhere else, like `run`.
 */
async function runIdle(cmd, { wait = true, timeout = 20000 } = {}) {
  const id = await activePane();
  if (!(await waitUntil(() => idle(id), 20000))) {
    throw new Error(`la shell del panel ${id} no está libre según la integración; no se tipea: ${cmd}`);
  }
  if (!(await waitUntil(terminalFocused, 3000))) {
    throw new Error(`la terminal activa no tiene el foco (${await focusReport()}); no se tipea: ${cmd}`);
  }
  await spy(id);
  const before = (await spied(id)).ends;
  await page.keyboard.type(cmd);
  await page.keyboard.press('Enter');
  if (!wait) return paneState(id);
  if (!(await waitUntil(async () => (await spied(id)).ends > before && (await idle(id)), timeout))) {
    throw new Error(`timeout esperando el fin de: ${cmd}\n--- pantalla ---\n${await screen()}`);
  }
  // The end mark comes right before the prompt is drawn: wait for the prompt itself.
  await waitUntil(async () => (await cursorLine()).trim() !== '', 3000);
  return paneState(id);
}
/** A folder under the e2e temp dir, by its real long path (os.tmpdir() may use 8.3 names). */
function trickyDir(...parts) {
  const dir = path.join(WORK, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}
const PARENT_DIR = ['carpeta con espacios'];
const TRICKY_DIR = [...PARENT_DIR, 'Ñandú áéíóú'];
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
/**
 * cd into TRICKY_DIR typing only ASCII: the shell finds the accented folder itself (the only
 * one inside PARENT_DIR), so the test does not depend on how non-ASCII keys are typed.
 */
const cdTricky = () =>
  runIdle(`Set-Location -LiteralPath ((Get-ChildItem -LiteralPath ${psQuote(trickyDir(...PARENT_DIR))} -Directory)[0].FullName)`);
/** What the integration scripts send for a folder: file://<computer>/C:/a%20b/%C3%91... */
const fileUri = (dir) =>
  `file://${process.env.COMPUTERNAME}/${dir
    .split('\\')
    .filter(Boolean)
    .map((segment, i) => (i === 0 ? segment : encodeURIComponent(segment)))
    .join('/')}`;
const statusBar = () =>
  page.evaluate(() => {
    const q = (sel) => document.querySelector(`.status-bar ${sel}`);
    return {
      cwd: q('.status-cwd')?.textContent ?? null,
      cwdTitle: q('.status-cwd')?.getAttribute('title') ?? null,
      command: q('.status-command')?.textContent ?? null,
      commandState: q('.status-command')?.getAttribute('data-state') ?? null,
      notice: q('.status-notice')?.textContent ?? null,
      noticeTitle: q('.status-notice')?.getAttribute('title') ?? null,
      shell: q('.status-shell')?.textContent ?? null,
      git: q('.status-git')?.textContent ?? null,
    };
  });
const tabSubtitle = (id) =>
  page.evaluate((sel) => document.querySelector(sel)?.textContent ?? null, `${tabSel(id)} .tab-subtitle`);
/** A pane's buffer for failed checks: non-empty rows with their number, cursor, buffer kind. */
const paneText = (id, lines = 8) =>
  page.evaluate(
    ({ id, lines }) => {
      const t = window.__paneTerminal(id);
      const b = t?.buffer.active;
      if (!b) return '(sin terminal)';
      const rows = [];
      for (let y = 0; y < b.length && rows.length < lines; y++) {
        const text = b.getLine(y)?.translateToString(true) ?? '';
        if (text.trim()) rows.push(`${y}:${text}`);
      }
      return `${b.type} ${t.cols}x${t.rows} cursor ${b.cursorX},${b.baseY + b.cursorY} largo ${b.length} | ${rows.join(' ⏎ ')}`;
    },
    { id, lines },
  );
/** The pane's folder once its shell reported it. */
async function paneCwd(id, timeout = 20000) {
  await waitUntil(() => idle(id), timeout);
  return (await paneState(id))?.cwd ?? null;
}

// ---------------------------------------------------------------- explorer helpers
const RECYCLE = path.join(ROOT, 'e2e', 'recycle.ps1');
const explorerState = () =>
  page.evaluate(() => {
    const e = window.__explorer.getState();
    const sidebar = document.querySelector('.sidebar');
    return {
      visible: e.visible,
      width: e.width,
      pinned: e.pinned,
      showHidden: e.showHidden,
      watched: e.watched,
      notice: e.notice,
      root: sidebar?.dataset.root ?? null,
    };
  });
/** A value for a CSS attribute selector in double quotes (paths have backslashes). */
const attrValue = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const rowSel = (p) => `.tree-row[data-path="${attrValue(p)}"]`;
const hasRow = async (p) => (await page.locator(rowSel(p)).count()) > 0;
const rowAttr = (p, name) => page.locator(rowSel(p)).getAttribute(name, { timeout: 1000 }).catch(() => null);
const waitRow = (p, present = true, timeout = 8000) => waitUntil(async () => (await hasRow(p)) === present, timeout);
const waitRoot = (dir, timeout = 8000) =>
  waitUntil(async () => (await explorerState()).root?.toLowerCase() === dir.toLowerCase(), timeout);
const rowCount = async () => Number(await page.getAttribute('.file-tree', 'data-row-count'));
async function showExplorer() {
  if (!(await explorerState()).visible) await page.evaluate(() => window.__explorer.getState().toggleVisible());
  await page.waitForSelector('.sidebar', { timeout: 3000 });
}
/** Clicks a row's name (not the twisty): a folder means cd, a file means insert its path. */
async function clickRow(p) {
  const box = await page.locator(`${rowSel(p)} .tree-name`).boundingBox();
  await page.mouse.click(box.x + Math.min(8, box.width / 2), box.y + box.height / 2);
}
const toggleRow = (p) => page.click(`${rowSel(p)} .tree-twisty`);
const atEmptyPrompt = async (id) => /^PS [A-Za-z]:\\.*>\s*$/.test(await paneCursorLine(id));
/** Opens the explorer's context menu on a row and returns the actions it offers. */
async function rowMenu(p) {
  await page.click(rowSel(p), { button: 'right' });
  await page.waitForSelector('[role="menu"]', { timeout: 3000 });
  return page.$$eval('[role="menu"] [data-action]', (items) => items.map((item) => item.dataset.action));
}
/** Files inside TRICKY_DIR for the explorer stages (each stage can run on its own). */
function explorerFixture() {
  const dir = trickyDir(...TRICKY_DIR);
  const sub = path.join(dir, 'sub carpeta');
  const fixture = {
    dir,
    parent: trickyDir(...PARENT_DIR),
    file: path.join(dir, 'archivo con espacios.txt'),
    accented: path.join(dir, 'ñandú.md'),
    sub,
    inner: path.join(sub, 'dentro.txt'),
  };
  fs.mkdirSync(sub, { recursive: true });
  for (const file of [fixture.file, fixture.accented, fixture.inner]) fs.writeFileSync(file, 'x');
  return fixture;
}
/** Private memory (MB) of the app and its WebView2 processes, by role. */
function appMemory() {
  const script = `
$all = Get-CimInstance Win32_Process
$kids = @{}
foreach ($p in $all) { $kids[[int]$p.ParentProcessId] += ,$p }
function Get-Tree([int]$id) { foreach ($c in $kids[$id]) { $c; Get-Tree ([int]$c.ProcessId) } }
$out = @{ app = 0; renderer = 0; gpu = 0; browser = 0; otros = 0 }
foreach ($p in @($all | Where-Object ProcessId -eq ${appPid}) + @(Get-Tree ${appPid})) {
  $cmd = [string]$p.CommandLine
  $role = if ([int]$p.ProcessId -eq ${appPid}) { 'app' }
    elseif ($p.Name -ne 'msedgewebview2.exe') { $null }
    elseif ($cmd -match '--type=renderer') { 'renderer' }
    elseif ($cmd -match '--type=gpu-process') { 'gpu' }
    elseif ($cmd -notmatch '--type=') { 'browser' }
    else { 'otros' }
  if ($role) { $out[$role] += [math]::Round($p.PrivatePageCount / 1MB, 1) }
}
$out | ConvertTo-Json -Compress`;
  return JSON.parse(powershell(script));
}

/** node.exe linked under an agent's name: runs the fake agent and looks like the real one. */
function agentExe(name) {
  const dir = path.join(WORK, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, `${name}.exe`);
  if (!fs.existsSync(exe)) {
    try {
      fs.linkSync(process.execPath, exe);
    } catch {
      fs.copyFileSync(process.execPath, exe);
    }
  }
  return exe;
}

// ---------------------------------------------------------------- stages
const stages = {
  async startup() {
    await waitFor(/PS [A-Za-z]:\\.*>/, { timeout: 30000 });
    const dom = await page.evaluate(() => ({
      canvas: document.querySelectorAll('.xterm-screen canvas').length,
      domRows: document.querySelectorAll('.xterm-rows > div').length,
    }));
    check('arranca la shell con prompt', true);
    check('renderer WebGL activo', dom.canvas > 0 && dom.domRows === 0, JSON.stringify(dom));
    const info = await termInfo();
    check(
      'windowsPty = conpty + build',
      info.windowsPty?.backend === 'conpty' && info.windowsPty.buildNumber > 21376,
      JSON.stringify(info.windowsPty),
    );
    const shell = await value('(Get-Process -Id $PID).Path', 'shell');
    check('shell es pwsh o powershell.exe', /\\(pwsh|powershell)\.exe$/i.test(shell ?? ''), shell);
    check('COLORTERM=truecolor', (await value('$env:COLORTERM', 'colorterm')) === 'truecolor');
    const cwd = await value('$PWD', 'cwd');
    check('cwd inicial = USERPROFILE', cwd?.toLowerCase() === process.env.USERPROFILE.toLowerCase(), cwd);
    const size = await ptySize();
    check('tamaño PTY == tamaño xterm', size === `${info.cols}x${info.rows}`, `pty ${size} / xterm ${info.cols}x${info.rows}`);
    await shot('01-startup');
  },

  async colors() {
    await page.evaluate(() => window.__terminal.clear());
    await run(
      "Write-Host ('ro'+'jo') -ForegroundColor Red; Write-Host ('ver'+'de') -ForegroundColor Green; " +
        "Write-Output ([char]27 + '[38;2;255;100;0m' + 'naranja' + '-tc' + [char]27 + '[0m'); " +
        "Write-Output ([char]27 + '[1;4;3m' + 'negrita' + '-sub' + [char]27 + '[0m'); " +
        "0..15 | % { Write-Host -NoNewline (' {0,2} ' -f $_) -BackgroundColor ([ConsoleColor]$_) }; Write-Host ''",
    );
    const cells = await page.evaluate(() => {
      const b = window.__terminal.buffer.active;
      const find = (word) => {
        for (let i = b.length - 1; i >= 0; i--) {
          const line = b.getLine(i);
          const x = line.translateToString(true).indexOf(word);
          if (x >= 0) {
            const c = line.getCell(x);
            return { palette: c.isFgPalette(), rgb: c.isFgRGB(), color: c.getFgColor(), bold: !!c.isBold(), underline: !!c.isUnderline(), italic: !!c.isItalic() };
          }
        }
        return null;
      };
      return { rojo: find('rojo'), verde: find('verde'), naranja: find('naranja-tc'), negrita: find('negrita-sub') };
    });
    check('rojo (16 colores)', cells.rojo?.palette && [1, 9].includes(cells.rojo.color), JSON.stringify(cells.rojo));
    check('verde (16 colores)', cells.verde?.palette && [2, 10].includes(cells.verde.color), JSON.stringify(cells.verde));
    check('truecolor #ff6400', cells.naranja?.rgb && cells.naranja.color === 0xff6400, JSON.stringify(cells.naranja));
    check('negrita/subrayado/itálica', !!(cells.negrita?.bold && cells.negrita.underline && cells.negrita.italic));
    await shot('02-colors');
  },

  async ctrlc() {
    await page.evaluate(() => window.__terminal.clearSelection());
    const before = prompts(await text());
    await run('ping -t 127.0.0.1', { waitPrompt: false });
    await waitFor((s) => count(s, 'TTL=') >= 2);
    await page.keyboard.press('Control+c');
    const s = await waitFor((s) => prompts(s) > before, { timeout: 10000 });
    check('Ctrl+C sin selección interrumpe ping -t', s.includes('Control-C'));
  },

  async clipboard() {
    await run("'copia' + 'me-' + (6*7)");
    const selected = await page.evaluate(() => {
      const t = window.__terminal;
      const b = t.buffer.active;
      for (let i = b.length - 1; i >= 0; i--) {
        const x = b.getLine(i).translateToString(true).indexOf('copiame-42');
        if (x >= 0) {
          t.select(x, i, 'copiame-42'.length);
          return t.getSelection();
        }
      }
      return null;
    });
    const promptsBefore = prompts(await text());
    await page.keyboard.press('Control+c');
    await sleep(300);
    const after = await text();
    const hasSelection = await page.evaluate(() => window.__terminal.hasSelection());
    check('Ctrl+C con selección copia (no envía ^C)', selected === 'copiame-42' && !hasSelection && prompts(after) === promptsBefore);

    const pasteWith = async (label, gesture) => {
      const before = await text();
      await page.keyboard.type('echo ');
      await gesture();
      await sleep(500);
      await page.keyboard.press('Enter');
      const s = await waitFor((x) => prompts(x) > prompts(before), { timeout: 10000 });
      check(label, count(s, 'copiame-42') >= count(before, 'copiame-42') + 2);
    };
    await pasteWith('Ctrl+V pega lo copiado', () => page.keyboard.press('Control+v'));
    await pasteWith('Shift+Insert pega', () => page.keyboard.press('Shift+Insert'));
    await pasteWith('clic derecho sin selección pega', async () => {
      const box = await page.locator('.terminal-pane:not([hidden])').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    });
  },

  async search() {
    await run("'busca' + 'me-' + 'x'");
    await page.keyboard.press('Control+Shift+F');
    await page.waitForSelector('.search-bar input', { timeout: 3000 });
    await page.keyboard.type('buscame');
    await sleep(300);
    const summary = await page.textContent('.search-summary');
    await shot('03-search');
    await page.keyboard.press('Escape');
    await sleep(200);
    const state = await page.evaluate(() => ({
      open: !!document.querySelector('.search-bar'),
      focus: document.activeElement?.classList.contains('xterm-helper-textarea'),
    }));
    check('búsqueda encuentra resultados', /\d+ de \d+/.test(summary ?? ''), summary);
    check('Esc cierra la búsqueda y devuelve el foco', !state.open && state.focus, state.open || !state.focus ? await focusReport() : '');
  },

  async resize() {
    const start = await termInfo();
    await page.keyboard.press('Control+=');
    await page.keyboard.press('Control+=');
    await sleep(500);
    const zoomed = await termInfo();
    const zoomedPty = await ptySize();
    check('zoom cambia fuente y re-ajusta el grid', zoomed.fontSize === start.fontSize + 2 && zoomed.cols < start.cols, `${start.fontSize}->${zoomed.fontSize}, cols ${start.cols}->${zoomed.cols}`);
    check('PTY sigue al zoom', zoomedPty === `${zoomed.cols}x${zoomed.rows}`, `pty ${zoomedPty}`);
    await page.keyboard.press('Control+0');
    await sleep(300);

    win('resize', appPid, 820, 520);
    await sleep(800);
    const small = await termInfo();
    const smallPty = await ptySize();
    check('resize de ventana achica el grid', small.cols < start.cols && small.rows < start.rows, `${start.cols}x${start.rows} -> ${small.cols}x${small.rows}`);
    check('PTY sigue al resize de ventana', smallPty === `${small.cols}x${small.rows}`, `pty ${smallPty}`);
    win('resize', appPid, 1100, 700);
    await sleep(800);
    const big = await termInfo();
    const bigPty = await ptySize();
    check('PTY sigue al agrandar', bigPty === `${big.cols}x${big.rows}`, `pty ${bigPty}`);
  },

  async vim() {
    if (!fs.existsSync(path.join(GIT_BIN, 'vim.exe'))) return skip('vim', 'no está Git for Windows');
    const file = path.join(WORK, 'vim-test.txt');
    await run(`Set-Location '${WORK}'`);
    await run(`& '${GIT_BIN}\\vim.exe' vim-test.txt`, { waitPrompt: false });
    await waitUntil(async () => (await bufferType()) === 'alternate');
    await waitFor(/~\s*\n~/, { source: screen, timeout: 10000 });
    const alt = await bufferType();
    await page.keyboard.press('i');
    await page.keyboard.type('hola desde vim');
    await page.keyboard.press('Escape');
    await sleep(200);
    await shot('04-vim');
    await page.keyboard.type(':wq');
    await page.keyboard.press('Enter');
    await waitUntil(async () => (await bufferType()) === 'normal');
    await waitUntil(atShellPrompt);
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(no existe)';
    check('vim: pantalla alternativa', alt === 'alternate', alt);
    check('vim: edita y guarda', content.trim() === 'hola desde vim', JSON.stringify(content));
  },

  async nano() {
    if (!fs.existsSync(path.join(GIT_BIN, 'nano.exe'))) return skip('nano', 'no está Git for Windows');
    const file = path.join(WORK, 'nano-test.txt');
    await run(`Set-Location '${WORK}'`);
    // Relative name: MSYS2 nano mishandles absolute Windows paths when saving.
    await run(`& '${GIT_BIN}\\nano.exe' nano-test.txt`, { waitPrompt: false });
    try {
      await waitFor('GNU nano', { source: screen, timeout: 10000 });
      await page.keyboard.type('hola desde nano');
      await shot('05-nano');
      await page.keyboard.press('Control+o');
      await waitFor(/File Name to Write|Write to File|Nombre del archivo/i, { source: screen, timeout: 5000 });
      await page.keyboard.press('Enter');
      await waitFor(/Wrote|Escrit/i, { source: screen, timeout: 5000 });
      await page.keyboard.press('Control+x');
    } finally {
      if (!(await waitUntil(atShellPrompt, 5000))) {
        await page.keyboard.press('Control+c');
        await page.keyboard.press('Control+x');
        await page.keyboard.press('n');
      }
    }
    await waitUntil(atShellPrompt);
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(no existe)';
    check('nano: edita y guarda (Ctrl+O, Ctrl+X)', content.trim() === 'hola desde nano', JSON.stringify(content));
  },

  async agent() {
    // A fake agent (never a real one): checks that a raw-mode TUI renders, takes input,
    // receives multi-line pastes as one input and exits with Ctrl+C twice.
    await run(`& '${agentExe('claude')}' '${FAKE_AGENT}'`, { waitPrompt: false });
    try {
      await waitFor('FAKE-AGENT claude listo', { source: screen });
      await page.keyboard.type('hola agente');
      await page.keyboard.press('Enter');
      await waitFor('SUBMIT "hola agente"', { source: screen });
      check('agente falso: recibe input y Enter envía', true);

      await setClipboard('linea uno\nlinea dos');
      await page.keyboard.press('Control+v');
      await sleep(500);
      await page.keyboard.press('Enter');
      const pasted = await waitFor('SUBMIT "linea uno\\nlinea dos"', { source: screen, timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      check('agente falso: pegado multilínea llega como un solo input', pasted);
      await shot('06-agent');
    } finally {
      check('agente falso: Ctrl+C dos veces sale al prompt', await exitToPrompt());
    }
  },

  async shiftenter() {
    // PowerShell: Shift+Enter is PSReadLine's AddLine (continuation ">>", one single input).
    if (!(await waitUntil(atShellPrompt, 5000))) throw new Error('sin prompt de PowerShell');
    const before = prompts(await text());
    await page.keyboard.type("'uno'");
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type("'dos'");
    await page.keyboard.press('Enter');
    await waitFor((s) => prompts(s) > before, { timeout: 10000 });
    await sleep(500);
    const s = await text();
    check(
      'Shift+Enter en PowerShell agrega línea (AddLine) y ejecuta todo junto',
      /^>> 'dos'/m.test(s) && /^uno\ndos$/m.test(s) && prompts(s) === before + 1,
      `prompts nuevos: ${prompts(s) - before}`,
    );

    // Fake agents: each gets the newline sequence its own /terminal-setup would install.
    for (const agent of ['claude', 'gemini']) {
      // The "agent" stage may have left an older "listo" in the buffer: wait for a new one, or
      // the keys go out before this agent is in raw mode.
      const ready = `FAKE-AGENT ${agent} listo`;
      const readyBefore = count(await text(), ready);
      await run(`& '${agentExe(agent)}' '${FAKE_AGENT}'`, { waitPrompt: false });
      try {
        await waitFor((s) => count(s, ready) > readyBefore);
        await page.keyboard.type('hola');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('mundo');
        await page.keyboard.press('Enter');
        // Wait for the exact text: older SUBMIT lines may still be on screen.
        const ok = await waitFor('SUBMIT "hola\\nmundo"', { source: screen, timeout: 8000 })
          .then(() => true)
          .catch(() => false);
        check(`Shift+Enter en ${agent} (falso) inserta salto de línea`, ok);
        if (agent === 'claude') await shot('07-shift-enter-agent');
      } finally {
        await exitToPrompt();
      }
    }
  },

  async tabs() {
    await closeOtherTabsNow();
    const first = (await wsState()).active;
    await run("'marca-' + 'tab1'");
    await page.evaluate(() => (window.__terminal.__e2eMark = 'tab1'));

    const second = await openTab();
    check('Ctrl+Shift+T abre una tab nueva y la activa', second !== first && (await wsState()).order.at(-1) === second);
    await page.click('.tab-new');
    await waitUntil(async () => (await wsState()).order.length === 3, 5000);
    await waitUntil(atShellPrompt, 20000);
    const st = await wsState();
    const third = st.active;
    check('el botón + abre otra tab', st.order.length === 3 && third !== second);

    const dom = await page.evaluate(() => ({
      panes: document.querySelectorAll('.terminal-pane').length,
      hidden: document.querySelectorAll('.terminal-pane[hidden]').length,
      xterms: document.querySelectorAll('.terminal-pane .xterm').length,
    }));
    check('todas las terminales siguen montadas; las inactivas, ocultas', dom.panes === 3 && dom.xterms === 3 && dom.hidden === 2, JSON.stringify(dom));

    const activeAfter = async (key) => {
      await page.keyboard.press(key);
      await sleep(150);
      return (await wsState()).active;
    };
    check('Ctrl+1 salta a la primera tab', (await activeAfter('Control+1')) === first);
    check('Ctrl+Tab va a la siguiente', (await activeAfter('Control+Tab')) === second);
    check('Ctrl+Shift+Tab vuelve a la anterior', (await activeAfter('Control+Shift+Tab')) === first);
    check('Ctrl+Shift+Tab da la vuelta al final', (await activeAfter('Control+Shift+Tab')) === third);
    check('Ctrl+9 va a la última', (await activeAfter('Control+9')) === third);

    // Same xterm instance and buffer after switching away and back.
    await activeAfter('Control+1');
    const kept = await page.evaluate(() => window.__terminal.__e2eMark);
    check('volver a la tab conserva la instancia y el scrollback', kept === 'tab1' && (await text()).includes('marca-tab1'));

    // A hidden tab is refit when shown again.
    await activeAfter('Control+9');
    const big = await termInfo();
    win('resize', appPid, 900, 560);
    await sleep(700);
    await activeAfter('Control+1');
    await sleep(500);
    const shown = await termInfo();
    const pty = await ptySize();
    check('al mostrarse hace fit() y redimensiona el PTY', shown.cols < big.cols && pty === `${shown.cols}x${shown.rows}`, `${big.cols}x${big.rows} -> ${shown.cols}x${shown.rows}, pty ${pty}`);
    win('resize', appPid, 1100, 700);
    await sleep(700);

    // Rename by double click; process titles (OSC 0/2) no longer change it.
    await page.dblclick(tabSel(first));
    await page.fill(`${tabSel(first)} .rename-input`, 'Mi tab');
    await page.keyboard.press('Enter');
    check('doble clic + Enter renombra', (await tabLabel(first)) === 'Mi tab');
    await waitUntil(atShellPrompt);
    await run("$Host.UI.RawUI.WindowTitle = 'titulo-' + 'proceso'");
    await sleep(300);
    check('un título del proceso no pisa el nombre puesto a mano', (await tabLabel(first)) === 'Mi tab');

    await activeAfter('Control+2');
    await run("$Host.UI.RawUI.WindowTitle = 'otro-' + 'titulo'");
    await waitUntil(async () => (await tabLabel(second)) === 'otro-titulo', 3000);
    check('sin renombrar, la tab sigue el título OSC del proceso', (await tabLabel(second)) === 'otro-titulo');
    await page.keyboard.press('F2');
    await page.keyboard.type('descartado');
    await page.keyboard.press('Escape');
    check('F2 + Escape cancela', (await tabLabel(second)) === 'otro-titulo');

    await activeAfter('Control+1');
    await page.keyboard.press('F2');
    await page.fill(`${tabSel(first)} .rename-input`, '');
    await page.keyboard.press('Enter');
    check('renombrar a vacío vuelve al título del proceso', (await tabLabel(first)) === 'titulo-proceso');

    // Activity: output in a tab that is not visible.
    await run("Start-Sleep -Milliseconds 1500; 'salida-' + 'tardia'", { waitPrompt: false });
    await activeAfter('Control+2');
    const marked = await waitUntil(async () => (await tabAttr(first, 'data-indicator')) === 'activity', 6000);
    check('salida en una tab oculta muestra el punto de actividad', marked);
    await activeAfter('Control+1');
    check('mostrar la tab limpia el indicador', (await tabAttr(first, 'data-indicator')) === null);
    await waitUntil(atShellPrompt);

    // Exited process: a distinct indicator (red ring for a non-zero code).
    await activeAfter('Control+9');
    await run('exit 5', { waitPrompt: false });
    const exited = await waitUntil(async () => (await tabAttr(third, 'data-indicator')) === 'exited-error', 8000);
    check('proceso terminado con error: indicador distinto', exited);
    await page.keyboard.press('Enter'); // restart the shell in that tab
    await waitUntil(atShellPrompt, 20000);
    await shot('07-tabs');
    await closeOtherTabsNow();
  },

  async tabmenu() {
    await closeOtherTabsNow();
    const a = (await wsState()).active;
    const b = await openTab();
    const c = await openTab();

    await drag(tabSel(a), tabSel(c));
    const reordered = (await wsState()).order;
    check('arrastrar reordena las tabs', JSON.stringify(reordered) === JSON.stringify([b, c, a]), reordered.join(','));

    await page.click(tabSel(b), { button: 'right' });
    await page.waitForSelector('[role="menu"]');
    const items = await page.$$eval('[role="menu"] [data-action]', (els) => els.map((e) => e.dataset.action));
    check('menú contextual con las acciones pedidas', ['rename', 'duplicate', 'new-group', 'close', 'close-others'].every((x) => items.includes(x)) && (await page.$$('[role="menu"] .swatch')).length > 0, items.join(','));
    await page.click('[role="menu"] .swatch[data-color="green"]');
    check('cambiar color', (await tabAttr(b, 'data-color')) === 'green');

    await page.click(tabSel(b), { button: 'right' });
    await page.click('[role="menu"] [data-action="duplicate"]');
    await waitUntil(atShellPrompt, 20000);
    const st = await wsState();
    const dup = st.active;
    check('duplicar: tab nueva al lado, mismo color', st.order.indexOf(dup) === st.order.indexOf(b) + 1 && st.tabs[dup].color === 'green');

    // Closing a tab with a running program asks first.
    const ping = Number(await value("(Start-Process ping -ArgumentList '-n','300','127.0.0.1' -WindowStyle Hidden -PassThru).Id", 'ping'));
    await page.keyboard.press('Control+Shift+W');
    const dialog = await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 }).catch(() => null);
    const detail = dialog ? await dialog.textContent() : '';
    check('Ctrl+Shift+W con un proceso corriendo pide confirmación', !!dialog && /ping\.exe/i.test(detail), detail.slice(0, 120));
    await shot('08-confirm');
    await page.keyboard.press('Escape');
    await sleep(300);
    check('cancelar deja la tab y el proceso', (await wsState()).tabs[dup] !== undefined && alive(ping));
    await page.keyboard.press('Control+Shift+W');
    await page.click('[role="alertdialog"] [data-action="confirm"]');
    await waitUntil(async () => !alive(ping), 5000);
    check('confirmar cierra la tab y mata el proceso', (await wsState()).tabs[dup] === undefined && !alive(ping));

    // An idle shell closes without asking (close button).
    await page.hover(tabSel(c));
    await page.click(`${tabSel(c)} .tab-close`);
    await sleep(500);
    check('tab ociosa se cierra sin preguntar', !(await page.$('[role="alertdialog"]')) && (await wsState()).tabs[c] === undefined);

    // Windowed apps survive closing their tab (selective teardown) and do not trigger the dialog.
    if (fs.existsSync('C:\\Windows\\System32\\charmap.exe')) {
      await page.click(tabSel(a));
      await waitUntil(atShellPrompt);
      const app = Number(
        await value(
          '$( $v = Start-Process charmap -PassThru; $n = 0; while ((Get-Process -Id $v.Id).MainWindowHandle -eq 0 -and $n -lt 100) { Start-Sleep -Milliseconds 100; $n++ }; $v.Id )',
          'app',
        ),
      );
      const shell = await shellPid();
      await page.keyboard.press('Control+Shift+W');
      await sleep(1000);
      const asked = !!(await page.$('[role="alertdialog"]'));
      check('cerrar tab: sin diálogo si solo hay una app con ventana', !asked && (await wsState()).tabs[a] === undefined);
      const charmaps = powershell("(Get-Process charmap -ErrorAction SilentlyContinue).Id -join ','");
      check('cerrar tab: la shell muere y la app con ventana sobrevive', !alive(shell) && alive(app), `shell viva=${alive(shell)} app=${app} viva=${alive(app)} charmaps vivos=[${charmaps}]`);
      if (alive(app)) process.kill(app);
    } else skip('apps con ventana', 'no está charmap.exe');

    await openTab();
    await page.click(tabSel((await wsState()).order[0]), { button: 'right' });
    await page.click('[role="menu"] [data-action="close-others"]');
    await sleep(600);
    check('cerrar las demás', (await wsState()).order.length === 1);
  },

  async groups() {
    await closeOtherTabsNow();
    const a = (await wsState()).active;
    const b = await openTab();
    const c = await openTab();
    const d = await openTab();

    await page.keyboard.press('Control+Shift+G');
    await page.waitForSelector('.group-chip .rename-input');
    await page.fill('.group-chip .rename-input', 'Backend');
    await page.keyboard.press('Enter');
    let st = await wsState();
    const g = st.tabs[d].groupId;
    check('Ctrl+Shift+G crea un grupo con la tab actual', !!g && (await page.textContent(`[data-group-chip="${g}"]`)).includes('Backend'));
    await shot('09-group');

    await page.click(tabSel(b), { button: 'right' });
    await page.click(`[role="menu"] [data-action="move-to-group"][data-group-id="${g}"]`);
    st = await wsState();
    check('menú: mover a grupo', JSON.stringify(groupMembers(st, g)) === JSON.stringify([d, b]) && contiguous(st), st.order.join(','));

    await drag(tabSel(a), `[data-group-chip="${g}"]`);
    st = await wsState();
    check('arrastrar sobre el chip mete la tab en el grupo', st.tabs[a].groupId === g && contiguous(st), st.order.join(','));

    // Out: drop a member over the first tab of the strip, which is not grouped (c).
    const member = groupMembers(st, g).at(-1);
    await drag(tabSel(member), tabSel(st.order[0]));
    st = await wsState();
    check('arrastrar fuera del grupo la saca', st.tabs[member].groupId === null && contiguous(st), st.order.join(','));

    // In: coming from the left, dropping over the first member lands between the two members.
    const [m1, m2] = groupMembers(st, g);
    await drag(tabSel(member), tabSel(m1));
    st = await wsState();
    const at = st.order.indexOf(member);
    check(
      'arrastrar entre dos tabs del grupo la mete',
      st.tabs[member].groupId === g && contiguous(st) && st.order.indexOf(m1) < at && at < st.order.indexOf(m2),
      st.order.join(','),
    );

    // Collapse / expand with the chip.
    await page.click(tabSel(c));
    await page.click(`[data-group-chip="${g}"]`);
    await sleep(300);
    st = await wsState();
    const hiddenTabs = await page.$$eval('[data-tab-id]', (els) => els.map((e) => e.dataset.tabId));
    check(
      'colapsar oculta las tabs del grupo y muestra la cantidad',
      st.groups[g].collapsed && groupMembers(st, g).every((id) => !hiddenTabs.includes(id)) &&
        (await page.textContent(`[data-group-chip="${g}"] .group-count`)) === String(groupMembers(st, g).length),
    );
    await page.keyboard.press(`Control+${st.order.indexOf(groupMembers(st, g)[0]) + 1}`);
    await sleep(300);
    st = await wsState();
    check('saltar a una tab de un grupo colapsado lo expande', !st.groups[g].collapsed && st.tabs[st.active].groupId === g);

    await page.click(`[data-group-chip="${g}"]`, { button: 'right' });
    await page.click('[role="menu"] .swatch[data-color="red"]');
    check('cambiar color del grupo', (await page.getAttribute(`[data-group-chip="${g}"]`, 'data-color')) === 'red');
    await page.click(`[data-group-chip="${g}"]`, { button: 'right' });
    await page.click('[role="menu"] [data-action="ungroup"]');
    st = await wsState();
    check('desagrupar', !st.groups[g] && !(await page.$(`[data-group-chip="${g}"]`)));
    await closeOtherTabsNow();
  },

  async panes() {
    await freshTab();
    const p1 = await activePane();
    await page.evaluate((id) => (window.__paneTerminal(id).__e2eMark = 'p1'), p1);

    await page.keyboard.press('Alt+Shift+D');
    await waitPanes(2);
    const p2 = await activePane();
    let tab = await activeTab();
    const [b1, b2] = [await paneBox(p1), await paneBox(p2)];
    check(
      'Alt+Shift+D divide a la derecha y enfoca el panel nuevo',
      tab.layout.direction === 'horizontal' && JSON.stringify(leaves(tab.layout)) === JSON.stringify([p1, p2]) &&
        b2.x >= b1.x + b1.width && Math.abs(b1.height - b2.height) < 2,
    );
    check('dividir no recrea la terminal existente', (await paneMark(p1)) === 'p1');
    check('borde resaltado solo en el panel activo', (await paneAttr(p2, 'data-focused')) !== null && (await paneAttr(p1, 'data-focused')) === null);
    let pty = await ptyMatches(p2);
    check('PTY del panel nuevo = su tamaño', pty.ok, pty.detail);

    await page.keyboard.press('Alt+ArrowLeft');
    check('Alt+Izquierda enfoca el panel de la izquierda', (await activePane()) === p1);
    pty = await ptyMatches(p1);
    check('PTY del panel izquierdo = su tamaño (achicado)', pty.ok, pty.detail);

    await page.keyboard.press('Alt+Shift+Minus');
    await waitPanes(3);
    const p3 = await activePane();
    tab = await activeTab();
    const [c1, c3] = [await paneBox(p1), await paneBox(p3)];
    check(
      'Alt+Shift+- divide hacia abajo (anidado)',
      JSON.stringify(leaves(tab.layout)) === JSON.stringify([p1, p3, p2]) && tab.layout.children[0].direction === 'vertical' &&
        c3.y >= c1.y + c1.height && Math.abs(c1.x - c3.x) < 2,
    );

    const moves = [];
    for (const [key, want] of [['Alt+ArrowUp', p1], ['Alt+ArrowRight', p2], ['Alt+ArrowLeft', p1], ['Alt+ArrowDown', p3]]) {
      await page.keyboard.press(key);
      await sleep(100);
      moves.push((await activePane()) === want);
    }
    check('Alt+flechas mueven el foco según la posición en pantalla', moves.every(Boolean), moves.join(','));
    await clickPane(p2);
    check('clic en un panel lo enfoca', (await activePane()) === p2 && (await paneAttr(p2, 'data-focused')) !== null);

    // Divider: drag the root boundary 200 px to the left.
    const rootDivider = `[data-split-id="${tab.layout.id}"][data-index="0"]`;
    const before = await paneSize(p2);
    const d = await page.locator(rootDivider).boundingBox();
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
    await page.mouse.down();
    await page.mouse.move(d.x + d.width / 2 - 200, d.y + d.height / 2, { steps: 12 });
    await page.mouse.up();
    await sleep(500);
    tab = await activeTab();
    const after = await paneSize(p2);
    check('arrastrar el divisor cambia los tamaños', tab.layout.sizes[0] < 42 && Number(after.split('x')[0]) > Number(before.split('x')[0]), `${before} -> ${after}, sizes ${tab.layout.sizes.map(Math.round)}`);
    pty = await ptyMatches(p2);
    check('PTY sigue al divisor', pty.ok, pty.detail);
    await page.dblclick(rootDivider);
    await sleep(300);
    tab = await activeTab();
    check('doble clic en el divisor reparte en partes iguales', tab.layout.sizes.every((s) => Math.abs(s - 50) < 0.01));

    // Zoom.
    await clickPane(p2);
    const normal = await paneSize(p2);
    await page.keyboard.press('Control+Shift+Z');
    await sleep(500);
    tab = await activeTab();
    const zoomedHidden = (await paneAttr(p1, 'hidden')) !== null && (await paneAttr(p3, 'hidden')) !== null;
    const zoomed = await paneSize(p2);
    check('Ctrl+Shift+Z maximiza el panel activo', tab.zoomedPaneId === p2 && zoomedHidden && Number(zoomed.split('x')[0]) > Number(normal.split('x')[0]), `${normal} -> ${zoomed}`);
    pty = await ptyMatches(p2);
    check('PTY sigue al zoom', pty.ok, pty.detail);
    check('WebGL solo en lo visible (zoom): el resto suelta su contexto', (await paneAttr(p2, 'data-renderer')) === 'webgl' && (await paneAttr(p1, 'data-renderer')) === 'dom' && (await paneAttr(p3, 'data-renderer')) === 'dom');
    await page.keyboard.press('Control+Shift+Z');
    await sleep(500);
    check('Ctrl+Shift+Z restaura los paneles', (await activeTab()).zoomedPaneId === null && (await paneAttr(p1, 'hidden')) === null && (await paneAttr(p1, 'data-renderer')) === 'webgl');
    check('zoom y divisores no recrean terminales', (await paneMark(p1)) === 'p1');

    // The tab title follows the active pane.
    const tabId = (await wsState()).active;
    await clickPane(p1);
    await run("$Host.UI.RawUI.WindowTitle = 'tit-' + 'p1'");
    await clickPane(p2);
    await run("$Host.UI.RawUI.WindowTitle = 'tit-' + 'p2'");
    await waitUntil(async () => (await tabLabel(tabId)) === 'tit-p2', 3000);
    const withP2 = await tabLabel(tabId);
    await page.keyboard.press('Alt+ArrowLeft');
    await waitUntil(async () => (await tabLabel(tabId)) === 'tit-p1', 3000);
    check('el título de la tab sigue al panel activo', withP2 === 'tit-p2' && (await tabLabel(tabId)) === 'tit-p1');

    // Activity from a pane that is not the active one, while the tab is hidden.
    await clickPane(p1);
    await run("Start-Sleep -Milliseconds 1500; 'salida-' + 'p1'", { waitPrompt: false });
    await clickPane(p2);
    const other = await openTab();
    const marked = await waitUntil(async () => (await tabAttr(tabId, 'data-indicator')) === 'activity', 6000);
    check('la actividad de cualquier panel marca la tab', marked);
    await page.click(tabSel(tabId));
    await sleep(300);
    check('mostrar la tab limpia la marca', (await tabAttr(tabId, 'data-indicator')) === null);
    await page.evaluate((id) => window.__workspace.getState().closeTabs([id]), other);
    await waitUntil(atShellPrompt);

    // Closing panes: the sibling takes the space, terminals survive.
    await clickPane(p3);
    const tall = await paneBox(p1);
    await page.keyboard.press('Control+Shift+W');
    await waitUntil(async () => leaves((await activeTab()).layout).length === 2, 5000);
    tab = await activeTab();
    const grown = await paneBox(p1);
    check('cerrar un panel: el hermano ocupa su espacio', JSON.stringify(leaves(tab.layout)) === JSON.stringify([p1, p2]) && grown.height > tall.height * 1.8 && tab.activePaneId === p1);
    check('cerrar un panel no recrea las demás terminales', (await paneMark(p1)) === 'p1');
    pty = await ptyMatches(p1);
    check('PTY del hermano agrandado = su tamaño', pty.ok, pty.detail);

    await clickPane(p2);
    const ping = Number(await value("(Start-Process ping -ArgumentList '-n','300','127.0.0.1' -WindowStyle Hidden -PassThru).Id", 'ping'));
    await page.keyboard.press('Control+Shift+W');
    const dialog = await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 }).catch(() => null);
    const title = dialog ? await page.textContent('#confirm-title') : '';
    check('cerrar un panel con un proceso pide confirmación', title === '¿Cerrar el panel?');
    await page.click('[role="alertdialog"] [data-action="confirm"]');
    await waitUntil(async () => !alive(ping), 5000);
    tab = await activeTab();
    check('confirmar cierra el panel y mata su proceso', tab.layout.type === 'pane' && tab.layout.paneId === p1 && !alive(ping));

    const tabsBefore = (await wsState()).order.length;
    await openTab();
    await page.keyboard.press('Control+Shift+W');
    await waitUntil(async () => (await wsState()).order.length === tabsBefore, 5000);
    check('Ctrl+Shift+W en el último panel cierra la tab', (await wsState()).order.length === tabsBefore);
    await shot('10-panes');
  },

  // ------------------------------------------------------------ shell integration (Fase 4)
  async cwd() {
    await freshTab();
    const tabId = (await wsState()).active;
    const id = await activePane();
    const ready = await waitUntil(() => idle(id), 20000);
    let st = await paneState(id);
    check(
      'PowerShell carga la integración (sin -NoProfile: el perfil carga como siempre)',
      ready && st.shell === 'powershell' && (await value("[string]([Environment]::GetCommandLineArgs() -contains '-NoProfile')", 'np')) === 'False',
      JSON.stringify({ integration: st.integration, error: st.integrationError }),
    );
    // A new tab starts in the active pane's folder, so it can start anywhere: go home first.
    const home = await homeDir();
    st = await runIdle(`Set-Location -LiteralPath ${psQuote(home)}`);
    check('el cwd del panel es la carpeta de la shell', st.cwd === home, `${st.cwd} / ${home}`);

    const parent = trickyDir(...PARENT_DIR);
    const dir = trickyDir(...TRICKY_DIR);
    st = await cdTricky();
    check('cd a una ruta con espacios, tildes y ñ actualiza el cwd del panel', st.cwd === dir, `${st.cwd} / ${dir}`);
    const raw = (await spied(id)).osc7.at(-1);
    check('OSC 7: file:// URI con UTF-8 codificado (%20, %C3%91...)', raw === fileUri(dir), `${raw}\nesperado ${fileUri(dir)}`);

    const bar = await statusBar();
    const underHome = dir.toLowerCase().startsWith(`${home.toLowerCase()}\\`);
    check(
      'status bar: cwd acortado (~ y …) con la ruta completa en el tooltip',
      bar.cwdTitle === dir && bar.cwd.endsWith('Ñandú áéíóú') && (!underHome || bar.cwd.startsWith('~\\')) && bar.cwd.length < dir.length,
      JSON.stringify(bar),
    );
    win('resize', appPid, 640, 560);
    await sleep(700);
    const narrow = await statusBar();
    check(
      'ventana angosta: el cwd se colapsa en el medio (…) y conserva la carpeta',
      narrow.cwd.includes('…') && narrow.cwd.endsWith('Ñandú áéíóú') && narrow.cwdTitle === dir,
      narrow.cwd,
    );
    win('resize', appPid, 1100, 700);
    await sleep(700);
    check('subtítulo de la tab: el nombre de la carpeta', (await tabSubtitle(tabId)) === 'Ñandú áéíóú');

    st = await runIdle('Set-Location ..');
    check('cd .. se refleja en el panel y en la tab', st.cwd === parent && (await tabSubtitle(tabId)) === 'carpeta con espacios', st.cwd);
    st = await runIdle('Set-Location HKCU:\\Software');
    check('una ubicación que no es una carpeta (registro) no cambia el cwd', st.cwd === parent, st.cwd);
    await runIdle(`Set-Location -LiteralPath ${psQuote(parent)}`);

    await page.evaluate((id) => window.__workspace.getState().renameTab(id, 'Con nombre'), tabId);
    check('una tab renombrada no muestra subtítulo', (await tabSubtitle(tabId)) === null);
    await page.evaluate((id) => window.__workspace.getState().renameTab(id, null), tabId);
    await shot('20-cwd');
  },

  async commands() {
    await freshTab();
    let st = await runIdle("'todo ' + 'bien'");
    check('comando correcto: código 0 y la línea del comando', st.lastExitCode === 0 && st.lastCommand === "'todo ' + 'bien'", JSON.stringify(st));
    let bar = await statusBar();
    check('status bar: ✓ después de un comando correcto', bar.commandState === 'ok', JSON.stringify(bar));
    st = await runIdle('cmd /c exit 3');
    check('programa nativo que falla: su código (3)', st.lastExitCode === 3, String(st.lastExitCode));
    bar = await statusBar();
    check('status bar: ✗ con el código', bar.commandState === 'error' && bar.command === '✗ 3', JSON.stringify(bar));
    st = await runIdle('Get-Item C:\\no-existe-terminal-e2e');
    check('cmdlet que falla: código 1', st.lastExitCode === 1, String(st.lastExitCode));
    st = await runIdle("throw 'boom'");
    check('excepción: código 1', st.lastExitCode === 1, String(st.lastExitCode));
    await runIdle('cmd /c exit 9');
    await runIdle("'lec=' + $LASTEXITCODE + ';fin'");
    check('$LASTEXITCODE del usuario no se pisa', (await text()).includes('lec=9;fin'));

    // A running command with no child process (Start-Sleep runs inside PowerShell): the
    // process tree shows nothing, OSC 133 does. Closing must ask.
    const keep = (await wsState()).active;
    await openTab();
    const busyTab = (await wsState()).active;
    const id = await activePane();
    await runIdle('Start-Sleep -Seconds 60', { wait: false });
    const running = await waitUntil(async () => (await paneState(id)).commandRunning, 5000);
    bar = await statusBar();
    check('comando en ejecución: estado del panel y status bar', running && bar.commandState === 'running' && bar.command.includes('Start-Sleep -Seconds 60'), JSON.stringify(bar));
    await page.keyboard.press('Control+Shift+W');
    const dialog = await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 }).catch(() => null);
    const detail = dialog ? await page.textContent('.dialog-details') : '';
    check('cerrar con un comando corriendo pide confirmación (aunque no haya procesos hijos)', !!dialog && detail.includes('Start-Sleep -Seconds 60'), detail);
    await page.keyboard.press('Escape');
    await waitUntil(async () => !(await page.$('[role="alertdialog"]')), 3000);
    check('Cancelar deja la tab', (await wsState()).tabs[busyTab] !== undefined);
    await waitUntil(terminalFocused, 3000);
    await page.keyboard.press('Control+c');
    const stopped = await waitUntil(() => idle(id), 8000);
    st = await paneState(id);
    check('Ctrl+C termina el comando: deja de estar en ejecución', stopped && st.lastExitCode !== null, JSON.stringify(st));
    await page.keyboard.press('Control+Shift+W');
    await waitUntil(async () => (await wsState()).tabs[busyTab] === undefined, 5000);
    check('sin comando ni procesos, cerrar no pregunta', (await wsState()).tabs[busyTab] === undefined && !(await page.$('[role="alertdialog"]')));
    check('queda la otra tab', (await wsState()).active === keep);
    await shot('21-commands');
  },

  async prompt() {
    await freshTab();
    // Custom prompts defined after the integration loaded (like a profile or oh-my-posh that
    // redefines `prompt` later): the integration wraps them again.
    await runIdle("function global:prompt { 'MI-PROMPT ' + $PWD.ProviderPath + '> ' }");
    check('prompt personalizado: se ve tal cual', await lineMatches(/^MI-PROMPT .*> ?$/), await cursorLine());
    const parent = trickyDir(...PARENT_DIR);
    let st = await runIdle(`Set-Location -LiteralPath ${psQuote(parent)}`);
    check('prompt personalizado: el cwd se sigue reportando', st.cwd === parent, st.cwd);
    st = await runIdle('cmd /c exit 4');
    check('prompt personalizado: el código de salida se sigue reportando', st.lastExitCode === 4, String(st.lastExitCode));

    // Prompts that show the last status (oh-my-posh, starship...) must see the real $?.
    await runIdle("function global:prompt { if ($?) { 'BIEN> ' } else { 'MAL> ' } }");
    await runIdle('Get-Item C:\\no-existe-terminal-e2e');
    check('un prompt que usa $? ve el fallo', await lineMatches(/^MAL>/), await cursorLine());
    await runIdle("'ok'");
    check('... y el éxito', await lineMatches(/^BIEN>/), await cursorLine());

    await runIdle("function global:prompt { Write-Host 'HOST-PROMPT' -NoNewline -ForegroundColor Cyan; ' ' }");
    st = await runIdle('cmd /c exit 6');
    check('un prompt con Write-Host sigue integrado', st.lastExitCode === 6 && (await lineMatches(/^HOST-PROMPT/)), await cursorLine());

    // PSReadLine keeps working: history and completion.
    await page.keyboard.press('ArrowUp');
    const history = await waitUntil(async () => (await cursorLine()).includes('cmd /c exit 6'), 3000);
    check('PSReadLine: flecha arriba trae el historial', history, await cursorLine());
    await page.keyboard.press('Escape');
    await waitUntil(async () => (await cursorLine()).trim() === 'HOST-PROMPT', 3000);
    await page.keyboard.type('Get-ChildIt');
    await page.keyboard.press('Tab');
    const completed = await waitUntil(async () => (await cursorLine()).includes('Get-ChildItem'), 3000);
    check('PSReadLine: Tab autocompleta', completed, await cursorLine());
    await page.keyboard.press('Escape');
    await waitUntil(async () => (await cursorLine()).trim() === 'HOST-PROMPT', 3000);
    await shot('22-prompt');
    await freshTab();
  },

  async inherit() {
    await freshTab();
    const tabId = (await wsState()).active;
    const dir = trickyDir(...TRICKY_DIR);
    await cdTricky();

    await page.keyboard.press('Alt+Shift+D');
    await waitPanes(2);
    const right = await activePane();
    check('Alt+Shift+D: el panel nuevo abre en el mismo cwd', (await paneCwd(right)) === dir, String(await paneCwd(right)));
    await runIdle("'pwd=' + $PWD.ProviderPath + ';fin'");
    check('... y su shell está ahí de verdad', (await text()).includes(`pwd=${dir};fin`));
    await page.keyboard.press('Alt+Shift+Minus');
    await waitPanes(3);
    const down = await activePane();
    check('Alt+Shift+-: también', (await paneCwd(down)) === dir, String(await paneCwd(down)));

    await page.click(tabSel(tabId), { button: 'right' });
    await page.click('[role="menu"] [data-action="duplicate"]');
    if (!(await waitUntil(async () => (await wsState()).order.length === 2, 5000))) {
      // Seen once in a full run (Fase 4): no duplicate after the click. Keep the evidence.
      await shot('fail-inherit-duplicate');
      const st = await wsState();
      throw new Error(`duplicar no creó la tab: ${st.order.join(',')} activa=${st.active}; ${await focusReport()}`);
    }
    const dup = (await wsState()).active;
    const dupPane = (await wsState()).tabs[dup].activePaneId;
    const dupCwd = await paneCwd(dupPane);
    if (dupCwd !== dir) await shot('fail-inherit-duplicate-cwd');
    check('duplicar la tab: mismo cwd', dup !== tabId && dupCwd === dir, `${dupCwd} | ${JSON.stringify(await paneState(dupPane))} | ${await paneText(dupPane)}`);
    await waitUntil(atShellPrompt, 20000);
    const fresh = await openTab();
    const freshPane = (await wsState()).tabs[fresh].activePaneId;
    check('Ctrl+Shift+T: la tab nueva abre en el cwd del panel activo', (await paneCwd(freshPane)) === dir, String(await paneCwd(freshPane)));

    // The folder disappears: the next split falls back to home, without errors.
    const gone = trickyDir('se va a borrar');
    const st = await runIdle(`Set-Location -LiteralPath ${psQuote(gone)}`);
    fs.rmSync(gone, { recursive: true, force: true });
    await page.keyboard.press('Alt+Shift+D');
    await waitPanes(2);
    const orphan = await activePane();
    const home = await homeDir();
    const orphanCwd = await paneCwd(orphan);
    const noError = !(await text()).includes('No se pudo iniciar');
    check('si el cwd ya no existe, el panel nuevo abre en home sin error', st.cwd === gone && orphanCwd === home && noError, `${orphanCwd} / ${home}`);
    await shot('23-inherit');
    await freshTab();
  },

  async notice() {
    await freshTab();
    check('sin aviso mientras la integración funciona', (await statusBar()).notice === null);
    // The marker the injector writes when the script cannot load (execution policy, errors).
    // The real failure, end to end in PowerShell, is a Rust test
    // (powershell_integration_failure_is_reported_and_harmless).
    await run("[Console]::Write([char]27 + ']633;P;IntegrationError=prueba e2e' + [char]7)");
    await waitUntil(async () => (await statusBar()).notice !== null, 3000);
    const bar = await statusBar();
    check(
      'si la integración falla: aviso discreto en la status bar (motivo en el tooltip)',
      !!bar.notice?.includes('Sin integración') && !!bar.noticeTitle?.includes('prueba e2e'),
      JSON.stringify(bar),
    );
    check('... y la terminal sigue funcionando', (await value("'si' + 'gue'", 'v')) === 'sigue');
    await freshTab();
  },

  async gitbash() {
    const shells = await page.evaluate(() => window.__system.getState().shells);
    if (!shells.some((s) => s.kind === 'gitbash')) return skip('gitbash', 'Git Bash no está instalado');
    await freshTab();
    const parent = trickyDir(...PARENT_DIR);
    const dir = trickyDir(...TRICKY_DIR);
    await cdTricky();
    const before = (await wsState()).order.length;
    await page.click('.tab-new-menu');
    await page.click('[role="menu"] [data-shell="gitbash"]');
    await waitUntil(async () => (await wsState()).order.length === before + 1, 5000);
    const id = await activePane();
    const ready = await waitUntil(() => idle(id), 30000);
    let st = await paneState(id);
    check('Git Bash desde el selector "▾", con integración', ready && st.shell === 'gitbash', JSON.stringify({ shell: st.shell, integration: st.integration, error: st.integrationError }));
    check('Git Bash abre en el cwd del panel activo (tildes y ñ)', st.cwd === dir, `${st.cwd} / ${dir}`);
    check('status bar: nombre de la shell', (await statusBar()).shell === 'Git Bash');
    await waitUntil(terminalFocused, 3000);
    st = await runIdle('cd ..');
    check('Git Bash: cd actualiza el cwd', st.cwd === parent, st.cwd);
    st = await runIdle('false');
    check('Git Bash: comando que falla, código 1', st.lastExitCode === 1 && st.lastCommand === 'false', JSON.stringify(st));
    st = await runIdle('(exit 4)');
    check('Git Bash: código de salida 4', st.lastExitCode === 4, String(st.lastExitCode));
    await page.keyboard.press('Alt+Shift+D');
    await waitUntil(async () => leaves((await activeTab()).layout).length === 2, 5000);
    const second = await activePane();
    const ready2 = await waitUntil(() => idle(second), 30000);
    st = await paneState(second);
    check('dividir Git Bash: Git Bash en el mismo cwd', ready2 && st.shell === 'gitbash' && st.cwd === parent, JSON.stringify({ shell: st.shell, cwd: st.cwd }));
    await shot('24-gitbash');
    await freshTab();
  },

  // ------------------------------------------------------------ input integrity
  async typing() {
    // Thousands of keys typed fast into three raw-mode recorders (e2e/sink.mjs), with pane,
    // tab and layout changes in between and no waiting after them. Byte for byte, each program
    // must get exactly what was typed while its pane was the active one. Two checkpoints tell
    // where something got lost: what xterm emitted (before the app) and what the program got.
    await freshTab();
    const dir = trickyDir('sink');
    const panes = {};
    const startSink = async (id) => {
      const file = path.join(dir, `${id}.txt`);
      await run(`node ${psQuote(path.join(ROOT, 'e2e', 'sink.mjs'))} ${psQuote(file)}`, { waitPrompt: false });
      await waitFor((s) => s.includes('SINK listo'), { source: () => paneText(id, 500) });
      await page.evaluate((id) => {
        const t = window.__paneTerminal(id);
        t.__e2eEmitted = '';
        t.onData((data) => (t.__e2eEmitted += data));
      }, id);
      panes[id] = { file, expected: '' };
      // Passive counters (no effect on timing): keys that reach this pane's textarea, and IME
      // composition events, to tell "never reached xterm" from "xterm got it and kept it".
      await page.evaluate((id) => {
        const t = window.__paneTerminal(id);
        t.__e2eStats = { keydown: 0, compositionstart: 0, compositionend: 0, input: 0 };
        for (const type of Object.keys(t.__e2eStats)) {
          t.textarea.addEventListener(type, () => t.__e2eStats[type]++, true);
        }
      }, id);
    };
    const left = await activePane();
    await startSink(left);
    await page.keyboard.press('Alt+Shift+D');
    await waitPanes(2);
    const right = await activePane();
    await startSink(right);
    await openTab();
    const other = await activePane();
    await startSink(other);
    const tabs = (await wsState()).order;
    // Where the keyboard goes: per tab, its active pane.
    let tab = 1;
    const activeIn = { 1: right, 2: other };
    await page.keyboard.press('Control+1');
    await waitUntil(terminalFocused, 3000);

    let seed = 20261119;
    const random = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '\"\\-_.,;:!?()[]{}<>/|@#$%^&*+=~`áéñ";
    const actions = [
      ['Alt+ArrowLeft', () => tab === 1 && (activeIn[1] = left)],
      ['Alt+ArrowRight', () => tab === 1 && (activeIn[1] = right)],
      ['Control+Tab', () => (tab = tab === 1 ? 2 : 1)],
      ['click', null],
      ['Control+b', () => {}],
      ['none', () => {}],
    ];
    // Diagnostics: keys that reach no terminal, and where the focus was at each segment.
    await page.evaluate(() => {
      window.__strayKeys = [];
      window.addEventListener(
        'keydown',
        (event) => {
          const target = event.target;
          if (target instanceof HTMLTextAreaElement && target.classList.contains('xterm-helper-textarea')) return;
          window.__strayKeys.push(`${event.key}→${target?.tagName ?? '?'}.${String(target?.className ?? '').slice(0, 24)}`);
        },
        true,
      );
    });
    const segments = [];
    let typed = 0;
    let lastAction = 'inicio';
    const SEGMENTS = Number(process.env.E2E_TYPING_SEGMENTS ?? (SMOKE ? 10 : 24));
    for (let segment = 0; segment < SEGMENTS; segment++) {
      let text = '';
      const length = 60 + random(140);
      for (let i = 0; i < length; i++) text += alphabet[random(alphabet.length)];
      const target = activeIn[tab];
      segments.push({ segment, after: lastAction, pane: target, at: panes[target].expected.length, length });
      panes[target].expected += text;
      await page.keyboard.type(text);
      typed += text.length;
      const [key, apply] = actions[random(actions.length)];
      lastAction = key;
      if (key === 'click') {
        // Click a pane of the visible tab (by the pointer, like a user).
        const target = tab === 1 ? (random(2) ? left : right) : other;
        const box = await paneBox(target);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        activeIn[tab] = target;
      } else if (key !== 'none') {
        await page.keyboard.press(key);
        apply();
      }
    }
    // Close every recorder (Ctrl+D) and compare.
    for (const [index, id] of [left, right, other].entries()) {
      const tabIndex = index < 2 ? 1 : 2;
      await page.keyboard.press(`Control+${tabIndex}`);
      if (tabIndex === 1) await clickPane(id);
      await waitUntil(async () => (await activePane()) === id && (await terminalFocused()), 3000);
      await page.keyboard.press('Control+d');
      await waitFor((s) => s.includes('SINK fin'), { source: () => paneText(id, 500), timeout: 10000 }).catch(() => null);
    }
    void tabs;
    const report = [];
    let ok = true;
    for (const id of [left, right, other]) {
      const { file, expected } = panes[id];
      const received = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(sin archivo)';
      // ConPTY asks for focus reports (DECSET 1004): xterm sends ESC[I / ESC[O on focus changes
      // and ConPTY consumes them (they never reach the program). Not typed text: left out.
      const raw = (await page.evaluate((id) => window.__paneTerminal(id).__e2eEmitted, id)).replace(/\x04$/, '');
      let emitted = '';
      const rawIndex = [];
      for (let i = 0; i < raw.length; ) {
        if (raw.startsWith('\x1b[I', i) || raw.startsWith('\x1b[O', i)) {
          i += 3;
          continue;
        }
        rawIndex.push(i);
        emitted += raw[i];
        i++;
      }
      emitted = emitted.replace(/\x04$/, ''); // the Ctrl+D that closed the recorder
      const diff = (a, b) => {
        if (a === b) return 'igual';
        let at = 0;
        while (at < a.length && a[at] === b[at]) at++;
        return `${a.length} esperados, ${b.length} recibidos; primera diferencia en ${at}: ${JSON.stringify(a.slice(at, at + 12))} vs ${JSON.stringify(b.slice(at, at + 12))}`;
      };
      const xterm = diff(expected, emitted);
      const program = diff(expected, received);
      ok &&= received === expected;
      report.push(`${id}: xterm ${xterm} | programa ${program}`);
      if (emitted !== expected) {
        // Where xterm diverged, raw: a focus out/in (ESC[O ESC[I) there means focus left it.
        let at = 0;
        while (at < expected.length && expected[at] === emitted[at]) at++;
        const r = rawIndex[at] ?? raw.length;
        report.push(`${id} crudo en la diferencia: ${JSON.stringify(raw.slice(Math.max(0, r - 24), r + 24))}`);
      }
    }
    if (!ok) {
      const stray = await page.evaluate(() => window.__strayKeys);
      report.push(`teclas sin terminal: ${stray.length} ${stray.slice(0, 6).join(' ')}`);
      for (const id of [left, right, other]) {
        report.push(`${id} contadores: ${JSON.stringify(await page.evaluate((id) => window.__paneTerminal(id).__e2eStats, id))}`);
      }
      report.push(`tramos: ${segments.map((s) => `#${s.segment} ${s.after}→${s.pane}@${s.at}+${s.length}`).join('; ')}`);
    }
    check(`${typed} teclas rápidas con cambios de panel, tab y layout: cada programa recibe exactamente lo suyo`, ok, report.join(' || '));
    await shot('29-typing');
    await showExplorer(); // as found: an odd number of Ctrl+B leaves it hidden
    await freshTab();
  },

  // ------------------------------------------------------------ explorer (Fase 5)
  async explorer() {
    await freshTab();
    await showExplorer();
    const home = await homeDir();
    check('el explorador muestra el cwd del panel activo', await waitRoot(home), (await explorerState()).root);

    // Ctrl+B hides it: the terminal takes the space and the PTY follows.
    const id = await activePane();
    // The explorer may have just been shown: measure once the terminal has refitted.
    let narrow = await paneSize(id);
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      const now = await paneSize(id);
      if (now === narrow) break;
      narrow = now;
    }
    await page.keyboard.press('Control+b');
    await waitUntil(async () => !(await page.$('.sidebar')), 3000);
    await waitUntil(async () => (await paneSize(id)) !== narrow, 3000);
    const wide = await paneSize(id);
    check('Ctrl+B oculta el explorador y la terminal gana el ancho', Number(wide.split('x')[0]) > Number(narrow.split('x')[0]), `${narrow} -> ${wide}`);
    const pty = await ptyMatches(id);
    check('... y el PTY sigue al ancho nuevo', pty.ok, pty.detail);
    await page.keyboard.press('Control+b');
    await page.waitForSelector('.sidebar', { timeout: 3000 });

    // Holding a shortcut down repeats keydown: the action runs once.
    const tabsBefore = (await wsState()).order.length;
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    for (let i = 0; i < 4; i++) await page.keyboard.down('T');
    await page.keyboard.up('T');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await sleep(600);
    check('mantener Ctrl+Shift+T apretado abre una sola tab', (await wsState()).order.length === tabsBefore + 1, `${tabsBefore} -> ${(await wsState()).order.length}`);
    await page.keyboard.down('Control');
    for (let i = 0; i < 3; i++) await page.keyboard.down('b');
    await page.keyboard.up('b');
    await page.keyboard.up('Control');
    await sleep(300);
    check('mantener Ctrl+B apretado alterna una sola vez', !(await explorerState()).visible);
    await showExplorer();
    await freshTab();

    // Width: drag the edge; width and visibility survive a reload.
    const w0 = (await explorerState()).width;
    const edge = await page.locator('.sidebar-resizer').boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + 90, edge.y + 200, { steps: 6 });
    await page.mouse.up();
    await sleep(300);
    const w1 = (await explorerState()).width;
    check('arrastrar el borde cambia el ancho', Math.abs(w1 - w0 - 90) <= 3, `${w0} -> ${w1}`);
    await page.reload();
    await page.waitForFunction(() => window.__terminal, null, { timeout: 30000 });
    await emulateFocus();
    await waitFor(/PS [A-Za-z]:\\.*>/, { timeout: 30000 });
    const after = await explorerState();
    check('ancho y visibilidad se recuerdan al recargar', after.visible && after.width === w1, JSON.stringify({ visible: after.visible, width: after.width }));
    await page.evaluate((w) => window.__explorer.getState().setWidth(w), w0);
    await waitUntil(terminalFocused, 3000);

    // Follows the cwd, with spaces, accents and ñ; folders are read lazily.
    const { dir, parent, file, accented, sub, inner } = explorerFixture();
    await cdTricky();
    check('cd a una ruta con espacios, tildes y ñ: el explorador la sigue', await waitRoot(dir), (await explorerState()).root);
    check('breadcrumbs: la última es la carpeta actual', (await page.locator('.breadcrumbs .crumb').last().textContent()) === 'Ñandú áéíóú');
    check('el árbol lista sus archivos', (await waitRow(file)) && (await hasRow(accented)) && (await hasRow(sub)));
    const listed = await page.evaluate((key) => !!window.__explorer.getState().listings[key], sub.toLowerCase());
    check('carga perezosa: una subcarpeta no se lee hasta expandirla', !(await hasRow(inner)) && !listed);
    await toggleRow(sub);
    check('expandir la lee', await waitRow(inner));

    // Another pane, another cwd: the explorer shows the active one.
    const first = await activePane();
    await page.keyboard.press('Alt+Shift+D');
    await waitPanes(2);
    await runIdle('Set-Location ..');
    check('cd en el panel activo: el explorador lo sigue', await waitRoot(parent), (await explorerState()).root);
    await page.keyboard.press('Alt+ArrowLeft');
    await waitUntil(async () => (await activePane()) === first, 3000);
    check('cambiar de panel: muestra el cwd del otro panel', await waitRoot(dir), (await explorerState()).root);
    await openTab();
    await runIdle(`Set-Location -LiteralPath ${psQuote(home)}`);
    check('otra tab: su cwd', await waitRoot(home), (await explorerState()).root);
    await page.keyboard.press('Control+1');
    check('volver a la primera tab: el cwd de su panel activo', await waitRoot(dir), (await explorerState()).root);

    // Pinned: it stays; unpinned: it follows again.
    await page.click('[data-action="pin"]');
    check('fijar deja el explorador en esa carpeta', (await explorerState()).pinned?.toLowerCase() === dir.toLowerCase());
    await waitUntil(terminalFocused, 3000);
    await runIdle('Set-Location ..');
    await sleep(500);
    check('fijado: no sigue el cd', (await explorerState()).root?.toLowerCase() === dir.toLowerCase(), (await explorerState()).root);
    await page.click('[data-action="pin"]');
    check('desfijar: vuelve a seguir el cwd', await waitRoot(parent), (await explorerState()).root);
    await shot('25-explorer');
    await freshTab();
  },

  async explorercd() {
    await freshTab();
    await showExplorer();
    const { dir, sub, file } = explorerFixture();
    await cdTricky();
    await waitRoot(dir);
    await waitRow(sub);
    const id = await activePane();

    // A folder: cd in the active pane (idle shell, empty prompt).
    await clickRow(sub);
    const moved = await waitUntil(async () => (await paneState(id)).cwd === sub, 8000);
    check('clic en una carpeta: cd en el panel activo', moved && (await waitRoot(sub)), (await paneState(id)).cwd);
    check('... con la ruta entre comillas', (await text()).includes(`Set-Location -LiteralPath '${sub}'`));
    await page.click(`.breadcrumbs .crumb[data-path="${attrValue(dir)}"]`);
    check('clic en un breadcrumb: cd ahí', await waitUntil(async () => (await paneState(id)).cwd === dir, 8000));
    await waitRow(file);
    await waitUntil(() => idle(id), 5000);

    // A file: its path at the prompt, quoted for PowerShell, not run.
    await clickRow(file);
    const inserted = await waitUntil(async () => (await cursorLine()).endsWith(`> '${file}'`), 3000);
    check('clic en un archivo: inserta la ruta con comillas sin ejecutarla', inserted && !(await paneState(id)).commandRunning, await cursorLine());
    await page.keyboard.press('Escape');
    await waitUntil(() => atEmptyPrompt(id), 3000);

    // Something typed at the prompt: nothing is typed over it.
    await page.keyboard.type('abc');
    await waitUntil(async () => (await cursorLine()).endsWith('abc'), 3000);
    let before = await text();
    await clickRow(sub);
    await sleep(600);
    let notice = (await explorerState()).notice?.message ?? '';
    check('con texto en el prompt no se escribe nada', (await text()) === before && /texto escrito/.test(notice), notice);
    await waitUntil(terminalFocused, 3000);
    await page.keyboard.press('Escape');
    await waitUntil(() => atEmptyPrompt(id), 3000);

    // A command running: nothing is typed into that terminal; a new tab is offered.
    await runIdle('Start-Sleep -Seconds 30', { wait: false });
    await waitUntil(async () => (await paneState(id)).commandRunning, 5000);
    before = await text();
    await clickRow(sub);
    await sleep(600);
    notice = (await explorerState()).notice?.message ?? '';
    check('con un comando corriendo, clic en carpeta no escribe nada', (await text()) === before && /ejecutando/.test(notice), notice);
    await page.click('[data-action="notice-open-tab"]');
    await waitUntil(async () => (await wsState()).order.length === 2, 5000);
    const opened = await activePane();
    const openedCwd = await paneCwd(opened);
    check('... y "Abrir tab aquí" abre una tab en esa carpeta', openedCwd === sub, `${JSON.stringify(await paneState(opened))} | ${await paneText(opened)}`);
    await page.keyboard.press('Control+1');
    await waitUntil(async () => (await activePane()) === id, 3000);
    await waitUntil(terminalFocused, 3000);
    await page.keyboard.press('Control+c');
    await waitUntil(() => idle(id), 8000);
    await closeOtherTabsNow();
    await waitRoot(dir);
    await waitRow(file);

    // Dragging a row onto a terminal types its path in THAT pane, not in the active one. The
    // target is the new pane: the old one's long prompt was just reflowed by the split, which
    // PSReadLine 2.0 redraws badly (not the explorer's doing).
    await page.keyboard.press('Alt+Shift+D');
    await waitPanes(2);
    const right = await activePane();
    await waitUntil(() => idle(right), 10000);
    await page.keyboard.press('Alt+ArrowLeft');
    await waitUntil(async () => (await activePane()) === id, 3000);
    const leftBefore = await paneText(id, 200);
    const from = await page.locator(`${rowSel(file)} .tree-name`).boundingBox();
    const to = await paneBox(right);
    await page.mouse.move(from.x + 6, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + from.height / 2, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    const highlighted = !!(await page.$(`${paneSel(right)}[data-drop-target]`));
    await page.mouse.up();
    const dropped = await waitUntil(async () => (await paneCursorLine(right)).endsWith(`> '${file}'`), 3000);
    const leftUntouched = (await paneText(id, 200)) === leftBefore;
    check(
      'arrastrar un archivo a un panel: su ruta entre comillas en ESE panel (no en el activo)',
      dropped && highlighted && leftUntouched,
      `${await paneCursorLine(right)} | resaltado ${highlighted} | activo intacto ${leftUntouched}`,
    );
    await waitUntil(async () => (await activePane()) === right, 3000);
    await page.keyboard.press('Escape');
    await waitUntil(() => atEmptyPrompt(right), 3000);
    await page.keyboard.press('Alt+ArrowLeft');
    await waitUntil(async () => (await activePane()) === id, 3000);

    // Files dropped from Windows Explorer: the same native event Tauri emits.
    const box = await paneBox(right);
    const emitted = await page.evaluate(
      async ({ paths, x, y }) => {
        const ratio = window.devicePixelRatio;
        try {
          await window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
            target: { kind: 'Webview', label: 'main' },
            event: 'tauri://drag-drop',
            payload: { paths, position: { x: x * ratio, y: y * ratio } },
          });
          return 'ok';
        } catch (error) {
          return String(error);
        }
      },
      { paths: [file, sub], x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    const osDrop = await waitUntil(async () => (await paneCursorLine(right)).endsWith(`> '${file}' '${sub}'`), 3000);
    check('soltar archivos del Explorador de Windows en un panel: rutas entre comillas', osDrop, `${emitted} | ${await paneCursorLine(right)}`);
    await waitUntil(async () => (await activePane()) === right, 3000);
    await page.keyboard.press('Escape');
    await waitUntil(() => atEmptyPrompt(right), 3000);

    // Git Bash quotes its own way.
    const shells = await page.evaluate(() => window.__system.getState().shells);
    if (shells.some((s) => s.kind === 'gitbash')) {
      await page.click('.tab-new-menu');
      await page.click('[role="menu"] [data-shell="gitbash"]');
      const bash = await activePane();
      await waitUntil(() => idle(bash), 30000);
      await waitRow(file);
      await clickRow(file);
      const msys = `/c${file.slice(2).replace(/\\/g, '/')}`;
      const bashLine = await waitUntil(async () => (await paneCursorLine(bash)).endsWith(`'${msys}'`), 3000);
      check('en Git Bash la ruta va en formato MSYS y con comillas', bashLine, await paneCursorLine(bash));
      await page.keyboard.press('Control+u');
    }
    await shot('26-explorer-cd');
    await freshTab();
  },

  async watcher() {
    await freshTab();
    await showExplorer();
    const dir = trickyDir('vigilada');
    await runIdle(`Set-Location -LiteralPath ${psQuote(dir)}`);
    await waitRoot(dir);
    const watching = async (...dirs) => {
      const want = dirs.map((d) => d.toLowerCase()).sort().join('|');
      return waitUntil(async () => (await explorerState()).watched.join('|') === want, 3000);
    };
    check('vigila la carpeta visible', await watching(dir), (await explorerState()).watched.join(', '));
    const a = path.join(dir, 'creado afuera.txt');
    fs.writeFileSync(a, 'x');
    check('watcher: un archivo creado afuera aparece', await waitRow(a, true, 5000));
    const b = path.join(dir, 'renombrado ñ.txt');
    fs.renameSync(a, b);
    check('watcher: un renombre se refleja', (await waitRow(b, true, 5000)) && (await waitRow(a, false, 5000)));
    fs.rmSync(b);
    check('watcher: un borrado se refleja', await waitRow(b, false, 5000));

    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    await waitRow(sub, true, 5000);
    await toggleRow(sub);
    check('expandir: vigila la raíz y la subcarpeta', await watching(dir, sub), (await explorerState()).watched.join(', '));
    const inner = path.join(sub, 'adentro.txt');
    fs.writeFileSync(inner, 'x');
    check('watcher en la subcarpeta expandida', await waitRow(inner, true, 5000));
    await toggleRow(sub);
    check('colapsar libera su watcher', await watching(dir), (await explorerState()).watched.join(', '));
    await page.keyboard.press('Control+b');
    check('ocultar el explorador libera todos los watchers', await watching());
    await page.keyboard.press('Control+b');
    await watching(dir);

    // A burst (like npm install or git checkout): debounced, and the tree catches up.
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(dir, `rafaga ${i}.txt`), '');
    check('ráfaga de 200 archivos: el árbol se pone al día', await waitUntil(async () => (await rowCount()) === 201, 8000), String(await rowCount()));
    await freshTab();
  },

  async gitexplorer() {
    await freshTab();
    await showExplorer();
    const repo = trickyDir('repo con espacios');
    const git = (...args) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], { stdio: 'ignore' });
    git('init', '-q', '-b', 'principal');
    fs.writeFileSync(path.join(repo, 'versionado.txt'), 'uno');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'secreto.log\nsalida/\n');
    git('add', '.');
    git('commit', '-q', '-m', 'inicial');
    fs.writeFileSync(path.join(repo, 'versionado.txt'), 'dos');
    fs.writeFileSync(path.join(repo, 'nuevo.txt'), 'x');
    fs.writeFileSync(path.join(repo, 'secreto.log'), 'x');
    fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'salida'));
    const p = (name) => path.join(repo, name);

    await runIdle(`Set-Location -LiteralPath ${psQuote(repo)}`);
    await waitRoot(repo);
    check('git: la rama en la barra de estado', await waitUntil(async () => !!(await statusBar()).git?.includes('principal'), 8000), JSON.stringify((await statusBar()).git));
    const colored = await waitUntil(
      async () => (await rowAttr(p('versionado.txt'), 'data-git')) === 'modified' && (await rowAttr(p('nuevo.txt'), 'data-git')) === 'untracked',
      8000,
    );
    check('git: modificados y nuevos con su color', colored, `${await rowAttr(p('versionado.txt'), 'data-git')} / ${await rowAttr(p('nuevo.txt'), 'data-git')}`);
    const hiddenByDefault = !(await hasRow(p('secreto.log'))) && !(await hasRow(p('node_modules'))) && !(await hasRow(p('.git'))) && !(await hasRow(p('salida')));
    check('ocultos por defecto: .gitignore, node_modules y .git', hiddenByDefault);
    await page.click('[data-action="toggle-hidden"]');
    await waitRow(p('secreto.log'), true, 3000);
    const reasons = [
      await rowAttr(p('secreto.log'), 'data-hidden'),
      await rowAttr(p('salida'), 'data-hidden'),
      await rowAttr(p('node_modules'), 'data-hidden'),
      await rowAttr(p('.git'), 'data-hidden'),
    ];
    check('el toggle los muestra atenuados (ignorados por .gitignore / por defecto)', JSON.stringify(reasons) === JSON.stringify(['ignored', 'ignored', 'default', 'default']), reasons.join(','));
    await page.click('[data-action="toggle-hidden"]');
    await waitRow(p('secreto.log'), false, 3000);

    // Git commands in the terminal: the colors and the branch refresh when they end.
    await waitUntil(terminalFocused, 3000);
    await runIdle('git add nuevo.txt');
    check('al terminar un comando git se actualizan los colores', await waitUntil(async () => (await rowAttr(p('nuevo.txt'), 'data-git')) === 'added', 8000), await rowAttr(p('nuevo.txt'), 'data-git'));
    await runIdle('git checkout -q -b otra-rama');
    check('... y la rama', await waitUntil(async () => !!(await statusBar()).git?.includes('otra-rama'), 8000), JSON.stringify((await statusBar()).git));
    await shot('27-git');
    await freshTab();
  },

  async bigfolder() {
    await freshTab();
    await showExplorer();
    const big = trickyDir('carpeta grande');
    for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(big, `archivo ${String(i).padStart(5, '0')}.txt`), '');
    const samples = [];
    const measure = async (label) => {
      await cdp.send('HeapProfiler.collectGarbage');
      await sleep(500);
      const heap = await page.evaluate(() => performance.memory.usedJSHeapSize);
      samples.push({ label, heapMB: Math.round((heap / 1048576) * 10) / 10, ...appMemory() });
    };
    await page.keyboard.press('Control+b');
    await waitUntil(async () => !(await page.$('.sidebar')), 3000);
    await sleep(500);
    await measure('explorador oculto');
    await page.keyboard.press('Control+b');
    await waitUntil(async () => (await rowCount()) > 0, 5000);
    await sleep(500);
    await measure('explorador en home');

    // Long tasks while 5000 entries arrive: the UI must not freeze.
    await page.evaluate(() => {
      window.__longTasks = [];
      new PerformanceObserver((list) => window.__longTasks.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask' });
    });
    const started = Date.now();
    await runIdle(`Set-Location -LiteralPath ${psQuote(big)}`);
    const loaded = await waitUntil(async () => (await rowCount()) === 5000, 10000);
    const elapsed = Date.now() - started;
    const domRows = await page.$$eval('.tree-row', (rows) => rows.length);
    check('carpeta con 5000 archivos: lista completa, solo se dibujan las filas visibles', loaded && domRows < 120, `${elapsed} ms hasta listar, ${domRows} filas en el DOM`);
    const longTasks = await page.evaluate(() => window.__longTasks);
    const worst = Math.round(Math.max(0, ...longTasks));
    check('la UI no se congela (ninguna tarea larga > 250 ms)', worst < 250, `${longTasks.length} tareas largas, la peor ${worst} ms`);
    await page.evaluate(() => {
      const tree = document.querySelector('.file-tree');
      tree.scrollTop = tree.scrollHeight;
    });
    check('scroll al final: aparece el último archivo', await waitRow(path.join(big, 'archivo 04999.txt'), true, 3000));
    await sleep(500);
    await measure('5000 archivos');
    await page.keyboard.press('Control+b');
    await waitUntil(async () => !(await page.$('.sidebar')), 3000);
    await sleep(500);
    await measure('oculto otra vez');
    await page.keyboard.press('Control+b');
    fs.writeFileSync(path.join(ARTIFACTS, 'explorer-memory.json'), JSON.stringify(samples, null, 2));
    const table = samples.map((s) => `${s.label}: heap ${s.heapMB}, renderer ${s.renderer}, gpu ${s.gpu}, browser ${s.browser}, app ${s.app}`).join(' | ');
    check('memoria medida (MB privados)', samples.length === 4, table);
    await freshTab();
  },

  async explorermenu() {
    await freshTab();
    await showExplorer();
    const dir = trickyDir('menu contextual');
    const file = path.join(dir, 'original.txt');
    fs.writeFileSync(file, 'x');
    await runIdle(`Set-Location -LiteralPath ${psQuote(dir)}`);
    await waitRoot(dir);
    await waitRow(file);

    const actions = await rowMenu(file);
    const expected = ['open-vscode', 'open-file-manager', 'tab-here', 'split-here', 'copy-path', 'copy-relative-path', 'new-file', 'new-folder', 'rename-entry', 'trash'];
    check('menú contextual con todas las acciones', expected.every((a) => actions.includes(a)), actions.join(','));
    await page.click('[role="menu"] [data-action="copy-path"]');
    check('copiar ruta', await waitUntil(async () => (await getClipboard()) === file, 3000), await getClipboard());
    await rowMenu(file);
    await page.click('[role="menu"] [data-action="copy-relative-path"]');
    check('copiar ruta relativa (a la carpeta del explorador)', await waitUntil(async () => (await getClipboard()) === 'original.txt', 3000), await getClipboard());

    await rowMenu(file);
    await page.click('[role="menu"] [data-action="new-file"]');
    await page.waitForSelector('.tree-row[data-editing] input', { timeout: 3000 });
    await page.keyboard.type('nuevo desde el menu.txt');
    await page.keyboard.press('Enter');
    const created = path.join(dir, 'nuevo desde el menu.txt');
    check('nuevo archivo', (await waitRow(created)) && fs.existsSync(created));
    await rowMenu(file);
    await page.click('[role="menu"] [data-action="new-folder"]');
    await page.waitForSelector('.tree-row[data-editing] input', { timeout: 3000 });
    await page.keyboard.type('carpeta nueva');
    await page.keyboard.press('Enter');
    const folder = path.join(dir, 'carpeta nueva');
    check('nueva carpeta', (await waitRow(folder)) && fs.statSync(folder).isDirectory());

    await rowMenu(file);
    await page.click('[role="menu"] [data-action="rename-entry"]');
    await page.waitForSelector(`${rowSel(file)} input`, { timeout: 3000 });
    await page.fill(`${rowSel(file)} input`, 'renombrado.txt');
    await page.keyboard.press('Enter');
    const renamed = path.join(dir, 'renombrado.txt');
    check('renombrar', (await waitRow(renamed)) && fs.existsSync(renamed) && !fs.existsSync(file));

    await rowMenu(renamed);
    await page.click('[role="menu"] [data-action="trash"]');
    const dialog = await page.waitForSelector('[role="alertdialog"]', { timeout: 3000 }).catch(() => null);
    check('eliminar pide confirmación', !!dialog && (await page.textContent('#confirm-title')).includes('papelera'));
    await page.keyboard.press('Escape');
    check('Cancelar no borra', fs.existsSync(renamed));
    await rowMenu(renamed);
    await page.click('[role="menu"] [data-action="trash"]');
    await page.waitForSelector('[role="alertdialog"]', { timeout: 3000 });
    await page.click('[role="alertdialog"] [data-action="confirm"]');
    check('confirmar lo borra', (await waitRow(renamed, false)) && !fs.existsSync(renamed));
    const inBin = Number(
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RECYCLE, '-Folder', dir, '-Purge'], { encoding: 'utf8' }).trim(),
    );
    check('... a la Papelera de reciclaje (la prueba lo saca de ahí)', inBin === 1, `${inBin} en la papelera`);

    await rowMenu(folder);
    await page.click('[role="menu"] [data-action="tab-here"]');
    await waitUntil(async () => (await wsState()).order.length === 2, 5000);
    check('abrir una tab nueva aquí', (await paneCwd(await activePane())) === folder, String(await paneCwd(await activePane())));
    await page.keyboard.press('Control+1');
    await waitRoot(dir);
    await waitRow(folder);
    await rowMenu(folder);
    await page.click('[role="menu"] [data-action="split-here"]');
    await waitPanes(2);
    check('dividir panel aquí', (await paneCwd(await activePane())) === folder, String(await paneCwd(await activePane())));
    await shot('28-explorer-menu');
    await freshTab();
  },

  async passthrough() {
    // Ctrl+T / Ctrl+W are no longer app shortcuts: they must reach the program.
    await freshTab();
    const log = path.join(WORK, 'keys.log');
    await run(`$env:FAKE_AGENT_LOG = '${log}'`);
    await run(`& '${process.execPath}' '${FAKE_AGENT}' probe`, { waitPrompt: false });
    try {
      await waitFor('FAKE-AGENT probe listo', { source: screen });
      const tabs = (await wsState()).order.length;
      await page.keyboard.press('Control+t');
      await page.keyboard.press('Control+w');
      await sleep(600);
      const bytes = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      check(
        'Ctrl+T y Ctrl+W llegan al programa (0x14, 0x17) y no tocan las tabs',
        /(^|\s)14(\s|$)/m.test(bytes) && /(^|\s)17(\s|$)/m.test(bytes) && (await wsState()).order.length === tabs,
        bytes.replace(/\n/g, ' | ').slice(0, 80),
      );
    } finally {
      await exitToPrompt();
    }
  },

  async gpu() {
    // 18 terminals (17 tabs, one of them split): beyond Chromium's ~16 WebGL contexts, unless
    // hidden terminals release theirs.
    await freshTab();
    await page.keyboard.press('Alt+Shift+D');
    await waitPanes(2);
    const first = (await wsState()).active;
    const warningsBefore = consoleLog.length;
    await page.evaluate(() => {
      const s = window.__workspace.getState();
      for (let i = 0; i < 16; i++) s.newTab();
    });
    await sleep(1500);
    for (let i = 0; i < 17; i++) {
      await page.keyboard.press('Control+Tab');
      await sleep(120);
    }
    await page.click(tabSel(first));
    await sleep(600);
    const dom = await page.evaluate(() => {
      const panes = [...document.querySelectorAll('.terminal-pane')];
      const visible = panes.filter((p) => !p.hidden);
      return {
        total: panes.length,
        visibleWebgl: visible.filter((p) => p.dataset.renderer === 'webgl').length,
        visible: visible.length,
        hiddenWithCanvas: panes.filter((p) => p.hidden && p.querySelector('canvas')).length,
      };
    });
    const warnings = consoleLog.slice(warningsBefore).filter((m) => /WebGL/i.test(m));
    check(
      'WebGL solo en las terminales visibles (18 terminales, 2 visibles)',
      dom.total === 18 && dom.visible === 2 && dom.visibleWebgl === 2 && dom.hiddenWithCanvas === 0,
      JSON.stringify(dom),
    );
    check('sin avisos de contextos WebGL de más', warnings.length === 0, warnings.join(' | ').slice(0, 200));
    await freshTab();
  },

  async reload() {
    const pid = await shellPid();
    await page.reload();
    await page.waitForFunction(() => window.__terminal, null, { timeout: 30000 });
    await emulateFocus();
    await waitFor(/PS [A-Za-z]:\\.*>/, { timeout: 30000 });
    await sleep(1500);
    check('recargar la página cierra la sesión anterior', !alive(pid), `pid ${pid}`);
  },

  async restart() {
    const pid = await shellPid();
    await run('exit 3', { waitPrompt: false });
    await waitFor('Proceso finalizado con código 3', { timeout: 10000 });
    await sleep(500);
    check('exit muestra el código y libera la shell', !alive(pid));
    const before = prompts(await text());
    await page.keyboard.press('Enter');
    await waitFor((s) => prompts(s) > before, { timeout: 20000 });
    const pid2 = await shellPid();
    check('Enter abre una sesión nueva', pid2 !== pid && alive(pid2));
  },

  async close() {
    const shell = await shellPid();
    const child = Number(
      await value("(Start-Process ping -ArgumentList '-n','300','127.0.0.1' -WindowStyle Hidden -PassThru).Id", 'child'),
    );
    // charmap: a classic Win32 app that really is the shell's child. Visible, it stands for
    // `code .`/`notepad`; hidden, for windowless GUI processes such as headless browsers.
    const withGui = fs.existsSync('C:\\Windows\\System32\\charmap.exe');
    let visibleApp = 0;
    let hiddenApp = 0;
    if (withGui) {
      const ids = await value(
        '$( $v = Start-Process charmap -PassThru; $h = Start-Process charmap -WindowStyle Hidden -PassThru; ' +
          '$n = 0; while ((Get-Process -Id $v.Id).MainWindowHandle -eq 0 -and $n -lt 100) { Start-Sleep -Milliseconds 100; $n++ }; ' +
          "[string]$v.Id + ',' + $h.Id )",
        'gui',
      );
      [visibleApp, hiddenApp] = (ids ?? '').split(',').map(Number);
    } else skip('apps con ventana', 'no está charmap.exe');
    check('procesos de prueba corriendo antes de cerrar', [child, visibleApp, hiddenApp].every((p) => !p || alive(p)));

    win('close', appPid);
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      await sleep(200);
      gone = [appPid, shell, child, hiddenApp].every((p) => !p || !alive(p));
    }
    check('cerrar ventana: app, shell y procesos de consola terminados', gone, `app ${alive(appPid)} shell ${alive(shell)} nieto ${alive(child)}`);
    if (withGui) {
      check('cerrar ventana: proceso GUI sin ventana (tipo headless) terminado', !alive(hiddenApp));
      await sleep(500);
      check('cerrar ventana: app con ventana visible sobrevive', alive(visibleApp));
      if (alive(visibleApp)) process.kill(visibleApp);
    }
  },
};

// ---------------------------------------------------------------- main
const savedClipboard = await getClipboard();
let clipboardRestored = false;
const restoreClipboard = async () => {
  if (clipboardRestored || savedClipboard === null) return;
  clipboardRestored = true;
  await setClipboard(savedClipboard).catch(() => {});
};
try {
  for (const [name, stage] of Object.entries(stages)) {
    if (only && !only.includes(name)) continue;
    // The app is gone after "close": give the user's clipboard back while we still can.
    if (name === 'close') await restoreClipboard();
    const stageStarted = Date.now();
    try {
      await stage();
    } catch (error) {
      check(`etapa ${name}`, false, String(error.message ?? error).slice(0, 1500));
      await shot(`fail-${name}`).catch(() => {});
      await isolateAfterFailure().catch(() => {});
    }
    console.log(`== ${name}: ${((Date.now() - stageStarted) / 1000).toFixed(1)} s`);
  }
} finally {
  if (alive(appPid)) {
    await restoreClipboard();
    if (!ATTACH) win('close', appPid);
  }
  if (dev && !ATTACH) {
    await sleep(2000);
    try {
      execFileSync('taskkill', ['/PID', String(dev.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
  fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - failed}/${results.length} checks OK en ${Math.round((Date.now() - STARTED) / 1000)} s${SMOKE ? ' (smoke)' : ''}`,
);
process.exit(failed ? 1 : 0);
