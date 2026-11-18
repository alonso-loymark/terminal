// Unit tests for the pure workspace model. Run with `npm test` (node --test, no extra deps).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activateIndex,
  activateTab,
  addTab,
  closePane,
  closeTabs,
  createGroup,
  cycleTab,
  emptyWorkspace,
  equalizeSplit,
  focusDirection,
  focusPane,
  layoutDividers,
  layoutRects,
  markActivity,
  movePane,
  moveTab,
  moveTabToGroup,
  prettifyTitle,
  removeFromGroup,
  renameTab,
  panesOf,
  setPaneStatus,
  setPaneTitle,
  setSplitSizes,
  splitPane,
  tabIndicator,
  tabsInGroup,
  tabTitle,
  toggleGroupCollapsed,
  toggleZoom,
  ungroup,
  visibleTabIds,
  type Layout,
  type Workspace,
} from './workspaceModel.ts';

/** Workspace with tabs t1..tn (panes p1..pn), t1 active. */
function workspace(n: number): Workspace {
  let ws = emptyWorkspace();
  for (let i = 1; i <= n; i++) ws = addTab(ws, { tabId: `t${i}`, paneId: `p${i}`, activate: i === 1 });
  return ws;
}

/** t1..tn with t2,t3 in group "g" (needs n >= 4). */
function grouped(n = 5): Workspace {
  let ws = createGroup(workspace(n), 't2', { id: 'g', name: 'G', color: 'blue' });
  ws = moveTabToGroup(ws, 't3', 'g');
  assert.deepEqual(tabsInGroup(ws, 'g'), ['t2', 't3']);
  return ws;
}

const groupOf = (ws: Workspace, id: string) => ws.tabs[id]?.groupId ?? null;

test('new tabs go to the end and become active; "after" inserts next to a tab', () => {
  let ws = workspace(3);
  assert.deepEqual(ws.tabOrder, ['t1', 't2', 't3']);
  assert.equal(ws.activeTabId, 't1');
  ws = addTab(ws, { tabId: 't4', paneId: 'p4', after: 't1' });
  assert.deepEqual(ws.tabOrder, ['t1', 't4', 't2', 't3']);
  assert.equal(ws.activeTabId, 't4');
});

test('closing the active tab activates the right neighbor, else the left one', () => {
  let ws = activateTab(workspace(3), 't2');
  ws = closeTabs(ws, ['t2']);
  assert.equal(ws.activeTabId, 't3');
  ws = closeTabs(ws, ['t3']);
  assert.equal(ws.activeTabId, 't1');
  assert.equal(ws.panes.p3, undefined, 'pane removed with its tab');
  ws = closeTabs(ws, ['t1']);
  assert.equal(ws.activeTabId, null);
  assert.deepEqual(ws.tabOrder, []);
});

test('Ctrl+Tab cycles visible tabs with wrap-around; Ctrl+9 is the last tab', () => {
  let ws = workspace(3);
  ws = cycleTab(ws, 1);
  assert.equal(ws.activeTabId, 't2');
  ws = cycleTab(cycleTab(ws, 1), 1);
  assert.equal(ws.activeTabId, 't1');
  ws = cycleTab(ws, -1);
  assert.equal(ws.activeTabId, 't3');
  assert.equal(activateIndex(ws, 1).activeTabId, 't1');
  assert.equal(activateIndex(ws, 9).activeTabId, 't3');
  assert.equal(activateIndex(ws, 7).activeTabId, 't3', 'out of range: unchanged');
});

