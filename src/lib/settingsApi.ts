// The only module that talks to the backend about the app's files (settings.json, the session,
// saved layouts) and the window's look (like lib/pty.ts for terminals and lib/fsApi.ts for the
// explorer).
import { invoke } from '@tauri-apps/api/core';

export interface SettingsFile {
  path: string;
  /** The folder holding it (watched for changes). */
  dir: string;
  /** Null while the file does not exist. */
  text: string | null;
  /** The window was created transparent: a backdrop and translucency can apply live. */
  windowTransparent: boolean;
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
