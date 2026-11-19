import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_SESSION,
  instantiate,
  layoutToJson,
  parseLayouts,
  parseSession,
  sessionToText,
  snapshotWindow,
  windowToJson,
  type WindowSpec,
} from './layoutModel.ts';
import {
  addTab,
  applyShellEvent,
  createGroup,
  emptyWorkspace,
  panesOf,
  renameGroup,
  renameTab,
  setSplitSizes,
  setTabColor,
  splitPane,
  toggleGroupCollapsed,
  toggleZoom,
  type Workspace,
} from './workspaceModel.ts';

const ids = () => {
  let n = 0;
  return (prefix: string) => `${prefix}-r${++n}`;
};

/** Three tabs: a split one (3 panes, sizes, one folder reported by the shell), two in a group. */
function sample(): Workspace {
  let ws = emptyWorkspace();
  ws = addTab(ws, { tabId: 't1', paneId: 'p1', profile: 'pwsh', cwd: 'C:\\inicio' });
  ws = splitPane(ws, 'p1', 'horizontal', { paneId: 'p2', splitId: 's1' }, { profile: 'cmd', cwd: 'D:\\otra' });
  ws = splitPane(ws, 'p2', 'vertical', { paneId: 'p3', splitId: 's2' });
  ws = setSplitSizes(ws, 's1', [30, 70]);
  ws = applyShellEvent(ws, 'p1', { type: 'cwd', cwd: 'C:\\proyecto con espacios\\Ñandú' });
  ws = renameTab(ws, 't1', 'Proyecto X');
  ws = setTabColor(ws, 't1', 'purple');
  ws = addTab(ws, { tabId: 't2', paneId: 'p4' });
  ws = addTab(ws, { tabId: 't3', paneId: 'p5' });
  ws = createGroup(ws, 't2', { id: 'g1', name: 'Grupo 1', color: 'green' });
  ws = { ...ws, tabs: { ...ws.tabs, t3: { ...ws.tabs.t3!, groupId: 'g1' } } };
  ws = renameGroup(ws, 'g1', 'Servidores');
  return ws;
}

test('a workspace round-trips through the file format', () => {
  let ws = sample();
  ws = toggleGroupCollapsed({ ...ws, activeTabId: 't1' }, 'g1');
  ws = { ...ws, tabs: { ...ws.tabs, t1: { ...ws.tabs.t1!, activePaneId: 'p2' } } };
  const spec = snapshotWindow(ws);
  assert.deepEqual(spec.groups, [{ name: 'Servidores', color: 'green', collapsed: true }]);
  assert.deepEqual(windowToJson(spec).tabs, [
    {
      title: 'Proyecto X',
      color: 'purple',
      active: true,
      layout: {
        split: 'horizontal',
        sizes: [30, 70],
        panes: [
          { profile: 'pwsh', cwd: 'C:\\proyecto con espacios\\Ñandú' },
          { split: 'vertical', sizes: [50, 50], panes: [{ profile: 'cmd', cwd: 'D:\\otra', focus: true }, { profile: 'cmd', cwd: 'D:\\otra' }] },
        ],
      },
    },
    { group: 'Servidores' },
    { group: 'Servidores' },
  ]);

  // The file text goes back to the same spec.
  const session = parseSession(JSON.parse(sessionToText({ version: 1, window: spec, recent: ['tab.new'] })));
  assert.deepEqual(session.window, spec);
  assert.deepEqual(session.recent, ['tab.new']);

  const built = instantiate(emptyWorkspace(), spec, { id: ids(), activate: true });
  const out = built.ws;
  assert.equal(out.tabOrder.length, 3);
  const [a, b, c] = out.tabOrder.map((id) => out.tabs[id]!);
  assert.equal(a!.customTitle, 'Proyecto X');
  assert.equal(a!.color, 'purple');
  assert.equal(out.activeTabId, a!.id);
  assert.equal(panesOf(a!.layout).length, 3);
  assert.equal(a!.layout.type === 'split' && a!.layout.sizes.map(Math.round).join(), '30,70');
  // The focused pane is the second one (the cmd one) and every pane has its profile and folder.
  const leaves = panesOf(a!.layout).map((id) => out.panes[id]!);
  assert.equal(a!.activePaneId, leaves[1]!.id);
  assert.deepEqual(
    leaves.map((p) => [p.profile, p.startCwd, p.status]),
    [
      ['pwsh', 'C:\\proyecto con espacios\\Ñandú', 'starting'],
      ['cmd', 'D:\\otra', 'starting'],
      ['cmd', 'D:\\otra', 'starting'],
    ],
  );
  assert.ok(b!.groupId && b!.groupId === c!.groupId);
  assert.deepEqual(out.groups[b!.groupId!], { id: b!.groupId, name: 'Servidores', color: 'green', collapsed: true });
});

