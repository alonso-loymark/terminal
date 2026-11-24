import { openUrl } from '@tauri-apps/plugin-opener';
import { Check, Copy } from 'lucide-react';
import { Lexer, type Token, type Tokens } from 'marked';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { copyText } from '../lib/clipboard';
import { highlight, type HlNode } from '../lib/highlight';
import { decodeEntities, filePathOf, grammarOf, hiddenContentTag, htmlToText, isLineBreakTag, linkTarget, pathParts } from '../lib/markdownModel';

/**
 * Markdown of a model's answer (the orchestrator), complete: headings, lists (nested, tasks),
 * bold, italics, tables, quotes, inline code, code blocks with highlighting and "Copiar".
 *
 * Safe by construction: marked only tokenizes; every token becomes a React element, so text is
 * always escaped and nothing a model writes is inserted as HTML. Raw HTML becomes its text (a
 * script's content is dropped), links open only http(s)/mailto in the browser, images are never
 * loaded (a model could leak data through an image URL), file paths open in the explorer.
 *
 * Loaded on demand (React.lazy) with marked and Prism: the rest of the app does not pay for it.
 */
interface Props {
  text: string;
  /** A file path in the answer was clicked (relative to the project, or absolute). */
  onPath?: (path: string, line: number | null) => void;
  className?: string;
}

interface Ctx {
  onPath?: (path: string, line: number | null) => void;
}

export default function Markdown({ text, onPath, className = 'md' }: Props) {
  const tokens = useMemo(() => {
    try {
      // breaks: a single newline is a line break, as in any chat.
      return Lexer.lex(text, { gfm: true, breaks: true });
    } catch {
      return null;
    }
  }, [text]);
  const ctx: Ctx = { onPath };
  return <div className={className}>{tokens ? blocks(tokens, ctx) : <p className="md-plain">{text}</p>}</div>;
}

function blocks(tokens: readonly Token[], ctx: Ctx): ReactNode[] {
  return tokens.map((t, i) => <Fragment key={i}>{block(t, ctx)}</Fragment>);
}

