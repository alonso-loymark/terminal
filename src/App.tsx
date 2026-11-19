import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect } from 'react';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ContextMenus } from './components/ContextMenus';
import { SettingsPage } from './components/SettingsPage';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { Workspace } from './components/Workspace';
import { installAppearance } from './lib/appearance';
import { installAppShortcuts } from './lib/appShortcuts';
import { installFileDrop } from './lib/dropTarget';
import { installGitRefreshOnCommands } from './lib/explorerData';
import { initSettings } from './lib/settingsSync';
import { useSettings } from './store/settings';
import { loadSystemInfo, useSystem } from './store/system';
import { useWorkspace } from './store/workspace';
import { tabTitle } from './store/workspaceModel';

const APP_NAME = 'Terminal';

export function App() {
  // The window follows the active tab (custom name, or what the process sets via OSC 0/2).
  const title = useWorkspace((s) => (s.activeTabId ? tabTitle(s, s.activeTabId, '') : ''));
  // Settings and the detected shells take a few ms; waiting avoids starting a shell with the
  // wrong profile or showing the explorer before knowing whether it should be visible.
  const settingsLoaded = useSettings((s) => s.loaded);
  const shellsLoaded = useSystem((s) => s.loaded);
  const ready = settingsLoaded && shellsLoaded;

  useEffect(() => {
    getCurrentWindow()
      .setTitle(title.trim() || APP_NAME)
      .catch(() => {});
  }, [title]);

  useEffect(() => {
    void initSettings();
    void loadSystemInfo();
  }, []);
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
    </div>
  );
}
