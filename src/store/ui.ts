import { create } from 'zustand';
import type { GroupId, PaneId, TabId } from './workspaceModel';

export type MenuState =
  | { kind: 'tab'; tabId: TabId; x: number; y: number }
  | { kind: 'group'; groupId: GroupId; x: number; y: number }
  /** clipboard: also copy / paste / select all (right click set to "menu"). */
  | { kind: 'pane'; paneId: PaneId; x: number; y: number; clipboard?: boolean }
  /** The mark of a command block (lib/blocks.ts). */
  | { kind: 'block'; paneId: PaneId; blockId: number; x: number; y: number }
  /** "▾" next to "+": a new tab with any profile. */
  | { kind: 'shells'; x: number; y: number }
  /** "…" in the explorer's breadcrumbs: the folders it hides. */
  | { kind: 'crumbs'; crumbs: { label: string; path: string }[]; x: number; y: number }
  /** Right click in the explorer: on an entry, or on the empty area (the root folder). */
  | { kind: 'explorer'; path: string; isDir: boolean; isRoot: boolean; x: number; y: number };

/** What the confirmation dialog acts on when accepted. */
export type CloseTarget =
  | { kind: 'tabs'; tabIds: TabId[] }
  | { kind: 'pane'; paneId: PaneId }
  | { kind: 'trash'; paths: string[] }
  /** Worktrees of closed panes that have uncommitted changes. */
  | { kind: 'worktrees'; paths: string[] }
  /** A chat of the orchestrator (its messages go; the project's decision log stays). */
  | { kind: 'chat'; dir: string; chatId: string };

export interface ConfirmState {
  title: string;
  message: string;
  details: string[];
  confirmLabel: string;
  /** Default: "Cancelar". */
  cancelLabel?: string;
  target: CloseTarget;
}

export type SettingsSection = 'appearance' | 'themes' | 'profiles' | 'terminal' | 'explorer' | 'agents' | 'ai' | 'keybindings' | 'session';

/** Saving the active tab, or the whole window, as a named layout. */
export interface LayoutDialogState {
  scope: 'tab' | 'window';
  tabId: TabId | null;
}

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'warning';
}

/**
 * Transient UI state: what is being renamed, open menus and dialogs, the search bar, settings,
 * the command palette, the layout dialog and the toast.
 */
interface UiState {
  renamingTabId: TabId | null;
  renamingGroupId: GroupId | null;
  menu: MenuState | null;
  confirm: ConfirmState | null;
  searchOpen: boolean;
  /** Bumped on every "open search" so an already open bar re-focuses its input. */
  searchRequest: number;
  /** The settings screen (Ctrl+,) and its section; null when closed. */
  settings: SettingsSection | null;
  /** The command palette (Ctrl+Shift+P). */
  palette: boolean;
  layoutDialog: LayoutDialogState | null;
  /** The multi-agent preset's dialog, for a folder. */
  multiAgent: { cwd: string | null } | null;
  toast: Toast | null;
  /** The settings screen is recording a shortcut: no shortcut runs meanwhile. */
  capturingKeys: boolean;
  startRenameTab: (id: TabId) => void;
  startRenameGroup: (id: GroupId) => void;
  stopRename: () => void;
  openMenu: (menu: MenuState) => void;
  closeMenu: () => void;
  openConfirm: (confirm: ConfirmState) => void;
  closeConfirm: () => void;
  openSearch: () => void;
  closeSearch: () => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  openPalette: () => void;
  closePalette: () => void;
  openLayoutDialog: (dialog: LayoutDialogState) => void;
  closeLayoutDialog: () => void;
  openMultiAgent: (cwd: string | null) => void;
  closeMultiAgent: () => void;
  showToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: () => void;
  setCapturingKeys: (capturing: boolean) => void;
}

let toasts = 0;

export const useUi = create<UiState>()((set) => ({
  renamingTabId: null,
  renamingGroupId: null,
  menu: null,
  confirm: null,
  searchOpen: false,
  searchRequest: 0,
  settings: null,
  palette: false,
  layoutDialog: null,
  multiAgent: null,
  toast: null,
  capturingKeys: false,
  startRenameTab: (id) => set({ renamingTabId: id, renamingGroupId: null, menu: null }),
  startRenameGroup: (id) => set({ renamingGroupId: id, renamingTabId: null, menu: null }),
  stopRename: () => set({ renamingTabId: null, renamingGroupId: null }),
  openMenu: (menu) => set({ menu }),
  closeMenu: () => set({ menu: null }),
  openConfirm: (confirm) => set({ confirm, menu: null }),
  closeConfirm: () => set({ confirm: null }),
  openSearch: () => set((s) => ({ searchOpen: true, searchRequest: s.searchRequest + 1 })),
  closeSearch: () => set({ searchOpen: false }),
  openSettings: (section) => set((s) => ({ settings: section ?? s.settings ?? 'appearance', menu: null })),
  closeSettings: () => set({ settings: null, capturingKeys: false }),
  openPalette: () => set({ palette: true, menu: null }),
  closePalette: () => set({ palette: false }),
  openLayoutDialog: (layoutDialog) => set({ layoutDialog, palette: false, menu: null }),
  closeLayoutDialog: () => set({ layoutDialog: null }),
  openMultiAgent: (cwd) => set({ multiAgent: { cwd }, palette: false, menu: null }),
  closeMultiAgent: () => set({ multiAgent: null }),
  showToast: (message, kind = 'info') => set({ toast: { id: ++toasts, message, kind } }),
  dismissToast: () => set({ toast: null }),
  setCapturingKeys: (capturingKeys) => set({ capturingKeys }),
}));
