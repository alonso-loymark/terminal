// Pure model of the workspace: tabs, tab groups and the split panes that hold terminal sessions.
// No runtime imports, so `node --test` can run it directly (see workspaceModel.test.ts).
//
// Shape:
//   - a Tab owns a Layout tree: a leaf is a pane, a split lays its children out horizontally
//     (side by side) or vertically (stacked) with sizes in percent; splits nest without limit;
//   - Pane holds the per-session metadata (backend session id, OSC title, status, unseen
//     output) and what the shell integration reports (cwd, last command, exit code). Panes live in one global map, not inside tabs: a pane is identified by its id
//     wherever its leaf sits, so moving a leaf between tabs (`movePane`) keeps its terminal;
//   - groups are Chrome-style: a group is a contiguous run of tabs in `tabOrder` sharing a
//     groupId. Every operation keeps that invariant (see `normalize`).

export type TabId = string;
export type PaneId = string;
export type GroupId = string;
export type SplitId = string;
export type SessionStatus = 'starting' | 'running' | 'exited' | 'failed';
/** Shell profiles known to the backend (src-tauri/src/pty/shell.rs). */
export type ShellKind = 'powershell' | 'gitbash';
/**
 * pending: the integration script was injected and has not reported yet; ok: loaded;
 * unavailable: not injected (script missing); error: it failed to load (e.g. execution policy).
 */
export type IntegrationState = 'pending' | 'ok' | 'unavailable' | 'error';

/** What the shell integration reports through OSC 7 / 133 / 633 (see lib/shellIntegration.ts). */
export type ShellEvent =
  /** OSC 7: the shell's current directory (Windows path). */
  | { type: 'cwd'; cwd: string }
  /** OSC 133;A: a prompt is being drawn (the shell is idle). */
  | { type: 'prompt' }
  /** OSC 633;E: the command line about to run. */
  | { type: 'commandLine'; commandLine: string }
  /** OSC 133;C: the command started (its output follows). */
  | { type: 'commandStart' }
  /** OSC 133;D[;code]: the command finished. */
  | { type: 'commandEnd'; exitCode: number | null }
  /** OSC 633;P: the integration script loaded, or failed to. */
  | { type: 'integration'; ok: true }
  | { type: 'integration'; ok: false; error: string };

/** Where and with what a pane's session starts. */
export interface PaneSpawn {
  /** null: the default shell. */
  shell: ShellKind | null;
  /** null: the user's home. The backend also falls back to home if the folder is gone. */
  cwd: string | null;
}

export const COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'] as const;
export type TabColor = (typeof COLORS)[number];

/** horizontal: children side by side (vertical dividers); vertical: children stacked. */
export type SplitDirection = 'horizontal' | 'vertical';

export interface PaneLeaf {
  type: 'pane';
  paneId: PaneId;
}

export interface SplitNode {
  type: 'split';
  id: SplitId;
  direction: SplitDirection;
  children: Layout[];
  /** One per child, in percent of the split, summing to 100. */
  sizes: number[];
}

/** Pane tree of a tab. */
export type Layout = PaneLeaf | SplitNode;

/** A rectangle in fractions (0..1) of the tab's area. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The draggable boundary between children `index` and `index + 1` of a split. */
export interface Divider {
  splitId: SplitId;
  index: number;
  direction: SplitDirection;
  /** The whole split's rectangle; the divider sits at `offset` (fraction of it) along the axis. */
  split: Rect;
  offset: number;
  /** The split's current sizes (percent), the starting point of a drag. */
  sizes: number[];
}

export type FocusDirection = 'left' | 'right' | 'up' | 'down';

export interface Pane {
  id: PaneId;
  /** Backend PTY session while the shell runs. */
  sessionId: number | null;
  /** Last title set by the process (OSC 0/2). */
  title: string;
  status: SessionStatus;
  exitCode: number | null;
  /** New output arrived while the pane was not on screen. */
  activity: boolean;
  /** Shell profile: requested, then the one actually started. null = default. */
  shell: ShellKind | null;
  /** Folder the session was asked to start in (inherited from another pane); null = home. */
  startCwd: string | null;
  /** Current folder reported by the shell (OSC 7). */
  cwd: string | null;
  /** Last command line (OSC 633;E): the running one while `commandRunning`. */
  lastCommand: string | null;
  /** Exit code of the last finished command (OSC 133;D); null while running or unknown. */
  lastExitCode: number | null;
  /** Between OSC 133;C and 133;D. */
  commandRunning: boolean;
  integration: IntegrationState;
  integrationError: string | null;
}

