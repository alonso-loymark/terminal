import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import type { PaneId } from '../store/workspaceModel';
import type { GpuRenderer } from './renderer';
import type { ShellIntegrationHandle } from './shellIntegration';
import type { TerminalSession } from './terminalSession';

/** The imperative objects behind a pane. Never stored in zustand (not serializable). */
export interface PaneHandle {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  session: TerminalSession;
  /** The pane (positioned, painted with the terminal background, hidden when off screen). */
  host: HTMLElement;
  /** Where xterm lives: the pane minus its padding (what `fit()` measures). */
  inner: HTMLElement;
  gpu: GpuRenderer;
  /** Shell integration marks of this terminal (what is typed at the prompt). */
  integration: ShellIntegrationHandle;
}

const handles = new Map<PaneId, PaneHandle>();

export const registerPane = (id: PaneId, handle: PaneHandle) => void handles.set(id, handle);
export const unregisterPane = (id: PaneId, handle: PaneHandle) => {
  // StrictMode remounts: only drop the entry if it still belongs to this mount.
  if (handles.get(id) === handle) handles.delete(id);
};
export const getPane = (id: PaneId | null | undefined): PaneHandle | undefined => (id ? handles.get(id) : undefined);
