// layouts.json: read at startup, followed on disk (edits by hand apply live), and written when a
// layout is saved or removed from the app. Only that entry of the text changes: the user's
// comments, order and formatting stay. Written atomically by the backend.
import { parse } from 'jsonc-parser';
import {
  layoutsJsonSchema,
  layoutToJson,
  NEW_LAYOUTS_FILE,
  parseLayouts,
  type SavedLayout,
} from '../store/layoutModel';
import { useLayouts } from '../store/layouts';
import { useSystem } from '../store/system';
import { openConfigFile, readConfigFile, writeConfigFile } from './settingsApi';
import { onConfigDirChange } from './settingsSync';
import { editText, parseText, type Edit } from './settingsText';

let started: Promise<void> | null = null;
let pendingWrites = 0;
let changedWhileWriting = false;
let writeQueue: Promise<void> = Promise.resolve();

/** Reads the file and starts following it. Never rejects. */
export function initLayouts(): Promise<void> {
  return (started ??= start().catch((error: unknown) => {
    console.warn('[brisa] layouts.json:', error);
    useLayouts.setState({ loaded: true });
  }));
}

async function start(): Promise<void> {
  apply(await readConfigFile('layouts'));
  onConfigDirChange(onDiskChange);
  const ids = useSystem.getState().shells.map((shell) => shell.id);
  void writeConfigFile('layoutsSchema', `${JSON.stringify(layoutsJsonSchema(ids), null, 2)}\n`, true).catch((error: unknown) =>
    console.warn('[brisa] no se pudo escribir layouts.schema.json', error),
  );
}

function apply(text: string | null): void {
  if (text === null || text.trim() === '') {
    useLayouts.setState({ text, layouts: [], issues: [], status: 'ok', loaded: true });
    return;
  }
  const parsed = parseText(text);
  if (parsed.issues.length) {
    // Broken JSON: keep the last good list.
    useLayouts.setState({ text, issues: parsed.issues, status: 'invalid', loaded: true });
    return;
  }
  const { layouts, issues } = parseLayouts(parsed.value);
  useLayouts.setState({ text, layouts, issues, status: 'ok', loaded: true });
}

function onDiskChange(): void {
  if (pendingWrites > 0) {
    changedWhileWriting = true;
    return;
  }
  void reconcile();
}

async function reconcile(): Promise<void> {
  try {
    const text = await readConfigFile('layouts');
    if (pendingWrites > 0) {
      changedWhileWriting = true;
      return;
    }
    if (text !== useLayouts.getState().text) apply(text);
  } catch (error) {
    console.warn('[brisa] no se pudo releer layouts.json', error);
  }
}

function write(text: string): Promise<void> {
  pendingWrites++;
  writeQueue = writeQueue
    .then(() => writeConfigFile('layouts', text))
    .catch((error: unknown) => console.warn('[brisa] no se pudo guardar layouts.json', error))
    .finally(() => {
      pendingWrites--;
      if (pendingWrites === 0 && changedWhileWriting) {
        changedWhileWriting = false;
        void reconcile();
      }
    });
  return writeQueue;
}

/** Where a layout sits in the file's own list (broken entries count too), or -1. */
function rawIndex(text: string | null, name: string): { at: number; length: number } {
  const value = text ? (parse(text, [], { allowTrailingComma: true }) as { layouts?: unknown }) : null;
  const list = Array.isArray(value?.layouts) ? (value.layouts as unknown[]) : [];
  const key = name.trim().toLowerCase();
  const at = list.findIndex(
    (entry) => typeof entry === 'object' && entry !== null && String((entry as { name?: unknown }).name ?? '').trim().toLowerCase() === key,
  );
  return { at, length: list.length };
}

function edit(edits: Edit[]): boolean {
  const state = useLayouts.getState();
  if (state.status === 'invalid') return false;
  let text: string;
  try {
    text = editText(state.text, edits, NEW_LAYOUTS_FILE);
  } catch (error) {
    console.warn('[brisa] no se pudo editar layouts.json', error);
    return false;
  }
  apply(text);
  void write(text);
  return true;
}

/**
 * Adds the layout, or replaces the one with the same name (case aside). False while the file has
 * broken JSON (the user is editing it: the app does not write over it).
 */
export function saveLayout(layout: SavedLayout): boolean {
  const { text } = useLayouts.getState();
  const { at, length } = rawIndex(text, layout.name);
  return edit([[['layouts', at >= 0 ? at : length], layoutToJson(layout)]]);
}

export function deleteLayout(name: string): boolean {
  const { at } = rawIndex(useLayouts.getState().text, name);
  if (at < 0) return false;
  return edit([[['layouts', at], undefined]]);
}

/** Opens layouts.json in VS Code, creating it (with the format explained) if needed. */
export async function openLayoutsJson(): Promise<void> {
  if (useLayouts.getState().text === null) await write(NEW_LAYOUTS_FILE).then(() => apply(NEW_LAYOUTS_FILE));
  await writeQueue;
  await openConfigFile('layouts');
}
