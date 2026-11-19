// Keeps the app and settings.json in step: reads it at startup, re-reads it when it changes on
// disk (applied live; a broken file keeps the last valid settings), writes the changes made
// from the settings screen (only the edited values: the user's comments and formatting stay)
// and the explorer's state (Ctrl+B, width), and migrates what earlier versions kept in
// localStorage.
import { parse } from 'jsonc-parser';
import type { JSONPath } from 'jsonc-parser';
import { DEFAULT_SETTINGS, settingsJsonSchema } from '../config/settingsSchema';
import { useExplorer, type ExplorerPrefs } from '../store/explorer';
import { reuseEqual, useSettings } from '../store/settings';
import { loadSystemInfo, useSystem } from '../store/system';
import { pathKey } from './explorerModel';
import { watchSet, watchStart } from './fsApi';
import {
  loadSettingsFile,
  openSettingsFile,
  readSettingsFile,
  writeSettingsFile,
  writeSettingsSchema,
} from './settingsApi';
import { editText, evaluate, NEW_FILE, settingEdit, type Edit } from './settingsText';

/** Where Fase 5 kept the explorer's visibility and width. */
const LEGACY_EXPLORER_KEY = 'terminal.explorer';
/** Dragging the explorer's edge changes the width many times a second: write once it stops. */
const EXPLORER_WRITE_DELAY_MS = 400;

let started: Promise<void> | null = null;
let pendingWrites = 0;
let changedWhileWriting = false;
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Reads the file and starts following it. Resolves once the settings apply; never rejects
 * (terminals wait for it: whatever fails here, they start with what could be read).
 */
export function initSettings(): Promise<void> {
  return (started ??= start().catch((error: unknown) => {
    console.warn('[brisa] settings.json:', error);
    useSettings.setState({ loaded: true });
  }));
}

async function start(): Promise<void> {
  bindExplorer();
  let file;
  try {
    file = await loadSettingsFile();
  } catch (error) {
    console.warn('[brisa] no se pudo leer settings.json', error);
    useSettings.setState({ loaded: true });
    return;
  }
  useSettings.setState({ path: file.path, dir: file.dir, windowTransparent: file.windowTransparent });
  apply(file.text);
  try {
    const legacy = takeLegacyExplorer(file.text);
    if (legacy.length && !update(legacy)) restoreLegacy();
  } catch (error) {
    restoreLegacy();
    console.warn('[brisa] no se pudieron migrar las preferencias del explorador', error);
  }
  // A file to open from the settings screen (and to watch) from the first start on.
  if (useSettings.getState().text === null) await write(NEW_FILE);
  void writeSchema();
  void watch(file.dir);
}

/** Validates the text and puts it in use (if it has errors, only the problems are shown). */
function apply(text: string | null): void {
  const { settings, issues } = evaluate(text);
  const state = useSettings.getState();
  if (settings) {
    useSettings.setState({ text, settings: reuseEqual(state.settings, settings), issues, status: 'ok', loaded: true });
  } else {
    useSettings.setState({ text, issues, status: 'invalid', loaded: true });
  }
}

function write(text: string): Promise<void> {
  pendingWrites++;
  writeQueue = writeQueue
    .then(() => writeSettingsFile(text))
    .catch((error: unknown) => console.warn('[brisa] no se pudo guardar settings.json', error))
    .finally(() => {
      pendingWrites--;
      if (pendingWrites === 0 && changedWhileWriting) {
        changedWhileWriting = false;
        void reconcile();
      }
    });
  return writeQueue;
}

/**
 * Applies edits to the file (UI changes). Refused while the file has errors: the user is
 * editing it by hand, and the app must not write over a half-written file.
 */
export function update(edits: readonly Edit[]): boolean {
  const state = useSettings.getState();
  if (!state.loaded || state.status === 'invalid' || edits.length === 0) return false;
  let text: string;
  try {
    text = editText(state.text, edits);
  } catch (error) {
    console.warn('[brisa] no se pudo editar settings.json', error);
    return false;
  }
  if (text === state.text) return true;
  apply(text);
  void write(text);
  return true;
}

/** The default value at a settings path (to drop the key when a value goes back to it). */
function defaultAt(path: JSONPath): unknown {
  let node: unknown = DEFAULT_SETTINGS;
  for (const key of path) node = node && typeof node === 'object' ? (node as Record<string | number, unknown>)[key] : undefined;
  return node;
}

/** One setting from the settings screen. The default value removes the key. */
export function setSetting(path: JSONPath, value: unknown): boolean {
  return update([settingEdit(path, value, defaultAt(path))]);
}

// ---------------------------------------------------------------- watching

const configListeners = new Set<() => void>();

/** Something changed in the config folder: other files there (layouts.json) re-read themselves. */
export function onConfigDirChange(listener: () => void): () => void {
  configListeners.add(listener);
  return () => configListeners.delete(listener);
}

async function watch(dir: string): Promise<void> {
  try {
    const id = await watchStart((dirs) => {
      if (!dirs.some((changed) => pathKey(changed) === pathKey(dir))) return;
      onDiskChange();
      for (const listener of configListeners) listener();
    });
    await watchSet(id, [dir]);
  } catch (error) {
    console.warn('[brisa] no se puede vigilar settings.json', error);
  }
}

function onDiskChange(): void {
  // Our own write in progress: look again once it is done.
  if (pendingWrites > 0) {
    changedWhileWriting = true;
    return;
  }
  void reconcile();
}

