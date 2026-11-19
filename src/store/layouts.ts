import { create } from 'zustand';
import type { Issue } from '../config/schema';
import type { SavedLayout } from './layoutModel';

/**
 * layouts.json as the app sees it. ok: it parsed (a broken layout is left out and listed in
 * `issues`); invalid: the JSON itself is broken, the last good list stays in use and the app
 * does not write to the file until it is fixed.
 */
interface LayoutsState {
  layouts: SavedLayout[];
  /** The file's text; null while it does not exist. */
  text: string | null;
  status: 'ok' | 'invalid';
  issues: Issue[];
  loaded: boolean;
}

export const useLayouts = create<LayoutsState>()(() => ({ layouts: [], text: null, status: 'ok', issues: [], loaded: false }));

export const findLayout = (name: string): SavedLayout | undefined => {
  const key = name.trim().toLowerCase();
  return useLayouts.getState().layouts.find((l) => l.name.toLowerCase() === key);
};
