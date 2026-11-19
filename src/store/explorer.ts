import { create } from 'zustand';
import { pathKey, type Listing } from '../lib/explorerModel';

/** An inline input in the tree: renaming an entry, or naming a new file/folder. */
export type Editing = { kind: 'rename'; path: string } | { kind: 'create'; dir: string; entry: 'file' | 'dir' };

/** Discreet message at the bottom of the explorer (blocked cd, failed operation). */
export interface Notice {
  message: string;
  /** Offer to open a new tab in this folder instead. */
  openTabAt?: string;
  error?: boolean;
}

export const SIDEBAR_MIN = 160;
export const SIDEBAR_DEFAULT = 260;

/** What settings.json keeps (`explorer.*`, see lib/settingsSync.ts). */
export interface ExplorerPrefs {
  visible: boolean;
  width: number;
  showHidden: boolean;
}

interface ExplorerState extends ExplorerPrefs {
  /** Folder the explorer stays on instead of following the active pane's cwd. */
  pinned: string | null;
  /** pathKey → expanded. Kept across roots (absolute paths). */
  expanded: Record<string, true>;
  /** pathKey → listing of the folders read so far that are still on screen. */
  listings: Record<string, Listing>;
  editing: Editing | null;
  notice: Notice | null;
  /** pathKey of the selected row. */
  selected: string | null;
  /** Folders the backend confirmed it is watching (pathKeys; diagnostics and e2e). */
  watched: string[];
  toggleVisible: () => void;
  /** From settings.json (startup, or the file changed). */
  applyPrefs: (prefs: ExplorerPrefs) => void;
  setWidth: (width: number) => void;
  toggleHidden: () => void;
  setPinned: (path: string | null) => void;
  setExpanded: (path: string, open: boolean) => void;
  setListing: (listing: Listing) => void;
  /** Keeps only these listings (the visible folders): the rest is memory for nothing. */
  keepListings: (keys: Set<string>) => void;
  setEditing: (editing: Editing | null) => void;
  setNotice: (notice: Notice | null) => void;
  select: (path: string | null) => void;
  setWatched: (keys: string[]) => void;
}

export const useExplorer = create<ExplorerState>()((set) => ({
  visible: true,
  width: SIDEBAR_DEFAULT,
  showHidden: false,
  pinned: null,
  expanded: {},
  listings: {},
  editing: null,
  notice: null,
  selected: null,
  watched: [],
  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  applyPrefs: (prefs) =>
    set((s) =>
      s.visible === prefs.visible && s.width === prefs.width && s.showHidden === prefs.showHidden
        ? s
        : { visible: prefs.visible, width: Math.max(SIDEBAR_MIN, prefs.width), showHidden: prefs.showHidden },
    ),
  setWidth: (width) => set({ width: Math.max(SIDEBAR_MIN, Math.round(width)) }),
  toggleHidden: () => set((s) => ({ showHidden: !s.showHidden })),
  setPinned: (pinned) => set({ pinned }),
  setExpanded: (path, open) =>
    set((s) => {
      const key = pathKey(path);
      if (!!s.expanded[key] === open) return s;
      const expanded = { ...s.expanded };
      if (open) expanded[key] = true;
      else delete expanded[key];
      return { expanded };
    }),
  setListing: (listing) => set((s) => ({ listings: { ...s.listings, [pathKey(listing.path)]: listing } })),
  keepListings: (keys) =>
    set((s) => {
      const stale = Object.keys(s.listings).filter((key) => !keys.has(key));
      if (stale.length === 0) return s;
      const listings = { ...s.listings };
      for (const key of stale) delete listings[key];
      return { listings };
    }),
  setEditing: (editing) => set({ editing }),
  setNotice: (notice) => set({ notice }),
  select: (path) => set({ selected: path ? pathKey(path) : null }),
  setWatched: (watched) => set({ watched }),
}));
