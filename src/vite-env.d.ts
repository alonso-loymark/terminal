/// <reference types="vite/client" />
import type { Terminal } from '@xterm/xterm';
import type { useExplorer } from './store/explorer';
import type { useGit } from './store/git';
import type { useSystem } from './store/system';
import type { useUi } from './store/ui';
import type { useWorkspace } from './store/workspace';

declare global {
  interface Window {
    // Dev builds only (lib/devHooks.ts), for debugging and end-to-end checks.
    /** xterm instance of the active tab's pane. */
    __terminal?: Terminal;
    __workspace?: typeof useWorkspace;
    __ui?: typeof useUi;
    __system?: typeof useSystem;
    __explorer?: typeof useExplorer;
    __git?: typeof useGit;
    __paneTerminal?: (paneId: string) => Terminal | undefined;
  }
}
