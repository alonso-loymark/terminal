// Saved arrangements of tabs and panes. The session restored at startup (session.json) and the
// named layouts (layouts.json, editable by hand) share one format: tabs with their name, color
// and group, and a tree of panes, each with its profile, folder and, in layouts, a command to
// type once the shell is ready. Pure: snapshot a workspace, validate a file, rebuild tabs from
// it (node --test).
import type { Issue, JsonSchema } from '../config/schema.ts';
import {
  activateTab,
  COLORS,
  newPane,
  orchestratorPane,
  normalize,
  normalizeLayout,
  normalizeSizes,
  panesOf,
  type Group,
  type GroupId,
  type Layout,
  type Pane,
  type PaneId,
  type PaneWorktree,
  type SplitDirection,
  type Tab,
  type TabColor,
  type TabId,
  type Workspace,
} from './workspaceModel.ts';

/** A pane: what to start, where, and (layouts) what to type once the shell is ready. */
export interface PaneSpec {
  profile?: string;
  cwd?: string;
  command?: string;
  /** The tab's active pane. */
  focus?: boolean;
  /** Maximized inside its tab. */
  zoom?: boolean;
  /** The orchestrator's chat for `cwd` instead of a terminal. */
  orchestrator?: boolean;
  /** Session only: the worktree Brisa created for the pane (removed when it closes). */
  worktree?: PaneWorktree;
}

export interface SplitSpec {
  /** horizontal: side by side; vertical: stacked. */
  split: SplitDirection;
  /** Percent per pane; equal parts if missing. */
  sizes?: number[];
  panes: NodeSpec[];
}

export type NodeSpec = PaneSpec | SplitSpec;

export interface TabSpec {
  /** The tab's own name (without it, the process title). */
  title?: string;
  color?: TabColor;
  /** Name of a group in `groups`. */
  group?: string;
  /** The window's active tab. */
  active?: boolean;
  layout: NodeSpec;
}

export interface GroupSpec {
  name: string;
  color: TabColor;
  collapsed?: boolean;
}

export interface WindowSpec {
  tabs: TabSpec[];
  groups: GroupSpec[];
}

export interface SavedLayout extends WindowSpec {
  name: string;
}

export const isSplit = (node: NodeSpec): node is SplitSpec => 'split' in node;

export const specPanes = (node: NodeSpec): PaneSpec[] => (isSplit(node) ? node.panes.flatMap(specPanes) : [node]);

// ---------------------------------------------------------------- snapshot

export interface SnapshotOptions {
  /** Commands to type in each pane when the layout opens (layouts only; never in the session). */
  commands?: Record<PaneId, string>;
  /** Keep which panes own a worktree (the session; a layout never does). */
  worktrees?: boolean;
}

const round = (n: number) => Math.round(n * 10) / 10;

function snapshotNode(ws: Workspace, tab: Tab, node: Layout, options: SnapshotOptions): NodeSpec {
  if (node.type === 'split') {
    return { split: node.direction, sizes: node.sizes.map(round), panes: node.children.map((c) => snapshotNode(ws, tab, c, options)) };
  }
  const pane = ws.panes[node.paneId];
  const spec: PaneSpec = {};
  if (pane?.kind === 'orchestrator') spec.orchestrator = true;
  if (pane?.profile) spec.profile = pane.profile;
  const cwd = pane?.cwd ?? pane?.startCwd;
  if (cwd) spec.cwd = cwd;
  const command = options.commands?.[node.paneId]?.trim();
  if (command) spec.command = command;
  if (options.worktrees && pane?.worktree) spec.worktree = { ...pane.worktree };
  if (tab.layout.type === 'split') {
    if (tab.activePaneId === node.paneId) spec.focus = true;
    if (tab.zoomedPaneId === node.paneId) spec.zoom = true;
  }
  return spec;
}

