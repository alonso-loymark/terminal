// What the orchestrator's markdown renderer (components/Markdown.tsx) decides, pure: which links
// may open, which text is a file path (clickable: it opens in the explorer), what raw HTML from
// a model becomes (only text: never markup) and which grammar highlights a code block.
// The answers come from a model: nothing it writes is ever inserted as HTML. No runtime imports
// (node --test).

/** Where a markdown link may go: a web page, a mail, or a file of the project. Never a script. */
export type LinkTarget = { kind: 'url'; href: string } | { kind: 'path'; path: string; line: number | null } | null;

export function linkTarget(href: string): LinkTarget {
  const h = href.trim();
  // Control characters and whitespace inside a scheme are how "java\tscript:" sneaks through.
  const compact = h.replace(/[\u0000-\u0020\u007f-\u009f]+/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') {
    try {
      // Only well formed ones; the browser's own parser decides what it is.
      const url = new URL(h);
      return url.protocol === `${scheme}:` ? { kind: 'url', href: url.href } : null;
    } catch {
      return null;
    }
  }
  // A drive letter is not a scheme (C:\x, C:/x).
  if (scheme && !/^[a-z]$/i.test(scheme)) return null;
  if (h.startsWith('#') || h.startsWith('//') || !h) return null;
  const path = filePathOf(decodeSafe(h));
  return path ? { kind: 'path', ...path } : null;
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// A path: an optional drive, ./, ../ or a leading separator, folders, and a file with an
// extension (with a letter: "1.5" is a number), then maybe :line[:column].
const SEGMENT = String.raw`[\w@.+-]+`;
const FILE = String.raw`[\w@+-][\w@.+-]*\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}`;
const LINE = String.raw`(?::(\d+)(?::\d+)?)?`;
const PREFIX = String.raw`(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?`;
/** A path with at least one folder, inside running text. */
const IN_TEXT = new RegExp(String.raw`(?<![\w/\\.:@-])(${PREFIX}(?:${SEGMENT}[\\/])+${FILE})${LINE}(?![\w/\\])`, 'g');
/** A whole string that is a path (a folder is optional: `package.json` inside backticks). */
const WHOLE = new RegExp(String.raw`^(${PREFIX}(?:${SEGMENT}[\\/])*${FILE})${LINE}$`);

/** `src/app.js:12` → the path and the line; null when the whole text is not one path. */
export function filePathOf(text: string): { path: string; line: number | null } | null {
  const t = text.trim();
  if (!t || t.length > 260 || /\s/.test(t) || t.includes('://')) return null;
  const m = WHOLE.exec(t);
  if (!m?.[1]) return null;
  return { path: m[1], line: m[2] ? Number(m[2]) : null };
}

export type TextPart = { type: 'text'; text: string } | { type: 'path'; text: string; path: string; line: number | null };

/** Running text with its file paths apart (only paths with a folder: "Node.js" is not a file). */
export function pathParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(IN_TEXT)) {
    const at = m.index ?? 0;
    // Never inside a URL ("https://x.com/a/b.png" has no path of the project).
    const before = text.slice(Math.max(0, text.lastIndexOf(' ', at) + 1), at);
    if (before.includes('://') || !m[1]) continue;
    if (at > last) parts.push({ type: 'text', text: text.slice(last, at) });
    parts.push({ type: 'path', text: m[0], path: m[1], line: m[2] ? Number(m[2]) : null });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  return parts;
}

/** A path from an answer, absolute: relative ones are relative to the project. */
export function resolvePath(base: string, path: string): string {
  const p = path.replace(/\//g, '\\');
  if (/^[A-Za-z]:\\/.test(p) || p.startsWith('\\\\')) return normalize(p);
  return normalize(`${base.replace(/[\\/]+$/, '')}\\${p.replace(/^\\+/, '')}`);
}

function normalize(path: string): string {
  const unc = path.startsWith('\\\\');
  const parts: string[] = [];
  for (const part of path.split('\\')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join('\\');
  return unc ? `\\\\${joined}` : /^[A-Za-z]:$/.test(parts[0] ?? '') && parts.length === 1 ? `${joined}\\` : joined;
}

const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|template|noscript|textarea|title|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" };

/** `&amp;`, `&lt;`, `&#60;`... as the characters they stand for (control characters stay encoded). */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (entity, name: string) => {
    const known = ENTITIES[name.toLowerCase()];
    if (known) return known;
    const code = name.startsWith('#x') || name.startsWith('#X') ? Number.parseInt(name.slice(2), 16) : name.startsWith('#') ? Number(name.slice(1)) : Number.NaN;
    return Number.isFinite(code) && code > 31 && code < 0x110000 && (code < 0x7f || code > 0x9f) ? String.fromCodePoint(code) : entity;
  });
}

/**
 * Raw HTML a model wrote, as plain text: comments, scripts and the like are dropped with their
 * content, `<br>` and block ends become line breaks, every other tag goes, entities are decoded.
 * The renderer shows the result as text: no markup of a model's ever reaches the page.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(DROP_WITH_CONTENT, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/<[^>]*$/g, ''),
  ).replace(/\n{3,}/g, '\n\n');
}

/** An inline HTML token: only a line break means something; any other tag is dropped. */
export const isLineBreakTag = (html: string): boolean => /^<br\s*\/?>$/i.test(html.trim());

/** An inline tag whose content is never shown either (a script's code is not text to read). */
export function hiddenContentTag(html: string): 'open' | 'close' | null {
  const t = html.trim();
  if (/^<(script|style|template|iframe|textarea|title|noscript)\b/i.test(t)) return /\/>$/.test(t) ? null : 'open';
  if (/^<\/(script|style|template|iframe|textarea|title|noscript)\s*>$/i.test(t)) return 'close';
  return null;
}

const LANGUAGES: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  powershell: 'powershell',
  bat: 'batch',
  cmd: 'batch',
  batch: 'batch',
  rs: 'rust',
  rust: 'rust',
  py: 'python',
  python: 'python',
  css: 'css',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  markup: 'markup',
  diff: 'diff',
  patch: 'diff',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  cs: 'csharp',
  csharp: 'csharp',
  'c#': 'csharp',
};

/** A code fence's language → the grammar that highlights it (null: shown plain). */
export function grammarOf(lang: string): string | null {
  const key = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return LANGUAGES[key] ?? null;
}
