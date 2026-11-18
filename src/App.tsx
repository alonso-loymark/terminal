import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect } from 'react';
import { TerminalView } from './components/TerminalView';
import { useTerminalStore } from './store/terminal';

const APP_NAME = 'Terminal';

export function App() {
  const title = useTerminalStore((s) => s.title);

  // Programs set the title through OSC 0/2 (PowerShell shows its path, Claude Code its status).
  useEffect(() => {
    getCurrentWindow()
      .setTitle(title.trim() || APP_NAME)
      .catch(() => {});
  }, [title]);

  return <TerminalView />;
}