export interface Tab {
  id: TabId;
  /** Set by the user; while null the tab follows the active pane's process title. */
  customTitle: string | null;
  color: TabColor | null;
  groupId: GroupId | null;
  layout: Layout;
  activePaneId: PaneId;
  /** Pane temporarily maximized inside the tab (Ctrl+Shift+Z). */
  zoomedPaneId: PaneId | null;
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

/** Leaves of a layout in visual order (left to right, top to bottom). */
export function panesOf(layout: Layout): PaneId[] {
  return layout.type === 'pane' ? [layout.paneId] : layout.children.flatMap(panesOf);
}

/** A pane is on screen when its tab is active and no other pane of the tab is zoomed. */
export function isPaneVisible(ws: Workspace, paneId: PaneId): boolean {
  const tab = ws.activeTabId ? ws.tabs[ws.activeTabId] : undefined;
  if (!tab || !panesOf(tab.layout).includes(paneId)) return false;
  return !tab.zoomedPaneId || tab.zoomedPaneId === paneId;
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
  shell?: ShellKind | null;
  cwd?: string | null;
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
    zoomedPaneId: null,
  };
  const pane = newPane(spec.paneId, { shell: spec.shell ?? null, cwd: spec.cwd ?? null });
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
  // What comes on screen is seen: clear the marks of the panes that become visible.
  const shown = tab.zoomedPaneId ? [tab.zoomedPaneId] : panesOf(tab.layout);
  const panes = clearActivity(ws.panes, shown);
  if (ws.activeTabId === id && groups === ws.groups && panes === ws.panes) return ws;
  return { ...ws, activeTabId: id, groups, panes };
}

function clearActivity(panes: Record<PaneId, Pane>, ids: PaneId[]): Record<PaneId, Pane> {
  let next = panes;
  for (const id of ids) {
    const pane = next[id];
    if (pane?.activity) next = { ...next, [id]: { ...pane, activity: false } };
  }
  return next;
}

const newPane = (id: PaneId, spawn: PaneSpawn = { shell: null, cwd: null }): Pane => ({
  id,
  sessionId: null,
  title: '',
  status: 'starting',
  exitCode: null,
  activity: false,
  shell: spawn.shell,
  startCwd: spawn.cwd,
  cwd: null,
  lastCommand: null,
  lastExitCode: null,
  commandRunning: false,
  integration: 'pending',
  integrationError: null,
});

/**
 * How to start a session like this pane's: same shell, in its current folder (the last one the
 * shell reported, else the one it started in). Used by split, duplicate, new tab and restart.
 */
