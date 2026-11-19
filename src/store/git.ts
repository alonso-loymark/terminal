import { create } from 'zustand';
import { gitStatus } from '../lib/fsApi';
import { pathKey, type GitStatus } from '../lib/explorerModel';

/** Git status per repository, and which repository each folder asked about belongs to. */
interface GitState {
  /** Folder pathKey → repository root pathKey (null: not in a repository). */
  repoOf: Record<string, string | null>;
  /** Root pathKey → last status. */
  repos: Record<string, GitStatus>;
}

export const useGit = create<GitState>()(() => ({ repoOf: {}, repos: {} }));

/** The status for a folder, if known. */
export const selectGitFor = (dir: string | null) => (s: GitState): GitStatus | null => {
  if (!dir) return null;
  const root = s.repoOf[pathKey(dir)];
  return root ? (s.repos[root] ?? null) : null;
};

// One git process per folder at a time: a request during a run marks it to run once more after
// (a burst of file changes or prompts never piles up processes).
const running = new Map<string, boolean>();
const timers = new Map<string, number>();

async function run(dir: string): Promise<void> {
  const key = pathKey(dir);
  if (running.has(key)) {
    running.set(key, true);
    return;
  }
  running.set(key, false);
  try {
    const status = await gitStatus(dir).catch(() => null);
    useGit.setState((s) => {
      if (!status) return { repoOf: { ...s.repoOf, [key]: null } };
      const root = pathKey(status.root);
      return { repoOf: { ...s.repoOf, [key]: root }, repos: { ...s.repos, [root]: status } };
    });
  } finally {
    const again = running.get(key);
    running.delete(key);
    if (again) void run(dir);
  }
}

/** Refreshes the git status of the repository containing `dir`, after `delay` ms of calm. */
export function refreshGit(dir: string | null, delay = 0): void {
  if (!dir) return;
  const key = pathKey(dir);
  window.clearTimeout(timers.get(key));
  if (delay <= 0) {
    timers.delete(key);
    void run(dir);
    return;
  }
  timers.set(
    key,
    window.setTimeout(() => {
      timers.delete(key);
      void run(dir);
    }, delay),
  );
}
