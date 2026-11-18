// Tab and pane operations that involve more than state: asking before closing busy tabs or
// panes, closing the window with the last tab, focusing the terminal afterwards.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUi, type CloseTarget } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import { panesOf, tabOfPane, tabTitle, type PaneId, type TabId } from '../store/workspaceModel';
import { sessionBusy } from './pty';
import { getPane } from './terminalRegistry';

/**
 * Gives the keyboard back to the visible terminal (after menus, dialogs, renames...). Checked
 * when the frame runs: a click that also starts a rename (double click) must not steal the
 * focus from the rename input, or its blur would commit and close it at once.
 */
export function focusActiveTerminal(): void {
  requestAnimationFrame(() => {
    const ui = useUi.getState();
    if (ui.renamingTabId || ui.renamingGroupId || ui.menu || ui.confirm) return;
    getPane(selectActivePaneId(useWorkspace.getState()))?.term.focus();
  });
}

const MAX_COMMAND = 80;

/**
 * What closing these panes would stop: a command the shell reports as running (OSC 133, which
 * also covers in-process work like `Start-Sleep` that has no child process), plus the
 * processes besides the shell (dev servers, agents...; windowed apps are not listed).
 */
async function busyDetails(paneIds: PaneId[]): Promise<string[]> {
  const lists = await Promise.all(
    paneIds.map(async (paneId) => {
      const pane = useWorkspace.getState().panes[paneId];
      const sessionId = getPane(paneId)?.session.sessionId;
      const processes = sessionId == null ? [] : await sessionBusy(sessionId).catch(() => []);
      const command = pane?.commandRunning ? pane.lastCommand?.trim() || 'un comando' : null;
      const shown = command && command.length > MAX_COMMAND ? `${command.slice(0, MAX_COMMAND - 1)}…` : command;
      return [...(shown ? [`«${shown}»`] : []), ...processes.map((p) => p.name)];
    }),
  );
  return [...new Set(lists.flat())];
}

const panesOfTab = (tabId: TabId): PaneId[] => {
  const tab = useWorkspace.getState().tabs[tabId];
  return tab ? panesOf(tab.layout) : [];
};

const BUSY_MESSAGE = 'Hay comandos o procesos en ejecución que se van a terminar. Las apps con ventana siguen abiertas.';

/** Closes tabs, asking first if any of their panes runs something besides the bare shell. */
export async function requestCloseTabs(tabIds: TabId[]): Promise<void> {
  const ids = tabIds.filter((id) => useWorkspace.getState().tabs[id]);
  if (ids.length === 0) return;
  const busy = (
    await Promise.all(ids.map(async (id) => ({ id, names: await busyDetails(panesOfTab(id)) })))
  ).filter((b) => b.names.length > 0);
  if (busy.length === 0) {
    closeTabsNow(ids);
    return;
  }
  const ws = useWorkspace.getState();
  const single = ids.length === 1;
  useUi.getState().openConfirm({
    title: single ? '¿Cerrar la tab?' : `¿Cerrar ${ids.length} tabs?`,
    message: BUSY_MESSAGE,
    details: busy.map((b) => `${tabTitle(ws, b.id)}: ${b.names.join(', ')}`),
    confirmLabel: single ? 'Cerrar tab' : 'Cerrar tabs',
    target: { kind: 'tabs', tabIds: ids },
  });
}

/**
 * Ctrl+Shift+W: closes a pane (the active one by default), asking first if it runs something
 * besides the shell. The last pane of a tab closes the tab, with the same check.
 */
export async function requestClosePane(paneId?: PaneId): Promise<void> {
  const ws = useWorkspace.getState();
  const target = paneId ?? selectActivePaneId(ws);
  const tabId = target ? tabOfPane(ws, target) : null;
  if (!target || !tabId) return;
  if (panesOfTab(tabId).length === 1) return requestCloseTabs([tabId]);
  const names = await busyDetails([target]);
  if (names.length === 0) {
    closePaneNow(target);
    return;
  }
  useUi.getState().openConfirm({
    title: '¿Cerrar el panel?',
    message: BUSY_MESSAGE,
    details: [`${tabTitle(useWorkspace.getState(), tabId)}: ${names.join(', ')}`],
    confirmLabel: 'Cerrar panel',
    target: { kind: 'pane', paneId: target },
  });
}

/** Closes without asking. Unmounting a pane closes its session (selective teardown). */
export function closePaneNow(paneId: PaneId): void {
  useWorkspace.getState().closePane(paneId);
  afterClose();
}

/** Closes without asking. Unmounting the panes closes their sessions (selective teardown). */
export function closeTabsNow(tabIds: TabId[]): void {
  useWorkspace.getState().closeTabs(tabIds);
  afterClose();
}

/** What the confirmation dialog closes when accepted. */
export function closeTarget(target: CloseTarget): void {
  if (target.kind === 'pane') closePaneNow(target.paneId);
  else closeTabsNow(target.tabIds);
}

function afterClose(): void {
  if (useWorkspace.getState().tabOrder.length === 0) {
    void getCurrentWindow().close();
    return;
  }
  focusActiveTerminal();
}

export function closeOtherTabs(tabId: TabId): Promise<void> {
  return requestCloseTabs(useWorkspace.getState().tabOrder.filter((id) => id !== tabId));
}

/** Ctrl+Shift+G / "Nuevo grupo": groups the tab and opens the group name for editing. */
export function groupTab(tabId: TabId): void {
  const groupId = useWorkspace.getState().createGroup(tabId);
  useUi.getState().startRenameGroup(groupId);
}

/** Opens the pane menu at the top-left corner of a pane (keyboard: Shift+F10 / menu key). */
export function openPaneMenu(paneId: PaneId): void {
  const box = getPane(paneId)?.host.getBoundingClientRect();
  if (!box) return;
  useUi.getState().openMenu({ kind: 'pane', paneId, x: box.left + 16, y: box.top + 16 });
}
