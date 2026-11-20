// The explorer's only door to the backend (like lib/pty.ts for terminals): typed wrappers of the
// file-system commands, the per-page watcher channel and native file drops.
import { Channel, invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { DirEntry, GitStatus } from './explorerModel';

export type WatchId = number;

export function listDir(path: string): Promise<DirEntry[]> {
  return invoke('list_dir', { path });
}

/** A watcher for this page; `onChange` gets the folders whose contents changed (debounced). */
export function watchStart(onChange: (dirs: string[]) => void): Promise<WatchId> {
  return invoke('watch_start', { onChange: new Channel<string[]>(onChange) });
}

/** Watch exactly these folders from now on (the rest are released). Returns those being watched. */
export function watchSet(id: WatchId, dirs: string[]): Promise<string[]> {
  return invoke('watch_set', { id, dirs });
}

export function watchStop(id: WatchId): Promise<void> {
  return invoke('watch_stop', { id });
}

/** Status of the repository containing `path`; null outside one (or without git). */
export function gitStatus(path: string): Promise<GitStatus | null> {
  return invoke('git_status', { path });
}

/** Creates an empty file or folder; never overwrites. Returns its path. */
export function createEntry(dir: string, name: string, kind: 'file' | 'dir'): Promise<string> {
  return invoke('create_entry', { dir, name, kind });
}

export function renameEntry(path: string, name: string): Promise<string> {
  return invoke('rename_entry', { path, name });
}

/** To the Recycle Bin. */
export function trashEntries(paths: string[]): Promise<void> {
  return invoke('trash_entries', { paths });
}

export function openInVscode(path: string): Promise<void> {
  return invoke('open_in_vscode', { path });
}

export function openInFileManager(path: string): Promise<void> {
  return invoke('open_in_file_manager', { path });
}

export type FileDropEvent =
  | { type: 'over'; x: number; y: number }
  | { type: 'drop'; x: number; y: number; paths: string[] }
  | { type: 'leave' };

/**
 * Files dragged from Windows Explorer (or any app) over the window. Positions are CSS pixels
 * of the page. Returns the unsubscriber.
 */
export async function onFileDrop(handler: (event: FileDropEvent) => void): Promise<() => void> {
  return getCurrentWebview().onDragDropEvent(({ payload }) => {
    const ratio = window.devicePixelRatio || 1;
    if (payload.type === 'leave') handler({ type: 'leave' });
    else if (payload.type === 'drop') {
      handler({ type: 'drop', x: payload.position.x / ratio, y: payload.position.y / ratio, paths: payload.paths });
    } else handler({ type: 'over', x: payload.position.x / ratio, y: payload.position.y / ratio });
  });
}

// ---------------------------------------------------------------- worktrees (multi-agent preset)

export interface Worktree {
  path: string;
  repo: string;
  branch: string;
  /** Seconds since the epoch. */
  created: number;
}

export interface WorktreeStatus {
  exists: boolean;
  /** Uncommitted changes. */
  changes: number;
}

/** A worktree (new branch from HEAD) of the repository that contains `dir`. */
export function worktreeCreate(dir: string, label: string): Promise<Worktree> {
  return invoke('worktree_create', { dir, label });
}

export function worktreeStatus(path: string): Promise<WorktreeStatus> {
  return invoke('worktree_status', { path });
}

/** Only worktrees Brisa created; `force` removes them even with uncommitted changes. */
export function worktreeRemove(path: string, force: boolean): Promise<{ branchDeleted: boolean }> {
  return invoke('worktree_remove', { path, force });
}

export function worktreeList(): Promise<Worktree[]> {
  return invoke('worktree_list');
}
