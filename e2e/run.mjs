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
const only = process.argv[2]?.split(',').filter(Boolean);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-e2e-'));
fs.mkdirSync(ARTIFACTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
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
  await waitUntil(async () => (await wsState()).order.length === before + 1, 5000);
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
    const fresh = s.newTab();
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
/** Starts from a single fresh tab (closing the rest, without dialogs). */
async function freshTab() {
  await page.evaluate(() => {
    const s = window.__workspace.getState();
    const fresh = s.newTab();
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
      await run(`& '${agentExe(agent)}' '${FAKE_AGENT}'`, { waitPrompt: false });
      try {
        await waitFor(`FAKE-AGENT ${agent} listo`, { source: screen });
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
    try {
      await stage();
    } catch (error) {
      check(`etapa ${name}`, false, String(error.message ?? error).slice(0, 1500));
      await shot(`fail-${name}`).catch(() => {});
      await isolateAfterFailure().catch(() => {});
    }
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
console.log(`\n${results.length - failed}/${results.length} checks OK`);
process.exit(failed ? 1 : 0);