function block(t: Token, ctx: Ctx): ReactNode {
  switch (t.type) {
    case 'space':
    case 'def':
      return null;
    case 'heading': {
      const h = t as Tokens.Heading;
      const children = inline(h.tokens, ctx);
      if (h.depth <= 1) return <h3>{children}</h3>;
      if (h.depth === 2) return <h4>{children}</h4>;
      return <h5>{children}</h5>;
    }
    case 'paragraph':
      return <p>{inline((t as Tokens.Paragraph).tokens, ctx)}</p>;
    case 'text': {
      const x = t as Tokens.Text;
      return x.tokens ? inline(x.tokens, ctx) : textNode(x.text, ctx);
    }
    case 'code': {
      const c = t as Tokens.Code;
      return <CodeBlock code={c.text} lang={c.lang ?? ''} />;
    }
    case 'blockquote':
      return <blockquote>{blocks((t as Tokens.Blockquote).tokens, ctx)}</blockquote>;
    case 'list': {
      const l = t as Tokens.List;
      const items = l.items.map((item, i) => (
        <li key={i} data-task={item.task || undefined}>
          {blocks(item.tokens, ctx)}
        </li>
      ));
      if (l.ordered) return <ol start={typeof l.start === 'number' && l.start !== 1 ? l.start : undefined}>{items}</ol>;
      return <ul>{items}</ul>;
    }
    case 'table': {
      const table = t as Tokens.Table;
      const align = (i: number) => table.align[i] ?? undefined;
      return (
        <div className="md-table">
          <table>
            <thead>
              <tr>
                {table.header.map((cell, i) => (
                  <th key={i} style={{ textAlign: align(i) }}>
                    {inline(cell.tokens, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} style={{ textAlign: align(i) }}>
                      {inline(cell.tokens, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'hr':
      return <hr />;
    case 'html': {
      // Raw HTML from a model: only its text, never its markup.
      const plain = htmlToText((t as Tokens.HTML).text).trim();
      return plain ? <p className="md-plain">{plain}</p> : null;
    }
    case 'checkbox':
      return <input type="checkbox" className="md-check" checked={(t as Tokens.Checkbox).checked} disabled aria-label="tarea" />;
    default:
      return 'tokens' in t && Array.isArray(t.tokens) ? inline(t.tokens, ctx) : textNode(t.raw, ctx);
  }
}

function inline(tokens: readonly Token[] | undefined, ctx: Ctx): ReactNode[] {
  if (!tokens) return [];
  const out: ReactNode[] = [];
  // Inside <script>...</script> (inline): nothing is shown, not even as text.
  let hidden = false;
  tokens.forEach((t, i) => {
    if (t.type === 'html') {
      const tag = hiddenContentTag(t.text);
      if (tag) {
        hidden = tag === 'open';
        return;
      }
    }
    if (hidden) return;
    out.push(<Fragment key={i}>{inlineToken(t, ctx)}</Fragment>);
  });
  return out;
}

function inlineToken(t: Token, ctx: Ctx): ReactNode {
  switch (t.type) {
    case 'text': {
      const x = t as Tokens.Text;
      return x.tokens ? inline(x.tokens, ctx) : textNode(decodeEntities(x.text), ctx);
    }
    case 'escape':
      return (t as Tokens.Escape).text;
    case 'strong':
      return <strong>{inline((t as Tokens.Strong).tokens, ctx)}</strong>;
    case 'em':
      return <em>{inline((t as Tokens.Em).tokens, ctx)}</em>;
    case 'del':
      return <del>{inline((t as Tokens.Del).tokens, ctx)}</del>;
    case 'br':
      return <br />;
    case 'codespan': {
      const code = (t as Tokens.Codespan).text;
      const path = ctx.onPath ? filePathOf(code) : null;
      return path ? <PathLink path={path.path} line={path.line} label={code} code ctx={ctx} /> : <code>{code}</code>;
    }
    case 'link': {
      const link = t as Tokens.Link;
      const label = inline(link.tokens, ctx);
      const target = linkTarget(link.href);
      if (target?.kind === 'url') {
        return (
          <a
            href={target.href}
            title={target.href}
            onClick={(event) => {
              event.preventDefault();
              openUrl(target.href).catch((error: unknown) => console.warn('[brisa] no se pudo abrir el link', error));
            }}
          >
            {label}
          </a>
        );
      }
      if (target?.kind === 'path' && ctx.onPath) return <PathLink path={target.path} line={target.line} label={label} ctx={ctx} />;
      return <span>{label}</span>;
    }
    case 'image': {
      // Never loaded: a link the user can open, if it is a web page.
      const image = t as Tokens.Image;
      const target = linkTarget(image.href);
      const label = `[imagen: ${image.text || 'sin descripción'}]`;
      return target?.kind === 'url' ? (
        <a
          href={target.href}
          className="md-image"
          title={`Imagen sin cargar: ${target.href}`}
          onClick={(event) => {
            event.preventDefault();
            openUrl(target.href).catch(() => {});
          }}
        >
          {label}
        </a>
      ) : (
        <span className="md-image">{label}</span>
      );
    }
    case 'html':
      return isLineBreakTag(t.text) ? <br /> : null;
    case 'checkbox':
      return <input type="checkbox" className="md-check" checked={(t as Tokens.Checkbox).checked} disabled aria-label="tarea" />;
    default:
      return 'tokens' in t && Array.isArray(t.tokens) ? inline(t.tokens, ctx) : t.raw;
  }
}

/** Plain text, with its file paths clickable. */
function textNode(text: string, ctx: Ctx): ReactNode {
  if (!ctx.onPath) return text;
  const parts = pathParts(text);
  if (parts.length === 1 && parts[0]?.type === 'text') return text;
  return parts.map((part, i) => (part.type === 'path' ? <PathLink key={i} path={part.path} line={part.line} label={part.text} ctx={ctx} /> : part.text));
}

function PathLink({ path, line, label, code = false, ctx }: { path: string; line: number | null; label: ReactNode; code?: boolean; ctx: Ctx }) {
  return (
    <button type="button" className="md-path" data-code={code || undefined} data-path={path} title={`Mostrar ${path} en el explorador`} onClick={() => ctx.onPath?.(path, line)}>
      {label}
    </button>
  );
}

function renderHl(nodes: readonly HlNode[]): ReactNode[] {
  return nodes.map((node, i) =>
    typeof node === 'string' ? (
      node
    ) : (
      <span key={i} className={`tok ${node.type
        .split(' ')
        .map((x) => `tok-${x}`)
        .join(' ')}`}>
        {renderHl(node.children)}
      </span>
    ),
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const grammar = grammarOf(lang);
  const nodes = useMemo(() => highlight(code, grammar), [code, grammar]);
  const shown = lang.trim().split(/\s+/)[0] ?? '';
  return (
    <div className="md-code" data-lang={grammar ?? undefined}>
      <div className="md-code-head">
        <span className="md-code-lang">{shown}</span>
        <button
          type="button"
          className="md-code-copy"
          data-action="md-copy"
          title="Copiar el código"
          onClick={() =>
            void copyText(code).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <pre>
        <code>{nodes ? renderHl(nodes) : code}</code>
      </pre>
    </div>
  );
}