export function spawnOf(ws: Workspace, paneId: PaneId | null | undefined): PaneSpawn {
  const pane = paneId ? ws.panes[paneId] : undefined;
  return { shell: pane?.shell ?? null, cwd: pane?.cwd ?? pane?.startCwd ?? null };
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

export function setPaneStatus(
  ws: Workspace,
  paneId: PaneId,
  status: SessionStatus,
  exitCode: number | null,
  sessionId: number | null = null,
): Workspace {
  const pane = ws.panes[paneId];
  if (!pane || (pane.status === status && pane.exitCode === exitCode && pane.sessionId === sessionId)) return ws;
  let next: Pane = { ...pane, status, exitCode, sessionId };
  if (status === 'starting' && pane.status !== 'starting') {
    // A new session (restart): nothing reported yet. The folder stays: the session starts there.
    next = {
      ...next,
      lastCommand: null,
      lastExitCode: null,
      commandRunning: false,
      integration: 'pending',
      integrationError: null,
    };
  } else if (status === 'exited' || status === 'failed') {
    next = { ...next, commandRunning: false };
  }
  return { ...ws, panes: { ...ws.panes, [paneId]: next } };
}

/** The backend started the session: which shell, and whether the integration was injected. */
export function setPaneSession(
  ws: Workspace,
  paneId: PaneId,
  info: { shell: ShellKind; integration: boolean },
): Workspace {
  const pane = ws.panes[paneId];
  if (!pane) return ws;
  // Never downgrade an 'ok' or 'error' that the shell already reported.
  const integration: IntegrationState = !info.integration
    ? 'unavailable'
    : pane.integration === 'unavailable'
      ? 'pending'
      : pane.integration;
  if (pane.shell === info.shell && pane.integration === integration) return ws;
  return { ...ws, panes: { ...ws.panes, [paneId]: { ...pane, shell: info.shell, integration } } };
}

/** Applies one shell integration mark to the pane. Same object back if nothing changed. */
export function applyShellEvent(ws: Workspace, paneId: PaneId, event: ShellEvent): Workspace {
  const pane = ws.panes[paneId];
  if (!pane) return ws;
  let patch: Partial<Pane> | null = null;
  switch (event.type) {
    case 'cwd':
      // Our scripts report the folder at the prompt. While a command runs, an OSC 7 comes from
      // something else (ssh to another machine, a nested shell): not this pane's folder.
      if (!pane.commandRunning && pane.cwd !== event.cwd) patch = { cwd: event.cwd };
      break;
    case 'prompt':
      if (pane.commandRunning) patch = { commandRunning: false };
      break;
    case 'commandLine':
      if (pane.lastCommand !== event.commandLine) patch = { lastCommand: event.commandLine };
      break;
    case 'commandStart':
      if (!pane.commandRunning || pane.lastExitCode !== null) patch = { commandRunning: true, lastExitCode: null };
      break;
    case 'commandEnd':
      if (pane.commandRunning) patch = { commandRunning: false, lastExitCode: event.exitCode };
      break;
    case 'integration':
      if (event.ok) {
        if (pane.integration !== 'ok') patch = { integration: 'ok', integrationError: null };
      } else if (pane.integration !== 'error' || pane.integrationError !== (event.error || null)) {
        patch = { integration: 'error', integrationError: event.error || null };
      }
      break;
  }
  return patch ? { ...ws, panes: { ...ws.panes, [paneId]: { ...pane, ...patch } } } : ws;
}

/** Output arrived: marks the pane unless it is on screen. Cheap no-op otherwise. */
export function markActivity(ws: Workspace, paneId: PaneId): Workspace {
  const pane = ws.panes[paneId];
  if (!pane || pane.activity || isPaneVisible(ws, paneId)) return ws;
  return { ...ws, panes: { ...ws.panes, [paneId]: { ...pane, activity: true } } };
}

// ---------------------------------------------------------------- split panes: tree

const MIN_SIZE = 5; // percent of its split; the UI enforces a pixel minimum on top
const EPS = 1e-6;

const containsPane = (node: Layout, paneId: PaneId): boolean =>
  node.type === 'pane' ? node.paneId === paneId : node.children.some((child) => containsPane(child, paneId));

/** Scales sizes to sum 100, keeping proportions; then lifts tiny ones to about MIN_SIZE. */
function normalizeSizes(sizes: number[]): number[] {
  const scale = (values: number[]) => {
    const total = values.reduce((a, b) => a + b, 0) || 1;
    return values.map((v) => (v / total) * 100);
  };
  const scaled = scale(sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0)));
  const floor = sizes.length * MIN_SIZE <= 100 ? MIN_SIZE : 0;
  return scaled.some((s) => s < floor) ? scale(scaled.map((s) => Math.max(floor, s))) : scaled;
}

/**
 * Canonical tree: a split with one child is replaced by the child, and a split nested in a
 * split of the same direction is merged into its parent (sizes scaled), so dividers act
 * on the visible arrangement.
 */
function normalizeLayout(node: Layout): Layout {
  if (node.type === 'pane') return node;
  const children: Layout[] = [];
  const sizes: number[] = [];
  node.children.forEach((raw, i) => {
    const child = normalizeLayout(raw);
    const share = node.sizes[i] ?? 0;
    if (child.type === 'split' && child.direction === node.direction) {
      child.children.forEach((grandchild, k) => {
        children.push(grandchild);
        sizes.push((share * (child.sizes[k] ?? 0)) / 100);
      });
    } else {
      children.push(child);
      sizes.push(share);
    }
  });
  if (children.length === 1 && children[0]) return children[0];
  return { ...node, children, sizes: normalizeSizes(sizes) };
}

