// App shortcuts: one listener in the capture phase on window, so they win over xterm wherever
// the focus is, and the program never receives a key the app took. Which key does what comes
// from the keymap (defaults + settings.json `keybindings`, see config/keybindings.ts); what each
// action does, from lib/appActions.ts.
//
// Defaults follow Windows Terminal: tab shortcuts use Ctrl+Shift so plain Ctrl+T / Ctrl+W keep
// reaching programs (readline, nano...). Holding a key down repeats keydown (event.repeat):
// actions that create, close or toggle run once per press; only moving between tabs and panes
// repeats.
import { actionById, eventKeys, type ActionDef } from '../config/keybindings';
import { useAi } from '../store/ai';
import { currentKeymap } from '../store/keymap';
import { useUi } from '../store/ui';
import { runAction } from './appActions';
import { focusActiveTerminal } from './tabActions';

/** Where the key was pressed. */
type KeyContext =
  | { kind: 'terminal'; paneId: string }
  | { kind: 'explorer' }
  /** A text field of the app (renaming, search, settings, palette). */
  | { kind: 'input' }
  | { kind: 'other' };

function contextOf(target: EventTarget | null): KeyContext {
  if (!(target instanceof Element)) return { kind: 'other' };
  const pane = target.closest<HTMLElement>('.terminal-pane');
  if (pane?.dataset.paneId && target.closest('.xterm')) return { kind: 'terminal', paneId: pane.dataset.paneId };
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) {
    return { kind: 'input' };
  }
  if (target.closest('.file-tree')) return { kind: 'explorer' };
  return { kind: 'other' };
}

function applies(action: ActionDef, ctx: KeyContext, event: KeyboardEvent): boolean {
  if (action.scope === 'terminal') return ctx.kind === 'terminal';
  if (action.scope === 'explorer') return ctx.kind === 'explorer';
  // In a text field, keys without Ctrl/Alt (F2, Supr) belong to the field.
  return ctx.kind !== 'input' || event.ctrlKey || event.altKey || event.metaKey;
}

/** The action a key press triggers here: a scoped action of this context wins over a global one. */
export function actionForEvent(event: KeyboardEvent): { action: ActionDef; ctx: KeyContext } | null {
  const keymap = currentKeymap();
  const ctx = contextOf(event.target);
  for (const key of eventKeys(event)) {
    const candidates = (keymap.byKey.get(key) ?? [])
      .map(actionById)
      .filter((a): a is ActionDef => !!a && applies(a, ctx, event));
    const action = candidates.find((a) => a.scope !== 'global') ?? candidates[0];
    if (action) return { action, ctx };
  }
  return null;
}

/** After these, the keyboard goes back to the active terminal (a new tab, another pane...). */
const REFOCUS = new Set(['tabs', 'panes', 'explorer']);

/** Installs the listener; returns the uninstaller. */
export function installAppShortcuts(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const ui = useUi.getState();
    // A modal dialog owns the keyboard, and so does the settings screen while recording a key.
    if (ui.confirm || ui.layoutDialog || ui.multiAgent || ui.capturingKeys || useAi.getState().preview) return;
    const found = actionForEvent(event);
    if (!found) return;
    const { action, ctx } = found;
    // While the settings screen or the palette is open, only its own shortcut works (to close it).
    if (ui.settings && action.id !== 'app.settings') return;
    if (ui.palette && action.id !== 'app.commandPalette') return;
    // The file tree handles its own (it knows the selected entry).
    if (action.scope === 'explorer') return;
    if (event.repeat && !action.repeat) {
      // Held down: once is enough, and the key must not leak to the terminal either.
      if (action.passthrough) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const result = runAction(action.id, { paneId: ctx.kind === 'terminal' ? ctx.paneId : null, event });
    if (result === 'pass') return;
    event.stopPropagation();
    if (result === 'handled') event.preventDefault();
    const now = useUi.getState();
    if (REFOCUS.has(action.category) && !now.renamingTabId && !now.renamingGroupId && !now.menu && !now.settings) {
      focusActiveTerminal();
    }
  };
  window.addEventListener('keydown', onKeyDown, { capture: true });
  return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
}
