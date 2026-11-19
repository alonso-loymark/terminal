// App-level shortcuts (tabs, groups, panes). Listened in the capture phase on window, so they
// win over xterm wherever the focus is, and the terminal never receives them.
//
// Windows Terminal style: tab shortcuts use Ctrl+Shift so plain Ctrl+T / Ctrl+W keep reaching
// programs (readline, nano...). F2 and Ctrl+1..9 stay as they are. Ctrl+B (explorer) is taken
// like in VS Code, so programs no longer get it.
//
// Holding a key down repeats keydown (event.repeat): actions that create, close or toggle run
// once per press. Only moving between tabs and panes repeats.
import { useExplorer } from '../store/explorer';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import type { FocusDirection } from '../store/workspaceModel';
import { focusActiveTerminal, groupTab, openPaneMenu, requestClosePane } from './tabActions';

type Action = () => void;

/** What a key does, and whether holding it down keeps doing it. */
interface Shortcut {
  run: Action;
  repeatable?: true;
}

const once = (run: Action): Shortcut => ({ run });
const repeating = (run: Action): Shortcut => ({ run, repeatable: true });

const ARROWS: Record<string, FocusDirection> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

function actionFor(event: KeyboardEvent): Shortcut | null {
  const ws = useWorkspace.getState();
  const active = ws.activeTabId;
  // AltGr arrives as Ctrl+Alt on Windows: never treat it as Ctrl or Alt shortcuts.
  const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
  const alt = event.altKey && !event.ctrlKey && !event.metaKey;
  const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  // Settings (like VS Code). While the screen is open it owns the keyboard.
  if (ctrl && !event.shiftKey && key === ',') {
    return once(() => {
      const ui = useUi.getState();
      if (ui.settings) {
        ui.closeSettings();
        focusActiveTerminal();
      } else {
        ui.openSettings();
      }
    });
  }
  if (useUi.getState().settings) return null;

  // Tabs
  if (ctrl && event.shiftKey && key === 't') return once(() => ws.newTab());
  if (ctrl && event.shiftKey && key === 'w') return once(() => void requestClosePane());
  if (ctrl && key === 'Tab') return repeating(() => ws.cycleTab(event.shiftKey ? -1 : 1));
  if (ctrl && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) {
    return once(() => ws.activateIndex(Number(event.code.slice(5))));
  }
  if (ctrl && event.shiftKey && key === 'g') return once(() => active && groupTab(active));
  if (plain && !event.shiftKey && key === 'F2') {
    // Not while typing in an input (renaming, search), nor in the explorer (F2 renames a file there).
    if (event.target instanceof HTMLInputElement) return null;
    if (event.target instanceof Element && event.target.closest('.sidebar')) return null;
    return once(() => active && useUi.getState().startRenameTab(active));
  }

  // Explorer
  if (ctrl && !event.shiftKey && key === 'b') return once(() => useExplorer.getState().toggleVisible());

  // Panes
  if (alt && event.shiftKey && key === 'd') return once(() => void ws.splitPane('horizontal'));
  // Shift+'-' is '_' on US and Spanish layouts alike; the numpad minus works too.
  if (alt && event.shiftKey && (key === '-' || key === '_' || event.code === 'NumpadSubtract')) {
    return once(() => void ws.splitPane('vertical'));
  }
  const arrow = ARROWS[event.key];
  if (alt && !event.shiftKey && arrow) return repeating(() => ws.focusDirection(arrow));
  if (ctrl && event.shiftKey && key === 'z') return once(() => ws.toggleZoom());
  if ((plain && event.shiftKey && key === 'F10') || (plain && !event.shiftKey && key === 'ContextMenu')) {
    return once(() => {
      const paneId = active ? ws.tabs[active]?.activePaneId : undefined;
      if (paneId) openPaneMenu(paneId);
    });
  }
  return null;
}

/** Installs the listener; returns the uninstaller. */
export function installAppShortcuts(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    // A modal dialog owns the keyboard.
    if (useUi.getState().confirm) return;
    const shortcut = actionFor(event);
    if (!shortcut) return;
    // Swallowed either way: a held shortcut must not leak its key to the terminal.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat && !shortcut.repeatable) return;
    shortcut.run();
    // Tab/pane switches and new terminals land with the keyboard in the active pane, unless a
    // rename or a menu took it.
    const ui = useUi.getState();
    if (!ui.renamingTabId && !ui.renamingGroupId && !ui.menu && !ui.settings) focusActiveTerminal();
  };
  window.addEventListener('keydown', onKeyDown, { capture: true });
  return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
}
