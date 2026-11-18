import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import type { PaneId } from '../store/workspaceModel';
import type { GpuRenderer } from './renderer';
import type { TerminalSession } from './terminalSession';

/** The imperative objects behind a pane. Never stored in zustand (not serializable). */
export interface PaneHandle {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  session: TerminalSession;
  host: HTMLElement;
  gpu: GpuRenderer;
}

const handles = new Map<PaneId, PaneHandle>();

export const registerPane = (id: PaneId, handle: PaneHandle) => void handles.set(id, handle);
export const unregisterPane = (id: PaneId, handle: PaneHandle) => {
  // StrictMode remounts: only drop the entry if it still belongs to this mount.
  if (handles.get(id) === handle) handles.delete(id);
};
export const getPane = (id: PaneId | null | undefined): PaneHandle | undefined => (id ? handles.get(id) : undefined);
