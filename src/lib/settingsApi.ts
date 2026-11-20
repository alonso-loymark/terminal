// The only module that talks to the backend about the app's files (settings.json, the session,
// saved layouts) and the window's look (like lib/pty.ts for terminals and lib/fsApi.ts for the
// explorer).
import { Channel, invoke } from '@tauri-apps/api/core';

export interface SettingsFile {
  path: string;
  /** The folder holding it (watched for changes). */
  dir: string;
  /** Null while the file does not exist. */
  text: string | null;
  /** The window was created transparent: a backdrop and translucency can apply live. */
  windowTransparent: boolean;
  /** The window was created with Windows' own title bar. */
  nativeTitleBar: boolean;
}

export function loadSettingsFile(): Promise<SettingsFile> {
  return invoke('settings_load');
}

/** The app's files in the config folder (see src-tauri/src/settings.rs). */
export type ConfigFile = 'settings' | 'settingsSchema' | 'session' | 'layouts' | 'layoutsSchema';

/** Null while the file does not exist. */
export function readConfigFile(file: ConfigFile): Promise<string | null> {
  return invoke('config_read', { file });
}

/** Replaces the file atomically; `onlyIfChanged` skips identical content (schemas). */
export function writeConfigFile(file: ConfigFile, text: string, onlyIfChanged = false): Promise<void> {
  return invoke('config_write', { file, text, onlyIfChanged });
}

/** settings.json or layouts.json in VS Code; without it, in the app Windows associates with .json. */
export function openConfigFile(file: 'settings' | 'layouts'): Promise<void> {
  return invoke('config_open', { file });
}

export const readSettingsFile = () => readConfigFile('settings');
export const writeSettingsFile = (text: string) => writeConfigFile('settings', text);
/** settings.schema.json next to the file (written only if it changed). */
export const writeSettingsSchema = (text: string) => writeConfigFile('settingsSchema', text, true);
export const openSettingsFile = () => openConfigFile('settings');

/** A theme file dropped on the settings screen (JSON, at most 1 MB). */
export function readThemeFile(path: string): Promise<string> {
  return invoke('read_theme_file', { path });
}

export type Backdrop = 'none' | 'mica' | 'acrylic';

export interface WindowLookResult {
  applied: boolean;
  /** The window was created opaque: translucency and backdrops need a restart. */
  restartRequired: boolean;
}

export function setWindowLook(look: {
  backdrop: Backdrop;
  translucent: boolean;
  dark: boolean;
  background: string;
}): Promise<WindowLookResult> {
  return invoke('set_window_look', look);
}

// ---------------------------------------------------------------- custom title bar

export type CaptionButton = 'minimize' | 'maximize' | 'close';

/** The caption buttons as the native overlay sees them (Windows: Snap Layouts). */
export interface CaptionState {
  /** The overlay is in place: hover and clicks come from it, not from the page. */
  native: boolean;
  hover: CaptionButton | null;
  pressed: CaptionButton | null;
}

export function titlebarListen(onEvent: (state: CaptionState) => void): Promise<void> {
  return invoke('titlebar_listen', { onEvent: new Channel<CaptionState>(onEvent) });
}

/** Where the page's caption buttons are (physical px, client area); null: none (native title bar). */
export function titlebarButtons(rect: { x: number; y: number; width: number; height: number } | null): Promise<void> {
  return invoke('titlebar_buttons', { rect });
}

/** `appearance.titleBar`, live: our title bar with the tabs, or Windows' own. */
export function setTitleBar(custom: boolean): Promise<void> {
  return invoke('set_title_bar', { custom });
}
