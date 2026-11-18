// Pure model of the workspace: tabs, tab groups and the panes that hold terminal sessions.
// No runtime imports, so `node --test` can run it directly (see workspaceModel.test.ts).
//
// Shape, chosen with split panes in mind:
//   - a Tab owns a Layout tree of panes; today it is always a single pane, the next phase adds
//     `{ type: 'split', ... }` nodes without touching tabs or groups;
//   - Pane holds the per-session metadata (title from OSC 0/2, status, unseen output);
//   - groups are Chrome-style: a group is a contiguous run of tabs in `tabOrder` sharing a
//     groupId. Every operation keeps that invariant (see `normalize`).

export type TabId = string;
export type PaneId = string;
export type GroupId = string;
export type SessionStatus = 'starting' | 'running' | 'exited' | 'failed';

export const COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'] as const;
export type TabColor = (typeof COLORS)[number];

/** Pane tree of a tab. Phase 2: a single pane. */
export type Layout = { type: 'pane'; paneId: PaneId };

export interface Pane {
  id: PaneId;
  /** Last title set by the process (OSC 0/2). */
  title: string;
  status: SessionStatus;
  exitCode: number | null;
  /** New output arrived while the pane's tab was not visible. */
  activity: boolean;
}

export interface Tab {
  id: TabId;
  /** Set by the user; while null the tab follows the process title. */
  customTitle: string | null;
  color: TabColor | null;
  groupId: GroupId | null;
  layout: Layout;
  activePaneId: PaneId;
}

export interface Group {
  id: GroupId;
  name: string;
  color: TabColor;
  collapsed: boolean;
}

export interface Workspace {
  tabs: Record<TabId, Tab>;
  tabOrder: TabId[];
  groups: Record<GroupId, Group>;
  panes: Record<PaneId, Pane>;
  activeTabId: TabId | null;
}

export type TabIndicator = 'activity' | 'exited' | 'exited-error' | null;

export const emptyWorkspace = (): Workspace => ({ tabs: {}, tabOrder: [], groups: {}, panes: {}, activeTabId: null });

export function panesOf(layout: Layout): PaneId[] {
  return [layout.paneId];
}

export function tabOfPane(ws: Workspace, paneId: PaneId): TabId | null {
  for (const id of ws.tabOrder) {
    const tab = ws.tabs[id];
    if (tab && panesOf(tab.layout).includes(paneId)) return id;
  }
  return null;
}

export function tabsInGroup(ws: Workspace, groupId: GroupId): TabId[] {
  return ws.tabOrder.filter((id) => ws.tabs[id]?.groupId === groupId);
}

/** Tabs drawn in the strip: everything except tabs of collapsed groups. */
export function visibleTabIds(ws: Workspace): TabId[] {
  return ws.tabOrder.filter((id) => {
    const groupId = ws.tabs[id]?.groupId;
    return !groupId || !ws.groups[groupId]?.collapsed;
  });
}

/** "C:\...\powershell.exe" → "powershell"; any other title is kept as is. */
export function prettifyTitle(raw: string): string {
  const title = raw.trim();
  const path = /^(?:[A-Za-z]:)?[\\/](?:[^\\/]+[\\/])*([^\\/]+?)(?:\.exe)?$/i.exec(title);
  return path?.[1] ?? title;
}

export function tabTitle(ws: Workspace, tabId: TabId, fallback = 'Terminal'): string {
  const tab = ws.tabs[tabId];
  if (!tab) return fallback;
  if (tab.customTitle) return tab.customTitle;
  const title = prettifyTitle(ws.panes[tab.activePaneId]?.title ?? '');
  return title || fallback;
}

export function tabIndicator(ws: Workspace, tabId: TabId): TabIndicator {
  const tab = ws.tabs[tabId];
  if (!tab) return null;
  const panes = panesOf(tab.layout).map((id) => ws.panes[id]).filter((p): p is Pane => !!p);
  if (panes.some((p) => p.status === 'failed' || (p.status === 'exited' && p.exitCode !== 0 && p.exitCode !== null))) {
    return 'exited-error';
  }
  if (panes.some((p) => p.status === 'exited')) return 'exited';
  return panes.some((p) => p.activity) ? 'activity' : null;
}

// ---------------------------------------------------------------- tabs