/** Puts `leaf` next to `target`, splitting `target`'s share in half. */
function insertBeside(node: Layout, target: PaneId, direction: SplitDirection, leaf: PaneLeaf, splitId: SplitId): Layout {
  if (node.type === 'pane') {
    if (node.paneId !== target) return node;
    return { type: 'split', id: splitId, direction, children: [node, leaf], sizes: [50, 50] };
  }
  const at = node.children.findIndex((child) => child.type === 'pane' && child.paneId === target);
  if (at >= 0 && node.direction === direction) {
    // Same direction: a new sibling instead of another nesting level.
    const children = [...node.children];
    children.splice(at + 1, 0, leaf);
    const sizes = [...node.sizes];
    const half = (sizes[at] ?? 0) / 2;
    sizes.splice(at, 1, half, half);
    return { ...node, children, sizes };
  }
  const children = node.children.map((child) => insertBeside(child, target, direction, leaf, splitId));
  return children.every((child, i) => child === node.children[i]) ? node : { ...node, children };
}

/**
 * Removes a pane; its share goes to the adjacent sibling (the previous one, else the next).
 * Returns the new tree (null if it was the last pane) and the pane that inherits the space.
 */
function removeFromTree(node: Layout, paneId: PaneId): { layout: Layout | null; heir: PaneId | null } {
  if (node.type === 'pane') return { layout: node.paneId === paneId ? null : node, heir: null };
  const at = node.children.findIndex((child) => containsPane(child, paneId));
  const target = node.children[at];
  if (!target) return { layout: node, heir: null };
  const inner = removeFromTree(target, paneId);
  if (inner.layout) {
    const children = [...node.children];
    children[at] = inner.layout;
    return { layout: { ...node, children }, heir: inner.heir };
  }
  const children = node.children.filter((_, i) => i !== at);
  const sizes = node.sizes.filter((_, i) => i !== at);
  const heirAt = at > 0 ? at - 1 : 0;
  sizes[heirAt] = (sizes[heirAt] ?? 0) + (node.sizes[at] ?? 0);
  const heirNode = children[heirAt];
  // The pane of the heir subtree closest to where the removed one was.
  const heirPanes = heirNode ? panesOf(heirNode) : [];
  const heir = (at > 0 ? heirPanes.at(-1) : heirPanes[0]) ?? null;
  return { layout: { ...node, children, sizes }, heir };
}

function findSplit(node: Layout, splitId: SplitId): SplitNode | null {
  if (node.type === 'pane') return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const found = findSplit(child, splitId);
    if (found) return found;
  }
  return null;
}

function replaceSplit(node: Layout, splitId: SplitId, update: (split: SplitNode) => SplitNode): Layout {
  if (node.type === 'pane') return node;
  if (node.id === splitId) return update(node);
  const children = node.children.map((child) => replaceSplit(child, splitId, update));
  return children.every((child, i) => child === node.children[i]) ? node : { ...node, children };
}

/** The split that directly contains `paneId`, if any. */
export function parentSplit(node: Layout, paneId: PaneId): SplitNode | null {
  if (node.type === 'pane') return null;
  if (node.children.some((child) => child.type === 'pane' && child.paneId === paneId)) return node;
  for (const child of node.children) {
    const found = parentSplit(child, paneId);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------- split panes: geometry

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** Where every pane of the tree sits, in fractions of the tab area. */
export function layoutRects(layout: Layout, rect: Rect = FULL): Record<PaneId, Rect> {
  if (layout.type === 'pane') return { [layout.paneId]: rect };
  const out: Record<PaneId, Rect> = {};
  let offset = 0;
  layout.children.forEach((child, i) => {
    const share = (layout.sizes[i] ?? 0) / 100;
    const childRect =
      layout.direction === 'horizontal'
        ? { x: rect.x + offset * rect.w, y: rect.y, w: share * rect.w, h: rect.h }
        : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: share * rect.h };
    Object.assign(out, layoutRects(child, childRect));
    offset += share;
  });
  return out;
}

/** Every draggable boundary of the tree. */
export function layoutDividers(layout: Layout, rect: Rect = FULL): Divider[] {
  if (layout.type === 'pane') return [];
  const out: Divider[] = [];
  let offset = 0;
  layout.children.forEach((child, i) => {
    const share = (layout.sizes[i] ?? 0) / 100;
    const childRect =
      layout.direction === 'horizontal'
        ? { x: rect.x + offset * rect.w, y: rect.y, w: share * rect.w, h: rect.h }
        : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: share * rect.h };
    out.push(...layoutDividers(child, childRect));
    offset += share;
    if (i < layout.children.length - 1) {
      out.push({ splitId: layout.id, index: i, direction: layout.direction, split: rect, offset, sizes: layout.sizes });
    }
  });
  return out;
}

