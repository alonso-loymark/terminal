import { create } from 'zustand';
import type { Issue } from '../config/schema';
import { DEFAULT_SETTINGS, type Settings } from '../config/settingsSchema';

/**
 * ok: the file applied (maybe with warnings); invalid: it has errors and the last valid
 * settings stay in use (the status bar says so, the settings screen lists the problems).
 */
export type SettingsStatus = 'ok' | 'invalid';

export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 48;
const clampFontSize = (size: number) => Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));

interface SettingsState {
  /** In use: the last valid settings (the defaults until the file is read). */
  settings: Settings;
  /** The file was read once (the app waits for it before starting shells). */
  loaded: boolean;
  path: string | null;
  dir: string | null;
  /** The file's current text; null while it does not exist. */
  text: string | null;
  status: SettingsStatus;
  /** Errors (status invalid) or warnings. */
  issues: Issue[];
  /** The window was created transparent (backdrops and translucency apply live). */
  windowTransparent: boolean;
  /** The settings ask for transparency the window was not created with. */
  restartRequired: boolean;
  /** Ctrl+= / Ctrl+-: font size change on top of the setting, for this session only. */
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

export const useSettings = create<SettingsState>()((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  path: null,
  dir: null,
  text: null,
  status: 'ok',
  issues: [],
  windowTransparent: false,
  restartRequired: false,
  zoom: 0,
  zoomIn: () => set((s) => ({ zoom: clampFontSize(s.settings.appearance.fontSize + s.zoom + 1) - s.settings.appearance.fontSize })),
  zoomOut: () => set((s) => ({ zoom: clampFontSize(s.settings.appearance.fontSize + s.zoom - 1) - s.settings.appearance.fontSize })),
  resetZoom: () => set({ zoom: 0 }),
}));

/** The font size in use: the setting plus the session's zoom. */
export const selectFontSize = (s: Pick<SettingsState, 'settings' | 'zoom'>) =>
  clampFontSize(s.settings.appearance.fontSize + s.zoom);

/**
 * `next` with every part equal to `prev` replaced by `prev` itself: re-reading the file after
 * an unrelated change keeps the same objects, so nothing re-renders or re-applies for nothing.
 */
export function reuseEqual<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const items = next.map((item, i) => reuseEqual(prev[i], item));
    return (items.length === prev.length && items.every((item, i) => item === prev[i]) ? prev : items) as T;
  }
  if (prev && next && typeof prev === 'object' && typeof next === 'object' && !Array.isArray(prev) && !Array.isArray(next)) {
    const a = prev as Record<string, unknown>;
    const b = next as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let same = Object.keys(a).length === Object.keys(b).length;
    for (const key of Object.keys(b)) {
      out[key] = reuseEqual(a[key], b[key]);
      if (out[key] !== a[key] || !(key in a)) same = false;
    }
    return (same ? prev : out) as T;
  }
  return next;
}
