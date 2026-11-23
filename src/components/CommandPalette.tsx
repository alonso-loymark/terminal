import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fuzzyMatch, highlightRuns } from '../lib/fuzzy';
import { paletteItems, type PaletteItem } from '../lib/paletteItems';
import { focusActiveTerminal } from '../lib/tabActions';
import { recordRecent, useSession } from '../store/session';
import { useUi } from '../store/ui';

interface Row {
  item: PaletteItem;
  positions: number[];
}

/** Recently used commands rise: first when the query is empty, ahead of similar matches otherwise. */
const RECENT_BOOST = 6;

function filter(items: PaletteItem[], query: string, recent: readonly string[]): Row[] {
  const rank = (id: string) => {
    const at = recent.indexOf(id);
    return at < 0 ? 0 : RECENT_BOOST * (1 - at / Math.max(recent.length, 1));
  };
  if (!query.trim()) {
    const recentItems = recent.map((id) => items.find((item) => item.id === id)).filter((i): i is PaletteItem => !!i);
    const rest = items.filter((item) => !recent.includes(item.id));
    return [...recentItems, ...rest].map((item) => ({ item, positions: [] }));
  }
  return items
    .map((item, order) => ({ item, order, match: fuzzyMatch(query, item.label) }))
    .filter((r) => r.match)
    .sort((a, b) => b.match!.score + rank(b.item.id) - (a.match!.score + rank(a.item.id)) || a.order - b.order)
    .map((r) => ({ item: r.item, positions: r.match!.positions }));
}

const close = () => {
  useUi.getState().closePalette();
  focusActiveTerminal();
};

/** Ctrl+Shift+P: every action, tab, pane, profile, theme and layout, searchable. */
export function CommandPalette() {
  const open = useUi((s) => s.palette);
  if (!open) return null;
  return <PaletteBox />;
}

function PaletteBox() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const recent = useSession((s) => s.recent);
  // What the moment offers (tabs, panes...), taken when the palette opens.
  const items = useMemo(() => paletteItems(), []);
  const rows = useMemo(() => filter(items, query, recent), [items, query, recent]);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isRecent = (id: string) => !query.trim() && recent.includes(id);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, rows]);

  const runRow = (row: Row | undefined) => {
    if (!row) return;
    if (row.item.remember) recordRecent(row.item.id);
    useUi.getState().closePalette();
    row.item.run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const step = (delta: number) => {
      event.preventDefault();
      if (rows.length) setSelected((s) => (s + delta + rows.length) % rows.length);
    };
    if (event.key === 'ArrowDown') step(1);
    else if (event.key === 'ArrowUp') step(-1);
    else if (event.key === 'PageDown') step(Math.min(8, rows.length - 1 - selected) || 1);
    else if (event.key === 'PageUp') step(-Math.min(8, selected) || -1);
    else if (event.key === 'Enter') {
      event.preventDefault();
      runRow(rows[selected]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  return (
    <div className="palette-backdrop" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Paleta de comandos" onKeyDown={onKeyDown}>
        <div className="palette-search">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            className="palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={rows[selected] ? `palette-${selected}` : undefined}
            placeholder="Escribí un comando, una tab, un tema, un layout…"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <div ref={listRef} id="palette-list" className="palette-list" role="listbox" aria-label="Comandos" data-count={rows.length}>
          {rows.length === 0 && <div className="palette-empty">Nada coincide con «{query}».</div>}
          {rows.map((row, i) => (
            <div
              key={row.item.id}
              id={`palette-${i}`}
              role="option"
              aria-selected={i === selected}
              className="palette-item"
              data-command={row.item.id}
              data-recent={isRecent(row.item.id) || undefined}
              onPointerMove={() => i !== selected && setSelected(i)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => runRow(row)}
            >
              <span className="palette-category">{row.item.category}</span>
              <span className="palette-label">
                {highlightRuns(row.item.label, row.positions).map((run, k) => (run.hit ? <mark key={k}>{run.text}</mark> : <span key={k}>{run.text}</span>))}
                {row.item.detail && <span className="palette-detail">{row.item.detail}</span>}
              </span>
              {isRecent(row.item.id) && <span className="palette-recent">reciente</span>}
              {row.item.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
