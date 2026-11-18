import { create } from 'zustand';
import type { RendererKind } from '../lib/renderer';
import type { SessionStatus } from '../lib/terminalSession';

/** Serializable metadata about the terminal and its UI. The xterm instance lives in a ref. */
interface TerminalState {
  title: string;
  status: SessionStatus;
  exitCode: number | null;
  renderer: RendererKind;
  searchOpen: boolean;
  /** Bumped on every "open search" so an already open bar re-focuses its input. */
  searchRequest: number;
  setTitle: (title: string) => void;
  setStatus: (status: SessionStatus, exitCode: number | null) => void;
  setRenderer: (renderer: RendererKind) => void;
  openSearch: () => void;
  closeSearch: () => void;
}

export const useTerminalStore = create<TerminalState>()((set) => ({
  title: '',
  status: 'starting',
  exitCode: null,
  renderer: 'dom',
  searchOpen: false,
  searchRequest: 0,
  setTitle: (title) => set({ title }),
  setStatus: (status, exitCode) => set({ status, exitCode }),
  setRenderer: (renderer) => set({ renderer }),
  openSearch: () => set((s) => ({ searchOpen: true, searchRequest: s.searchRequest + 1 })),
  closeSearch: () => set({ searchOpen: false }),
}));
