// Explorer data: lazy listings, the backend watcher for the visible folders, and when to refresh
// git. Imperative module state (watcher id, request generations) lives here, not in zustand.
import { useExplorer } from '../store/explorer';
import { refreshGit } from '../store/git';
import { useWorkspace } from '../store/workspace';
import { pathKey } from './explorerModel';
import { listDir, watchSet, watchStart, type WatchId } from './fsApi';

// A listing request that finishes after a newer one for the same folder is dropped.
const generations = new Map<string, number>();

/** Reads a folder once (or again with `force`: the watcher saw a change). */
export async function loadDir(path: string, force = false): Promise<void> {
  const key = pathKey(path);
  const existing = useExplorer.getState().listings[key];
  if (existing && !force && existing.status !== 'error') return;
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  // A refresh keeps showing the old entries until the new ones arrive (no flicker).
  if (!existing || existing.status === 'error') {
    useExplorer.getState().setListing({ path, status: 'loading', entries: [], error: null });
  }
  try {
    const entries = await listDir(path);
    if (generations.get(key) !== generation) return;
    useExplorer.getState().setListing({ path, status: 'ok', entries, error: null });
  } catch (error) {
    if (generations.get(key) !== generation) return;
    useExplorer.getState().setListing({ path, status: 'error', entries: [], error: String(error) });
  }
}

let watcher: Promise<WatchId | null> | null = null;
let wanted: string[] = [];
let syncTimer = 0;
let watchedRoot: string | null = null;

function onChanged(dirs: string[]): void {
  const { listings } = useExplorer.getState();
  for (const dir of dirs) if (listings[pathKey(dir)]) void loadDir(dir, true);
  refreshGit(watchedRoot, 400);
}

/**
 * Watch exactly these folders (the root and the expanded, visible ones); everything else is
 * released. Empty when the explorer is hidden.
 */
export function syncWatches(root: string | null, dirs: string[]): void {
  watchedRoot = root;
  wanted = dirs;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    watcher ??= watchStart(onChanged).catch((error: unknown) => {
      console.warn('[explorer] watcher no disponible', error);
      return null;
    });
    const dirs = wanted;
    void watcher.then(async (id) => {
      if (id === null) return;
      const watched = await watchSet(id, dirs).catch(() => null);
      if (!watched || dirs !== wanted) return;
      const before = new Set(useExplorer.getState().watched);
      useExplorer.getState().setWatched(watched.map(pathKey).sort());
      // A change between the first listing and the watch being in place would be missed:
      // read the newly watched folders once more.
      for (const dir of watched) if (!before.has(pathKey(dir))) void loadDir(dir, true);
    });
  }, 100);
}

/**
 * Git changes with commands (commit, checkout, stash...): refresh when a command ends in any
 * pane. Returns the unsubscriber.
 */
export function installGitRefreshOnCommands(): () => void {
  const running = new Map<string, boolean>();
  return useWorkspace.subscribe((ws) => {
    for (const pane of Object.values(ws.panes)) {
      const was = running.get(pane.id) ?? false;
      if (was && !pane.commandRunning) refreshGit(pane.cwd, 300);
      running.set(pane.id, pane.commandRunning);
    }
  });
}
