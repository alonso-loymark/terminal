import { create } from 'zustand';
import { instantiate, type Instantiated, type WindowSpec } from './layoutModel';
import { profileFor } from './profiles';
import * as model from './workspaceModel';
import type {
  FocusDirection,
  GroupId,
  IntegrationLevel,
  PaneId,
  ProfileId,
  SessionStatus,
  ShellEvent,
  ShellKind,
  SplitDirection,
  SplitId,
  TabColor,
  TabId,
  Workspace,
} from './workspaceModel';

let lastId = 0;
const nextId = (prefix: string) => `${prefix}-${++lastId}`;
let groupsCreated = 0;

interface WorkspaceActions {
  /** One tab with the default profile (a fresh start, or nothing to restore). */
  reset: () => void;
  /**
   * Opens a saved arrangement (the session, a layout): its tabs and groups are added at the end
   * (or replace everything) and its active tab is activated.
   */
  openWindow: (spec: WindowSpec, options?: { replace?: boolean }) => Instantiated;
  /**
   * Opens a new tab at the end (or after `after`) and activates it. Without `profile`, the
   * default one. Without `cwd`, the profile's starting folder if it has one, else the active
   * pane's folder (`cwd: null`: the home folder).
   */
  newTab: (
    spec?: Partial<Pick<model.NewTab, 'after' | 'groupId' | 'customTitle' | 'color' | 'profile' | 'cwd' | 'kind'>>,
  ) => TabId;
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
  setPaneStatus: (paneId: PaneId, status: SessionStatus, exitCode: number | null, sessionId: number | null) => void;
  setPaneSession: (
    paneId: PaneId,
    info: { profile?: ProfileId | null; shell: ShellKind; integration: IntegrationLevel },
  ) => void;
  /** A shell integration mark (OSC 7 / 133 / 633) from the pane's terminal. */
  applyShellEvent: (paneId: PaneId, event: ShellEvent) => void;
  markActivity: (paneId: PaneId) => void;
  setPaneAgent: (paneId: PaneId, agent: model.PaneAgent | null) => void;
  setPaneWorktree: (paneId: PaneId, worktree: model.PaneWorktree | null) => void;
  /**
   * Splits the pane (default: the active one); the new pane gets the focus and, unless `spawn`
   * says otherwise, the same profile and folder. Returns its id.
   */
  splitPane: (direction: SplitDirection, paneId?: PaneId, spawn?: Partial<model.PaneSpawn>) => PaneId | null;
  /** Removes a pane from its tab (unmounting its terminal closes the session); last pane closes the tab. */
  closePane: (paneId: PaneId) => void;
  focusPane: (paneId: PaneId) => void;
  focusDirection: (direction: FocusDirection) => void;
  toggleZoom: () => void;
  setSplitSizes: (splitId: SplitId, sizes: number[]) => void;
  equalizeSplit: (splitId: SplitId) => void;
}

export type WorkspaceStore = Workspace & WorkspaceActions;

/**
 * Tabs, groups and pane metadata. Serializable only: xterm instances live in terminalRegistry.
 * Empty until lib/sessionSync.ts restores the last session or opens the first tab.
 */
export const useWorkspace = create<WorkspaceStore>()((set, get) => {
  // Model functions return the same object when nothing changed, so no needless re-renders.
  const update = (fn: (ws: Workspace) => Workspace) => set((state) => fn(state));
  return {
    ...model.emptyWorkspace(),
    reset: () => set({ ...model.addTab(model.emptyWorkspace(), { tabId: nextId('tab'), paneId: nextId('pane') }) }),
    openWindow: (spec, options = {}) => {
      const base = options.replace ? model.emptyWorkspace() : get();
      const result = instantiate(base, spec, { id: nextId, activate: true });
      set({ tabs: result.ws.tabs, tabOrder: result.ws.tabOrder, groups: result.ws.groups, panes: result.ws.panes, activeTabId: result.ws.activeTabId });
      return result;
    },
    newTab: (spec = {}) => {
      const tabId = nextId('tab');
      update((ws) => {
        const cwd =
          spec.cwd !== undefined ? spec.cwd : (profileFor(spec.profile)?.cwd ?? model.spawnOf(ws, selectActivePaneId(ws)).cwd);
        return model.addTab(ws, { ...spec, cwd, tabId, paneId: nextId('pane') });
      });
      return tabId;
    },
    closeTabs: (ids) => update((ws) => model.closeTabs(ws, ids)),
    duplicateTab: (id) => {
      const ws = get();
      const tab = ws.tabs[id];
      if (!tab) return null;
      // Same name, color, group, profile and folder (the one its active pane is in now).
      const { profile, cwd } = model.spawnOf(ws, tab.activePaneId);
      return ws.newTab({ after: id, groupId: tab.groupId, customTitle: tab.customTitle, color: tab.color, profile, cwd });
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
    setPaneStatus: (paneId, status, exitCode, sessionId) =>
      update((ws) => model.setPaneStatus(ws, paneId, status, exitCode, sessionId)),
    setPaneSession: (paneId, info) => update((ws) => model.setPaneSession(ws, paneId, info)),
    applyShellEvent: (paneId, event) => update((ws) => model.applyShellEvent(ws, paneId, event)),
    markActivity: (paneId) => update((ws) => model.markActivity(ws, paneId)),
    setPaneAgent: (paneId, agent) => update((ws) => model.setPaneAgent(ws, paneId, agent)),
    setPaneWorktree: (paneId, worktree) => update((ws) => model.setPaneWorktree(ws, paneId, worktree)),
    splitPane: (direction, paneId, spawn) => {
      const target = paneId ?? selectActivePaneId(get());
      if (!target) return null;
      const ids = { paneId: nextId('pane'), splitId: nextId('split') };
      update((ws) => model.splitPane(ws, target, direction, ids, { ...model.spawnOf(ws, target), ...spawn }));
      return get().panes[ids.paneId] ? ids.paneId : null;
    },
    closePane: (paneId) => update((ws) => model.closePane(ws, paneId)),
    focusPane: (paneId) => update((ws) => model.focusPane(ws, paneId)),
    focusDirection: (direction) => update((ws) => model.focusDirection(ws, direction)),
    toggleZoom: () => update((ws) => model.toggleZoom(ws)),
    setSplitSizes: (splitId, sizes) => update((ws) => model.setSplitSizes(ws, splitId, sizes)),
    equalizeSplit: (splitId) => update((ws) => model.equalizeSplit(ws, splitId)),
  };
});

/** Pane shown in the active tab, if any. */
export const selectActivePaneId = (ws: Workspace): PaneId | null =>
  ws.activeTabId ? (ws.tabs[ws.activeTabId]?.activePaneId ?? null) : null;
