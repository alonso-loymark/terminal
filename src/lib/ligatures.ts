// Programming ligatures (=>, !=, ->...). xterm draws each cell on its own, so a font's
// ligatures never form; a character joiner tells it which runs to draw together, and the font
// (Cascadia Code, Fira Code...) does the rest. The official addon finds the font file on disk to
// read its exact ligature table, which needs Node or a font-access permission prompt; this
// joins the common sequences instead (the same list the addon falls back to), with no
// dependency and no cost while disabled.
import type { Terminal } from '@xterm/xterm';

/** Longest first, so `===` wins over `==`. */
const SEQUENCES = [
  '<--', '<---', '<<-', '<-', '->', '->>', '-->', '--->', '<==', '<===', '<<=', '<=', '=>', '=>>', '==>', '===>', '>=',
  '>>=', '<->', '<-->', '<--->', '<---->', '<=>', '<==>', '<===>', '<====>', '::', ':::', '<~~', '</', '</>', '/>',
  '~~>', '==', '!=', '/=', '~=', '<>', '===', '!==', '!===', '<:', ':=', '*=', '*+', '<*', '<*>', '*>', '<|', '<|>',
  '|>', '+*', '=*', '=:', ':>', '/*', '*/', '+++', '<!--', '<!---',
].sort((a, b) => b.length - a.length);

/** [start, end) ranges of `text` to draw as one glyph run. */
export function ligatureRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (let i = 0; i < text.length; i++) {
    const match = SEQUENCES.find((sequence) => text.startsWith(sequence, i));
    if (!match) continue;
    ranges.push([i, i + match.length]);
    i += match.length - 1;
  }
  return ranges;
}

const joiners = new WeakMap<Terminal, number>();

/** Turns ligatures on or off for a terminal (redraws if anything changed). */
export function setLigatures(term: Terminal, on: boolean): void {
  const id = joiners.get(term);
  if (on === (id !== undefined)) return;
  if (on) {
    joiners.set(term, term.registerCharacterJoiner(ligatureRanges));
    // Contextual alternates are what turn the joined run into a ligature.
    if (term.element) term.element.style.fontFeatureSettings = '"calt" on, "liga" on';
  } else if (id !== undefined) {
    term.deregisterCharacterJoiner(id);
    joiners.delete(term);
    if (term.element) term.element.style.fontFeatureSettings = '';
  }
  term.refresh(0, term.rows - 1);
}

export const hasLigatures = (term: Terminal) => joiners.has(term);
