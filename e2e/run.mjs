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
await page.waitForFunction(() => window.__terminal, null, { timeout: 60000 });
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
/** Types a command at the shell prompt. Refuses to type anywhere else (e.g. into a TUI). */
async function run(cmd, { waitPrompt = true } = {}) {
  if (!(await waitUntil(atShellPrompt, 5000))) throw new Error(`sin prompt de PowerShell; no se tipea: ${cmd}`);
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
      const box = await page.locator('.terminal-host').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    });
  },

  async search() {
    await page.keyboard.press('Control+Shift+F');
    await page.waitForSelector('.search-bar input', { timeout: 3000 });
    await page.keyboard.type('copiame');
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
    check('Esc cierra la búsqueda y devuelve el foco', !state.open && state.focus);
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
      const s = await waitFor(/SUBMIT "linea uno/, { source: screen });
      check('agente falso: pegado multilínea llega como un solo input', s.includes('SUBMIT "linea uno\\nlinea dos"'));
      await shot('06-agent');
    } finally {
      check('agente falso: Ctrl+C dos veces sale al prompt', await exitToPrompt());
    }
  },

  async reload() {
    const pid = await shellPid();
    await page.reload();
    await page.waitForFunction(() => window.__terminal, null, { timeout: 30000 });
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
    check('nieto oculto corriendo antes de cerrar', alive(child));
    win('close', appPid);
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      await sleep(200);
      gone = !alive(appPid) && !alive(shell) && !alive(child);
    }
    check('cerrar ventana: app, shell y nieto terminados', gone, `app ${alive(appPid)} shell ${alive(shell)} nieto ${alive(child)}`);
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
