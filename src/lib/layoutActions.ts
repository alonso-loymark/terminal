// Saving the active tab or the whole window as a named layout, and opening one: its tabs are
// added, each pane starts with its profile in its folder, and the commands are typed once each
// shell is ready (lib/initialCommands.ts).
import { snapshotTab, snapshotWindow, type SavedLayout } from '../store/layoutModel';
import { findLayout, useLayouts } from '../store/layouts';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { panesOf, type PaneId, type TabId } from '../store/workspaceModel';
import { queueInitialCommand } from './initialCommands';
import { saveLayout } from './layoutsSync';
import { closeTabsNow, focusActiveTerminal } from './tabActions';
import { getPane } from './terminalRegistry';

/** What to save: one tab or the window. */
export interface LayoutTarget {
  scope: 'tab' | 'window';
  tabId: TabId | null;
}

/** The panes a layout would contain, in order (to ask for each one's command). */
export function panesToSave(target: LayoutTarget): PaneId[] {
  const ws = useWorkspace.getState();
  const tabs = target.scope === 'tab' ? (target.tabId ? [target.tabId] : []) : ws.tabOrder;
  return tabs.flatMap((id) => {
    const tab = ws.tabs[id];
    return tab ? panesOf(tab.layout) : [];
  });
}

/** A pane's suggested command: what runs there now (a dev server, an agent), if anything. */
export function runningCommand(paneId: PaneId): string {
  const pane = useWorkspace.getState().panes[paneId];
  return pane?.commandRunning ? (pane.lastCommand?.trim() ?? '') : '';
}

export function saveCurrentLayout(name: string, target: LayoutTarget, commands: Record<PaneId, string>): boolean {
  const ws = useWorkspace.getState();
  let layout: SavedLayout | null = null;
  if (target.scope === 'tab') {
    const tab = target.tabId ? snapshotTab(ws, target.tabId, { commands }) : null;
    // The tab's group goes too, so it opens grouped the same way.
    const groupId = target.tabId ? ws.tabs[target.tabId]?.groupId : null;
    const group = groupId ? ws.groups[groupId] : undefined;
    if (tab) layout = { name: name.trim(), tabs: [tab], groups: group ? [{ name: group.name, color: group.color }] : [] };
  } else {
    const spec = snapshotWindow(ws, ws.tabOrder, { commands });
    layout = { name: name.trim(), ...spec };
  }
  if (!layout || !layout.name || !saveLayout(layout)) {
    useUi.getState().showToast('No se pudo guardar el layout: layouts.json tiene errores (corregilo primero).', 'warning');
    return false;
  }
  useUi.getState().showToast(`Layout «${layout.name}» guardado.`);
  return true;
}

/**
 * A window with a single untouched tab (no command run, nothing typed, not renamed): opening a
 * layout replaces it instead of leaving it next to the new tabs.
 */
function pristineTab(): TabId | null {
  const ws = useWorkspace.getState();
  if (ws.tabOrder.length !== 1) return null;
  const tab = ws.tabs[ws.tabOrder[0]!];
  if (!tab || tab.layout.type !== 'pane' || tab.customTitle || tab.groupId) return null;
  const pane = ws.panes[tab.activePaneId];
  if (!pane || pane.lastCommand !== null || pane.commandRunning || pane.status !== 'running') return null;
  const typed = getPane(pane.id)?.integration.promptInput();
  return typed === '' ? tab.id : null;
}

export function openLayout(name: string): boolean {
  const layout = findLayout(name);
  if (!layout) {
    useUi.getState().showToast(`No hay un layout llamado «${name}».`, 'warning');
    return false;
  }
  const replace = pristineTab();
  const { commands } = useWorkspace.getState().openWindow(layout);
  for (const { paneId, command } of commands) queueInitialCommand(paneId, command);
  if (replace) closeTabsNow([replace]);
  focusActiveTerminal();
  return true;
}

export const layoutNames = (): string[] => useLayouts.getState().layouts.map((l) => l.name);
