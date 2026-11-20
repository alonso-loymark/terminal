// Tab and pane operations that involve more than state: asking before closing busy tabs or
// panes, closing the window with the last tab, focusing the terminal afterwards.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAi } from '../store/ai';
import { useExplorer } from '../store/explorer';
import { useUi, type CloseTarget } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import { panesOf, tabOfPane, tabTitle, type PaneId, type TabId } from '../store/workspaceModel';
import { sessionBusy } from './pty';
import { releaseWorktrees, worktreesOf } from './multiAgent';
import { flushSession } from './sessionSync';
import { getPane } from './terminalRegistry';

/**
 * Gives the keyboard to the active terminal (after a switch, a menu, a dialog...) **before the
 * next keystroke**. Until focus moves, keys keep going to the previously focused terminal, even
 * if it was just hidden: they would land in the wrong pane (the stress test in the e2e `typing`
 * stage caught exactly that while focus waited for the next frame). So: now if the pane is
 * already on screen (pane switch), else in a microtask, which runs after React commits the
 * switch (React queued its own microtask when the store changed) and before any new input
 * event. A frame later only as a last resort.
 */
export function focusActiveTerminal(): void {
  if (focusNow()) return;
  queueMicrotask(() => {
    if (!focusNow()) requestAnimationFrame(() => void focusNow());
  });
}

/** True when done: focused, or another widget (rename, menu, dialog) owns the keyboard. */
function focusNow(): boolean {
  const ui = useUi.getState();
  if (
    ui.renamingTabId ||
    ui.renamingGroupId ||
    ui.menu ||
    ui.confirm ||
    ui.settings ||
    ui.palette ||
    ui.layoutDialog ||
    ui.multiAgent ||
    useExplorer.getState().editing ||
    useAi.getState().bar ||
    useAi.getState().preview
  ) {
    return true;
  }
  const pane = getPane(selectActivePaneId(useWorkspace.getState()));
  if (!pane || pane.host.hidden || !pane.host.isConnected) return false;
  pane.term.focus();
  return document.activeElement === pane.term.textarea;
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

/**
 * Closes without asking. Unmounting a pane closes its session (selective teardown); a worktree
 * Brisa created for it is removed (asking first if it has uncommitted changes).
 */
export function closePaneNow(paneId: PaneId): void {
  const worktrees = worktreesOf([paneId]);
  useWorkspace.getState().closePane(paneId);
  afterClose();
  if (worktrees.length) void releaseWorktrees(worktrees);
}

/** Closes without asking. Unmounting the panes closes their sessions (selective teardown). */
export function closeTabsNow(tabIds: TabId[]): void {
  const worktrees = worktreesOf(tabIds.flatMap(panesOfTab));
  useWorkspace.getState().closeTabs(tabIds);
  afterClose();
  if (worktrees.length) void releaseWorktrees(worktrees);
}

/** What the confirmation dialog closes when accepted (file deletions are the explorer's). */
export function closeTarget(target: Extract<CloseTarget, { kind: 'pane' | 'tabs' }>): void {
  if (target.kind === 'pane') closePaneNow(target.paneId);
  else closeTabsNow(target.tabIds);
}

function afterClose(): void {
  if (useWorkspace.getState().tabOrder.length === 0) {
    // Nothing left to restore next time: save that first (a fresh tab then).
    void flushSession().finally(() => void getCurrentWindow().close());
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