// ---------------------------------------------------------------- split panes: operations

/**
 * Splits a pane; the new pane gets half of its space and the focus (Alt+Shift+D / Alt+Shift+-).
 * By default it runs the same shell in the same folder as the pane it comes from.
 */
export function splitPane(
  ws: Workspace,
  paneId: PaneId,
  direction: SplitDirection,
  ids: { paneId: PaneId; splitId: SplitId },
  spawn: PaneSpawn = spawnOf(ws, paneId),
): Workspace {
  const tabId = tabOfPane(ws, paneId);
  const tab = tabId ? ws.tabs[tabId] : undefined;
  if (!tab || ws.panes[ids.paneId]) return ws;
  const layout = normalizeLayout(insertBeside(tab.layout, paneId, direction, { type: 'pane', paneId: ids.paneId }, ids.splitId));
  const next: Workspace = {
    ...ws,
    panes: { ...ws.panes, [ids.paneId]: newPane(ids.paneId, spawn) },
    tabs: { ...ws.tabs, [tab.id]: { ...tab, layout, activePaneId: ids.paneId, zoomedPaneId: null } },
  };
  return activateTab(next, tab.id);
}

/**
 * Closes a pane: the adjacent sibling takes its space (and the focus if it had it). The last
 * pane of a tab closes the tab.
 */
export function closePane(ws: Workspace, paneId: PaneId): Workspace {
  const tabId = tabOfPane(ws, paneId);
  const tab = tabId ? ws.tabs[tabId] : undefined;
  if (!tab) return ws;
  const { layout, heir } = removeFromTree(tab.layout, paneId);
  if (!layout) return closeTabs(ws, [tab.id]);
  const panes = { ...ws.panes };
  delete panes[paneId];
  const activePaneId = tab.activePaneId === paneId ? (heir ?? panesOf(layout)[0] ?? paneId) : tab.activePaneId;
  return {
    ...ws,
    panes,
    tabs: {
      ...ws.tabs,
      [tab.id]: { ...tab, layout: normalizeLayout(layout), activePaneId, zoomedPaneId: null },
    },
  };
}

/** Clicking a pane, or moving the focus to it. Also activates its tab. */
export function focusPane(ws: Workspace, paneId: PaneId): Workspace {
  const tabId = tabOfPane(ws, paneId);
  const tab = tabId ? ws.tabs[tabId] : undefined;
  if (!tab) return ws;
  const zoomedPaneId = tab.zoomedPaneId && tab.zoomedPaneId !== paneId ? null : tab.zoomedPaneId;
  const next =
    tab.activePaneId === paneId && zoomedPaneId === tab.zoomedPaneId
      ? ws
      : { ...ws, tabs: { ...ws.tabs, [tab.id]: { ...tab, activePaneId: paneId, zoomedPaneId } } };
  return activateTab({ ...next, panes: clearActivity(next.panes, [paneId]) }, tab.id);
}

/**
 * Alt+arrows: the nearest pane on that side of the active one, by on-screen position. Ties go
 * to the largest shared edge, then to the closest center, then to the first in visual order.
 */
