// App-level shortcuts (tabs, groups, panes). Listened in the capture phase on window, so they
// win over xterm wherever the focus is, and the terminal never receives them.
//
// Windows Terminal style: tab shortcuts use Ctrl+Shift so plain Ctrl+T / Ctrl+W keep reaching
// programs (readline, nano...). F2 and Ctrl+1..9 stay as they are.
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import type { FocusDirection } from '../store/workspaceModel';
import { focusActiveTerminal, groupTab, openPaneMenu, requestClosePane } from './tabActions';

type Action = () => void;

const ARROWS: Record<string, FocusDirection> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

function actionFor(event: KeyboardEvent): Action | null {
  const ws = useWorkspace.getState();
  const active = ws.activeTabId;
  // AltGr arrives as Ctrl+Alt on Windows: never treat it as Ctrl or Alt shortcuts.
  const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
  const alt = event.altKey && !event.ctrlKey && !event.metaKey;
  const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  // Tabs
  if (ctrl && event.shiftKey && key === 't') return () => ws.newTab();
  if (ctrl && event.shiftKey && key === 'w') return () => void requestClosePane();
  if (ctrl && key === 'Tab') return () => ws.cycleTab(event.shiftKey ? -1 : 1);
  if (ctrl && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) {
    return () => ws.activateIndex(Number(event.code.slice(5)));
  }
  if (ctrl && event.shiftKey && key === 'g') return () => active && groupTab(active);
  if (plain && !event.shiftKey && key === 'F2') {
    // Not while typing in an input (renaming, search).
    if (event.target instanceof HTMLInputElement) return null;
    return () => active && useUi.getState().startRenameTab(active);
  }

  // Panes
  if (alt && event.shiftKey && key === 'd') return () => void ws.splitPane('horizontal');
  // Shift+'-' is '_' on US and Spanish layouts alike; the numpad minus works too.
  if (alt && event.shiftKey && (key === '-' || key === '_' || event.code === 'NumpadSubtract')) {
    return () => void ws.splitPane('vertical');
  }
  const arrow = ARROWS[event.key];
  if (alt && !event.shiftKey && arrow) return () => ws.focusDirection(arrow);
  if (ctrl && event.shiftKey && key === 'z') return () => ws.toggleZoom();
  if ((plain && event.shiftKey && key === 'F10') || (plain && !event.shiftKey && key === 'ContextMenu')) {
    return () => {
      const paneId = active ? ws.tabs[active]?.activePaneId : undefined;
      if (paneId) openPaneMenu(paneId);
    };
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
    // Tab/pane switches and new terminals land with the keyboard in the active pane, unless a
    // rename or a menu took it.
    const ui = useUi.getState();
    if (!ui.renamingTabId && !ui.renamingGroupId && !ui.menu) focusActiveTerminal();
  };
  window.addEventListener('keydown', onKeyDown, { capture: true });
  return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
}
