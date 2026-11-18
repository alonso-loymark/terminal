import type { Terminal } from '@xterm/xterm';
import { copyText } from './clipboard';

export interface KeybindingActions {
  shiftEnter: () => void;
  openSearch: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

/** Copies the selection (if any) and clears it, like Windows Terminal. */
export function copySelection(term: Terminal): void {
  const text = term.getSelection();
  if (!text) return;
  void copyText(text);
  term.clearSelection();
}

/**
 * Terminal-level shortcuts. Returning `false` from the handler means "xterm, ignore this key";
 * the browser's default action still runs unless we prevent it.
 */
export function installKeybindings(term: Terminal, actions: KeybindingActions): void {
  term.attachCustomKeyEventHandler((event) => {
    // Shift+Enter is never sent by xterm (it would be a plain CR): the backend translates it.
    // Swallow keypress/keyup too so no stray CR follows.
    if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (event.type === 'keydown') {
        event.preventDefault();
        actions.shiftEnter();
      }
      return false;
    }
    if (event.type !== 'keydown') return true;

    // AltGr arrives as Ctrl+Alt on Windows: never treat it as a Ctrl shortcut.
    const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
    const shift = event.shiftKey;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    if (ctrl && key === 'c') {
      // Plain Ctrl+C with nothing selected must reach the shell as ^C.
      if (!shift && !term.hasSelection()) return true;
      copySelection(term);
      return false;
    }
    if (ctrl && !shift && key === 'Insert') {
      copySelection(term);
      return false;
    }
    // Paste: skip xterm (it would send ^V) so the browser fires its native `paste` event,
    // which xterm handles, bracketed paste included.
    if ((ctrl && key === 'v') || (shift && !event.ctrlKey && !event.altKey && key === 'Insert')) {
      return false;
    }
    if (ctrl && shift && key === 'f') {
      event.preventDefault();
      actions.openSearch();
      return false;
    }
    if (ctrl && (key === '=' || key === '+')) {
      event.preventDefault();
      actions.zoomIn();
      return false;
    }
    if (ctrl && !shift && key === '-') {
      event.preventDefault();
      actions.zoomOut();
      return false;
    }
    if (ctrl && !shift && key === '0') {
      event.preventDefault();
      actions.resetZoom();
      return false;
    }
    return true;
  });
}