export function focusDirection(ws: Workspace, direction: FocusDirection): Workspace {
  const tab = ws.activeTabId ? ws.tabs[ws.activeTabId] : undefined;
  if (!tab) return ws;
  const rects = layoutRects(tab.layout);
  const current = rects[tab.activePaneId];
  if (!current) return ws;
  const horizontal = direction === 'left' || direction === 'right';
  let best: { id: PaneId; distance: number; overlap: number; offCenter: number } | null = null;
  for (const id of panesOf(tab.layout)) {
    const r = rects[id];
    if (!r || id === tab.activePaneId) continue;
    let distance: number;
    if (direction === 'right') distance = r.x - (current.x + current.w);
    else if (direction === 'left') distance = current.x - (r.x + r.w);
    else if (direction === 'down') distance = r.y - (current.y + current.h);
    else distance = current.y - (r.y + r.h);
    if (distance < -EPS) continue; // not on that side
    const overlap = horizontal
      ? Math.min(r.y + r.h, current.y + current.h) - Math.max(r.y, current.y)
      : Math.min(r.x + r.w, current.x + current.w) - Math.max(r.x, current.x);
    if (overlap <= EPS) continue; // no shared edge
    const offCenter = horizontal
      ? Math.abs(r.y + r.h / 2 - (current.y + current.h / 2))
      : Math.abs(r.x + r.w / 2 - (current.x + current.w / 2));
    const better =
      !best ||
      distance < best.distance - EPS ||
      (Math.abs(distance - best.distance) <= EPS &&
        (overlap > best.overlap + EPS || (Math.abs(overlap - best.overlap) <= EPS && offCenter < best.offCenter - EPS)));
    if (better) best = { id, distance, overlap, offCenter };
  }
  return best ? focusPane(ws, best.id) : ws;
}

/** Ctrl+Shift+Z: maximizes the active pane inside its tab, or restores the layout. */
export function toggleZoom(ws: Workspace): Workspace {
  const tab = ws.activeTabId ? ws.tabs[ws.activeTabId] : undefined;
  if (!tab || tab.layout.type === 'pane') return ws;
  if (tab.zoomedPaneId) {
    const tabs = { ...ws.tabs, [tab.id]: { ...tab, zoomedPaneId: null } };
    return { ...ws, tabs, panes: clearActivity(ws.panes, panesOf(tab.layout)) };
  }
  return { ...ws, tabs: { ...ws.tabs, [tab.id]: { ...tab, zoomedPaneId: tab.activePaneId } } };
}

/** Divider drag: new sizes (percent) for the children of a split. */
export function setSplitSizes(ws: Workspace, splitId: SplitId, sizes: number[]): Workspace {
  for (const id of ws.tabOrder) {
    const tab = ws.tabs[id];
    const split = tab ? findSplit(tab.layout, splitId) : null;
    if (!tab || !split) continue;
    if (sizes.length !== split.children.length) return ws;
    const layout = replaceSplit(tab.layout, splitId, (node) => ({ ...node, sizes: normalizeSizes(sizes) }));
    return { ...ws, tabs: { ...ws.tabs, [id]: { ...tab, layout } } };
  }
  return ws;
}

/** Double click on a divider: all children of the split share the space equally. */
export function equalizeSplit(ws: Workspace, splitId: SplitId): Workspace {
  for (const id of ws.tabOrder) {
    const split = ws.tabs[id] ? findSplit(ws.tabs[id].layout, splitId) : null;
    if (split) return setSplitSizes(ws, splitId, split.children.map(() => 100 / split.children.length));
  }
  return ws;
}

/**
 * Moves a pane (with its session and terminal: same id) next to `targetPaneId` in another tab
 * or the same one. A tab left without panes is removed. Not exposed in the UI yet.
 */
export function movePane(
  ws: Workspace,
  paneId: PaneId,
  targetPaneId: PaneId,
  direction: SplitDirection,
  splitId: SplitId,
): Workspace {
  const fromId = tabOfPane(ws, paneId);
  const toId = tabOfPane(ws, targetPaneId);
  const from = fromId ? ws.tabs[fromId] : undefined;
  if (!from || !toId || paneId === targetPaneId) return ws;
  const { layout: rest, heir } = removeFromTree(from.layout, paneId);
  let tabs = { ...ws.tabs };
  let tabOrder = ws.tabOrder;
  if (rest) {
    const activePaneId = from.activePaneId === paneId ? (heir ?? panesOf(rest)[0] ?? paneId) : from.activePaneId;
    tabs[from.id] = { ...from, layout: normalizeLayout(rest), activePaneId, zoomedPaneId: null };
  } else {
    delete tabs[from.id];
    tabOrder = tabOrder.filter((id) => id !== from.id);
  }
  const to = tabs[toId];
  if (!to) return ws;
  const layout = normalizeLayout(insertBeside(to.layout, targetPaneId, direction, { type: 'pane', paneId }, splitId));
  tabs = { ...tabs, [to.id]: { ...to, layout, activePaneId: paneId, zoomedPaneId: null } };
  return activateTab(normalize({ ...ws, tabs, tabOrder }), to.id);
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
