import type { ISearchDecorationOptions, ISearchOptions } from '@xterm/addon-search';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { getPane } from '../lib/terminalRegistry';
import { useUi } from '../store/ui';
import type { PaneId } from '../store/workspaceModel';

const decorations: ISearchDecorationOptions = {
  matchBackground: '#3a3f4b',
  matchOverviewRuler: '#d29922',
  activeMatchBackground: '#9e6a03',
  activeMatchColorOverviewRuler: '#e3b341',
};

interface SearchBarProps {
  /** Pane to search in (the active one); the bar is remounted when it changes. */
  paneId: PaneId;
  onClose: () => void;
}

interface Results {
  index: number;
  count: number;
}

export function SearchBar({ paneId, onClose }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const searchRequest = useUi((s) => s.searchRequest);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [searchRequest]);

  useEffect(() => {
    const addon = getPane(paneId)?.search;
    const subscription = addon?.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount }),
    );
    return () => {
      subscription?.dispose();
      addon?.clearDecorations();
    };
  }, [paneId]);

  const find = (term: string, direction: 'next' | 'previous', incremental = false) => {
    const addon = getPane(paneId)?.search;
    if (!addon) return;
    if (!term) {
      addon.clearDecorations();
      setResults(null);
      return;
    }
    const options: ISearchOptions = { decorations, incremental };
    if (direction === 'next') addon.findNext(term, options);
    else addon.findPrevious(term, options);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      find(query, event.shiftKey ? 'previous' : 'next');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  let summary = '';
  if (query && results) {
    if (results.count === 0) summary = 'Sin resultados';
    else if (results.index < 0) summary = `${results.count}+`;
    else summary = `${results.index + 1} de ${results.count}`;
  }

  return (
    <div className="search-bar" role="search">
      <input
        ref={inputRef}
        value={query}
        placeholder="Buscar"
        aria-label="Buscar en la terminal"
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value);
          find(event.target.value, 'next', true);
        }}
        onKeyDown={onKeyDown}
      />
      <span className="search-summary" aria-live="polite">
        {summary}
      </span>
      <button type="button" title="Anterior (Shift+Enter)" onClick={() => find(query, 'previous')}>
        ↑
      </button>
      <button type="button" title="Siguiente (Enter)" onClick={() => find(query, 'next')}>
        ↓
      </button>
      <button type="button" title="Cerrar (Esc)" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
