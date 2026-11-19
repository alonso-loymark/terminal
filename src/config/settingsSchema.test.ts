import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, settingsJsonSchema, validateSettings } from './settingsSchema.ts';
import { editText, evaluate, NEW_FILE, parseText, settingEdit } from '../lib/settingsText.ts';

test('an empty file means every default', () => {
  const { settings, issues } = validateSettings({});
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.equal(issues.length, 0);
  assert.equal(DEFAULT_SETTINGS.appearance.fontSize, 14);
  assert.equal(DEFAULT_SETTINGS.terminal.rightClick, 'copyPaste');
  assert.equal(DEFAULT_SETTINGS.explorer.folderClick, 'cd');
  assert.equal(DEFAULT_SETTINGS.profiles.default, null);
  assert.deepEqual(evaluate(null).settings, DEFAULT_SETTINGS, 'no file yet');
  assert.deepEqual(evaluate(NEW_FILE).settings, DEFAULT_SETTINGS, 'a new file');
});

test('values are merged over the defaults', () => {
  const { settings, issues } = validateSettings({ appearance: { fontSize: 18, cursorStyle: 'block' }, terminal: { copyOnSelect: true } });
  assert.equal(issues.length, 0);
  assert.equal(settings?.appearance.fontSize, 18);
  assert.equal(settings?.appearance.cursorStyle, 'block');
  assert.equal(settings?.appearance.lineHeight, DEFAULT_SETTINGS.appearance.lineHeight, 'untouched keys keep their default');
  assert.equal(settings?.terminal.copyOnSelect, true);
});

test('type errors reject the whole file, with the path of each problem', () => {
  const { settings, issues } = validateSettings({
    appearance: { fontSize: 'grande', lineHeight: 9, cursorStyle: 'triangle', padding: 2.5 },
    explorer: { visible: 'si' },
    profiles: { list: [{ args: 'no es lista' }] },
  });
  assert.equal(settings, null);
  const byPath = Object.fromEntries(issues.map((i) => [i.path, i.message]));
  assert.match(byPath['appearance.fontSize']!, /número/);
  assert.match(byPath['appearance.lineHeight']!, /entre 0.8 y 3/);
  assert.match(byPath['appearance.cursorStyle']!, /block, bar, underline/);
  assert.match(byPath['appearance.padding']!, /entero/);
  assert.match(byPath['explorer.visible']!, /true o false/);
  assert.match(byPath['profiles.list[0].args']!, /lista/);
  assert.ok(issues.every((i) => i.severity === 'error'));
});

test('unknown keys are warnings: the rest still applies', () => {
  const { settings, issues } = validateSettings({ $schema: './settings.schema.json', appearance: { fontSise: 20, fontSize: 16 }, extra: 1 });
  assert.equal(settings?.appearance.fontSize, 16);
  assert.deepEqual(
    issues.map((i) => [i.path, i.severity]),
    [
      ['appearance.fontSise', 'warning'],
      ['extra', 'warning'],
    ],
  );
});

test('syntax errors carry line and column; comments and trailing commas are fine', () => {
  const ok = evaluate('{\n  // tamaño\n  "appearance": { "fontSize": 20, },\n}');
  assert.equal(ok.settings?.appearance.fontSize, 20);
  assert.equal(ok.issues.length, 0);
  const broken = evaluate('{\n  "appearance": {\n    "fontSize": 20\n    "lineHeight": 1.2\n  }\n}');
  assert.equal(broken.settings, null);
  assert.equal(broken.issues[0]?.message, 'falta una coma');
  assert.equal(broken.issues[0]?.line, 4);
  const path = parseText('{ "cwd": "C:\\Users" }');
  assert.match(path.issues[0]?.message ?? '', /escape/, 'an unescaped backslash in a path is explained');
});

test('edits keep comments and formatting, and defaults are removed', () => {
  const text = '{\n  "$schema": "./settings.schema.json",\n  // mi fuente\n  "appearance": {\n    "fontSize": 18\n  }\n}\n';
  const bigger = editText(text, [settingEdit(['appearance', 'fontSize'], 20, 14)]);
  assert.match(bigger, /\/\/ mi fuente/);
  assert.match(bigger, /"fontSize": 20/);
  const added = editText(bigger, [settingEdit(['terminal', 'copyOnSelect'], true, false)]);
  assert.equal(evaluate(added).settings?.terminal.copyOnSelect, true);
  const back = editText(added, [settingEdit(['appearance', 'fontSize'], 14, 14)]);
  assert.doesNotMatch(back, /fontSize/, 'the default value is not written');
  assert.match(back, /\/\/ mi fuente/);
  // No file yet: the edit creates one with the schema reference.
  const fresh = editText(null, [settingEdit(['theme'], 'dracula', 'dark')]);
  assert.match(fresh, /"\$schema": "\.\/settings\.schema\.json"/);
  assert.equal(evaluate(fresh).settings?.theme, 'dracula');
  // Back to the default where the file never set it: nothing to remove, nothing changes.
  assert.equal(editText(NEW_FILE, [settingEdit(['explorer', 'visible'], true, true)]), NEW_FILE);
  assert.equal(editText(null, [[['profiles', 'list', 3, 'name'], undefined]]), NEW_FILE);
  // Array items (profiles) are edited in place too.
  const profiles = editText(null, [[['profiles', 'list'], [{ id: 'cmd', hidden: true }]]]);
  const renamed = editText(profiles, [[['profiles', 'list', 0, 'name'], 'CMD']]);
  assert.deepEqual(evaluate(renamed).settings?.profiles.list[0], { id: 'cmd', hidden: true, name: 'CMD', icon: undefined, command: undefined, args: undefined, cwd: undefined, env: undefined, theme: undefined });
});

test('the JSON Schema documents every setting and suggests names', () => {
  const schema = settingsJsonSchema(['pwsh', 'cmd'], ['Mi tema']) as {
    properties: Record<string, { properties?: Record<string, { description?: string; anyOf?: unknown[] }> ; anyOf?: unknown[] }>;
  };
  assert.ok(schema.properties.appearance?.properties?.fontSize?.description);
  assert.ok(schema.properties.$schema, '$schema is allowed');
  const theme = JSON.stringify(schema.properties.theme);
  assert.match(theme, /dracula/);
  assert.match(theme, /Mi tema/);
  assert.match(JSON.stringify(schema.properties.profiles), /"pwsh"/);
  assert.doesNotMatch(JSON.stringify(schema), /undefined/);
});

test('a section left empty by going back to the defaults is removed, unless it has a comment', () => {
  const on = editText(NEW_FILE, [settingEdit(['explorer', 'visible'], false, true)]);
  assert.match(on, /"visible": false/);
  assert.equal(editText(on, [settingEdit(['explorer', 'visible'], true, true)]), NEW_FILE);
  const keys = editText(NEW_FILE, [[['keybindings', 'tab.new'], ['ctrl+shift+n']]]);
  assert.equal(editText(keys, [[['keybindings', 'tab.new'], undefined]]), NEW_FILE);
  const commented = '{\n  // mi explorador\n  "explorer": { "visible": false }\n}\n';
  assert.match(editText(commented, [settingEdit(['explorer', 'visible'], true, true)]), /\/\/ mi explorador/);
});
