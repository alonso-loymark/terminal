import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIONS,
  blocksTyping,
  conflictsFor,
  eventKeys,
  formatKey,
  keybindingsSchema,
  keyFromEvent,
  keymapConflicts,
  normalizeKey,
  resolveKeymap,
  type KeyEventLike,
} from './keybindings.ts';
import type { Issue } from './schema.ts';

const ev = (key: string, code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

test('keys are written in any case and order, and normalized', () => {
  assert.equal(normalizeKey('Ctrl+Shift+T'), 'ctrl+shift+t');
  assert.equal(normalizeKey('shift + ctrl + t'), 'ctrl+shift+t');
  assert.equal(normalizeKey('Alt+ArrowLeft'), 'alt+left');
  assert.equal(normalizeKey('ctrl++'), 'ctrl++');
  assert.equal(normalizeKey('ctrl+plus'), 'ctrl++');
  assert.equal(normalizeKey('Supr'), 'delete');
  assert.equal(normalizeKey('Shift+F10'), 'shift+f10');
  assert.equal(normalizeKey('ctrl+ñ'), 'ctrl+ñ');
  assert.equal(normalizeKey('ctrl+shfit+t'), null);
  assert.equal(normalizeKey('ctrl+'), null);
  assert.equal(normalizeKey('ctrl+ctrl+a'), null);
  assert.equal(normalizeKey('ctrl+f25'), null);
  assert.equal(formatKey('ctrl+shift+t'), 'Ctrl+Shift+T');
  assert.equal(formatKey('alt+left'), 'Alt+←');
  assert.equal(formatKey('delete'), 'Supr');
  assert.equal(formatKey('ctrl+,'), 'Ctrl+,');
});

test('every default key is valid and normalized; ids are unique', () => {
  const ids = new Set<string>();
  for (const action of ACTIONS) {
    assert.ok(!ids.has(action.id), action.id);
    ids.add(action.id);
    for (const key of action.keys) assert.equal(normalizeKey(key), key, `${action.id}: ${key}`);
  }
});

test('events map to the keys they stand for, on US and Spanish layouts', () => {
  assert.deepEqual(eventKeys(ev('T', 'KeyT', { ctrlKey: true, shiftKey: true }))[0], 'ctrl+shift+t');
  assert.ok(eventKeys(ev('ArrowLeft', 'ArrowLeft', { altKey: true })).includes('alt+left'));
  assert.ok(eventKeys(ev('Tab', 'Tab', { ctrlKey: true, shiftKey: true })).includes('ctrl+shift+tab'));
  // Ctrl+Shift+1 types "!" on a US keyboard: still the 1 key.
  assert.ok(eventKeys(ev('!', 'Digit1', { ctrlKey: true, shiftKey: true })).includes('ctrl+shift+1'));
  // Alt+Shift+- types "_" (US and Spanish): the binding says "-".
  assert.ok(eventKeys(ev('_', 'Slash', { altKey: true, shiftKey: true })).includes('alt+shift+-'));
  // The numpad minus with Shift still says "-".
  assert.ok(eventKeys(ev('-', 'NumpadSubtract', { altKey: true, shiftKey: true })).includes('alt+shift+-'));
  // "ctrl++": Ctrl+Shift+= on US, Ctrl and the + key on Spanish, Ctrl+Num+.
  assert.ok(eventKeys(ev('+', 'Equal', { ctrlKey: true, shiftKey: true })).includes('ctrl++'));
  assert.ok(eventKeys(ev('+', 'BracketRight', { ctrlKey: true })).includes('ctrl++'));
  assert.ok(eventKeys(ev('+', 'NumpadAdd', { ctrlKey: true })).includes('ctrl++'));
  // Ctrl+Shift+, is not Ctrl+, (settings).
  assert.ok(!eventKeys(ev('<', 'Comma', { ctrlKey: true, shiftKey: true })).includes('ctrl+,'));
  assert.ok(eventKeys(ev(',', 'Comma', { ctrlKey: true })).includes('ctrl+,'));
  // A non-Latin layout: the physical key.
  assert.ok(eventKeys(ev('и', 'KeyB', { ctrlKey: true })).includes('ctrl+b'));
  // Dvorak: Ctrl and the key that types x is Ctrl+X, not Ctrl+B.
  assert.deepEqual(eventKeys(ev('x', 'KeyB', { ctrlKey: true })), ['ctrl+x']);
  // AltGr (Ctrl+Alt) typing "@" on a Spanish keyboard is only "@", never Ctrl+Alt+2.
  assert.deepEqual(eventKeys(ev('@', 'Digit2', { ctrlKey: true, altKey: true })), ['ctrl+alt+@']);
  assert.deepEqual(eventKeys(ev('Shift', 'ShiftLeft', { shiftKey: true })), []);
  assert.deepEqual(eventKeys(ev(' ', 'Space', { ctrlKey: true })), ['ctrl+space']);
  assert.deepEqual(eventKeys(ev('Enter', 'Enter', { shiftKey: true })), ['shift+enter']);
});

test('the user overrides keys per action; [] removes them; their own keys come first', () => {
  const keymap = resolveKeymap({ 'explorer.toggle': [], 'app.commandPalette': ['ctrl+shift+p', 'ctrl+b'] });
  assert.deepEqual(keymap.bindings['explorer.toggle'], []);
  assert.deepEqual(keymap.bindings['tab.new'], ['ctrl+shift+t']);
  assert.deepEqual(keymap.byKey.get('ctrl+b'), ['app.commandPalette']);
  assert.ok(keymap.customized.has('explorer.toggle'));
  assert.ok(!keymap.customized.has('tab.new'));
  // An override equal to the default is not a customization.
  assert.ok(!resolveKeymap({ 'tab.new': ['ctrl+shift+t'] }).customized.has('tab.new'));
  // A key on two actions: the user's own binding wins the dispatch.
  const clash = resolveKeymap({ 'app.commandPalette': ['ctrl+shift+t'] });
  assert.deepEqual(clash.byKey.get('ctrl+shift+t'), ['app.commandPalette', 'tab.new']);
});

test('conflicts: duplicates across overlapping scopes, keys programs use, keys that type', () => {
  const defaults = keymapConflicts(resolveKeymap());
  // The defaults clash with nothing; Ctrl+B is taken from readline/tmux on purpose (warned).
  assert.deepEqual(defaults.filter((c) => c.kind !== 'reserved'), []);
  assert.deepEqual(
    defaults.map((c) => c.key),
    ['ctrl+b'],
  );
  // F2 renames a tab and, in the explorer, a file: different scopes, no conflict.
  assert.ok(!defaults.some((c) => c.key === 'f2'));
  // Ctrl+C copies only with a selection (otherwise the program gets it): not a conflict.
  assert.ok(!defaults.some((c) => c.key === 'ctrl+c'));

  const user = keymapConflicts(resolveKeymap({ 'tab.new': ['ctrl+shift+t', 'ctrl+r'], 'pane.close': ['ctrl+shift+t'] }));
  assert.ok(user.some((c) => c.kind === 'duplicate' && c.key === 'ctrl+shift+t' && c.actions.includes('pane.close') && c.actions.includes('tab.new')));
  assert.ok(user.some((c) => c.kind === 'reserved' && c.key === 'ctrl+r' && /historial/.test(c.message)));

  assert.ok(blocksTyping('a'));
  assert.ok(blocksTyping('shift+a'));
  assert.ok(blocksTyping('space'));
  assert.ok(blocksTyping('enter'));
  assert.ok(!blocksTyping('shift+enter'));
  assert.ok(!blocksTyping('f2'));
  assert.ok(!blocksTyping('ctrl+a'));
  assert.ok(!blocksTyping('delete'));

  const before = conflictsFor(resolveKeymap(), 'app.commandPalette', 'ctrl+shift+t');
  assert.equal(before[0]?.kind, 'duplicate');
  assert.deepEqual(conflictsFor(resolveKeymap(), 'app.commandPalette', 'ctrl+shift+k'), []);
  assert.equal(conflictsFor(resolveKeymap(), 'tab.new', 'ctrl+w')[0]?.kind, 'reserved');
});

test('settings.json keybindings: strings or lists, validated and normalized', () => {
  const schema = keybindingsSchema();
  const issues: Issue[] = [];
  const parsed = schema.parse(
    { 'tab.new': 'Ctrl+Shift+N', 'explorer.toggle': [], 'pane.close': ['ctrl+shift+w', 'Ctrl+Shift+W', 'alt+w'], 'no.existe': 'f5' },
    'keybindings',
    issues,
  );
  assert.deepEqual(parsed, { 'tab.new': ['ctrl+shift+n'], 'explorer.toggle': [], 'pane.close': ['ctrl+shift+w', 'alt+w'] });
  assert.deepEqual(
    issues.map((i) => [i.path, i.severity]),
    [['keybindings.no.existe', 'warning']],
  );

  const bad: Issue[] = [];
  schema.parse({ 'tab.new': 'ctrl+shfit+t', 'tab.close': 'x', 'tab.next': 3, 'explorer.rename': 'r' }, 'keybindings', bad);
  assert.deepEqual(
    bad.map((i) => [i.path, i.severity]),
    [
      ['keybindings.tab.new', 'error'],
      ['keybindings.tab.close', 'error'],
      ['keybindings.tab.next', 'error'],
    ],
  );
  const json = schema.json() as { properties: Record<string, { description: string }> };
  assert.match(json.properties['tab.new']?.description ?? '', /Nueva tab\. Por defecto: Ctrl\+Shift\+T/);
});

test('a recorded key press is stored in its readable form', () => {
  assert.equal(keyFromEvent(ev('!', 'Digit1', { ctrlKey: true, shiftKey: true })), 'ctrl+shift+1');
  assert.equal(keyFromEvent(ev('_', 'Slash', { altKey: true, shiftKey: true })), 'alt+shift+-');
  assert.equal(keyFromEvent(ev('K', 'KeyK', { ctrlKey: true, shiftKey: true })), 'ctrl+shift+k');
  assert.equal(keyFromEvent(ev('F5', 'F5')), 'f5');
  assert.equal(keyFromEvent(ev('ArrowUp', 'ArrowUp', { altKey: true })), 'alt+up');
  assert.equal(keyFromEvent(ev('@', 'Digit2', { ctrlKey: true, altKey: true })), 'ctrl+alt+@');
  assert.equal(keyFromEvent(ev('Control', 'ControlLeft', { ctrlKey: true })), null);
});
