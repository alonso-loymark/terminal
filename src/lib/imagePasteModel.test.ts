import assert from 'node:assert/strict';
import test from 'node:test';
import { IMAGE_PASTE_KEYS, RAW_CTRL_V, imagePastePlan, imagePathText, isPng } from './imagePasteModel.ts';

test('auto: each agent gets the key it reads the clipboard on; without an agent, the file', () => {
  assert.deepEqual(imagePastePlan('auto', 'claude'), { kind: 'key', data: '\x1bv', label: 'Alt+V' });
  for (const agent of ['codex', 'gemini', 'agy'] as const) {
    assert.deepEqual(imagePastePlan('auto', agent), { kind: 'key', data: '\x16', label: 'Ctrl+V' });
  }
  assert.deepEqual(imagePastePlan('auto', null), { kind: 'file' });
});

test('key: always a key (a raw Ctrl+V for any program); path: always the file', () => {
  assert.deepEqual(imagePastePlan('key', null), { kind: 'key', data: RAW_CTRL_V, label: 'Ctrl+V' });
  assert.equal(imagePastePlan('key', 'claude').kind, 'key');
  assert.deepEqual(imagePastePlan('path', 'claude'), { kind: 'file' });
  assert.deepEqual(imagePastePlan('path', null), { kind: 'file' });
  // Every agent the backend recognizes has its key.
  assert.deepEqual(Object.keys(IMAGE_PASTE_KEYS).sort(), ['agy', 'claude', 'codex', 'gemini']);
});

test('the path: double quotes for an agent, the shell quoting otherwise', () => {
  const path = 'C:\\Users\\ALONSO~1\\AppData\\Local\\Temp\\brisa-images\\brisa-1.png';
  assert.equal(imagePathText(path, 'claude', 'gitbash'), `"${path}" `);
  assert.equal(imagePathText(path, null, 'powershell'), `'${path}' `);
  assert.equal(imagePathText(path, null, 'cmd'), `"${path}" `);
  assert.equal(imagePathText(path, null, 'gitbash'), "'/c/Users/ALONSO~1/AppData/Local/Temp/brisa-images/brisa-1.png' ");
  assert.equal(imagePathText("C:\\Users\\O'Brien\\x.png", null, 'powershell'), "'C:\\Users\\O''Brien\\x.png' ");
});

test('PNG by its signature', () => {
  assert.equal(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), true);
  assert.equal(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), false);
  assert.equal(isPng(new Uint8Array()), false);
});
