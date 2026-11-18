// Tab operations that involve more than state: asking before closing busy tabs, closing the
// window with the last tab, focusing the terminal afterwards.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import { panesOf, tabTitle, type TabId } from '../store/workspaceModel';
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

/** Image names of what closing the tab would kill besides its shell (dev servers, agents...). */
async function busyProcessNames(tabId: TabId): Promise<string[]> {
  const tab = useWorkspace.getState().tabs[tabId];
  if (!tab) return [];
  const lists = await Promise.all(
    panesOf(tab.layout).map((paneId) => {
      const sessionId = getPane(paneId)?.session.sessionId;
      return sessionId == null ? Promise.resolve([]) : sessionBusy(sessionId).catch(() => []);
    }),
  );
  return [...new Set(lists.flat().map((p) => p.name))];
}

/** Closes tabs, asking first if any of them runs something besides the bare shell. */
export async function requestCloseTabs(tabIds: TabId[]): Promise<void> {
  const ids = tabIds.filter((id) => useWorkspace.getState().tabs[id]);
  if (ids.length === 0) return;
  const busy = (await Promise.all(ids.map(async (id) => ({ id, names: await busyProcessNames(id) })))).filter(
    (b) => b.names.length > 0,
  );
  if (busy.length === 0) {
    closeTabsNow(ids);
    return;
  }
  const ws = useWorkspace.getState();
  const single = ids.length === 1;
  useUi.getState().openConfirm({
    title: single ? '¿Cerrar la tab?' : `¿Cerrar ${ids.length} tabs?`,
    message: 'Hay procesos en ejecución que se van a terminar. Las apps con ventana siguen abiertas.',
    details: busy.map((b) => `${tabTitle(ws, b.id)}: ${b.names.join(', ')}`),
    confirmLabel: single ? 'Cerrar tab' : 'Cerrar tabs',
    tabIds: ids,
  });
}

/** Closes without asking. Unmounting the panes closes their sessions (selective teardown). */
export function closeTabsNow(tabIds: TabId[]): void {
  useWorkspace.getState().closeTabs(tabIds);
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
