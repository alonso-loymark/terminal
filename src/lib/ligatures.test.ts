import assert from 'node:assert/strict';
import test from 'node:test';
import { ligatureRanges } from './ligatures.ts';

test('ligatures: the longest sequence wins, plain text is left alone', () => {
  assert.deepEqual(ligatureRanges('a => b'), [[2, 4]]);
  assert.deepEqual(ligatureRanges('x === y'), [[2, 5]]);
  assert.deepEqual(ligatureRanges('a !== b && c -> d'), [
    [2, 5],
    [13, 15],
  ]);
  assert.deepEqual(ligatureRanges('<!-- comentario -->'), [
    [0, 4],
    [16, 19],
  ]);
  assert.deepEqual(ligatureRanges('PS C:\\Users> dir'), []);
});