test('a custom title wins over the process title; blank resets it', () => {
  let ws = setPaneTitle(workspace(1), 'p1', 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(tabTitle(ws, 't1'), 'powershell');
  ws = renameTab(ws, 't1', '  Backend  ');
  assert.equal(tabTitle(ws, 't1'), 'Backend');
  ws = setPaneTitle(ws, 'p1', 'claude');
  assert.equal(tabTitle(ws, 't1'), 'Backend', 'process title does not override a rename');
  ws = renameTab(ws, 't1', '   ');
  assert.equal(tabTitle(ws, 't1'), 'claude');
});

test('prettifyTitle shortens executable paths only', () => {
  assert.equal(prettifyTitle('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'pwsh');
  assert.equal(prettifyTitle('✳ Claude Code'), '✳ Claude Code');
  assert.equal(prettifyTitle('npm run dev'), 'npm run dev');
});

test('activity marks only panes of hidden tabs and clears on activation', () => {
  let ws = workspace(2);
  assert.equal(markActivity(ws, 'p1'), ws, 'active tab: no-op, same object');
  ws = markActivity(ws, 'p2');
  assert.equal(tabIndicator(ws, 't2'), 'activity');
  assert.equal(markActivity(ws, 'p2'), ws, 'already marked: same object');
  ws = activateTab(ws, 't2');
  assert.equal(tabIndicator(ws, 't2'), null);
});

test('exited tabs show a distinct indicator, red for a non-zero code', () => {
  let ws = setPaneStatus(workspace(2), 'p2', 'exited', 0);
  assert.equal(tabIndicator(ws, 't2'), 'exited');
  ws = setPaneStatus(ws, 'p2', 'exited', 1);
  assert.equal(tabIndicator(ws, 't2'), 'exited-error');
  ws = setPaneStatus(ws, 'p1', 'failed', null);
  assert.equal(tabIndicator(ws, 't1'), 'exited-error');
});

test('createGroup on a grouped tab moves it out next to its old group', () => {
  let ws = grouped();
  ws = createGroup(ws, 't2', { id: 'h', name: 'H', color: 'red' });
  assert.deepEqual(ws.tabOrder, ['t1', 't3', 't2', 't4', 't5']);
  assert.equal(groupOf(ws, 't2'), 'h');
  assert.deepEqual(tabsInGroup(ws, 'g'), ['t3']);
});

test('drag: a tab dropped strictly inside a group joins it', () => {
  // order: t1 [t2 t3] t4 t5 → drop t5 over t3 → t1 [t2 t5 t3] t4
  const ws = moveTab(grouped(), 't5', 't3');
  assert.deepEqual(ws.tabOrder, ['t1', 't2', 't5', 't3', 't4']);
  assert.equal(groupOf(ws, 't5'), 'g');
});

test('drag: a grouped tab dropped among ungrouped tabs leaves the group', () => {
  // t1 [t2 t3] t4 t5 → drop t2 over t5 → t1 [t3] t4 t5 t2
  const ws = moveTab(grouped(), 't2', 't5');
  assert.deepEqual(ws.tabOrder, ['t1', 't3', 't4', 't5', 't2']);
  assert.equal(groupOf(ws, 't2'), null);
  assert.deepEqual(tabsInGroup(ws, 'g'), ['t3']);
});

test('drag: reordering inside a group, or to its edge, keeps the membership', () => {
  let ws = moveTab(grouped(), 't3', 't2');
  assert.deepEqual(ws.tabOrder, ['t1', 't3', 't2', 't4', 't5']);
  assert.equal(groupOf(ws, 't3'), 'g');
  // t1 [t3 t2] t4 t5 → drop t3 over t2: it ends at the group's right edge, next to t4
  ws = moveTab(ws, 't3', 't2');
  assert.deepEqual(ws.tabOrder, ['t1', 't2', 't3', 't4', 't5']);
  assert.equal(groupOf(ws, 't3'), 'g');
  assert.equal(groupOf(ws, 't2'), 'g');
});

test('drag: an ungrouped tab dropped at a group edge stays ungrouped', () => {
  // t1 [t2 t3] t4 t5 → drop t5 over t4 → t1 [t2 t3] t5 t4: left neighbor in g, right is not
  const ws = moveTab(grouped(), 't5', 't4');
  assert.deepEqual(ws.tabOrder, ['t1', 't2', 't3', 't5', 't4']);
  assert.equal(groupOf(ws, 't5'), null);
});

test('drag: the only tab of a group carries the group along', () => {
  let ws = createGroup(workspace(4), 't2', { id: 'g', name: 'G', color: 'blue' });
  ws = moveTab(ws, 't2', 't4');
  assert.deepEqual(ws.tabOrder, ['t1', 't3', 't4', 't2']);
  assert.equal(groupOf(ws, 't2'), 'g');
});

test('groups stay contiguous whatever happens', () => {
  let ws = grouped(6);
  ws = moveTabToGroup(ws, 't6', 'g');
  assert.deepEqual(ws.tabOrder, ['t1', 't2', 't3', 't6', 't4', 't5']);
  ws = removeFromGroup(ws, 't2');
  assert.deepEqual(ws.tabOrder, ['t1', 't3', 't6', 't2', 't4', 't5']);
  for (const groupId of Object.keys(ws.groups)) {
    const at = ws.tabOrder.map((id, i) => (ws.tabs[id]?.groupId === groupId ? i : -1)).filter((i) => i >= 0);
    assert.equal(at.at(-1)! - at[0]! + 1, at.length, `group ${groupId} is contiguous`);
  }
});

test('empty groups disappear; ungroup keeps the tabs', () => {
  let ws = grouped();
  ws = ungroup(ws, 'g');
  assert.equal(ws.groups.g, undefined);
  assert.equal(groupOf(ws, 't2'), null);
  ws = grouped();
  ws = closeTabs(ws, ['t2', 't3']);
  assert.equal(ws.groups.g, undefined);
});

test('collapsing hides the group; the active tab is moved out first', () => {
  let ws = activateTab(grouped(), 't3');
  ws = toggleGroupCollapsed(ws, 'g');
  assert.equal(ws.groups.g?.collapsed, true);
  assert.equal(ws.activeTabId, 't4', 'nearest visible tab to the right');
  assert.deepEqual(visibleTabIds(ws), ['t1', 't4', 't5']);
  assert.equal(cycleTab(ws, 1).activeTabId, 't5', 'Ctrl+Tab skips collapsed tabs');
  // Jumping into a collapsed group expands it.
  ws = activateIndex(ws, 2);
  assert.equal(ws.activeTabId, 't2');
  assert.equal(ws.groups.g?.collapsed, false);
});

test('a group holding every tab cannot hide the active tab', () => {
  let ws = createGroup(workspace(1), 't1', { id: 'g', name: 'G', color: 'blue' });
  ws = toggleGroupCollapsed(ws, 'g');
  assert.equal(ws.groups.g?.collapsed, false);
  assert.equal(ws.activeTabId, 't1');
});

test('moving the active tab into a collapsed group expands it', () => {
  let ws = toggleGroupCollapsed(grouped(), 'g');
  ws = activateTab(ws, 't5');
  ws = moveTabToGroup(ws, 't5', 'g');
  assert.equal(ws.groups.g?.collapsed, false);
  assert.equal(ws.activeTabId, 't5');
});

// ---------------------------------------------------------------- split panes

/** One tab t1 split into: [ p1 | (p2 / p3) ] — p2 above p3 on the right. */
function splitWorkspace(): Workspace {
  let ws = workspace(1);
  ws = splitPane(ws, 'p1', 'horizontal', { paneId: 'p2', splitId: 's1' });
  ws = splitPane(ws, 'p2', 'vertical', { paneId: 'p3', splitId: 's2' });
  return ws;
}

const layoutOf = (ws: Workspace, tabId = 't1'): Layout => {
  const tab = ws.tabs[tabId];
  assert.ok(tab, `tab ${tabId} exists`);
  return tab.layout;
};
/** Compact view of a tree: 'p1' or { h|v: [...children], sizes: [...] }. */
const shape = (node: Layout): unknown =>
  node.type === 'pane'
    ? node.paneId
    : { [node.direction === 'horizontal' ? 'h' : 'v']: node.children.map(shape), sizes: node.sizes.map(Math.round) };
const sizesOf = (ws: Workspace) => {
  const layout = layoutOf(ws);
  return layout.type === 'split' ? layout.sizes : null;
};

test('splitting nests splits and gives the new pane half the space and the focus', () => {
  const ws = splitWorkspace();
  assert.deepEqual(shape(layoutOf(ws)), { h: ['p1', { v: ['p2', 'p3'], sizes: [50, 50] }], sizes: [50, 50] });
  assert.equal(ws.tabs.t1?.activePaneId, 'p3');
  assert.deepEqual(panesOf(layoutOf(ws)), ['p1', 'p2', 'p3']);
  assert.equal(ws.panes.p3?.status, 'starting');
});

test('splitting in the same direction adds a sibling instead of nesting', () => {
  let ws = splitPane(workspace(1), 'p1', 'horizontal', { paneId: 'p2', splitId: 's1' });
  ws = splitPane(ws, 'p2', 'horizontal', { paneId: 'p3', splitId: 's2' });
  assert.deepEqual(shape(layoutOf(ws)), { h: ['p1', 'p2', 'p3'], sizes: [50, 25, 25] });
});

test('closing a pane gives its space to the sibling and collapses one-child splits', () => {
  let ws = splitWorkspace();
  ws = closePane(ws, 'p3');
  assert.deepEqual(shape(layoutOf(ws)), { h: ['p1', 'p2'], sizes: [50, 50] });
  assert.equal(ws.tabs.t1?.activePaneId, 'p2', 'the heir takes the focus');
  assert.equal(ws.panes.p3, undefined);
  ws = closePane(ws, 'p1');
  assert.deepEqual(shape(layoutOf(ws)), 'p2');
});

test('closing merges nested splits of the same direction', () => {
  // h[ p1, v[ p2, h[p3, p4] ] ] → close p2 → h[ p1, p3, p4 ]
  let ws = splitWorkspace();
  ws = splitPane(ws, 'p3', 'horizontal', { paneId: 'p4', splitId: 's3' });
  ws = closePane(ws, 'p2');
  assert.deepEqual(shape(layoutOf(ws)), { h: ['p1', 'p3', 'p4'], sizes: [50, 25, 25] });
});

test('closing the last pane closes the tab', () => {
  const ws = closePane(workspace(2), 'p1');
  assert.deepEqual(ws.tabOrder, ['t2']);
});

test('geometry: pane rectangles and dividers follow the tree', () => {
  const ws = setSplitSizes(splitWorkspace(), 's1', [30, 70]);
  const rects = layoutRects(layoutOf(ws));
  const round = (r: { x: number; y: number; w: number; h: number } | undefined) =>
    r && [r.x, r.y, r.w, r.h].map((v) => Math.round(v * 100));
  assert.deepEqual(round(rects.p1), [0, 0, 30, 100]);
  assert.deepEqual(round(rects.p2), [30, 0, 70, 50]);
  assert.deepEqual(round(rects.p3), [30, 50, 70, 50]);
  const dividers = layoutDividers(layoutOf(ws));
  // Visual order: the outer split's divider, then the one inside the right column.
  assert.deepEqual(
    dividers.map((d) => [d.splitId, d.direction, Math.round(d.offset * 100)]),
    [
      ['s1', 'horizontal', 30],
      ['s2', 'vertical', 50],
    ],
  );
});

test('sizes are normalized to 100 and equalize shares the space', () => {
  let ws = setSplitSizes(splitWorkspace(), 's1', [1, 3]);
  assert.deepEqual(sizesOf(ws), [25, 75]);
  ws = equalizeSplit(ws, 's1');
  assert.deepEqual(sizesOf(ws), [50, 50]);
  assert.equal(setSplitSizes(ws, 's1', [10, 20, 70]), ws, 'wrong number of sizes: ignored');
});

test('Alt+arrows move by on-screen position', () => {
  let ws = splitWorkspace(); // [ p1 | p2 / p3 ], focus p3
  ws = focusDirection(ws, 'up');
  assert.equal(ws.tabs.t1?.activePaneId, 'p2');
  ws = focusDirection(ws, 'left');
  assert.equal(ws.tabs.t1?.activePaneId, 'p1');
  ws = focusDirection(ws, 'right');
  assert.equal(ws.tabs.t1?.activePaneId, 'p2', 'tie between p2 and p3: same distance and overlap, first wins');
  assert.equal(focusDirection(ws, 'right'), ws, 'nothing further right: unchanged');
  ws = focusDirection(ws, 'down');
  assert.equal(ws.tabs.t1?.activePaneId, 'p3');
});

test('zoom maximizes the active pane; focusing another pane or splitting restores', () => {
  const ws = toggleZoom(splitWorkspace());
  assert.equal(ws.tabs.t1?.zoomedPaneId, 'p3');
  assert.equal(toggleZoom(ws).tabs.t1?.zoomedPaneId, null);
  assert.equal(focusPane(ws, 'p1').tabs.t1?.zoomedPaneId, null);
  assert.equal(splitPane(ws, 'p3', 'vertical', { paneId: 'p4', splitId: 's9' }).tabs.t1?.zoomedPaneId, null);
  assert.equal(toggleZoom(workspace(1)).tabs.t1?.zoomedPaneId, null, 'a single pane cannot zoom');
});

test('activity: any pane of the tab counts; visible panes are never marked', () => {
  let ws = addTab(splitWorkspace(), { tabId: 't9', paneId: 'p9', activate: false });
  assert.equal(markActivity(ws, 'p1'), ws, 'p1 is visible (its tab is active): no mark');
  ws = activateTab(ws, 't9');
  ws = markActivity(ws, 'p1'); // not the active pane of t1, and t1 is hidden
  assert.equal(tabIndicator(ws, 't1'), 'activity');
  ws = activateTab(ws, 't1');
  assert.equal(tabIndicator(ws, 't1'), null);
  // Zoomed on p3: p1 is hidden even though its tab is active.
  ws = markActivity(toggleZoom(ws), 'p1');
  assert.equal(tabIndicator(ws, 't1'), 'activity');
  ws = toggleZoom(ws);
  assert.equal(tabIndicator(ws, 't1'), null, 'restoring the layout shows it');
});

test('the tab title follows the active pane', () => {
  let ws = setPaneTitle(splitWorkspace(), 'p1', 'uno');
  ws = setPaneTitle(ws, 'p3', 'tres');
  assert.equal(tabTitle(ws, 't1'), 'tres');
  ws = focusPane(ws, 'p1');
  assert.equal(tabTitle(ws, 't1'), 'uno');
});

test('a pane can move to another tab keeping its id (prepared for drag between tabs)', () => {
  let ws = addTab(splitWorkspace(), { tabId: 't2', paneId: 'q1' });
  ws = movePane(ws, 'p2', 'q1', 'horizontal', 's7');
  assert.deepEqual(shape(layoutOf(ws, 't1')), { h: ['p1', 'p3'], sizes: [50, 50] });
  assert.deepEqual(shape(layoutOf(ws, 't2')), { h: ['q1', 'p2'], sizes: [50, 50] });
  assert.ok(ws.panes.p2, 'same pane, same session');
  assert.equal(ws.activeTabId, 't2');
  // Moving the only pane of a tab removes that tab.
  ws = movePane(ws, 'q1', 'p1', 'vertical', 's8');
  ws = movePane(ws, 'p2', 'p1', 'vertical', 's9');
  assert.deepEqual(ws.tabOrder, ['t1']);
  assert.deepEqual(panesOf(layoutOf(ws)).sort(), ['p1', 'p2', 'p3', 'q1']);
});
