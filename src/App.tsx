import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect } from 'react';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ContextMenus } from './components/ContextMenus';
import { TabBar } from './components/TabBar';
import { Workspace } from './components/Workspace';
import { installAppShortcuts } from './lib/appShortcuts';
import { useWorkspace } from './store/workspace';
import { tabTitle } from './store/workspaceModel';

const APP_NAME = 'Terminal';

export function App() {
  // The window follows the active tab (custom name, or what the process sets via OSC 0/2).
  const title = useWorkspace((s) => (s.activeTabId ? tabTitle(s, s.activeTabId, '') : ''));

  useEffect(() => {
    getCurrentWindow()
      .setTitle(title.trim() || APP_NAME)
      .catch(() => {});
  }, [title]);

  useEffect(() => installAppShortcuts(), []);

  return (
    <div className="app">
      <TabBar />
      <Workspace />
      <ContextMenus />
      <ConfirmDialog />
    </div>
  );
}
