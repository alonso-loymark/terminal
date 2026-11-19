import assert from 'node:assert/strict';
import test from 'node:test';
import type { Issue } from './schema.ts';
import { validateSettings } from './settingsSchema.ts';
import {
  BUILTIN_THEMES,
  allThemes,
  findTheme,
  luminance,
  mix,
  parseThemeSpec,
  resolveTheme,
  themesFromImport,
  themeToJson,
  withAlpha,
} from './themes.ts';

const DRACULA_WT = {
  name: 'Dracula WT',
  background: '#282A36',
  foreground: '#F8F8F2',
  cursorColor: '#F8F8F2',
  selectionBackground: '#44475A',
  black: '#21222C',
  blue: '#BD93F9',
  brightBlack: '#6272A4',
  brightBlue: '#D6ACFF',
  brightCyan: '#A4FFFF',
  brightGreen: '#69FF94',
  brightPurple: '#FF92DF',
  brightRed: '#FF6E6E',
  brightWhite: '#FFFFFF',
  brightYellow: '#FFFFA5',
  cyan: '#8BE9FD',
  green: '#50FA7B',
  purple: '#FF79C6',
  red: '#FF5555',
  white: '#F8F8F2',
  yellow: '#F1FA8C',
};

test('the built-in themes are complete and named', () => {
  const ids = BUILTIN_THEMES.map((t) => t.id);
  for (const id of ['dark', 'light', 'catppuccin', 'dracula', 'tokyo-night', 'one-dark']) assert.ok(ids.includes(id), id);
  for (const theme of allThemes([])) {
    assert.ok(Object.values(theme.terminal).every((c) => /^#[0-9a-f]{6}$/i.test(c)), theme.id);
    assert.ok(Object.values(theme.ui).every((c) => /^#[0-9a-f]{6}$/i.test(c)), theme.id);
  }
  assert.equal(resolveTheme('light', []).dark, false);
  assert.equal(resolveTheme('dark', []).dark, true);
  assert.equal(resolveTheme('Tokyo Night', []).id, 'tokyo-night', 'by label, any case');
  assert.equal(resolveTheme('no-existe', []).id, 'dark', 'unknown falls back to dark');
});

test('Windows Terminal schemes import: purple is magenta, cursorColor the cursor, UI derived', () => {
  const issues: Issue[] = [];
  const spec = parseThemeSpec(DRACULA_WT, 'themes[0]', issues);
  assert.equal(issues.length, 0);
  assert.equal(spec?.terminal.magenta, '#FF79C6');
  assert.equal(spec?.terminal.brightMagenta, '#FF92DF');
  assert.equal(spec?.terminal.cursor, '#F8F8F2');
  const theme = findTheme('dracula wt', [spec!]);
  assert.ok(theme && theme.dark && !theme.builtin);
  assert.equal(theme.ui.background, '#282A36');
  assert.equal(theme.ui.danger, '#FF5555');
  assert.notEqual(theme.ui.chrome, theme.ui.background, 'chrome derived darker');
});

test('our format: terminal and ui colors, missing ones filled by lightness', () => {
  const issues: Issue[] = [];
  const spec = parseThemeSpec({ name: 'Papel', terminal: { background: '#fdf6e3', foreground: '#657b83' }, ui: { accent: '#268bd2' } }, '', issues);
  assert.equal(issues.length, 0);
  const theme = findTheme('Papel', [spec!])!;
  assert.equal(theme.dark, false);
  assert.equal(theme.ui.accent, '#268bd2');
  assert.equal(theme.terminal.red, resolveTheme('light', []).terminal.red, 'palette from the light base');
  assert.deepEqual(themeToJson(spec!), { name: 'Papel', terminal: spec!.terminal, ui: { accent: '#268bd2' } });
});

test('bad themes are explained', () => {
  const issues: Issue[] = [];
  assert.equal(parseThemeSpec({ background: '#000' }, 'themes[1]', issues), null);
  assert.equal(issues[0]?.path, 'themes[1].name');
  const colors: Issue[] = [];
  parseThemeSpec({ name: 'x', background: 'rojo', sparkle: '#fff' }, 't', colors);
  assert.deepEqual(
    colors.map((i) => [i.path, i.severity]),
    [
      ['t.background', 'error'],
      ['t.sparkle', 'warning'],
    ],
  );
  // In settings.json, a broken theme rejects the file like any other error.
  assert.equal(validateSettings({ themes: [{ name: 'x', red: 'no' }] }).settings, null);
  assert.equal(validateSettings({ themes: [DRACULA_WT] }).settings?.themes[0]?.name, 'Dracula WT');
});

test('imports accept one theme, a list or a Windows Terminal "schemes" fragment', () => {
  assert.equal(themesFromImport(DRACULA_WT).themes.length, 1);
  assert.equal(themesFromImport([DRACULA_WT, { ...DRACULA_WT, name: 'Otro' }]).themes.length, 2);
  assert.equal(themesFromImport({ schemes: [DRACULA_WT] }).themes[0]?.name, 'Dracula WT');
  const empty = themesFromImport({ name: 'sin colores' });
  assert.equal(empty.themes.length, 0);
  assert.match(empty.issues[0]?.message ?? '', /colores/);
});

test('custom themes shadow built-ins with the same name', () => {
  const mine = parseThemeSpec({ ...DRACULA_WT, name: 'Dracula', background: '#000000' }, '', [])!;
  assert.equal(resolveTheme('dracula', [mine]).terminal.background, '#000000');
  assert.equal(allThemes([mine]).filter((t) => t.label === 'Dracula').length, 1);
});

test('color helpers', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(withAlpha('#0d1117', 0.8), '#0d1117cc');
  assert.ok(luminance('#ffffff') > 0.99 && luminance('#000') < 0.01);
});
