import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ContextMenus } from './components/ContextMenus';
import { SaveLayoutDialog } from './components/SaveLayoutDialog';
import { SettingsPage } from './components/SettingsPage';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { Toast } from './components/Toast';
import { Workspace } from './components/Workspace';
import { installAppearance } from './lib/appearance';
import { installAppShortcuts } from './lib/appShortcuts';
import { installFileDrop } from './lib/dropTarget';
import { installGitRefreshOnCommands } from './lib/explorerData';
import { initSession } from './lib/sessionSync';
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

  if (!ready) return <div className="app" />;

  return (
    <div className="app">
      <TabBar />
      <div className="main">
        <Sidebar />
        <Workspace />
      </div>
      <StatusBar />
      <ContextMenus />
      <ConfirmDialog />
      <SettingsPage />
      <CommandPalette />
      <SaveLayoutDialog />
      <Toast />
    </div>
  );
}
