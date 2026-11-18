import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useRef } from 'react';
import { readText } from '../lib/clipboard';
import { copySelection, installKeybindings } from '../lib/keybindings';
import { getPtyBackend, type PtyBackend } from '../lib/pty';
import { loadRenderer } from '../lib/renderer';
import { getPane, registerPane, unregisterPane, type PaneHandle } from '../lib/terminalRegistry';
import { TerminalSession } from '../lib/terminalSession';
import { useSettings, type TerminalSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import type { PaneId } from '../store/workspaceModel';

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

/** Resizes the grid to the host, skipping hidden/minimized states (a 0×0 host would shrink the PTY). */
function fitToHost(fit: FitAddon, host: HTMLElement): void {
  if (host.clientWidth === 0 || host.clientHeight === 0) return;
  fit.fit();
}

// Same answer for every pane: ask the backend once.
let backend: Promise<PtyBackend | null> | null = null;
const ptyBackend = () =>
  (backend ??= getPtyBackend().catch((error: unknown) => {
    console.warn('[terminal] pty_backend falló', error);
    return null;
  }));

interface TerminalPaneProps {
  paneId: PaneId;
  /** Hidden panes stay mounted (display: none): scrollback, modes and the session survive. */
  visible: boolean;
}

export function TerminalPane({ paneId, visible }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const settings = useSettings.getState();
    const workspace = () => useWorkspace.getState();

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
    host.dataset.renderer = loadRenderer(term, (kind) => (host.dataset.renderer = kind));
    fitToHost(fit, host);

    const session = new TerminalSession(term, {
      onStatus: (status, exitCode) => workspace().setPaneStatus(paneId, status, exitCode),
      onOutput: () => workspace().markActivity(paneId),
    });
    const handle: PaneHandle = { term, fit, search, session, host };
    registerPane(paneId, handle);

    installKeybindings(term, {
      shiftEnter: () => session.shiftEnter(),
      openSearch: () => useUi.getState().openSearch(),
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
    void ptyBackend().then((info) => {
      if (info) term.options.windowsPty = { backend: info.backend, buildNumber: info.buildNumber ?? undefined };
      session.start();
    });

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitToHost(fit, host));
    });
    observer.observe(host);

    const titleSubscription = term.onTitleChange((title) => workspace().setPaneTitle(paneId, title));
    // Zoom, theme...: applied live; hidden panes refit when shown.
    const unsubscribeSettings = useSettings.subscribe((next) => {
      Object.assign(term.options, appearance(next));
      fitToHost(fit, host);
    });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      unsubscribeSettings();
      host.removeEventListener('contextmenu', onContextMenu);
      titleSubscription.dispose();
      unregisterPane(paneId, handle);
      session.dispose();
      term.dispose();
    };
  }, [paneId]);

  // Shown again: the window may have been resized meanwhile, so refit (which resizes the PTY).
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      const handle = getPane(paneId);
      if (!handle) return;
      fitToHost(handle.fit, handle.host);
      handle.term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [paneId, visible]);

  return <div ref={hostRef} className="terminal-pane" data-pane-id={paneId} hidden={!visible} />;
}
