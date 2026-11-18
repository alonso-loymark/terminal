import type { ISearchDecorationOptions, ISearchOptions, SearchAddon } from '@xterm/addon-search';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTerminalStore } from '../store/terminal';

const decorations: ISearchDecorationOptions = {
  matchBackground: '#3a3f4b',
  matchOverviewRuler: '#d29922',
  activeMatchBackground: '#9e6a03',
  activeMatchColorOverviewRuler: '#e3b341',
};

interface SearchBarProps {
  search: RefObject<SearchAddon | null>;
  onClose: () => void;
}

interface Results {
  index: number;
  count: number;
}

export function SearchBar({ search, onClose }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const searchRequest = useTerminalStore((s) => s.searchRequest);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [searchRequest]);

  useEffect(() => {
    const addon = search.current;
    const subscription = addon?.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount }),
    );
    return () => {
      subscription?.dispose();
      addon?.clearDecorations();
    };
  }, [search]);

  const find = (term: string, direction: 'next' | 'previous', incremental = false) => {
    const addon = search.current;
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
