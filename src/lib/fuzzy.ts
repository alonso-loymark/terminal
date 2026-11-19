// Fuzzy matching for the command palette: the query's characters must appear in order in the
// text ("ntab" finds "Nueva tab"); matches at word starts and in runs score higher. Accents and
// case are ignored ("configuracion" finds "Configuración"). Each word of the query matches on
// its own, so the order of the words does not matter ("dracula tema"). Pure (node --test).

export interface FuzzyMatch {
  score: number;
  /** Indexes (in the text's characters) to highlight. */
  positions: number[];
}

/** One comparable character per character of the text (accents stripped, lower case). */
function fold(text: string): string[] {
  return [...text].map((c) => c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().charAt(0) || c.toLowerCase());
}

const isWordStart = (chars: readonly string[], original: readonly string[], i: number) => {
  if (i === 0) return true;
  const prev = original[i - 1] ?? '';
  const here = original[i] ?? '';
  if (/[\s:›/\\._\-()«»"'[\]]/.test(prev)) return true;
  // camelCase: "commandPalette" → P
  return /\p{Ll}/u.test(prev) && /\p{Lu}/u.test(here) && chars[i] !== undefined;
};

/** Best placement of one word (no spaces) in the text, or null. */
function matchWord(word: readonly string[], chars: readonly string[], original: readonly string[]): FuzzyMatch | null {
  if (word.length === 0) return { score: 0, positions: [] };
  let best: FuzzyMatch | null = null;
  // Try every start of the first character: the greedy match from the best start wins.
  for (let start = chars.indexOf(word[0]!); start >= 0; start = chars.indexOf(word[0]!, start + 1)) {
    const positions = [start];
    let at = start;
    let ok = true;
    for (let k = 1; k < word.length; k++) {
      // Prefer the next character right after, else the next word start, else any.
      const next = chars[at + 1] === word[k] ? at + 1 : -1;
      let found = next;
      if (found < 0) {
        for (let i = at + 1; i < chars.length; i++) {
          if (chars[i] === word[k] && isWordStart(chars, original, i)) {
            found = i;
            break;
          }
        }
      }
      if (found < 0) found = chars.indexOf(word[k]!, at + 1);
      if (found < 0) {
        ok = false;
        break;
      }
      positions.push(found);
      at = found;
    }
    if (!ok) break; // later starts cannot do better on what is left
    let score = 0;
    positions.forEach((p, k) => {
      score += 1;
      if (isWordStart(chars, original, p)) score += 8;
      if (k > 0 && p === positions[k - 1]! + 1) score += 5;
      else if (k > 0) score -= Math.min(4, p - positions[k - 1]! - 1) * 0.5;
    });
    if (start === 0) score += 6;
    if (!best || score > best.score) best = { score, positions };
  }
  return best;
}

/** How well `query` matches `text`; null when it does not. An empty query matches everything. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const words = query.trim().split(/\s+/).filter(Boolean).map(fold);
  if (words.length === 0) return { score: 0, positions: [] };
  const original = [...text];
  const chars = fold(text);
  let score = 0;
  const positions = new Set<number>();
  for (const word of words) {
    const match = matchWord(word, chars, original);
    if (!match) return null;
    score += match.score;
    match.positions.forEach((p) => positions.add(p));
  }
  // Shorter texts first among equals: "Tema" before "Tema: Tokyo Night" for "tema".
  score -= text.length * 0.01;
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

/** Splits a text into highlighted / plain runs for rendering. */
export function highlightRuns(text: string, positions: readonly number[]): { text: string; hit: boolean }[] {
  const marked = new Set(positions);
  const runs: { text: string; hit: boolean }[] = [];
  [...text].forEach((c, i) => {
    const hit = marked.has(i);
    const last = runs.at(-1);
    if (last && last.hit === hit) last.text += c;
    else runs.push({ text: c, hit });
  });
  return runs;
}