async function reconcile(): Promise<void> {
  try {
    const text = await readSettingsFile();
    if (pendingWrites > 0) {
      changedWhileWriting = true;
      return;
    }
    if (text !== useSettings.getState().text) apply(text);
  } catch (error) {
    console.warn('[brisa] no se pudo releer settings.json', error);
  }
}

/** settings.schema.json, for completions in VS Code: profile ids need the detected shells. */
async function writeSchema(): Promise<void> {
  await loadSystemInfo();
  const schema = () => {
    const ids = useSystem.getState().shells.map((shell) => shell.id);
    const themes = useSettings.getState().settings.themes.map((theme) => theme.name);
    return `${JSON.stringify(settingsJsonSchema(ids, themes), null, 2)}\n`;
  };
  let last = '';
  const save = () => {
    const text = schema();
    if (text === last) return;
    last = text;
    writeSettingsSchema(text).catch((error: unknown) => console.warn('[brisa] no se pudo escribir el schema', error));
  };
  save();
  // New custom themes are suggested too.
  useSettings.subscribe((s, prev) => {
    if (s.settings.themes !== prev.settings.themes) save();
  });
}

/** Opens settings.json in VS Code (creating it if needed). */
export async function openSettingsJson(): Promise<void> {
  if (useSettings.getState().text === null) await write(NEW_FILE);
  await writeQueue;
  await openSettingsFile();
}

// ---------------------------------------------------------------- explorer

let applyingToExplorer = false;

/** Explorer visibility on startup: the last state, or always visible / hidden. */
function startupVisible(): boolean {
  const { startup, visible } = useSettings.getState().settings.explorer;
  return startup === 'remember' ? visible : startup === 'visible';
}

function bindExplorer(): void {
  const applyPrefs = (prefs: ExplorerPrefs) => {
    applyingToExplorer = true;
    useExplorer.getState().applyPrefs(prefs);
    applyingToExplorer = false;
  };
  // Settings → explorer: once loaded, and whenever the file changes them.
  useSettings.subscribe((s, prev) => {
    const e = s.settings.explorer;
    if (s.loaded && !prev.loaded) {
      applyPrefs({ visible: startupVisible(), width: e.width, showHidden: e.showHidden });
    } else if (s.loaded && e !== prev.settings.explorer) {
      const visible = e.startup === 'remember' ? e.visible : useExplorer.getState().visible;
      applyPrefs({ visible, width: e.width, showHidden: e.showHidden });
    }
  });
  // Explorer → settings: Ctrl+B and the hidden-files toggle at once; the width once the drag
  // stops (or when it ends: flushExplorerPrefs).
  useExplorer.subscribe((s, prev) => {
    if (applyingToExplorer || !useSettings.getState().loaded) return;
    if (s.visible === prev.visible && s.width === prev.width && s.showHidden === prev.showHidden) return;
    window.clearTimeout(explorerTimer);
    if (s.visible !== prev.visible || s.showHidden !== prev.showHidden) flushExplorerPrefs();
    else explorerTimer = window.setTimeout(flushExplorerPrefs, EXPLORER_WRITE_DELAY_MS);
  });
}

let explorerTimer = 0;

/** Writes the explorer's visibility, width and hidden toggle now (the edge drag just ended). */
export function flushExplorerPrefs(): void {
  window.clearTimeout(explorerTimer);
  const now = useExplorer.getState();
  const remember = useSettings.getState().settings.explorer.startup === 'remember';
  update([
    ...(remember ? [settingEdit(['explorer', 'visible'], now.visible, DEFAULT_SETTINGS.explorer.visible)] : []),
    settingEdit(['explorer', 'width'], now.width, DEFAULT_SETTINGS.explorer.width),
    settingEdit(['explorer', 'showHidden'], now.showHidden, DEFAULT_SETTINGS.explorer.showHidden),
  ]);
}

// ---------------------------------------------------------------- migration

let legacyRaw: string | null = null;

/** Fase 5's localStorage preferences, as edits for the values the file does not set yet. */
function takeLegacyExplorer(text: string | null): Edit[] {
  try {
    legacyRaw = localStorage.getItem(LEGACY_EXPLORER_KEY);
    if (legacyRaw === null) return [];
    localStorage.removeItem(LEGACY_EXPLORER_KEY);
  } catch {
    return [];
  }
  let legacy: unknown;
  try {
    legacy = JSON.parse(legacyRaw);
  } catch {
    return [];
  }
  if (!legacy || typeof legacy !== 'object') return [];
  const current = (text ? parse(text, [], { allowTrailingComma: true }) : null) as { explorer?: Record<string, unknown> } | null;
  const edits: Edit[] = [];
  for (const key of ['visible', 'width', 'showHidden'] as const) {
    const value = (legacy as Record<string, unknown>)[key];
    const expected = typeof DEFAULT_SETTINGS.explorer[key];
    if (typeof value === expected && current?.explorer?.[key] === undefined) {
      edits.push(settingEdit(['explorer', key], value, DEFAULT_SETTINGS.explorer[key]));
    }
  }
  return edits;
}

/** The file has errors: keep the old preferences for a later start. */
function restoreLegacy(): void {
  try {
    if (legacyRaw !== null) localStorage.setItem(LEGACY_EXPLORER_KEY, legacyRaw);
  } catch {
    // Nothing else to do: the defaults apply.
  }
}