export function snapshotTab(ws: Workspace, tabId: TabId, options: SnapshotOptions = {}): TabSpec | null {
  const tab = ws.tabs[tabId];
  if (!tab) return null;
  const spec: TabSpec = { layout: snapshotNode(ws, tab, tab.layout, options) };
  if (tab.customTitle) spec.title = tab.customTitle;
  if (tab.color) spec.color = tab.color;
  const group = tab.groupId ? ws.groups[tab.groupId] : undefined;
  if (group) spec.group = group.name;
  return spec;
}

/** The tabs (default: all) with their groups; the active tab marked. */
export function snapshotWindow(ws: Workspace, tabIds: readonly TabId[] = ws.tabOrder, options: SnapshotOptions = {}): WindowSpec {
  const tabs: TabSpec[] = [];
  const groups: GroupSpec[] = [];
  const seen = new Set<GroupId>();
  for (const id of tabIds) {
    const spec = snapshotTab(ws, id, options);
    if (!spec) continue;
    if (id === ws.activeTabId && tabIds.length > 1) spec.active = true;
    const groupId = ws.tabs[id]?.groupId;
    const group = groupId ? ws.groups[groupId] : undefined;
    if (group && !seen.has(group.id)) {
      seen.add(group.id);
      groups.push({ name: group.name, color: group.color, ...(group.collapsed ? { collapsed: true } : {}) });
    }
    tabs.push(spec);
  }
  return { tabs, groups };
}

// ---------------------------------------------------------------- rebuild

export interface Instantiated {
  ws: Workspace;
  tabIds: TabId[];
  /** Panes with a command to type once their shell is ready. */
  commands: { paneId: PaneId; command: string }[];
}

export interface InstantiateOptions {
  /** Ids for the new tabs, panes, splits and groups (prefix: tab, pane, split, group). */
  id: (prefix: string) => string;
  /** Insert after this tab (default: at the end). */
  after?: TabId | null;
  /** Make the spec's active tab (or its first) the active one. */
  activate?: boolean;
}

/** Adds the spec's tabs and groups to the workspace, with new ids. */
export function instantiate(ws: Workspace, spec: WindowSpec, options: InstantiateOptions): Instantiated {
  const { id } = options;
  const tabs: Record<TabId, Tab> = { ...ws.tabs };
  const panes: Record<PaneId, Pane> = { ...ws.panes };
  const groups: Record<GroupId, Group> = { ...ws.groups };
  const commands: Instantiated['commands'] = [];
  const tabIds: TabId[] = [];
  // Groups are runs of consecutive tabs: a name that comes back later is another group.
  const unused = [...spec.groups];
  let run: { name: string; id: GroupId } | null = null;
  let activeTab: TabId | null = null;

  const build = (node: NodeSpec, tab: { focus: PaneId | null; zoom: PaneId | null }): Layout => {
    if (isSplit(node)) {
      const children = node.panes.map((child) => build(child, tab));
      const sizes = node.sizes && node.sizes.length === children.length ? node.sizes : children.map(() => 100 / children.length);
      return { type: 'split', id: id('split'), direction: node.split, children, sizes: normalizeSizes(sizes) };
    }
    const paneId = id('pane');
    if (node.orchestrator && node.cwd) {
      panes[paneId] = orchestratorPane(paneId, node.cwd);
    } else {
      panes[paneId] = { ...newPane(paneId, { profile: node.profile ?? null, cwd: node.cwd ?? null }), worktree: node.worktree ?? null };
      if (node.command?.trim()) commands.push({ paneId, command: node.command.trim() });
    }
    if (node.focus && !tab.focus) tab.focus = paneId;
    if (node.zoom && !tab.zoom) tab.zoom = paneId;
    return { type: 'pane', paneId };
  };

  for (const tabSpec of spec.tabs) {
    let groupId: GroupId | null = null;
    if (tabSpec.group) {
      if (run && run.name === tabSpec.group) {
        groupId = run.id;
      } else {
        const at = unused.findIndex((g) => g.name === tabSpec.group);
        const group: GroupSpec = at >= 0 ? unused.splice(at, 1)[0]! : { name: tabSpec.group, color: 'grey' as TabColor };
        groupId = id('group');
        groups[groupId] = { id: groupId, name: group.name, color: group.color, collapsed: !!group.collapsed };
        run = { name: group.name, id: groupId };
      }
    } else {
      run = null;
    }
    const marks = { focus: null as PaneId | null, zoom: null as PaneId | null };
    const layout = normalizeLayout(build(tabSpec.layout, marks));
    const tabId = id('tab');
    const leaves = panesOf(layout);
    const activePaneId = marks.focus && leaves.includes(marks.focus) ? marks.focus : leaves[0]!;
    tabs[tabId] = {
      id: tabId,
      customTitle: tabSpec.title?.trim() || null,
      color: tabSpec.color ?? null,
      groupId,
      layout,
      activePaneId,
      zoomedPaneId: layout.type === 'split' && marks.zoom ? marks.zoom : null,
    };
    tabIds.push(tabId);
    if (tabSpec.active && !activeTab) activeTab = tabId;
  }

  const at = options.after ? ws.tabOrder.indexOf(options.after) : -1;
  const tabOrder = [...ws.tabOrder];
  tabOrder.splice(at >= 0 ? at + 1 : tabOrder.length, 0, ...tabIds);
  let next = normalize({ ...ws, tabs, panes, groups, tabOrder, activeTabId: ws.activeTabId ?? tabIds[0] ?? null });
  const target = activeTab ?? tabIds[0];
  if (options.activate !== false && target) next = activateTab(next, target);
  return { ws: next, tabIds, commands };
}

