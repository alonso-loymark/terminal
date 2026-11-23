// The explorer's only door to the backend (like lib/pty.ts for terminals): typed wrappers of the
// file-system commands, the per-page watcher channel and native file drops.
import { Channel, invoke } from '@tauri-apps/api/core';
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
  /** `image`: an image that is not a file (dragged from a browser or another app). */
  | { type: 'over'; x: number; y: number; image: boolean }
  | { type: 'drop'; x: number; y: number; paths: string[] }
  /** Its bytes wait in the backend: `takeDroppedImage(id)`. */
  | { type: 'dropImage'; x: number; y: number; id: number; name: string }
  | { type: 'leave' };

type DropMessage =
  | { type: 'over'; x: number; y: number; image: boolean }
  | { type: 'drop'; x: number; y: number; paths: string[] }
  | { type: 'dropImage'; x: number; y: number; id: number; name: string }
  | { type: 'leave' };

/**
 * Drags from other apps over the window: files from Windows Explorer (or any app) and images
 * that are not files (Brisa's own drop target, see dragdrop.rs). Positions are CSS pixels of the
 * page. Each page load listens again. Returns the unsubscriber.
 */
export async function onFileDrop(handler: (event: FileDropEvent) => void): Promise<() => void> {
  let active = true;
  const channel = new Channel<DropMessage>((message) => {
    if (!active) return;
    if (message.type === 'leave') {
      handler(message);
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    handler({ ...message, x: message.x / ratio, y: message.y / ratio });
  });
  await invoke('drop_listen', { onEvent: channel });
  return () => {
    active = false;
  };
}

/** The bytes of a dropped image (once). */
export async function takeDroppedImage(id: number): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('take_dropped_image', { id }));
}

/** Saves a PNG in Brisa's temporary folder (old ones are removed after a few hours). Returns its path. */
export function savePastedImage(png: Uint8Array): Promise<string> {
  return invoke('save_pasted_image', png);
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
