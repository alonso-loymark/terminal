// Unit tests for the pure workspace model. Run with `npm test` (node --test, no extra deps).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activateIndex,
  activateTab,
  addTab,
  closeTabs,
  createGroup,
  cycleTab,
  emptyWorkspace,
  markActivity,
  moveTab,
  moveTabToGroup,
  prettifyTitle,
  removeFromGroup,
  renameTab,
  setPaneStatus,
  setPaneTitle,
  tabIndicator,
  tabsInGroup,
  tabTitle,
  toggleGroupCollapsed,
  ungroup,
  visibleTabIds,
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
