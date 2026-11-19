// Unit tests for the explorer's pure logic (npm test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  breadcrumbs,
  cdCommand,
  flattenTree,
  gitDecorations,
  gitStatusOf,
  isInside,
  joinPath,
  normalizePath,
  parentDir,
  pathKey,
  quotePath,
  relativePath,
  toMsysPath,
  toWslPath,
  visibleDirs,
  type DirEntry,
  type Listing,
} from './explorerModel.ts';

test('paths: normalize, join, parent, inside, relative', () => {
  assert.equal(normalizePath('C:/Users/Ana/'), 'C:\\Users\\Ana');
  assert.equal(normalizePath('c:'), 'C:\\');
  assert.equal(joinPath('C:\\', 'x'), 'C:\\x');
  assert.equal(joinPath('C:\\a', 'b c'), 'C:\\a\\b c');
  assert.equal(parentDir('C:\\a\\b'), 'C:\\a');
  assert.equal(parentDir('C:\\a'), 'C:\\');
  assert.equal(parentDir('C:\\'), null);
  assert.equal(parentDir('\\\\srv\\share'), null);
  assert.equal(parentDir('\\\\srv\\share\\x'), '\\\\srv\\share');
  assert.ok(isInside('c:\\USERS\\ana\\x', 'C:\\Users\\Ana'));
  assert.ok(isInside('C:\\Users\\Ana', 'c:\\users\\ana\\'));
  assert.ok(!isInside('C:\\Users\\Anabel', 'C:\\Users\\Ana'));
  assert.ok(isInside('C:\\x', 'C:\\'));
  assert.equal(relativePath('C:\\proj', 'C:\\proj\\src\\a b.ts'), 'src\\a b.ts');
  assert.equal(relativePath('C:\\proj\\src', 'C:\\proj\\docs\\x.md'), '..\\docs\\x.md');
  assert.equal(relativePath('C:\\proj', 'c:\\PROJ'), '.');
  assert.equal(relativePath('C:\\proj', 'D:\\otro\\x'), 'D:\\otro\\x');
});

test('breadcrumbs: drive and UNC roots, accents', () => {
  assert.deepEqual(breadcrumbs('C:\\Users\\Ana María\\Ñandú'), [
    { label: 'C:', path: 'C:\\' },
    { label: 'Users', path: 'C:\\Users' },
    { label: 'Ana María', path: 'C:\\Users\\Ana María' },
    { label: 'Ñandú', path: 'C:\\Users\\Ana María\\Ñandú' },
  ]);
  assert.deepEqual(breadcrumbs('C:\\'), [{ label: 'C:', path: 'C:\\' }]);
  assert.deepEqual(breadcrumbs('\\\\srv\\share\\docs'), [
    { label: '\\\\srv\\share', path: '\\\\srv\\share' },
    { label: 'docs', path: '\\\\srv\\share\\docs' },
  ]);
});

test('quoting for PowerShell and Git Bash', () => {
  assert.equal(quotePath('C:\\Users\\Ana María\\a.txt', 'powershell'), "'C:\\Users\\Ana María\\a.txt'");
  assert.equal(quotePath("C:\\it's\\o\u2019brien", null), "'C:\\it''s\\o\u2019\u2019brien'");
  assert.equal(quotePath('C:\\$env:x `n\\y', 'powershell'), "'C:\\$env:x `n\\y'", 'no expansion inside single quotes');
  assert.equal(toMsysPath('C:\\Users\\Ana\\x'), '/c/Users/Ana/x');
  assert.equal(toMsysPath('D:\\'), '/d');
  assert.equal(toMsysPath('\\\\srv\\share\\x'), '//srv/share/x');
  assert.equal(quotePath("C:\\it's here\\$HOME", 'gitbash'), "'/c/it'\\''s here/$HOME'");
  assert.equal(cdCommand('C:\\a b', 'powershell'), "Set-Location -LiteralPath 'C:\\a b'");
  assert.equal(cdCommand('C:\\a b', 'gitbash'), "cd -- '/c/a b'");
});