// ---------------------------------------------------------------- files

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const err = (issues: Issue[], path: string, message: string) => issues.push({ path, message, severity: 'error' });
const warn = (issues: Issue[], path: string, message: string) => issues.push({ path, message, severity: 'warning' });
const join = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

const PANE_KEYS = ['profile', 'cwd', 'command', 'focus', 'zoom', 'orchestrator'] as const;
/** Accepted when reading (the session writes it); never written to layouts. */
const READ_ONLY_PANE_KEYS = ['worktree'] as const;
const TAB_KEYS = ['title', 'color', 'group', 'active', 'layout'] as const;

function unknownKeys(value: Record<string, unknown>, known: readonly string[], path: string, issues: Issue[]): void {
  for (const key of Object.keys(value)) if (!known.includes(key) && key !== '$schema') warn(issues, join(path, key), 'clave desconocida: se ignora');
}

function parsePane(value: Record<string, unknown>, path: string, issues: Issue[]): PaneSpec | null {
  const spec: PaneSpec = {};
  for (const key of ['profile', 'cwd', 'command'] as const) {
    const v = value[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return err(issues, join(path, key), 'tiene que ser texto'), null;
    if (v.trim()) spec[key] = v;
  }
  for (const key of ['focus', 'zoom', 'orchestrator'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return err(issues, join(path, key), 'tiene que ser true o false'), null;
    if (v) spec[key] = true;
  }
  const w = value.worktree;
  if (isObject(w) && typeof w.path === 'string' && typeof w.repo === 'string' && typeof w.branch === 'string') {
    spec.worktree = { path: w.path, repo: w.repo, branch: w.branch };
  }
  return spec;
}

function parseNode(value: unknown, path: string, issues: Issue[], depth = 0): NodeSpec | null {
  if (!isObject(value)) return err(issues, path, 'tiene que ser un objeto (un panel o una división)'), null;
  if (depth > 32) return err(issues, path, 'demasiados niveles de divisiones'), null;
  if (value.split === undefined) {
    unknownKeys(value, [...PANE_KEYS, ...READ_ONLY_PANE_KEYS], path, issues);
    return parsePane(value, path, issues);
  }
  unknownKeys(value, ['split', 'sizes', 'panes'], path, issues);
  if (value.split !== 'horizontal' && value.split !== 'vertical') {
    return err(issues, join(path, 'split'), 'tiene que ser "horizontal" (lado a lado) o "vertical" (apilados)'), null;
  }
  if (!Array.isArray(value.panes) || value.panes.length === 0) {
    return err(issues, join(path, 'panes'), 'tiene que ser una lista con al menos un panel'), null;
  }
  const children: NodeSpec[] = [];
  for (let i = 0; i < value.panes.length; i++) {
    const child = parseNode(value.panes[i], join(join(path, 'panes'), i), issues, depth + 1);
    if (!child) return null;
    children.push(child);
  }
  if (children.length === 1) return children[0]!;
  const spec: SplitSpec = { split: value.split, panes: children };
  if (value.sizes !== undefined) {
    const sizes = value.sizes;
    if (Array.isArray(sizes) && sizes.length === children.length && sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)) {
      spec.sizes = sizes as number[];
    } else {
      warn(issues, join(path, 'sizes'), `tiene que ser una lista de ${children.length} números positivos: se usan partes iguales`);
    }
  }
  return spec;
}

const isColor = (value: unknown): value is TabColor => typeof value === 'string' && (COLORS as readonly string[]).includes(value);

function parseTab(value: unknown, path: string, issues: Issue[]): TabSpec | null {
  if (!isObject(value)) return err(issues, path, 'tiene que ser un objeto'), null;
  // A tab with one pane can carry the pane's fields itself: { "title": "dev", "command": "npm run dev" }.
  const shorthand = value.layout === undefined;
  unknownKeys(value, shorthand ? [...TAB_KEYS, ...PANE_KEYS, ...READ_ONLY_PANE_KEYS] : TAB_KEYS, path, issues);
  let layout: NodeSpec | null;
  if (shorthand) layout = parsePane(value, path, issues);
  else layout = parseNode(value.layout, join(path, 'layout'), issues);
  if (!layout) return null;
  const tab: TabSpec = { layout };
  if (value.title !== undefined) {
    if (typeof value.title !== 'string') return err(issues, join(path, 'title'), 'tiene que ser texto'), null;
    if (value.title.trim()) tab.title = value.title;
  }
  if (value.color !== undefined && value.color !== null) {
    if (!isColor(value.color)) return err(issues, join(path, 'color'), `tiene que ser uno de: ${COLORS.join(', ')}`), null;
    tab.color = value.color;
  }
  if (value.group !== undefined && value.group !== null) {
    if (typeof value.group !== 'string') return err(issues, join(path, 'group'), 'tiene que ser el nombre de un grupo'), null;
    tab.group = value.group;
  }
  if (value.active === true) tab.active = true;
  return tab;
}

function parseGroup(value: unknown, path: string, issues: Issue[]): GroupSpec | null {
  if (!isObject(value)) return err(issues, path, 'tiene que ser un objeto'), null;
  unknownKeys(value, ['name', 'color', 'collapsed'], path, issues);
  if (typeof value.name !== 'string') return err(issues, join(path, 'name'), 'falta el nombre del grupo'), null;
  const color = value.color === undefined ? 'grey' : value.color;
  if (!isColor(color)) return err(issues, join(path, 'color'), `tiene que ser uno de: ${COLORS.join(', ')}`), null;
  return { name: value.name, color, ...(value.collapsed === true ? { collapsed: true } : {}) };
}

/** Tabs and groups; null (with issues) if anything is wrong. */
export function parseWindowSpec(value: Record<string, unknown>, path: string, issues: Issue[]): WindowSpec | null {
  if (!Array.isArray(value.tabs) || value.tabs.length === 0) return err(issues, join(path, 'tabs'), 'tiene que ser una lista con al menos una tab'), null;
  const tabs: TabSpec[] = [];
  for (let i = 0; i < value.tabs.length; i++) {
    const tab = parseTab(value.tabs[i], join(join(path, 'tabs'), i), issues);
    if (!tab) return null;
    tabs.push(tab);
  }
  const groups: GroupSpec[] = [];
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups)) return err(issues, join(path, 'groups'), 'tiene que ser una lista'), null;
    for (let i = 0; i < value.groups.length; i++) {
      const group = parseGroup(value.groups[i], join(join(path, 'groups'), i), issues);
      if (!group) return null;
      groups.push(group);
    }
  }
  return { tabs, groups };
}