test('zoom, and groups as runs: the same name twice apart is two groups', () => {
  let ws = sample();
  ws = toggleZoom({ ...ws, activeTabId: 't1' });
  const spec = snapshotWindow(ws);
  const zoomed = instantiate(emptyWorkspace(), spec, { id: ids() }).ws;
  const first = zoomed.tabs[zoomed.tabOrder[0]!]!;
  assert.equal(first.zoomedPaneId, first.activePaneId);

  const twice: WindowSpec = {
    tabs: [
      { group: 'A', layout: {} },
      { layout: {} },
      { group: 'A', layout: {} },
    ],
    groups: [
      { name: 'A', color: 'red' },
      { name: 'A', color: 'blue' },
    ],
  };
  const out = instantiate(emptyWorkspace(), twice, { id: ids() }).ws;
  const groups = out.tabOrder.map((id) => out.tabs[id]!.groupId);
  assert.equal(new Set(groups.filter(Boolean)).size, 2);
  assert.deepEqual(Object.values(out.groups).map((g) => g.color).sort(), ['blue', 'red']);
});

test('instantiating next to existing tabs: after a tab, commands collected', () => {
  let ws = addTab(emptyWorkspace(), { tabId: 'x1', paneId: 'y1' });
  ws = addTab(ws, { tabId: 'x2', paneId: 'y2' });
  const { ws: out, tabIds, commands } = instantiate(
    ws,
    {
      tabs: [
        { title: 'Claude', layout: { cwd: 'C:\\x', command: 'claude' } },
        { layout: { split: 'vertical', panes: [{ command: 'npm run dev' }, { command: '  ' }] } },
      ],
      groups: [],
    },
    { id: ids(), after: 'x1', activate: true },
  );
  assert.deepEqual(out.tabOrder, ['x1', ...tabIds, 'x2']);
  assert.equal(out.activeTabId, tabIds[0]);
  assert.deepEqual(
    commands.map((c) => c.command),
    ['claude', 'npm run dev'],
  );
});

test('layouts.json: hand-written shorthand, errors per layout, duplicates', () => {
  const { layouts, issues } = parseLayouts({
    layouts: [
      {
        name: 'Proyecto X',
        tabs: [
          { title: 'Claude', cwd: '~\\proyectos\\x', command: 'claude' },
          { title: 'Servidores', layout: { split: 'horizontal', sizes: [60, 40], panes: [{ command: 'npm run dev' }, { profile: 'gitbash', command: 'git status' }] } },
        ],
        groups: [{ name: 'Proyecto', color: 'blue' }],
      },
      { name: 'Roto', tabs: [{ layout: { split: 'diagonal', panes: [{}] } }] },
      { name: 'proyecto x', tabs: [{}] },
      { tabs: [{}] },
      { name: 'Raro', tabs: [{ colour: 'red', layout: { split: 'vertical', sizes: [1], panes: [{}, {}] } }] },
    ],
  });
  assert.deepEqual(
    layouts.map((l) => l.name),
    ['Proyecto X', 'Raro'],
  );
  assert.deepEqual(layouts[0]!.tabs[0], { title: 'Claude', layout: { cwd: '~\\proyectos\\x', command: 'claude' } });
  assert.deepEqual(
    issues.map((i) => [i.path, i.severity]),
    [
      ['layouts[1].tabs[0].layout.split', 'error'],
      ['layouts[2].name', 'warning'],
      ['layouts[3].name', 'error'],
      ['layouts[4].tabs[0].colour', 'warning'],
      ['layouts[4].tabs[0].layout.sizes', 'warning'],
    ],
  );
  // Written back: one-pane tabs keep the short form.
  assert.deepEqual(layoutToJson(layouts[0]!).tabs, [
    { title: 'Claude', cwd: '~\\proyectos\\x', command: 'claude' },
    { title: 'Servidores', layout: { split: 'horizontal', sizes: [60, 40], panes: [{ command: 'npm run dev' }, { profile: 'gitbash', command: 'git status' }] } },
  ]);
  assert.deepEqual(parseLayouts(undefined), { layouts: [], issues: [] });
  assert.equal(parseLayouts([]).issues[0]?.severity, 'error');
});

test('a broken or foreign session file is no session', () => {
  assert.deepEqual(parseSession(null), EMPTY_SESSION);
  assert.deepEqual(parseSession({ version: 2, window: {} }), EMPTY_SESSION);
  assert.deepEqual(parseSession({ version: 1, window: { tabs: [] }, recent: ['a', 3] }), { version: 1, window: null, recent: ['a'] });
  assert.deepEqual(parseSession({ version: 1, window: null }), { version: 1, window: null, recent: [] });
});
