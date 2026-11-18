import type { ITheme } from '@xterm/xterm';
import { create } from 'zustand';
import { defaultTheme } from '../config/theme';

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  scrollback: number;
  theme: ITheme;
}

export const DEFAULT_SETTINGS: TerminalSettings = {
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
  fontSize: 14,
  lineHeight: 1.1,
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollback: 10_000,
  theme: defaultTheme,
};

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 36;

interface SettingsState extends TerminalSettings {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

const clampFontSize = (size: number) => Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));

export const useSettings = create<SettingsState>()((set) => ({
  ...DEFAULT_SETTINGS,
  zoomIn: () => set((s) => ({ fontSize: clampFontSize(s.fontSize + 1) })),
  zoomOut: () => set((s) => ({ fontSize: clampFontSize(s.fontSize - 1) })),
  resetZoom: () => set({ fontSize: DEFAULT_SETTINGS.fontSize }),
}));