export interface LayoutsFile {
  /** The valid layouts (a broken one is left out, with its issues). */
  layouts: SavedLayout[];
  issues: Issue[];
}

/** layouts.json (already parsed). Each layout stands on its own: a broken one does not hide the rest. */
export function parseLayouts(value: unknown): LayoutsFile {
  const issues: Issue[] = [];
  if (value === undefined || value === null) return { layouts: [], issues };
  if (!isObject(value)) return { layouts: [], issues: [{ path: '', message: 'tiene que ser un objeto con "layouts": [...]', severity: 'error' }] };
  unknownKeys(value, ['layouts'], '', issues);
  if (value.layouts === undefined) return { layouts: [], issues };
  if (!Array.isArray(value.layouts)) return { layouts: [], issues: [...issues, { path: 'layouts', message: 'tiene que ser una lista', severity: 'error' }] };
  const layouts: SavedLayout[] = [];
  const names = new Set<string>();
  value.layouts.forEach((raw, i) => {
    const path = `layouts[${i}]`;
    if (!isObject(raw)) return void err(issues, path, 'tiene que ser un objeto');
    unknownKeys(raw, ['name', 'tabs', 'groups'], path, issues);
    if (typeof raw.name !== 'string' || !raw.name.trim()) return void err(issues, `${path}.name`, 'falta el nombre');
    const name = raw.name.trim();
    if (names.has(name.toLowerCase())) return void warn(issues, `${path}.name`, `hay otro layout llamado «${name}»: se usa el primero`);
    const spec = parseWindowSpec(raw, path, issues);
    if (!spec) return;
    names.add(name.toLowerCase());
    layouts.push({ name, ...spec });
  });
  return { layouts, issues };
}

