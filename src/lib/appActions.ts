// What each action of config/keybindings.ts does: run from its shortcut (lib/appShortcuts.ts)
// or from the command palette.
import type { ActionId } from '../config/keybindings';
import { useExplorer } from '../store/explorer';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import type { Layout, PaneId, SplitId } from '../store/workspaceModel';
import { navigateBlocks } from './blockActions';
import { readText } from './clipboard';
import { copySelection } from './keybindings';
import { openLayoutsJson } from './layoutsSync';
import { openSettingsJson } from './settingsSync';
import { closeOtherTabs, focusActiveTerminal, groupTab, openPaneMenu, requestClosePane, requestCloseTabs } from './tabActions';
import { getPane } from './terminalRegistry';

/**
 * handled: done, the key goes no further; native: the browser's default action does it (Ctrl+V
 * fires the paste event xterm handles), only the terminal must not see the key; pass: nothing
 * to do here, the key goes on to the program (Ctrl+C without a selection).
 */
export type ActionResult = 'handled' | 'native' | 'pass';

export interface ActionContext {
  /** The pane the key was pressed in (terminal actions); default the active one. */
  paneId?: PaneId | null;
  /** The key press, when the action comes from a shortcut. */
  event?: KeyboardEvent;
}

const ws = () => useWorkspace.getState();
const activeTab = () => ws().activeTabId;

/** Chromium pastes on these by itself (xterm handles the paste event, bracketed paste included). */
const NATIVE_PASTE = (e: KeyboardEvent) =>
  (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'v') ||
  (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Insert');

function splitsOf(layout: Layout): SplitId[] {
  return layout.type === 'pane' ? [] : [layout.id, ...layout.children.flatMap(splitsOf)];
}

const toggleSettings = () => {
  const ui = useUi.getState();
  if (ui.settings) {
    ui.closeSettings();
    focusActiveTerminal();
  } else {
    ui.openSettings();
  }
};

type Runner = (ctx: ActionContext) => ActionResult | void;

const terminal = (ctx: ActionContext) => getPane(ctx.paneId ?? selectActivePaneId(ws()));

const RUNNERS: Record<ActionId, Runner> = {
  'app.commandPalette': () => {
    const ui = useUi.getState();
    if (ui.palette) {
      ui.closePalette();
      focusActiveTerminal();
    } else {
      ui.openPalette();
    }
  },
  'app.settings': toggleSettings,
  'app.openSettingsJson': () => void openSettingsJson().catch((e: unknown) => console.warn('[brisa] no se pudo abrir settings.json', e)),
  'app.openLayoutsJson': () => void openLayoutsJson().catch((e: unknown) => console.warn('[brisa] no se pudo abrir layouts.json', e)),
  'tab.new': () => void ws().newTab(),
  'tab.close': () => {
    const id = activeTab();
    if (id) void requestCloseTabs([id]);
  },
  'tab.closeOthers': () => {
    const id = activeTab();
    if (id) void closeOtherTabs(id);
  },
  'tab.duplicate': () => {
    const id = activeTab();
    if (id) ws().duplicateTab(id);
  },
  'tab.rename': () => {
    const id = activeTab();
    if (id) useUi.getState().startRenameTab(id);
  },
  'tab.next': () => ws().cycleTab(1),
  'tab.previous': () => ws().cycleTab(-1),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`tab.goTo${n}`, () => ws().activateIndex(n)])),
  'tab.goToLast': () => ws().activateIndex(9),
  'tab.newGroup': () => {
    const id = activeTab();
    if (id) groupTab(id);
  },
  'tab.removeFromGroup': () => {
    const id = activeTab();
    if (id) ws().removeFromGroup(id);
  },
  'pane.splitRight': () => void ws().splitPane('horizontal'),
  'pane.splitDown': () => void ws().splitPane('vertical'),
  'pane.close': () => void requestClosePane(),
  'pane.focusLeft': () => ws().focusDirection('left'),
  'pane.focusRight': () => ws().focusDirection('right'),
  'pane.focusUp': () => ws().focusDirection('up'),
  'pane.focusDown': () => ws().focusDirection('down'),
  'pane.toggleZoom': () => ws().toggleZoom(),
  'pane.equalize': () => {
    const tab = activeTab() ? ws().tabs[activeTab()!] : undefined;
    if (tab) for (const id of splitsOf(tab.layout)) ws().equalizeSplit(id);
  },
  'pane.menu': (ctx) => {
    const paneId = ctx.paneId ?? selectActivePaneId(ws());
    if (paneId) openPaneMenu(paneId);
  },
  'terminal.copySelection': (ctx) => {
    const term = terminal(ctx)?.term;
    if (!term?.hasSelection()) return 'pass';
    copySelection(term);
  },
  'terminal.copy': (ctx) => {
    const term = terminal(ctx)?.term;
    if (term) copySelection(term);
  },
  'terminal.paste': (ctx) => {
    if (ctx.event && NATIVE_PASTE(ctx.event)) return 'native';
    const term = terminal(ctx)?.term;
    if (!term) return;
    void readText().then((text) => {
      if (text) term.paste(text);
    });
  },
  'terminal.selectAll': (ctx) => terminal(ctx)?.term.selectAll(),
  'terminal.clear': (ctx) => terminal(ctx)?.term.clear(),
  'terminal.find': () => useUi.getState().openSearch(),
  'terminal.zoomIn': () => useSettings.getState().zoomIn(),
  'terminal.zoomOut': () => useSettings.getState().zoomOut(),
  'terminal.zoomReset': () => useSettings.getState().resetZoom(),
  'terminal.newline': (ctx) => terminal(ctx)?.session.shiftEnter(),
  'blocks.previous': (ctx) => (navigateBlocks(ctx.paneId ?? selectActivePaneId(ws()) ?? '', -1) ? 'handled' : 'pass'),
  'blocks.next': (ctx) => (navigateBlocks(ctx.paneId ?? selectActivePaneId(ws()) ?? '', 1) ? 'handled' : 'pass'),
  'agents.multiAgent': () => {
    const pane = ws().panes[selectActivePaneId(ws()) ?? ''];
    useUi.getState().openMultiAgent(pane?.cwd ?? pane?.startCwd ?? null);
  },
  'explorer.toggle': () => useExplorer.getState().toggleVisible(),
  'explorer.toggleHidden': () => useExplorer.getState().toggleHidden(),
  // The file tree runs these itself: it knows the selected entry.
  'explorer.rename': () => 'pass',
  'explorer.delete': () => 'pass',
  'layout.saveTab': () => useUi.getState().openLayoutDialog({ scope: 'tab', tabId: activeTab() }),
  'layout.saveWindow': () => useUi.getState().openLayoutDialog({ scope: 'window', tabId: null }),
};

export function runAction(id: ActionId, ctx: ActionContext = {}): ActionResult {
  const runner = RUNNERS[id];
  if (!runner) return 'pass';
  return runner(ctx) ?? 'handled';
}
