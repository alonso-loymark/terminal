// Shortcuts in use: the defaults merged with settings.json `keybindings` (config/keybindings.ts),
// recomputed only when the setting changes.
import {
  eventKeys,
  formatKey,
  keymapConflicts,
  resolveKeymap,
  type ActionId,
  type Conflict,
  type KeyEventLike,
  type Keymap,
} from '../config/keybindings';
import { useSettings } from './settings';

let cache: { overrides: unknown; keymap: Keymap; conflicts: Conflict[] } | null = null;

function current() {
  const overrides = useSettings.getState().settings.keybindings;
  if (!cache || cache.overrides !== overrides) {
    const keymap = resolveKeymap(overrides);
    cache = { overrides, keymap, conflicts: keymapConflicts(keymap) };
  }
  return cache;
}

export const currentKeymap = (): Keymap => current().keymap;
export const currentConflicts = (): Conflict[] => current().conflicts;

/** The first key of an action, for menus and tooltips ("Ctrl+Shift+T"); undefined if unbound. */
export function shortcutLabel(id: ActionId): string | undefined {
  const key = currentKeymap().bindings[id]?.[0];
  return key ? formatKey(key) : undefined;
}

/** Re-renders when the keybindings change. */
export function useKeymap(): Keymap {
  useSettings((s) => s.settings.keybindings);
  return currentKeymap();
}

export function useShortcutLabel(id: ActionId): string | undefined {
  useSettings((s) => s.settings.keybindings);
  return shortcutLabel(id);
}

/** The key press is one of the action's keys (for widgets that handle their own: the file tree). */
export function eventMatches(event: KeyEventLike, id: ActionId): boolean {
  const keys = currentKeymap().bindings[id] ?? [];
  return eventKeys(event).some((key) => keys.includes(key));
}