/** session.json: the last window (null when restoring is off) and the palette's recent commands. */
export interface SessionFile {
  version: 1;
  window: WindowSpec | null;
  recent: string[];
}

export const EMPTY_SESSION: SessionFile = { version: 1, window: null, recent: [] };

/** Whatever is wrong in the session file means "no session": the app starts with one tab. */
export function parseSession(value: unknown): SessionFile {
  if (!isObject(value) || value.version !== 1) return EMPTY_SESSION;
  const recent = Array.isArray(value.recent) ? value.recent.filter((r): r is string => typeof r === 'string').slice(0, 50) : [];
  const window = isObject(value.window) ? parseWindowSpec(value.window, 'window', []) : null;
  return { version: 1, window, recent };
}

// ---------------------------------------------------------------- writing

/** A pane / tab for the file: no empty fields; a one-pane tab carries its pane's fields itself. */
function nodeToJson(node: NodeSpec): Record<string, unknown> {
  if (isSplit(node)) {
    return { split: node.split, ...(node.sizes ? { sizes: node.sizes.map(round) } : {}), panes: node.panes.map(nodeToJson) };
  }
  const out: Record<string, unknown> = {};
  for (const key of PANE_KEYS) if (node[key] !== undefined && node[key] !== false) out[key] = node[key];
  if (node.worktree) out.worktree = { ...node.worktree };
  return out;
}

export function tabToJson(tab: TabSpec): Record<string, unknown> {
  const head: Record<string, unknown> = {};
  if (tab.title) head.title = tab.title;
  if (tab.color) head.color = tab.color;
  if (tab.group) head.group = tab.group;
  if (tab.active) head.active = true;
  return isSplit(tab.layout) ? { ...head, layout: nodeToJson(tab.layout) } : { ...head, ...nodeToJson(tab.layout) };
}

