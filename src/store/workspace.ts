import { create } from 'zustand';
import * as model from './workspaceModel';
import type { GroupId, PaneId, SessionStatus, TabColor, TabId, Workspace } from './workspaceModel';

let lastId = 0;
const nextId = (prefix: string) => `${prefix}-${++lastId}`;
let groupsCreated = 0;

interface WorkspaceActions {
  /** Opens a new tab at the end (or after `after`) and activates it. */
  newTab: (spec?: Partial<Pick<model.NewTab, 'after' | 'groupId' | 'customTitle' | 'color'>>) => TabId;
  /** Removes tabs and their panes from the state (unmounting their terminals closes the sessions). */
  closeTabs: (ids: TabId[]) => void;
  duplicateTab: (id: TabId) => TabId | null;
  activateTab: (id: TabId) => void;
  cycleTab: (delta: number) => void;
  activateIndex: (n: number) => void;
  renameTab: (id: TabId, title: string | null) => void;
  setTabColor: (id: TabId, color: TabColor | null) => void;
  moveTab: (id: TabId, overId: TabId) => void;
  moveTabToGroup: (tabId: TabId, groupId: GroupId) => void;
  removeFromGroup: (tabId: TabId) => void;
  createGroup: (tabId: TabId) => GroupId;
  renameGroup: (groupId: GroupId, name: string) => void;
  setGroupColor: (groupId: GroupId, color: TabColor) => void;
  toggleGroupCollapsed: (groupId: GroupId) => void;
  ungroup: (groupId: GroupId) => void;
  setPaneTitle: (paneId: PaneId, title: string) => void;
  setPaneStatus: (paneId: PaneId, status: SessionStatus, exitCode: number | null) => void;
  markActivity: (paneId: PaneId) => void;
}

export type WorkspaceStore = Workspace & WorkspaceActions;

const initial = model.addTab(model.emptyWorkspace(), { tabId: nextId('tab'), paneId: nextId('pane') });

/** Tabs, groups and pane metadata. Serializable only: xterm instances live in terminalRegistry. */
export const useWorkspace = create<WorkspaceStore>()((set, get) => {
  // Model functions return the same object when nothing changed, so no needless re-renders.
  const update = (fn: (ws: Workspace) => Workspace) => set((state) => fn(state));
  return {
    ...initial,
    newTab: (spec = {}) => {
      const tabId = nextId('tab');
      update((ws) => model.addTab(ws, { ...spec, tabId, paneId: nextId('pane') }));
      return tabId;
    },
    closeTabs: (ids) => update((ws) => model.closeTabs(ws, ids)),
    duplicateTab: (id) => {
      const tab = get().tabs[id];
      if (!tab) return null;
      return get().newTab({ after: id, groupId: tab.groupId, customTitle: tab.customTitle, color: tab.color });
    },
    activateTab: (id) => update((ws) => model.activateTab(ws, id)),
    cycleTab: (delta) => update((ws) => model.cycleTab(ws, delta)),
    activateIndex: (n) => update((ws) => model.activateIndex(ws, n)),
    renameTab: (id, title) => update((ws) => model.renameTab(ws, id, title)),
    setTabColor: (id, color) => update((ws) => model.setTabColor(ws, id, color)),
    moveTab: (id, overId) => update((ws) => model.moveTab(ws, id, overId)),
    moveTabToGroup: (tabId, groupId) => update((ws) => model.moveTabToGroup(ws, tabId, groupId)),
    removeFromGroup: (tabId) => update((ws) => model.removeFromGroup(ws, tabId)),
    createGroup: (tabId) => {
      groupsCreated++;
      const group = {
        id: nextId('group'),
        name: `Grupo ${groupsCreated}`,
        color: model.COLORS[(groupsCreated - 1) % model.COLORS.length] ?? 'blue',
      };
      update((ws) => model.createGroup(ws, tabId, group));
      return group.id;
    },
    renameGroup: (groupId, name) => update((ws) => model.renameGroup(ws, groupId, name)),
    setGroupColor: (groupId, color) => update((ws) => model.setGroupColor(ws, groupId, color)),
    toggleGroupCollapsed: (groupId) => update((ws) => model.toggleGroupCollapsed(ws, groupId)),
    ungroup: (groupId) => update((ws) => model.ungroup(ws, groupId)),
    setPaneTitle: (paneId, title) => update((ws) => model.setPaneTitle(ws, paneId, title)),
    setPaneStatus: (paneId, status, exitCode) => update((ws) => model.setPaneStatus(ws, paneId, status, exitCode)),
    markActivity: (paneId) => update((ws) => model.markActivity(ws, paneId)),
  };
});

/** Pane shown in the active tab, if any. */
export const selectActivePaneId = (ws: Workspace): PaneId | null =>
  ws.activeTabId ? (ws.tabs[ws.activeTabId]?.activePaneId ?? null) : null;
