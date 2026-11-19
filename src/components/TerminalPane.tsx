import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { openUrl } from '@tauri-apps/plugin-opener';
import { memo, useEffect, useRef } from 'react';
import { shellSpec } from '../config/profiles';
import { terminalLook, type TerminalLook } from '../lib/appearance';
import { copyText, readText } from '../lib/clipboard';
import { copySelection, installKeybindings } from '../lib/keybindings';
import { setLigatures } from '../lib/ligatures';
import { paneStyle, sameRect } from '../lib/paneGeometry';
import { getPtyBackend, type PtyBackend } from '../lib/pty';
import { GpuRenderer } from '../lib/renderer';
import { initSettings } from '../lib/settingsSync';
import { registerShellIntegration } from '../lib/shellIntegration';
import { focusActiveTerminal } from '../lib/tabActions';
import { getPane, registerPane, unregisterPane, type PaneHandle } from '../lib/terminalRegistry';
import { TerminalSession } from '../lib/terminalSession';
import { profileFor } from '../store/profiles';
import { useSettings } from '../store/settings';
import { loadSystemInfo } from '../store/system';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import { spawnOf, type PaneId, type Rect } from '../store/workspaceModel';

/**
 * The integration script reports itself as soon as the user's profile finished loading. A
 * shell that stays silent this long gets the status bar notice (it clears if it reports later).
 */
const INTEGRATION_TIMEOUT_MS = 20_000;

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
  /** Highlighted as the active pane of a split tab. */
  focused: boolean;
  /** Position inside the tab, in fractions of the pane area. */
  rect: Rect;
}

/**
 * One terminal (xterm + session). Rendered flat by Workspace and positioned from the layout,
 * so splitting, closing or resizing panes only changes its style: the instance is never rebuilt.
 */