export function windowToJson(spec: WindowSpec): Record<string, unknown> {
  return { tabs: spec.tabs.map(tabToJson), ...(spec.groups.length ? { groups: spec.groups.map((g) => ({ ...g })) } : {}) };
}

export const layoutToJson = (layout: SavedLayout): Record<string, unknown> => ({ name: layout.name, ...windowToJson(layout) });

export const sessionToText = (session: SessionFile): string =>
  `${JSON.stringify({ version: 1, window: session.window ? windowToJson(session.window) : null, recent: session.recent }, null, 2)}\n`;

export const LAYOUTS_SCHEMA_REFERENCE = './layouts.schema.json';

/** A new layouts.json: the format explained for whoever edits it by hand. */
export const NEW_LAYOUTS_FILE = `{
  "$schema": "${LAYOUTS_SCHEMA_REFERENCE}",
  // Layouts guardados: se abren desde la paleta (Ctrl+Shift+P) o el menú "▾".
  // Cada layout es una lista de tabs. Una tab puede tener "title", "color", "group" (el
  // nombre de uno de "groups") y un panel ("profile", "cwd", "command") o un "layout" con
  // divisiones: { "split": "horizontal" | "vertical", "sizes": [50, 50], "panes": [...] }.
  // "command" se escribe en la shell recién cuando está lista (integración de shell).
  "layouts": []
}
`;

/** JSON Schema of layouts.json (completions and help in VS Code). */
export function layoutsJsonSchema(profiles: readonly string[] = []): JsonSchema {
  const color = { enum: [...COLORS], description: 'Color de la tab o del grupo.' };
  const paneProps = {
    profile: { type: 'string', description: 'Perfil de la shell (sin esto, el de por defecto).', ...(profiles.length ? { anyOf: [{ enum: [...profiles] }, { type: 'string' }] } : {}) },
    cwd: { type: 'string', description: 'Carpeta (admite ~ y %VARIABLES%). Si no existe, la carpeta del usuario.' },
    command: { type: 'string', description: 'Comando a escribir cuando la shell está lista (según la integración de shell). Sin integración no se escribe.' },
    focus: { type: 'boolean', description: 'El panel activo de la tab.' },
    zoom: { type: 'boolean', description: 'Maximizado dentro de la tab.' },
    orchestrator: { type: 'boolean', description: 'El chat del orquestador de la carpeta "cwd" en vez de una terminal.' },
  };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Brisa: layouts.json',
    type: 'object',
    allowComments: true,
    allowTrailingCommas: true,
    definitions: {
      node: {
        description: 'Un panel, o una división con "split".',
        anyOf: [
          { type: 'object', properties: paneProps, additionalProperties: false },
          {
            type: 'object',
            required: ['split', 'panes'],
            properties: {
              split: { enum: ['horizontal', 'vertical'], description: 'horizontal: lado a lado; vertical: apilados.' },
              sizes: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 }, description: 'Porcentaje de cada panel (sin esto, partes iguales).' },
              panes: { type: 'array', minItems: 1, items: { $ref: '#/definitions/node' } },
            },
            additionalProperties: false,
          },
        ],
      },
    },
    properties: {
      $schema: { type: 'string' },
      layouts: {
        type: 'array',
        description: 'Layouts guardados (se abren desde la paleta o el menú de la flecha junto al +).',
        items: {
          type: 'object',
          required: ['name', 'tabs'],
          properties: {
            name: { type: 'string', description: 'Nombre del layout.' },
            tabs: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Nombre de la tab.' },
                  color,
                  group: { type: 'string', description: 'Nombre de un grupo de "groups".' },
                  active: { type: 'boolean', description: 'La tab activa al abrir.' },
                  layout: { $ref: '#/definitions/node' },
                  ...paneProps,
                },
                additionalProperties: false,
              },
            },
            groups: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' }, color, collapsed: { type: 'boolean' } },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  };
}
