import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect } from 'react';
import { AiContextDialog } from './components/AiContextDialog';
import { OrchestratorDialog } from './components/OrchestratorDialog';
import { AiPanel } from './components/AiPanel';
import { CommandPalette } from './components/CommandPalette';
import { MultiAgentDialog } from './components/MultiAgentDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ContextMenus } from './components/ContextMenus';
import { SaveLayoutDialog } from './components/SaveLayoutDialog';
import { SettingsPage } from './components/SettingsPage';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { Toast } from './components/Toast';
import { Workspace } from './components/Workspace';
import { installAgentMonitor } from './lib/agentMonitor';
import { installAi } from './lib/aiActions';
import { installOrchestrator } from './lib/orchestratorActions';
import { installAppearance } from './lib/appearance';
import { installAppShortcuts } from './lib/appShortcuts';
import { installFileDrop } from './lib/dropTarget';
import { installGitRefreshOnCommands } from './lib/explorerData';
import { initSession } from './lib/sessionSync';
import { installWindowChrome, startResizeTop } from './lib/windowChrome';
import { useChrome } from './store/chrome';
import { useSession } from './store/session';
import { useWorkspace } from './store/workspace';
import { tabTitle } from './store/workspaceModel';

const APP_NAME = 'Brisa';

export function App() {
  // The window follows the active tab (custom name, or what the process sets via OSC 0/2).
  const title = useWorkspace((s) => (s.activeTabId ? tabTitle(s, s.activeTabId, '') : ''));
  // Settings, the detected shells, the layouts and the last session take a few ms; waiting avoids
  // starting a shell with the wrong profile, or a tab that the restored session replaces.
  const ready = useSession((s) => s.ready);
  const custom = !useChrome((s) => s.nativeTitleBar);
  const maximized = useChrome((s) => s.maximized);
  const active = useChrome((s) => s.active);

  useEffect(() => {
    getCurrentWindow()
      .setTitle(title.trim() || APP_NAME)
      .catch(() => {});
  }, [title]);

  useEffect(() => void initSession(), []);
  useEffect(() => installAppearance(), []);
  useEffect(() => installAppShortcuts(), []);
  useEffect(() => installFileDrop(), []);
  useEffect(() => installGitRefreshOnCommands(), []);
  useEffect(() => installAgentMonitor(), []);
  useEffect(() => installAi(), []);
  useEffect(() => installOrchestrator(), []);
  useEffect(() => installWindowChrome(), []);

  if (!ready) return <div className="app" />;

  return (
    <div className="app" data-title-bar={custom ? 'custom' : 'native'} data-maximized={maximized || undefined} data-inactive={!active || undefined}>
      {/* The title bar covers the window's top edge: resize from there too. */}
      {custom && !maximized && <div className="window-resize-top" onPointerDown={(e) => e.button === 0 && startResizeTop()} />}
      <TabBar />
      <div className="main">
        <Sidebar />
        <Workspace />
        <AiPanel />
      </div>
      <StatusBar />
      <ContextMenus />
      <ConfirmDialog />
      <SettingsPage />
      <CommandPalette />
      <SaveLayoutDialog />
      <MultiAgentDialog />
      <AiContextDialog />
      <OrchestratorDialog />
      <Toast />
    </div>
  );
}