export const TerminalPane = memo(
  function TerminalPane({ paneId, visible, focused, rect }: TerminalPaneProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const innerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const host = hostRef.current;
      const inner = innerRef.current;
      if (!host || !inner) return;
      const workspace = () => useWorkspace.getState();
      const profileId = () => workspace().panes[paneId]?.profile ?? null;
      let look: TerminalLook = terminalLook(profileId());

      const term = new Terminal({
        ...look.options,
        linkHandler: { activate: openLink }, // OSC 8 hyperlinks
        // The search addon highlights matches with decorations, still a "proposed" API in xterm 6.
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(new WebLinksAddon(openLink));
      term.open(inner);
      host.style.background = look.background;
      setLigatures(term, look.ligatures);
      host.dataset.renderer = 'dom';
      // WebGL is attached when the pane is shown (see the visibility effect below).
      const gpu = new GpuRenderer(term, (kind) => (host.dataset.renderer = kind));
      fitToHost(fit, inner);

      // Shell integration marks (cwd, command start/end, exit code) go to the pane's state.
      // Registered before the session starts, so the first prompt is not missed.
      const integration = registerShellIntegration(term, (event) => workspace().applyShellEvent(paneId, event));
      let integrationTimer = 0;
      // The profile actually started (the pane may ask for the default one, or for one that
      // no longer exists).
      let startedProfile: string | null = null;

      const session: TerminalSession = new TerminalSession(term, {
        spawn: () => {
          const { profile: requested, cwd } = spawnOf(workspace(), paneId);
          const profile = profileFor(requested);
          startedProfile = profile?.id ?? null;
          // A profile's own starting folder applies when nothing more specific was asked for.
          return { shell: profile ? shellSpec(profile) : null, cwd: cwd ?? profile?.cwd ?? null };
        },
        onStatus: (status, exitCode) => workspace().setPaneStatus(paneId, status, exitCode, session.sessionId),
        onStarted: (info) => {
          workspace().setPaneSession(paneId, { profile: startedProfile, shell: info.shell, integration: info.integration });
          window.clearTimeout(integrationTimer);
          if (info.integration !== 'full') return;
          integrationTimer = window.setTimeout(() => {
            if (workspace().panes[paneId]?.integration !== 'pending') return;
            workspace().applyShellEvent(paneId, { type: 'integration', ok: false, error: 'el script no respondió' });
          }, INTEGRATION_TIMEOUT_MS);
        },
        onOutput: () => workspace().markActivity(paneId),
      });
      const handle: PaneHandle = { term, fit, search, session, host, inner, gpu, integration };
      registerPane(paneId, handle);

      installKeybindings(term, {
        shiftEnter: () => session.shiftEnter(),
        openSearch: () => useUi.getState().openSearch(),
        zoomIn: () => useSettings.getState().zoomIn(),
        zoomOut: () => useSettings.getState().zoomOut(),
        resetZoom: () => useSettings.getState().resetZoom(),
      });

      // Right click: copy the selection if there is one, otherwise paste (Windows Terminal
      // style), or a context menu (VS Code style), as the settings say. Shift+right click
      // always opens the menu.
      const onContextMenu = (event: MouseEvent) => {
        event.preventDefault();
        if (event.shiftKey || useSettings.getState().settings.terminal.rightClick === 'menu') {
          workspace().focusPane(paneId);
          useUi.getState().openMenu({ kind: 'pane', paneId, x: event.clientX, y: event.clientY, clipboard: !event.shiftKey });
          return;
        }
        if (term.hasSelection()) {
          copySelection(term);
          return;
        }
        void readText().then((text) => {
          if (text) term.paste(text);
        });
      };
      host.addEventListener('contextmenu', onContextMenu);

      // Copy on select: when a mouse selection ends (drag, double or triple click). Selections
      // made by the app (search results) are not copied.
      const onMouseUp = (event: MouseEvent) => {
        if (event.button !== 0 || !useSettings.getState().settings.terminal.copyOnSelect) return;
        window.setTimeout(() => {
          const text = term.getSelection();
          if (text) void copyText(text);
        });
      };
      host.addEventListener('mouseup', onMouseUp);

      // Clicking a pane (or any focus landing in it) makes it the active pane of its tab. The
      // pointer is handled too: Chromium skips focus events while the window is not focused.
      const onFocus = () => {
        if (selectActivePaneId(workspace()) !== paneId) workspace().focusPane(paneId);
      };
      term.textarea?.addEventListener('focus', onFocus);
      host.addEventListener('pointerdown', onFocus);

      // Keys typed while nothing has the focus (it fell to <body>, e.g. because the focused
      // element was hidden) reach no terminal and are lost. If the active terminal loses the
      // focus to nothing, take it back before the next keystroke. Focus moving to another
      // element (the explorer, an input, a menu) is left alone, and so is the window losing
      // the system focus (activeElement stays on the textarea then).
      const onBlur = (event: FocusEvent) => {
        if (event.relatedTarget || selectActivePaneId(workspace()) !== paneId) return;
        queueMicrotask(() => {
          const now = document.activeElement;
          if (!now || now === document.body) focusActiveTerminal();
        });
      };
      term.textarea?.addEventListener('blur', onBlur);

      // Tell xterm it is talking to ConPTY before the first byte of output arrives, and start
      // once the settings (default profile, profile folders) and the detected shells are known.
      void Promise.all([ptyBackend(), initSettings(), loadSystemInfo()]).then(([info]) => {
        if (info) term.options.windowsPty = { backend: info.backend, buildNumber: info.buildNumber ?? undefined };
        session.start();
      });

      // Any size change (window, split, divider drag, zoom, padding) refits, which resizes the PTY.
      let frame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => fitToHost(fit, inner));
      });
      observer.observe(inner);

      const titleSubscription = term.onTitleChange((title) => workspace().setPaneTitle(paneId, title));

      // Theme, font, zoom, cursor...: applied live (also when the pane's profile changes, or the
      // profile's theme). Hidden panes refit when shown.
      const restyle = () => {
        const next = terminalLook(profileId());
        if (JSON.stringify(next) === JSON.stringify(look)) return;
        const transparencyChanged = next.options.allowTransparency !== look.options.allowTransparency;
        look = next;
        Object.assign(term.options, next.options);
        host.style.background = next.background;
        setLigatures(term, next.ligatures);
        // WebGL builds its glyph atlas for an opaque or a transparent background: rebuild it.
        if (transparencyChanged && !host.hidden) {
          gpu.detach();
          gpu.attach();
        }
        fitToHost(fit, inner);
      };
      const unsubscribeSettings = useSettings.subscribe(restyle);
      const unsubscribeProfile = useWorkspace.subscribe((s, prev) => {
        if (s.panes[paneId]?.profile !== prev.panes[paneId]?.profile) restyle();
      });

      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        unsubscribeSettings();
        unsubscribeProfile();
        host.removeEventListener('contextmenu', onContextMenu);
        host.removeEventListener('mouseup', onMouseUp);
        term.textarea?.removeEventListener('focus', onFocus);
        term.textarea?.removeEventListener('blur', onBlur);
        host.removeEventListener('pointerdown', onFocus);
        titleSubscription.dispose();
        window.clearTimeout(integrationTimer);
        integration.dispose();
        unregisterPane(paneId, handle);
        session.dispose();
        term.dispose();
      };
    }, [paneId]);

    // Shown: take a WebGL context and refit (the size may have changed meanwhile). Hidden:
    // give the WebGL context back.
    useEffect(() => {
      const handle = getPane(paneId);
      if (!visible) {
        handle?.gpu.detach();
        return;
      }
      const frame = requestAnimationFrame(() => {
        const current = getPane(paneId);
        if (!current) return;
        current.gpu.attach();
        fitToHost(current.fit, current.inner);
        // Only the tab's active pane takes the keyboard.
        focusActiveTerminal();
      });
      return () => cancelAnimationFrame(frame);
    }, [paneId, visible]);

    return (
      <div
        ref={hostRef}
        className="terminal-pane"
        data-pane-id={paneId}
        data-focused={focused || undefined}
        hidden={!visible}
        style={paneStyle(rect)}
      >
        <div ref={innerRef} className="terminal-host" />
      </div>
    );
  },
  (a, b) => a.paneId === b.paneId && a.visible === b.visible && a.focused === b.focused && sameRect(a.rect, b.rect),
);
