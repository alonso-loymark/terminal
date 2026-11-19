// Dev builds only (loaded with a dynamic import from main.tsx): handles for debugging and for
// the end-to-end checks in e2e/run.mjs.
import { useExplorer } from '../store/explorer';
import { useGit } from '../store/git';
import { useLayouts } from '../store/layouts';
import { useSession } from '../store/session';
import { currentProfiles } from '../store/profiles';
import { useSettings } from '../store/settings';
import { useSystem } from '../store/system';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import { pendingInitialCommands } from './initialCommands';
import { hasLigatures } from './ligatures';
import { getPane } from './terminalRegistry';

export function installDevHooks(): void {
  Object.defineProperty(window, '__terminal', {
    configurable: true,
    get: () => getPane(selectActivePaneId(useWorkspace.getState()))?.term,
  });
  window.__workspace = useWorkspace;
  window.__ui = useUi;
  window.__system = useSystem;
  window.__explorer = useExplorer;
  window.__git = useGit;
  window.__paneTerminal = (paneId) => getPane(paneId)?.term;
  window.__settings = useSettings;
  window.__profiles = currentProfiles;
  window.__layouts = useLayouts;
  window.__session = useSession;
  window.__pendingCommands = pendingInitialCommands;
  window.__paneLigatures = (paneId) => {
    const term = getPane(paneId)?.term;
    return !!term && hasLigatures(term);
  };
}
