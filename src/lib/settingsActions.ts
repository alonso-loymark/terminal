// What the settings screen does to settings.json beyond single values: importing and deleting
// themes, and editing the profile list (entries are matched by id; a detected profile gets an
// entry the first time it is customized).
import { defaultKeys } from '../config/keybindings';
import type { ProfileEntry } from '../config/profiles';
import type { Issue } from '../config/schema';
import { findTheme, themesFromImport, themeToJson } from '../config/themes';
import { currentKeymap } from '../store/keymap';
import { useSettings } from '../store/settings';
import { readThemeFile } from './settingsApi';
import { setSetting, update } from './settingsSync';
import { parseText, settingEdit, type Edit } from './settingsText';

export interface ImportResult {
  imported: string[];
  issues: Issue[];
}

/** Adds the themes in `text` (ours, Windows Terminal's, a list or a "schemes" fragment) and selects the first. */
export function importThemes(text: string): ImportResult {
  const parsed = parseText(text);
  if (parsed.issues.length) return { imported: [], issues: parsed.issues };
  const { themes, issues } = themesFromImport(parsed.value);
  if (themes.length === 0) return { imported: [], issues };
  const existing = useSettings.getState().settings.themes;
  const edits: Edit[] = [];
  let appended = 0;
  for (const theme of themes) {
    // Same name: the import replaces it (re-importing an updated scheme).
    const at = existing.findIndex((t) => t.name.toLowerCase() === theme.name.toLowerCase());
    edits.push([['themes', at >= 0 ? at : existing.length + appended++], themeToJson(theme)]);
  }
  edits.push([['theme'], themes[0]!.name]);
  if (!update(edits)) {
    return { imported: [], issues: [{ path: '', message: 'settings.json tiene errores: corregilo antes de importar', severity: 'error' }] };
  }
  return { imported: themes.map((t) => t.name), issues };
}

/** Theme files dropped on the import area. */
export async function importThemeFiles(paths: string[]): Promise<ImportResult> {
  const result: ImportResult = { imported: [], issues: [] };
  for (const path of paths) {
    try {
      const one = importThemes(await readThemeFile(path));
      result.imported.push(...one.imported);
      result.issues.push(...one.issues.map((issue) => ({ ...issue, path: `${path}${issue.path ? ` › ${issue.path}` : ''}` })));
    } catch (error) {
      result.issues.push({ path, message: String(error), severity: 'error' });
    }
  }
  return result;
}

export function selectTheme(id: string): void {
  setSetting(['theme'], id);
}

/** Removes a custom theme; if it was in use, back to the default one. */
export function deleteTheme(name: string): void {
  const { settings } = useSettings.getState();
  const at = settings.themes.findIndex((t) => t.name === name);
  if (at < 0) return;
  const edits: Edit[] = [[['themes', at], undefined]];
  const current = findTheme(settings.theme, settings.themes);
  if (current && !current.builtin && current.id === name) edits.push([['theme'], undefined]);
  update(edits);
}

// ---------------------------------------------------------------- profiles

const entries = () => useSettings.getState().settings.profiles.list;

/**
 * Sets one field of a profile's entry (`undefined` or an empty value removes it: back to the
 * detected value or the default).
 */
export function editProfile<K extends keyof ProfileEntry>(id: string, field: K, value: ProfileEntry[K] | undefined): void {
  const empty =
    value === undefined ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
  const at = entries().findIndex((entry) => entry.id === id);
  if (at >= 0) {
    update([[['profiles', 'list', at, field], empty ? undefined : value]]);
  } else if (!empty) {
    update([[['profiles', 'list', entries().length], { id, [field]: value }]]);
  }
}

/** A new profile of the user's own; returns its id. */
export function addProfile(): string {
  const taken = new Set(entries().map((entry) => entry.id));
  let n = 1;
  while (taken.has(`custom-${n}`)) n++;
  const id = `custom-${n}`;
  update([[['profiles', 'list', entries().length], { id, name: `Perfil ${n}`, command: 'powershell.exe', icon: 'terminal' }]]);
  return id;
}

/** Removes the entry: a custom profile disappears, a detected one goes back to how it was found. */
export function removeProfileEntry(id: string): void {
  const at = entries().findIndex((entry) => entry.id === id);
  if (at < 0) return;
  const edits: Edit[] = [[['profiles', 'list', at], undefined]];
  if (useSettings.getState().settings.profiles.default === id) edits.push([['profiles', 'default'], undefined]);
  update(edits);
}

export function setDefaultProfile(id: string): void {
  setSetting(['profiles', 'default'], id);
}

/** "A=1\nB=dos" ⇄ { A: '1', B: 'dos' } for the environment field. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    const key = (eq < 0 ? line : line.slice(0, eq)).trim();
    if (key) env[key] = eq < 0 ? '' : line.slice(eq + 1);
  }
  return env;
}

export const formatEnv = (env: Record<string, string> | undefined) =>
  Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

// ---------------------------------------------------------------- keybindings

/** An action's keys; the defaults remove the entry (the file keeps only what was changed). */
export function setKeybindings(id: string, keys: string[]): boolean {
  return update([settingEdit(['keybindings', id], keys, defaultKeys(id))]);
}

/** Moves `key` to `id`, taking it from the actions that had it. */
export function reassignKey(id: string, key: string): boolean {
  const { bindings } = currentKeymap();
  const edits: Edit[] = [];
  for (const [other, keys] of Object.entries(bindings)) {
    if (other !== id && keys.includes(key)) edits.push(settingEdit(['keybindings', other], keys.filter((k) => k !== key), defaultKeys(other)));
  }
  const own = bindings[id] ?? [];
  edits.push(settingEdit(['keybindings', id], own.includes(key) ? own : [...own, key], defaultKeys(id)));
  return update(edits);
}

/** Every shortcut back to its default. */
export function resetKeybindings(): boolean {
  return update([[['keybindings'], undefined]]);
}
