// The only module that talks to the backend about the settings file and the window's look (like
// lib/pty.ts for terminals and lib/fsApi.ts for the explorer).
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

export function readSettingsFile(): Promise<string | null> {
  return invoke('settings_read');
}

/** Replaces the file atomically. */
export function writeSettingsFile(text: string): Promise<void> {
  return invoke('settings_write', { text });
}

/** settings.schema.json next to the file (written only if it changed). */
export function writeSettingsSchema(text: string): Promise<void> {
  return invoke('settings_write_schema', { text });
}

/** In VS Code; without it, in the app Windows associates with .json. */
export function openSettingsFile(): Promise<void> {
  return invoke('settings_open');
}

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