export interface NewTab {
  tabId: TabId;
  paneId: PaneId;
  /** Insert right after this tab (default: at the end). */
  after?: TabId | null;
  groupId?: GroupId | null;
  customTitle?: string | null;
  color?: TabColor | null;
  activate?: boolean;
}

export function addTab(ws: Workspace, spec: NewTab): Workspace {
  const groupId = spec.groupId && ws.groups[spec.groupId] ? spec.groupId : null;
  const tab: Tab = {
    id: spec.tabId,
    customTitle: spec.customTitle ?? null,
    color: spec.color ?? null,
    groupId,
    layout: { type: 'pane', paneId: spec.paneId },
    activePaneId: spec.paneId,
  };
  const pane: Pane = { id: spec.paneId, title: '', status: 'starting', exitCode: null, activity: false };
  const at = spec.after ? ws.tabOrder.indexOf(spec.after) : -1;
  const tabOrder = [...ws.tabOrder];
  tabOrder.splice(at >= 0 ? at + 1 : tabOrder.length, 0, tab.id);
  const next = normalize({
    ...ws,
    tabs: { ...ws.tabs, [tab.id]: tab },
    panes: { ...ws.panes, [pane.id]: pane },
    tabOrder,
    activeTabId: ws.activeTabId ?? tab.id,
  });
  return spec.activate === false ? next : activateTab(next, tab.id);
}

export function closeTabs(ws: Workspace, ids: TabId[]): Workspace {
  const doomed = new Set(ids.filter((id) => ws.tabs[id]));
  if (doomed.size === 0) return ws;
  let activeTabId = ws.activeTabId;
  if (activeTabId && doomed.has(activeTabId)) {
    // Like browsers: the neighbor to the right, else to the left; visible tabs first.
    const at = ws.tabOrder.indexOf(activeTabId);
    const visible = new Set(visibleTabIds(ws));
    const right = ws.tabOrder.slice(at + 1).filter((id) => !doomed.has(id));
    const left = ws.tabOrder.slice(0, at).filter((id) => !doomed.has(id)).reverse();
    const candidates = [...right, ...left];
    activeTabId = candidates.find((id) => visible.has(id)) ?? candidates[0] ?? null;
  }
  const tabs = { ...ws.tabs };
  const panes = { ...ws.panes };
  for (const id of doomed) {
    const tab = tabs[id];
    if (tab) for (const paneId of panesOf(tab.layout)) delete panes[paneId];
    delete tabs[id];
  }
  const next = normalize({ ...ws, tabs, panes, tabOrder: ws.tabOrder.filter((id) => !doomed.has(id)), activeTabId });
  return next.activeTabId ? activateTab(next, next.activeTabId) : next;
}

/** Makes a tab active: expands its group if collapsed and clears its activity marks. */
export function activateTab(ws: Workspace, id: TabId): Workspace {
  const tab = ws.tabs[id];
  if (!tab) return ws;
  let groups = ws.groups;
  const group = tab.groupId ? ws.groups[tab.groupId] : undefined;
  if (group?.collapsed) groups = { ...groups, [group.id]: { ...group, collapsed: false } };
  let panes = ws.panes;
  for (const paneId of panesOf(tab.layout)) {
    const pane = panes[paneId];
    if (pane?.activity) panes = { ...panes, [paneId]: { ...pane, activity: false } };
  }
  if (ws.activeTabId === id && groups === ws.groups && panes === ws.panes) return ws;
  return { ...ws, activeTabId: id, groups, panes };
}

/** Next/previous visible tab, wrapping around (Ctrl+Tab / Ctrl+Shift+Tab). */
export function cycleTab(ws: Workspace, delta: number): Workspace {
  const visible = visibleTabIds(ws);
  if (visible.length === 0 || !ws.activeTabId) return ws;
  const at = Math.max(0, visible.indexOf(ws.activeTabId));
  const next = visible[(((at + delta) % visible.length) + visible.length) % visible.length];
  return next ? activateTab(ws, next) : ws;
}

/** Ctrl+1..8 jump to that tab; Ctrl+9 to the last one (browser convention). */
export function activateIndex(ws: Workspace, n: number): Workspace {
  const id = n >= 9 ? ws.tabOrder.at(-1) : ws.tabOrder[n - 1];
  return id ? activateTab(ws, id) : ws;
}

