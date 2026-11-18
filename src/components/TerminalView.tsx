import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useRef } from 'react';
import { readText } from '../lib/clipboard';
import { copySelection, installKeybindings } from '../lib/keybindings';
import { getPtyBackend } from '../lib/pty';
import { loadRenderer } from '../lib/renderer';
import { TerminalSession } from '../lib/terminalSession';
import { useSettings, type TerminalSettings } from '../store/settings';
import { useTerminalStore } from '../store/terminal';
import { SearchBar } from './SearchBar';

function appearance(s: TerminalSettings): ITerminalOptions {
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    theme: s.theme,
  };
}

/** Links open on Ctrl+click (like VS Code and Windows Terminal), never on a plain click. */
function openLink(event: MouseEvent, uri: string): void {
  if (!event.ctrlKey) return;
  openUrl(uri).catch((error: unknown) => console.warn('[terminal] no se pudo abrir el link', error));
}

/** Resizes the grid to the host, skipping minimized/hidden states (a 0×0 host would shrink the PTY). */
function fitToHost(fit: FitAddon, host: HTMLElement): void {
  if (host.clientWidth === 0 || host.clientHeight === 0) return;
  fit.fit();
}

export function TerminalView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchOpen = useTerminalStore((s) => s.searchOpen);
  const background = useSettings((s) => s.theme.background);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const store = useTerminalStore.getState();
    const settings = useSettings.getState();

    const term = new Terminal({
      ...appearance(settings),
      scrollback: settings.scrollback,
      linkHandler: { activate: openLink }, // OSC 8 hyperlinks
      // The search addon highlights matches with decorations, still a "proposed" API in xterm 6.
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon(openLink));
    term.open(host);
    store.setRenderer(loadRenderer(term, (kind) => useTerminalStore.getState().setRenderer(kind)));
    fitToHost(fit, host);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    const session = new TerminalSession(term, {
      onStatus: (status, exitCode) => useTerminalStore.getState().setStatus(status, exitCode),
    });

    installKeybindings(term, {
      shiftEnter: () => session.shiftEnter(),
      openSearch: () => useTerminalStore.getState().openSearch(),
      zoomIn: () => useSettings.getState().zoomIn(),
      zoomOut: () => useSettings.getState().zoomOut(),
      resetZoom: () => useSettings.getState().resetZoom(),
    });

    // Right click: copy the selection if there is one, otherwise paste (Windows Terminal style).
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (term.hasSelection()) {
        copySelection(term);
        return;
      }
      void readText().then((text) => {
        if (text) term.paste(text);
      });
    };
    host.addEventListener('contextmenu', onContextMenu);

    // Tell xterm it is talking to ConPTY before the first byte of output arrives.
    getPtyBackend()
      .then((backend) => {
        if (backend) term.options.windowsPty = { backend: backend.backend, buildNumber: backend.buildNumber ?? undefined };
      })
      .catch((error: unknown) => console.warn('[terminal] pty_backend falló', error))
      .finally(() => session.start());

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitToHost(fit, host));
    });
    observer.observe(host);

    const titleSubscription = term.onTitleChange((title) => useTerminalStore.getState().setTitle(title));
    term.focus();
    if (import.meta.env.DEV) window.__terminal = term;

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      host.removeEventListener('contextmenu', onContextMenu);
      titleSubscription.dispose();
      session.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      if (import.meta.env.DEV && window.__terminal === term) delete window.__terminal;
    };
  }, []);

  // Apply appearance changes (zoom, theme...) live and refit the grid.
  useEffect(
    () =>
      useSettings.subscribe((settings) => {
        const term = termRef.current;
        const fit = fitRef.current;
        const host = hostRef.current;
        if (!term || !fit || !host) return;
        Object.assign(term.options, appearance(settings));
        fitToHost(fit, host);
      }),
    [],
  );

  const closeSearch = () => {
    useTerminalStore.getState().closeSearch();
    termRef.current?.focus();
  };

  return (
    <div className="terminal-root" style={{ background }}>
      <div ref={hostRef} className="terminal-host" />
      {searchOpen && <SearchBar search={searchRef} onClose={closeSearch} />}
    </div>
  );
}