test('quoting for pwsh, cmd, WSL and other programs', () => {
  assert.equal(quotePath("C:\\it's", 'pwsh'), "'C:\\it''s'");
  assert.equal(cdCommand('C:\\a b', 'pwsh'), "Set-Location -LiteralPath 'C:\\a b'");
  assert.equal(quotePath('C:\\Users\\Ana María\\a.txt', 'cmd'), '"C:\\Users\\Ana María\\a.txt"');
  assert.equal(cdCommand('D:\\a b', 'cmd'), 'cd /d "D:\\a b"', '/d also changes the drive');
  assert.equal(toWslPath('C:\\Users\\Ana\\x'), '/mnt/c/Users/Ana/x');
  assert.equal(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\ana'), '/home/ana');
  assert.equal(toWslPath('\\\\wsl$\\Debian'), '/');
  assert.equal(quotePath("C:\\it's", 'wsl'), "'/mnt/c/it'\\''s'");
  assert.equal(cdCommand('C:\\a b', 'wsl'), `cd -- "$(wslpath -u 'C:\\a b')"`);
  assert.equal(quotePath('C:\\a b', 'other'), '"C:\\a b"');
});

const dir = (path: string, entries: DirEntry[]): Listing => ({ path, status: 'ok', entries, error: null });
const e = (path: string, kind: 'dir' | 'file', hidden: DirEntry['hidden'] = null): DirEntry => ({
  name: path.slice(path.lastIndexOf('\\') + 1),
  path,
  kind,
  hidden,
  link: false,
});

test('tree: lazy expansion, hidden entries and their children, messages', () => {
  const listings: Record<string, Listing> = {
    [pathKey('C:\\p')]: dir('C:\\p', [e('C:\\p\\src', 'dir'), e('C:\\p\\node_modules', 'dir', 'default'), e('C:\\p\\a.ts', 'file')]),
    [pathKey('C:\\p\\node_modules')]: dir('C:\\p\\node_modules', [e('C:\\p\\node_modules\\x', 'dir')]),
  };
  const names = (rows: ReturnType<typeof flattenTree>) =>
    rows.map((r) => (r.type === 'entry' ? `${'  '.repeat(r.depth)}${r.name}${r.hidden ? ` (${r.hidden})` : ''}` : `${'  '.repeat(r.depth)}[${r.type === 'message' ? r.text : 'nuevo'}]`));
  let rows = flattenTree({ root: 'C:\\p', listings, expanded: {}, showHidden: false });
  assert.deepEqual(names(rows), ['src', 'a.ts']);
  // Expanded but not loaded yet: a loading row.
  rows = flattenTree({ root: 'C:\\p', listings, expanded: { [pathKey('C:\\p\\src')]: true }, showHidden: false });
  assert.deepEqual(names(rows), ['src', '  [Cargando…]', 'a.ts']);
  // Hidden shown: children of a hidden folder inherit its reason.
  rows = flattenTree({ root: 'C:\\p', listings, expanded: { [pathKey('C:\\p\\node_modules')]: true }, showHidden: true });
  assert.deepEqual(names(rows), ['src', 'node_modules (default)', '  x (default)', 'a.ts']);
  assert.deepEqual(visibleDirs('C:\\p', rows), ['C:\\p', 'C:\\p\\node_modules']);
  // New file input at the top of its folder; empty folders say so.
  listings[pathKey('C:\\p\\src')] = dir('C:\\p\\src', []);
  rows = flattenTree({ root: 'C:\\p', listings, expanded: { [pathKey('C:\\p\\src')]: true }, showHidden: false });
  assert.deepEqual(names(rows), ['src', '  [Carpeta vacía]', 'a.ts']);
  rows = flattenTree({ root: 'C:\\p', listings, expanded: { [pathKey('C:\\p\\src')]: true }, showHidden: false, creating: { dir: 'C:\\p\\src', kind: 'file' } });
  assert.deepEqual(names(rows), ['src', '  [nuevo]', 'a.ts']);
  listings[pathKey('C:\\p\\src')] = { path: 'C:\\p\\src', status: 'error', entries: [], error: 'acceso denegado' };
  rows = flattenTree({ root: 'C:\\p', listings, expanded: { [pathKey('C:\\p\\src')]: true }, showHidden: false });
  assert.deepEqual(names(rows), ['src', '  [acceso denegado]', 'a.ts']);
});

test('tree: thousands of entries flatten quickly', () => {
  const entries = Array.from({ length: 20000 }, (_, i) => e(`C:\\big\\f${i}.txt`, 'file'));
  const started = performance.now();
  const rows = flattenTree({ root: 'C:\\big', listings: { [pathKey('C:\\big')]: dir('C:\\big', entries) }, expanded: {}, showHidden: false });
  assert.equal(rows.length, 20000);
  assert.ok(performance.now() - started < 200, 'flatten took too long');
});

test('git decorations: files, folders up to the root, untracked folders', () => {
  const deco = gitDecorations({
    root: 'C:\\repo',
    branch: 'main',
    commit: null,
    ahead: 0,
    behind: 0,
    changes: [
      { path: 'src/app.ts', status: 'modified' },
      { path: 'src/nuevo.ts', status: 'untracked' },
      { path: 'docs/añadido.md', status: 'added' },
      { path: 'sin seguir/', status: 'untracked' },
    ],
  });
  assert.equal(gitStatusOf('C:\\repo\\src\\app.ts', deco), 'modified');
  assert.equal(gitStatusOf('c:\\REPO\\src', deco), 'modified', 'folder takes the strongest change inside');
  assert.equal(gitStatusOf('C:\\repo\\docs', deco), 'added');
  assert.equal(gitStatusOf('C:\\repo\\docs\\añadido.md', deco), 'added');
  assert.equal(gitStatusOf('C:\\repo\\sin seguir\\a\\b.txt', deco), 'untracked');
  assert.equal(gitStatusOf('C:\\repo\\limpio.txt', deco), null);
  assert.equal(gitStatusOf('C:\\repo', deco), 'modified');
});