/** `null` or blank goes back to following the process title. */
export function renameTab(ws: Workspace, id: TabId, title: string | null): Workspace {
  const tab = ws.tabs[id];
  if (!tab) return ws;
  const customTitle = title?.trim() || null;
  return { ...ws, tabs: { ...ws.tabs, [id]: { ...tab, customTitle } } };
}

export function setTabColor(ws: Workspace, id: TabId, color: TabColor | null): Workspace {
  const tab = ws.tabs[id];
  if (!tab) return ws;
  return { ...ws, tabs: { ...ws.tabs, [id]: { ...tab, color } } };
}

/**
 * Drag & drop: `id` dropped over tab `overId`. Group membership after the move:
 *   - strictly between two tabs of the same group → joins that group;
 *   - at the edge of its own group → stays in it;
 *   - the only tab of its group → the group moves with it;
 *   - anywhere else → leaves its group.
 */
export function moveTab(ws: Workspace, id: TabId, overId: TabId): Workspace {
  const tab = ws.tabs[id];
  const from = ws.tabOrder.indexOf(id);
  const to = ws.tabOrder.indexOf(overId);
  if (!tab || from < 0 || to < 0 || from === to) return ws;
  const tabOrder = [...ws.tabOrder];
  tabOrder.splice(to, 0, ...tabOrder.splice(from, 1));
  const at = tabOrder.indexOf(id);
  const left = groupAt(ws, tabOrder[at - 1]);
  const right = groupAt(ws, tabOrder[at + 1]);
  const own = tab.groupId;
  let groupId: GroupId | null = null;
  if (left && left === right) groupId = left;
  else if (own && (left === own || right === own)) groupId = own;
  else if (own && tabsInGroup(ws, own).length === 1) groupId = own;
  return normalize({ ...ws, tabOrder, tabs: { ...ws.tabs, [id]: { ...tab, groupId } } });
}

function groupAt(ws: Workspace, id: TabId | undefined): GroupId | null {
  return id ? (ws.tabs[id]?.groupId ?? null) : null;
}

// ---------------------------------------------------------------- groups

/** Adds a tab at the end of a group (drop on the group chip, "Mover a grupo"). */
export function moveTabToGroup(ws: Workspace, tabId: TabId, groupId: GroupId): Workspace {
  const tab = ws.tabs[tabId];
  if (!tab || !ws.groups[groupId] || tab.groupId === groupId) return ws;
  const without = ws.tabOrder.filter((id) => id !== tabId);
  const members = without.filter((id) => ws.tabs[id]?.groupId === groupId);
  const last = members.at(-1);
  const at = last ? without.indexOf(last) + 1 : without.length;
  without.splice(at, 0, tabId);
  let next = normalize({ ...ws, tabOrder: without, tabs: { ...ws.tabs, [tabId]: { ...tab, groupId } } });
  // The active tab must stay visible.
  if (next.activeTabId === tabId) next = activateTab(next, tabId);
  return next;
}

/** Takes a tab out of its group, placing it right after the group. */
export function removeFromGroup(ws: Workspace, tabId: TabId): Workspace {
  const tab = ws.tabs[tabId];
  if (!tab?.groupId) return ws;
  const members = tabsInGroup(ws, tab.groupId);
  const without = ws.tabOrder.filter((id) => id !== tabId);
  const lastOther = members.filter((id) => id !== tabId).at(-1);
  const at = lastOther ? without.indexOf(lastOther) + 1 : ws.tabOrder.indexOf(tabId);
  without.splice(at, 0, tabId);
  return normalize({ ...ws, tabOrder: without, tabs: { ...ws.tabs, [tabId]: { ...tab, groupId: null } } });
}

export function createGroup(
  ws: Workspace,
  tabId: TabId,
  group: { id: GroupId; name: string; color: TabColor },
): Workspace {
  if (!ws.tabs[tabId] || ws.groups[group.id]) return ws;
  const base = removeFromGroup(ws, tabId);
  const tab = base.tabs[tabId];
  if (!tab) return ws;
  return normalize({
    ...base,
    groups: { ...base.groups, [group.id]: { ...group, collapsed: false } },
    tabs: { ...base.tabs, [tabId]: { ...tab, groupId: group.id } },
  });
}

export function renameGroup(ws: Workspace, groupId: GroupId, name: string): Workspace {
  const group = ws.groups[groupId];
  if (!group) return ws;
  return { ...ws, groups: { ...ws.groups, [groupId]: { ...group, name: name.trim() } } };
}

