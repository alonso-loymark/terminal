import assert from 'node:assert/strict';
import test from 'node:test';
import { fuzzyMatch, highlightRuns } from './fuzzy.ts';

const rank = (query: string, items: string[]) =>
  items
    .map((text) => ({ text, match: fuzzyMatch(query, text) }))
    .filter((r) => r.match)
    .sort((a, b) => b.match!.score - a.match!.score)
    .map((r) => r.text);

test('characters in order, ignoring case and accents', () => {
  assert.ok(fuzzyMatch('ntab', 'Nueva tab'));
  assert.ok(fuzzyMatch('configuracion', 'Configuración'));
  assert.ok(fuzzyMatch('CONFIG', 'Configuración'));
  assert.equal(fuzzyMatch('tabn', 'Nueva tab'), null);
  assert.equal(fuzzyMatch('xyz', 'Nueva tab'), null);
  assert.deepEqual(fuzzyMatch('', 'Lo que sea'), { score: 0, positions: [] });
});

test('each word on its own, in any order', () => {
  assert.ok(fuzzyMatch('dracula tema', 'Tema: Dracula'));
  assert.ok(fuzzyMatch('tema dracula', 'Tema: Dracula'));
  assert.equal(fuzzyMatch('tema solarized', 'Tema: Dracula'), null);
});

test('word starts and runs rank first', () => {
  assert.deepEqual(rank('nt', ['Cerrar las demás tabs', 'Nueva tab', 'Mostrar el explorador']).slice(0, 1), ['Nueva tab']);
  assert.equal(rank('div', ['Ir al panel de la izquierda', 'Dividir el panel a la derecha'])[0], 'Dividir el panel a la derecha');
  assert.equal(rank('expl', ['Ir al panel de la izquierda', 'Mostrar / ocultar el explorador', 'Abrir layouts.json'])[0], 'Mostrar / ocultar el explorador');
  // The positions point at the word starts.
  assert.deepEqual(fuzzyMatch('nt', 'Nueva tab')?.positions, [0, 6]);
});

test('highlight runs', () => {
  assert.deepEqual(highlightRuns('Nueva tab', [0, 6]), [
    { text: 'N', hit: true },
    { text: 'ueva ', hit: false },
    { text: 't', hit: true },
    { text: 'ab', hit: false },
  ]);
});
