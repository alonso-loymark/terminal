// Syntax highlighting for the code blocks of the orchestrator's answers: Prism's tokenizer
// (grammars only; its HTML output is never used), turned into a tree the renderer draws as React
// elements. Loaded with the markdown renderer, only when an orchestrator answer is on screen.
// Languages: the ones agents write most (see lib/markdownModel.ts → grammarOf).
import './prismManual';
import Prism, { type Token } from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-batch';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-csharp';

export type HlNode = string | { type: string; children: HlNode[] };

/** Longer code is shown plain: highlighting it would block the page for nothing. */
const MAX_CODE = 60_000;

function convert(stream: string | Token | (string | Token)[]): HlNode[] {
  const items = Array.isArray(stream) ? stream : [stream];
  return items.map((item) => {
    if (typeof item === 'string') return item;
    const alias = Array.isArray(item.alias) ? item.alias.join(' ') : (item.alias ?? '');
    return { type: `${item.type}${alias ? ` ${alias}` : ''}`, children: convert(item.content) };
  });
}

/** The code as highlighted tokens, or null (unknown language, too long). */
export function highlight(code: string, grammar: string | null): HlNode[] | null {
  const g = grammar ? Prism.languages[grammar] : undefined;
  if (!g || code.length > MAX_CODE) return null;
  try {
    return convert(Prism.tokenize(code, g));
  } catch {
    return null;
  }
}
