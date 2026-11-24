// What the command palette offers: every action of the app (with its shortcut), plus what the
// moment has: go to a tab or a pane by name, open a tab with a profile, apply a theme, open a
// saved layout.
import { ACTIONS, CATEGORY_LABELS, formatKey } from '../config/keybindings';
import { allThemes, findTheme } from '../config/themes';
import { currentKeymap } from '../store/keymap';
import { specPanes } from '../store/layoutModel';
import { useLayouts } from '../store/layouts';
import { currentProfiles } from '../store/profiles';
import { useSettings } from '../store/settings';
import { useSystem } from '../store/system';
import { useWorkspace } from '../store/workspace';
import { panesOf, prettifyTitle, tabTitle } from '../store/workspaceModel';
import { runAction } from './appActions';
import { activeOrchestratorDir, openChat } from './orchestratorActions';
import { sortChats } from './orchestratorChats';
import { activeChatOf, projectKey, useOrchestrator } from '../store/orchestrator';
import { openLayout } from './layoutActions';
import { folderName, shortenPath } from './paths';
import { selectTheme } from './settingsActions';
import { focusActiveTerminal } from './tabActions';

export interface PaletteItem {
  /** Stable across sessions for actions, profiles, themes and layouts (the recent list). */
  id: string;
  label: string;
  category: string;
  detail?: string;
  /** Shortcuts, formatted. */
  keys: string[];
  run: () => void;
  /** Goes to the recent list (tabs and panes are not: they change every session). */
  remember: boolean;
}

/** After these the keyboard goes back to the terminal; the rest open something of their own. */
const KEEPS_FOCUS = new Set([
  'app.commandPalette',
  'app.settings',
  'tab.rename',
  'tab.newGroup',
  'terminal.find',
  'layout.saveTab',
  'layout.saveWindow',
  'agents.multiAgent',
  'orchestrator.open',
  'orchestrator.newChat',
  'orchestrator.searchChats',
  'orchestrator.showChats',
  'chats.rename',
  'chats.delete',
]);

export function paletteItems(): PaletteItem[] {
  const keymap = currentKeymap();
  const ws = useWorkspace.getState();
  const home = useSystem.getState().homeDir;
  const items: PaletteItem[] = [];

  for (const action of ACTIONS) {
    if (action.paletteHidden) continue;
    if (action.category === 'agents' && !useSettings.getState().settings.agents.enabled) continue;
    if (action.category === 'orchestrator' && !useSettings.getState().settings.orchestrator.enabled) continue;
    // The chat actions act on the active orchestrator tab.
    if (action.category === 'orchestrator' && action.id !== 'orchestrator.open' && !activeOrchestratorDir()) continue;
    items.push({
      id: action.id,
      label: action.label,
      category: CATEGORY_LABELS[action.category],
      keys: (keymap.bindings[action.id] ?? []).map(formatKey),
      remember: true,
      run: () => {
        runAction(action.id);
        if (!KEEPS_FOCUS.has(action.id)) focusActiveTerminal();
      },
    });
  }

  ws.tabOrder.forEach((tabId, index) => {
    const tab = ws.tabs[tabId];
    if (!tab) return;
    const title = tabTitle(ws, tabId);
    const group = tab.groupId ? ws.groups[tab.groupId]?.name : undefined;
    const pane = ws.panes[tab.activePaneId];
    const cwd = pane?.cwd ?? pane?.startCwd;
    const goKey = index < 8 ? keymap.bindings[`tab.goTo${index + 1}`]?.[0] : undefined;
    items.push({
      id: `tab:${tabId}`,
      label: `Ir a la tab: ${title}`,
      category: 'Tabs',
      detail: [group && `grupo ${group}`, cwd && shortenPath(cwd, home, 40)].filter(Boolean).join(' · ') || undefined,
      keys: goKey ? [formatKey(goKey)] : [],
      remember: false,
      run: () => {
        useWorkspace.getState().activateTab(tabId);
        focusActiveTerminal();
      },
    });
    const leaves = panesOf(tab.layout);
    if (leaves.length < 2) return;
    leaves.forEach((paneId, i) => {
      const p = ws.panes[paneId];
      const where = p?.cwd ?? p?.startCwd;
      const name = prettifyTitle(p?.title ?? '') || (where ? folderName(where) : `panel ${i + 1}`);
      items.push({
        id: `pane:${paneId}`,
        label: `Ir al panel: ${title} › ${name}`,
        category: 'Paneles',
        detail: where ? shortenPath(where, home, 40) : undefined,
        keys: [],
        remember: false,
        run: () => {
          useWorkspace.getState().focusPane(paneId);
          focusActiveTerminal();
        },
      });
    });
  });

  // The chats of the active orchestrator's project.
  const orchDir = activeOrchestratorDir();
  const project = orchDir ? useOrchestrator.getState().projects[projectKey(orchDir)] : undefined;
  const openId = activeChatOf(project)?.id;
  for (const chat of sortChats(project?.chats ?? [])) {
    if (!orchDir || chat.count === 0) continue;
    items.push({
      id: `chat:${chat.id}`,
      label: `Ir al chat: ${chat.title}`,
      category: 'Orquestador',
      detail: chat.id === openId ? 'abierto' : undefined,
      keys: [],
      remember: false,
      run: () => {
        openChat(orchDir, chat.id);
        focusActiveTerminal();
      },
    });
  }

  const { profiles, defaultId } = currentProfiles();
  for (const profile of profiles) {
    if (profile.hidden) continue;
    const tabKey = keymap.bindings['tab.new']?.[0];
    items.push({
      id: `profile:${profile.id}`,
      label: `Nueva tab con: ${profile.name}`,
      category: 'Perfiles',
      keys: profile.id === defaultId && tabKey ? [formatKey(tabKey)] : [],
      remember: true,
      run: () => {
        useWorkspace.getState().newTab({ profile: profile.id });
        focusActiveTerminal();
      },
    });
  }

  const { theme: current, themes: custom } = useSettings.getState().settings;
  const inUse = findTheme(current, custom)?.id;
  for (const theme of allThemes(custom)) {
    items.push({
      id: `theme:${theme.id}`,
      label: `Tema: ${theme.label}`,
      category: 'Temas',
      detail: theme.id === inUse ? 'en uso' : undefined,
      keys: [],
      remember: true,
      run: () => {
        selectTheme(theme.id);
        focusActiveTerminal();
      },
    });
  }

  for (const layout of useLayouts.getState().layouts) {
    const panes = layout.tabs.reduce((n, tab) => n + specPanes(tab.layout).length, 0);
    items.push({
      id: `layout:${layout.name}`,
      label: `Abrir layout: ${layout.name}`,
      category: 'Layouts',
      detail: `${layout.tabs.length === 1 ? '1 tab' : `${layout.tabs.length} tabs`}, ${panes === 1 ? '1 panel' : `${panes} paneles`}`,
      keys: [],
      remember: true,
      run: () => void openLayout(layout.name),
    });
  }
  return items;
}
