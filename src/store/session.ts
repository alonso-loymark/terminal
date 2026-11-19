import { create } from 'zustand';

/** The session file as the app uses it (see lib/sessionSync.ts). */
interface SessionState {
  /** The workspace was restored (or started fresh): terminals can mount. */
  ready: boolean;
  /** Ids of the commands last run from the palette, most recent first. */
  recent: string[];
}

export const useSession = create<SessionState>()(() => ({ ready: false, recent: [] }));

const MAX_RECENT = 20;

/** A command was run from the palette: it goes first next time. */
export function recordRecent(id: string): void {
  useSession.setState((s) => ({ recent: [id, ...s.recent.filter((r) => r !== id)].slice(0, MAX_RECENT) }));
}
