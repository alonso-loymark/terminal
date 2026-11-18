import { create } from 'zustand';
import type { GroupId, PaneId, TabId } from './workspaceModel';

export type MenuState =
  | { kind: 'tab'; tabId: TabId; x: number; y: number }
  | { kind: 'group'; groupId: GroupId; x: number; y: number }
  | { kind: 'pane'; paneId: PaneId; x: number; y: number }
  /** "▾" next to "+": a new tab with another shell. */
  | { kind: 'shells'; x: number; y: number };

/** What a confirmed close acts on. */
export type CloseTarget = { kind: 'tabs'; tabIds: TabId[] } | { kind: 'pane'; paneId: PaneId };

export interface ConfirmState {
  title: string;
  message: string;
  details: string[];
  confirmLabel: string;
  target: CloseTarget;
}

/** Transient UI state: what is being renamed, open menus and dialogs, the search bar. */
interface UiState {
  renamingTabId: TabId | null;
  renamingGroupId: GroupId | null;
  menu: MenuState | null;
  confirm: ConfirmState | null;
  searchOpen: boolean;
  /** Bumped on every "open search" so an already open bar re-focuses its input. */
  searchRequest: number;
  startRenameTab: (id: TabId) => void;
  startRenameGroup: (id: GroupId) => void;
  stopRename: () => void;
  openMenu: (menu: MenuState) => void;
  closeMenu: () => void;
  openConfirm: (confirm: ConfirmState) => void;
  closeConfirm: () => void;
  openSearch: () => void;
  closeSearch: () => void;
}

export const useUi = create<UiState>()((set) => ({
  renamingTabId: null,
  renamingGroupId: null,
  menu: null,
  confirm: null,
  searchOpen: false,
  searchRequest: 0,
  startRenameTab: (id) => set({ renamingTabId: id, renamingGroupId: null, menu: null }),
  startRenameGroup: (id) => set({ renamingGroupId: id, renamingTabId: null, menu: null }),
  stopRename: () => set({ renamingTabId: null, renamingGroupId: null }),
  openMenu: (menu) => set({ menu }),
  closeMenu: () => set({ menu: null }),
  openConfirm: (confirm) => set({ confirm, menu: null }),
  closeConfirm: () => set({ confirm: null }),
  openSearch: () => set((s) => ({ searchOpen: true, searchRequest: s.searchRequest + 1 })),
  closeSearch: () => set({ searchOpen: false }),
}));