export function setGroupColor(ws: Workspace, groupId: GroupId, color: TabColor): Workspace {
  const group = ws.groups[groupId];
  if (!group) return ws;
  return { ...ws, groups: { ...ws.groups, [groupId]: { ...group, color } } };
}

/**
 * Collapsing a group that holds the active tab first activates the nearest visible tab
 * outside it; if there is none, the group stays expanded (the active tab is never hidden).
 */
export function toggleGroupCollapsed(ws: Workspace, groupId: GroupId): Workspace {
  const group = ws.groups[groupId];
  if (!group) return ws;
  if (group.collapsed) return { ...ws, groups: { ...ws.groups, [groupId]: { ...group, collapsed: false } } };
  let next: Workspace = ws;
  if (ws.activeTabId && ws.tabs[ws.activeTabId]?.groupId === groupId) {
    const at = ws.tabOrder.indexOf(ws.activeTabId);
    const outside = (id: TabId) => groupAt(ws, id) !== groupId && visibleTabIds(ws).includes(id);
    const right = ws.tabOrder.slice(at + 1).find(outside);
    const left = ws.tabOrder.slice(0, at).reverse().find(outside);
    const target = right ?? left;
    if (!target) return ws;
    next = activateTab(ws, target);
  }
  return { ...next, groups: { ...next.groups, [groupId]: { ...group, collapsed: true } } };
}

export function ungroup(ws: Workspace, groupId: GroupId): Workspace {
  if (!ws.groups[groupId]) return ws;
  const tabs = { ...ws.tabs };
  for (const id of tabsInGroup(ws, groupId)) {
    const tab = tabs[id];
    if (tab) tabs[id] = { ...tab, groupId: null };
  }
  const groups = { ...ws.groups };
  delete groups[groupId];
  return { ...ws, tabs, groups };
}

// ---------------------------------------------------------------- panes

export function setPaneTitle(ws: Workspace, paneId: PaneId, title: string): Workspace {
  const pane = ws.panes[paneId];
  if (!pane || pane.title === title) return ws;
  return { ...ws, panes: { ...ws.panes, [paneId]: { ...pane, title } } };
}

export function setPaneStatus(ws: Workspace, paneId: PaneId, status: SessionStatus, exitCode: number | null): Workspace {
  const pane = ws.panes[paneId];
  if (!pane || (pane.status === status && pane.exitCode === exitCode)) return ws;
  return { ...ws, panes: { ...ws.panes, [paneId]: { ...pane, status, exitCode } } };
}

/** Output arrived: marks the pane unless its tab is the one on screen. Cheap no-op otherwise. */
export function markActivity(ws: Workspace, paneId: PaneId): Workspace {
  const pane = ws.panes[paneId];
  if (!pane || pane.activity) return ws;
  if (ws.activeTabId && ws.tabs[ws.activeTabId]?.activePaneId === paneId) return ws;
  return { ...ws, panes: { ...ws.panes, [paneId]: { ...pane, activity: true } } };
}

// ---------------------------------------------------------------- invariants

/**
 * Restores the invariants after any change: each group's tabs contiguous (placed where the
 * group first appears), no empty groups, no dangling group ids, a valid active tab.
 */
export function normalize(ws: Workspace): Workspace {
  const tabs = { ...ws.tabs };
  for (const id of ws.tabOrder) {
    const tab = tabs[id];
    if (tab?.groupId && !ws.groups[tab.groupId]) tabs[id] = { ...tab, groupId: null };
  }
  const placed = new Set<GroupId>();
  const tabOrder: TabId[] = [];
  for (const id of ws.tabOrder) {
    const groupId = tabs[id]?.groupId;
    if (!tabs[id]) continue;
    if (!groupId) {
      tabOrder.push(id);
    } else if (!placed.has(groupId)) {
      placed.add(groupId);
      tabOrder.push(...ws.tabOrder.filter((other) => tabs[other]?.groupId === groupId));
    }
  }
  const groups: Record<GroupId, Group> = {};
  for (const groupId of placed) {
    const group = ws.groups[groupId];
    if (group) groups[groupId] = group;
  }
  const activeTabId = ws.activeTabId && tabs[ws.activeTabId] ? ws.activeTabId : (tabOrder[0] ?? null);
  return { ...ws, tabs, tabOrder, groups, activeTabId };
}
