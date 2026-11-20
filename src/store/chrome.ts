import { create } from 'zustand';
import type { CaptionState } from '../lib/settingsApi';

/** The window's own state, for the custom title bar (lib/windowChrome.ts keeps it current). */
interface ChromeState {
  /** The window has Windows' own title bar right now. */
  nativeTitleBar: boolean;
  maximized: boolean;
  /** The window has the system focus (inactive windows dim their title bar, like Windows). */
  active: boolean;
  /** Hover and press of the caption buttons, from the native overlay. */
  caption: CaptionState;
}

export const useChrome = create<ChromeState>()(() => ({
  nativeTitleBar: false,
  maximized: false,
  active: true,
  caption: { native: false, hover: null, pressed: null },
}));
