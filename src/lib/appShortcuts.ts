// App-level shortcuts (tabs and groups). Listened in the capture phase on window, so they win
// over xterm wherever the focus is, and the terminal never receives them.
//
// Note: Ctrl+T and Ctrl+W are taken from programs that use them (readline transpose /
// delete-word, nano's Ctrl+W search). That is the chosen trade-off; see CLAUDE.md.
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { focusActiveTerminal, groupTab, requestCloseTabs } from './tabActions';

type Action = () => void;

function actionFor(event: KeyboardEvent): Action | null {
  const ws = useWorkspace.getState();
  const active = ws.activeTabId;
  const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  if (ctrl && !event.shiftKey && key === 't') return () => ws.newTab();
  if (ctrl && !event.shiftKey && key === 'w') return () => active && void requestCloseTabs([active]);
  if (ctrl && key === 'Tab') return () => ws.cycleTab(event.shiftKey ? -1 : 1);
  if (ctrl && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) {
    return () => ws.activateIndex(Number(event.code.slice(5)));
  }
  if (ctrl && event.shiftKey && key === 'g') return () => active && groupTab(active);
  if (key === 'F2' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    // Not while typing in an input (renaming, search).
    if (event.target instanceof HTMLInputElement) return null;
    return () => active && useUi.getState().startRenameTab(active);
  }
  return null;
}

/** Installs the listener; returns the uninstaller. */
export function installAppShortcuts(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    // A modal dialog owns the keyboard.
    if (useUi.getState().confirm) return;
    const action = actionFor(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
    // Tab switches and new tabs land with the keyboard in the terminal, unless a rename began.
    const ui = useUi.getState();
    if (!ui.renamingTabId && !ui.renamingGroupId) focusActiveTerminal();
  };
  window.addEventListener('keydown', onKeyDown, { capture: true });
  return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
}
