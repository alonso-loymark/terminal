/// <reference types="vite/client" />
import type { Terminal } from '@xterm/xterm';
import type { useExplorer } from './store/explorer';
import type { useGit } from './store/git';
import type { useLayouts } from './store/layouts';
import type { currentProfiles } from './store/profiles';
import type { useSession } from './store/session';
import type { useSettings } from './store/settings';
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
    __settings?: typeof useSettings;
    __profiles?: typeof currentProfiles;
    __layouts?: typeof useLayouts;
    __session?: typeof useSession;
    /** Panes whose layout command still waits for the shell to be ready. */
    __pendingCommands?: () => string[];
    /** Command blocks of a pane, with their text (lib/blocks.ts). */
    __blocks?: (paneId: string) => (import('./lib/blocks').BlockText | null)[];
    __selectedBlock?: (paneId: string) => number | null;
    /** What clicking a native notification does (the backend's debug command). */
    __notificationClick?: (tag: string) => Promise<void>;
    __worktrees?: () => Promise<import('./lib/fsApi').Worktree[]>;
    /** Whether a pane's terminal has the ligature joiner registered. */
    __paneLigatures?: (paneId: string) => boolean;
  }
}
