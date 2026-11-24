// Keyboard shortcuts: every action of the app with its default keys, the user's overrides from
// settings.json (`keybindings`), conflicts (between actions, and with keys that programs in the
// terminal need) and matching keyboard events. Pure, no runtime imports (node --test).
//
// A key is written like in VS Code and Windows Terminal: modifiers and a key joined by "+",
// case-insensitive: "ctrl+shift+t", "alt+left", "shift+f10", "ctrl++". Normalized as
// ctrl+alt+shift+meta+key.
import type { Issue, JsonSchema, Schema } from './schema.ts';

/**
 * global: anywhere in the app (not while typing in a text field, unless it has Ctrl or Alt);
 * terminal: only with the keyboard in a terminal; explorer: only in the file tree; chats: only
 * in the orchestrator's chat list.
 */
export type ActionScope = 'global' | 'terminal' | 'explorer' | 'chats';
export type ActionCategory = 'app' | 'tabs' | 'panes' | 'terminal' | 'blocks' | 'agents' | 'orchestrator' | 'ai' | 'explorer' | 'layouts';

export const CATEGORY_LABELS: Record<ActionCategory, string> = {
  app: 'Aplicación',
  tabs: 'Tabs',
  panes: 'Paneles',
  terminal: 'Terminal',
  blocks: 'Bloques',
  agents: 'Agentes',
  orchestrator: 'Orquestador',
  ai: 'IA',
  explorer: 'Explorador',
  layouts: 'Layouts',
};

export interface ActionDef {
  id: string;
  label: string;
  category: ActionCategory;
  scope: ActionScope;
  /** Default keys (normalized). */
  keys: readonly string[];
  /** Holding the key down repeats the action (moving between tabs and panes). */
  repeat?: boolean;
  /**
   * Acts only in some situations (copy when there is a selection); otherwise the key goes on to
   * the program, so taking a key programs use is not a conflict.
   */
  passthrough?: boolean;
  /** Not offered by the command palette (it needs a key event, or it is the palette itself). */
  paletteHidden?: boolean;
}

const def = (
  id: string,
  label: string,
  category: ActionCategory,
  scope: ActionScope,
  keys: string[],
  extra: Partial<ActionDef> = {},
): ActionDef => ({ id, label, category, scope, keys, ...extra });

/** Every action, in the order the settings screen and the palette show them. */
export const ACTIONS: readonly ActionDef[] = [
  def('app.commandPalette', 'Paleta de comandos', 'app', 'global', ['ctrl+shift+p'], { paletteHidden: true }),
  def('app.settings', 'Configuración', 'app', 'global', ['ctrl+,']),
  def('app.openSettingsJson', 'Abrir settings.json', 'app', 'global', []),
  def('tab.new', 'Nueva tab', 'tabs', 'global', ['ctrl+shift+t']),
  def('tab.close', 'Cerrar tab', 'tabs', 'global', []),
  def('tab.closeOthers', 'Cerrar las demás tabs', 'tabs', 'global', []),
  def('tab.duplicate', 'Duplicar tab', 'tabs', 'global', []),
  def('tab.rename', 'Renombrar tab', 'tabs', 'global', ['f2']),
  def('tab.next', 'Tab siguiente', 'tabs', 'global', ['ctrl+tab'], { repeat: true }),
  def('tab.previous', 'Tab anterior', 'tabs', 'global', ['ctrl+shift+tab'], { repeat: true }),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => def(`tab.goTo${n}`, `Ir a la tab ${n}`, 'tabs', 'global', [`ctrl+${n}`])),
  def('tab.goToLast', 'Ir a la última tab', 'tabs', 'global', ['ctrl+9']),
  def('tab.newGroup', 'Nuevo grupo con la tab actual', 'tabs', 'global', ['ctrl+shift+g']),
  def('tab.removeFromGroup', 'Quitar la tab de su grupo', 'tabs', 'global', []),
  def('pane.splitRight', 'Dividir el panel a la derecha', 'panes', 'global', ['alt+shift+d']),
  def('pane.splitDown', 'Dividir el panel hacia abajo', 'panes', 'global', ['alt+shift+-']),
  def('pane.close', 'Cerrar el panel (el último cierra la tab)', 'panes', 'global', ['ctrl+shift+w']),
  def('pane.focusLeft', 'Ir al panel de la izquierda', 'panes', 'global', ['alt+left'], { repeat: true }),
  def('pane.focusRight', 'Ir al panel de la derecha', 'panes', 'global', ['alt+right'], { repeat: true }),
  def('pane.focusUp', 'Ir al panel de arriba', 'panes', 'global', ['alt+up'], { repeat: true }),
  def('pane.focusDown', 'Ir al panel de abajo', 'panes', 'global', ['alt+down'], { repeat: true }),
  def('pane.toggleZoom', 'Maximizar / restaurar el panel', 'panes', 'global', ['ctrl+shift+z']),
  def('pane.equalize', 'Igualar los tamaños de los paneles', 'panes', 'global', []),
  def('pane.menu', 'Menú del panel', 'panes', 'global', ['shift+f10', 'contextmenu'], { paletteHidden: true }),
  def('terminal.copySelection', 'Copiar si hay selección (si no, la tecla llega al programa)', 'terminal', 'terminal', ['ctrl+c'], {
    passthrough: true,
    paletteHidden: true,
  }),
  def('terminal.copy', 'Copiar', 'terminal', 'terminal', ['ctrl+shift+c', 'ctrl+insert']),
  def('terminal.paste', 'Pegar', 'terminal', 'terminal', ['ctrl+v', 'ctrl+shift+v', 'shift+insert']),
  def('terminal.pasteImageFile', 'Pegar imagen como archivo', 'terminal', 'terminal', []),
  def('terminal.selectAll', 'Seleccionar todo', 'terminal', 'terminal', []),
  def('terminal.clear', 'Limpiar la terminal', 'terminal', 'terminal', []),
  def('terminal.find', 'Buscar', 'terminal', 'terminal', ['ctrl+shift+f']),
  def('terminal.zoomIn', 'Agrandar la fuente', 'terminal', 'global', ['ctrl+=', 'ctrl++']),
  def('terminal.zoomOut', 'Achicar la fuente', 'terminal', 'global', ['ctrl+-']),
  def('terminal.zoomReset', 'Fuente al tamaño normal', 'terminal', 'global', ['ctrl+0']),
  def('terminal.newline', 'Salto de línea (agentes de IA; en el resto, Shift+Enter nativo)', 'terminal', 'terminal', ['shift+enter'], {
    paletteHidden: true,
  }),
  def('blocks.previous', 'Bloque anterior (comando y su salida)', 'blocks', 'terminal', ['ctrl+up'], { repeat: true, passthrough: true, paletteHidden: true }),
  def('blocks.next', 'Bloque siguiente', 'blocks', 'terminal', ['ctrl+down'], { repeat: true, passthrough: true, paletteHidden: true }),
  def('agents.multiAgent', 'Abrir multi-agente aquí…', 'agents', 'global', []),
  def('orchestrator.open', 'Abrir orquestador aquí', 'orchestrator', 'global', []),
  // Only with an orchestrator tab active; elsewhere the key goes on to the program.
  def('orchestrator.newChat', 'Orquestador: chat nuevo', 'orchestrator', 'global', ['ctrl+shift+n'], { passthrough: true }),
  def('orchestrator.searchChats', 'Orquestador: buscar en los chats', 'orchestrator', 'global', ['ctrl+shift+k'], { passthrough: true }),
  def('orchestrator.showChats', 'Orquestador: mostrar la lista de chats', 'orchestrator', 'global', [], { passthrough: true }),
  def('chats.rename', 'Orquestador: renombrar el chat', 'orchestrator', 'chats', ['f2']),
  def('chats.delete', 'Orquestador: eliminar el chat', 'orchestrator', 'chats', ['delete']),
  def('ai.command', 'IA: lenguaje natural a comando', 'ai', 'global', ['ctrl+i']),
  def('ai.panel', 'IA: panel de chat', 'ai', 'global', ['ctrl+shift+i']),
  def('ai.explainLast', 'IA: explicar el último comando que falló', 'ai', 'global', []),
  def('ai.cancel', 'IA: cancelar la consulta en curso del panel (solo con la shell libre)', 'ai', 'terminal', ['escape'], {
    passthrough: true,
    paletteHidden: true,
  }),
  def('explorer.toggle', 'Mostrar / ocultar el explorador', 'explorer', 'global', ['ctrl+b']),
  def('explorer.toggleHidden', 'Ver / esconder los archivos ocultos', 'explorer', 'global', []),
  def('explorer.rename', 'Renombrar el archivo seleccionado', 'explorer', 'explorer', ['f2'], { paletteHidden: true }),
  def('explorer.delete', 'Mover a la papelera el archivo seleccionado', 'explorer', 'explorer', ['delete'], { paletteHidden: true }),
  def('layout.saveTab', 'Guardar la tab como layout…', 'layouts', 'global', []),
  def('layout.saveWindow', 'Guardar la ventana como layout…', 'layouts', 'global', []),
  def('app.openLayoutsJson', 'Abrir layouts.json', 'layouts', 'global', []),
];

export type ActionId = string;

const BY_ID = new Map(ACTIONS.map((action) => [action.id, action]));
export const actionById = (id: ActionId): ActionDef | undefined => BY_ID.get(id);

// ---------------------------------------------------------------- keys

const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const;
type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  mayús: 'shift',
  mayus: 'shift',
  meta: 'meta',
  win: 'meta',
  cmd: 'meta',
  super: 'meta',
};

const NAMED = [
  'tab',
  'enter',
  'escape',
  'space',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  'contextmenu',
  'pause',
  'printscreen',
  'scrolllock',
] as const;

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  spacebar: 'space',
  del: 'delete',
  supr: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
  repág: 'pageup',
  avpág: 'pagedown',
  inicio: 'home',
  fin: 'end',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  menu: 'contextmenu',
  apps: 'contextmenu',
  plus: '+',
  minus: '-',
  backquote: '`',
};

const NUMPAD = ['numpad_add', 'numpad_subtract', 'numpad_multiply', 'numpad_divide', 'numpad_decimal', 'numpad_enter'];

function normalizeKeyName(raw: string): string | null {
  const key = KEY_ALIASES[raw] ?? raw;
  if ((NAMED as readonly string[]).includes(key)) return key;
  if (/^f([1-9]|1\d|2[0-4])$/.test(key)) return key;
  if (/^numpad\d$/.test(key) || NUMPAD.includes(key)) return key;
  // Any single visible character: letters, digits, punctuation, ñ, ´...
  if ([...key].length === 1 && !/\s/.test(key)) return key;
  return null;
}

export interface KeyCombo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

/** "Ctrl + Shift + T" → { ctrl, shift, key: 't' }; null if it is not a valid key. */
export function parseCombo(text: string): KeyCombo | null {
  const compact = text.toLowerCase().replace(/\s+/g, '');
  if (!compact) return null;
  let keyPart: string;
  let modPart: string;
  // "+" itself as the key: "ctrl++", "+".
  if (compact === '+') {
    keyPart = '+';
    modPart = '';
  } else if (compact.endsWith('++')) {
    keyPart = '+';
    modPart = compact.slice(0, -2);
  } else {
    const at = compact.lastIndexOf('+');
    keyPart = compact.slice(at + 1);
    modPart = at < 0 ? '' : compact.slice(0, at);
  }
  const combo: KeyCombo = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  if (modPart) {
    for (const raw of modPart.split('+')) {
      const mod = MODIFIER_ALIASES[raw];
      if (!mod || combo[mod]) return null;
      combo[mod] = true;
    }
  }
  const key = normalizeKeyName(keyPart);
  if (!key) return null;
  combo.key = key;
  return combo;
}

export const comboToString = (c: KeyCombo): string =>
  [...MODIFIERS.filter((m) => c[m]), c.key].join('+');

/** The canonical form of a key ("Ctrl+Shift+T" → "ctrl+shift+t"), or null if invalid. */
export function normalizeKey(text: string): string | null {
  const combo = parseCombo(text);
  return combo ? comboToString(combo) : null;
}

const KEY_LABELS: Record<string, string> = {
  tab: 'Tab',
  enter: 'Enter',
  escape: 'Esc',
  space: 'Espacio',
  backspace: 'Retroceso',
  delete: 'Supr',
  insert: 'Insert',
  home: 'Inicio',
  end: 'Fin',
  pageup: 'RePág',
  pagedown: 'AvPág',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  contextmenu: 'Menú',
  pause: 'Pausa',
  printscreen: 'ImprPant',
  scrolllock: 'BloqDespl',
  numpad_add: 'Num+',
  numpad_subtract: 'Num-',
  numpad_multiply: 'Num*',
  numpad_divide: 'Num/',
  numpad_decimal: 'Num.',
  numpad_enter: 'NumEnter',
};

const MOD_LABELS: Record<Modifier, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' };

/** For the UI: "ctrl+shift+t" → "Ctrl+Shift+T", "alt+left" → "Alt+←". */
export function formatKey(text: string): string {
  const c = parseCombo(text);
  if (!c) return text;
  const key =
    KEY_LABELS[c.key] ?? (/^numpad\d$/.test(c.key) ? `Num${c.key.slice(6)}` : /^f\d+$/.test(c.key) ? c.key.toUpperCase() : c.key.toUpperCase());
  return [...MODIFIERS.filter((m) => c[m]).map((m) => MOD_LABELS[m]), key].join('+');
}

// ---------------------------------------------------------------- matching events

/** The parts of a KeyboardEvent that matter (a plain object in tests). */
export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const EVENT_KEYS: Record<string, string> = {
  Tab: 'tab',
  Enter: 'enter',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ContextMenu: 'contextmenu',
  Pause: 'pause',
  PrintScreen: 'printscreen',
  ScrollLock: 'scrolllock',
};

const NUMPAD_CODES: Record<string, string> = {
  NumpadAdd: 'numpad_add',
  NumpadSubtract: 'numpad_subtract',
  NumpadMultiply: 'numpad_multiply',
  NumpadDivide: 'numpad_divide',
  NumpadDecimal: 'numpad_decimal',
  NumpadEnter: 'numpad_enter',
};

/** Shifted symbol → the key it is on (US and Spanish layouts): Shift+"-" types "_". */
const SHIFTED: Record<string, string> = {
  _: '-',
  '+': '=',
  '<': ',',
  '>': '.',
  '?': '/',
  ':': ';',
  '"': "'",
  '{': '[',
  '}': ']',
  '|': '\\',
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
};

const isSymbol = (key: string) => [...key].length === 1 && !/[\p{L}\p{N}]/u.test(key);

/**
 * The keys (normalized) a keyboard event may stand for, most specific first. The key as typed
 * comes first; then, for digits and letters, the physical key (Ctrl+Shift+1 types "!", a
 * non-Latin layout types "и" for B); a shifted symbol also stands for the key it is on
 * (Alt+Shift+- types "_") and, when the binding does not say Shift, for itself ("ctrl++" is
 * Ctrl+Shift+= on a US keyboard). Ctrl+Alt with a character is AltGr: only that character.
 */
export function eventKeys(event: KeyEventLike): string[] {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'CapsLock', 'NumLock'].includes(event.key)) return [];
  const mods = (shift: boolean) =>
    [event.ctrlKey && 'ctrl', event.altKey && 'alt', shift && 'shift', event.metaKey && 'meta'].filter(Boolean).join('+');
  const withMods = (key: string, shift = event.shiftKey) => (mods(shift) ? `${mods(shift)}+${key}` : key);
  const altGr = event.ctrlKey && event.altKey && [...event.key].length === 1;
  const out: string[] = [];
  const add = (key: string | null | undefined, shift = event.shiftKey) => {
    if (!key) return;
    const text = withMods(key, shift);
    if (!out.includes(text)) out.push(text);
  };

  let typed: string | null = null;
  if (event.key === ' ') typed = 'space';
  else if ([...event.key].length === 1) typed = event.key.toLowerCase();
  else if (/^F\d{1,2}$/.test(event.key)) typed = event.key.toLowerCase();
  else typed = EVENT_KEYS[event.key] ?? null;
  add(typed);
  if (!altGr) {
    const digit = /^Digit(\d)$/.exec(event.code)?.[1];
    add(digit);
    const letter = /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase();
    // Only when the layout does not type a Latin letter there (Dvorak's Ctrl+X stays Ctrl+X).
    if (letter && !(typed && /^[a-z]$/.test(typed))) add(letter);
    const numpad = /^Numpad(\d)$/.exec(event.code)?.[1];
    if (numpad) add(`numpad${numpad}`);
    add(NUMPAD_CODES[event.code]);
  }
  if (typed && isSymbol(typed) && event.shiftKey) {
    add(SHIFTED[typed]);
    add(typed, false);
  }
  return out;
}

// ---------------------------------------------------------------- the user's keymap

/** settings.json `keybindings`: action id → its keys (normalized); missing = the defaults. */
export type KeybindingOverrides = Record<ActionId, string[]>;

export interface Keymap {
  /** Keys in use for every action. */
  bindings: Record<ActionId, string[]>;
  /** Key → actions bound to it; the user's own bindings first, then the registry order. */
  byKey: Map<string, ActionId[]>;
  /** Actions whose keys differ from the defaults. */
  customized: Set<ActionId>;
}

export const defaultKeys = (id: ActionId): string[] => [...(actionById(id)?.keys ?? [])];

export function resolveKeymap(overrides: KeybindingOverrides = {}): Keymap {
  const bindings: Record<ActionId, string[]> = {};
  const customized = new Set<ActionId>();
  for (const action of ACTIONS) {
    const own = overrides[action.id];
    bindings[action.id] = own ? [...own] : [...action.keys];
    if (own && !sameKeys(own, action.keys)) customized.add(action.id);
  }
  const byKey = new Map<string, ActionId[]>();
  const ordered = [...ACTIONS.filter((a) => customized.has(a.id)), ...ACTIONS.filter((a) => !customized.has(a.id))];
  for (const action of ordered) {
    for (const key of bindings[action.id] ?? []) byKey.set(key, [...(byKey.get(key) ?? []), action.id]);
  }
  return { bindings, byKey, customized };
}

export const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, i) => key === b[i]);

/**
 * Two actions on one key clash when both would want the same press: same scope, or global and
 * terminal (the keyboard is almost always in a terminal). An explorer (or chat list) action
 * shadows a global one only while that list has the focus (F2 renames a tab, a file in the tree
 * and a chat in the orchestrator's list).
 */
export const scopesClash = (a: ActionScope, b: ActionScope) =>
  a === b || (a === 'global' && b === 'terminal') || (a === 'terminal' && b === 'global');

// ---------------------------------------------------------------- conflicts

/**
 * Keys programs in the terminal rely on, and what they do there. Taking one for the app means
 * no program ever receives it (tmux's prefix, readline's editing keys, nano's commands...).
 * Ctrl+V is not here: pasting with it is the Windows convention.
 */
export const RESERVED_KEYS: Record<string, string> = {
  'ctrl+c': 'interrumpe el programa (Ctrl+C)',
  'ctrl+d': 'fin de la entrada: cierra shells y REPLs',
  'ctrl+z': 'deshacer en PowerShell; suspender en bash',
  'ctrl+r': 'buscar en el historial (PowerShell, bash, fzf)',
  'ctrl+w': 'borra la palabra anterior; en nano, buscar',
  'ctrl+a': 'inicio de la línea; prefijo de screen',
  'ctrl+e': 'fin de la línea',
  'ctrl+k': 'borra hasta el final de la línea; en nano, cortar',
  'ctrl+u': 'borra hasta el inicio de la línea; en nano, pegar',
  'ctrl+l': 'limpia la pantalla',
  'ctrl+t': 'transpone caracteres; fzf: buscar archivos',
  'ctrl+p': 'comando anterior del historial',
  'ctrl+n': 'comando siguiente del historial',
  'ctrl+f': 'un carácter adelante; en vim, página abajo',
  'ctrl+b': 'un carácter atrás (readline); prefijo de tmux',
  'ctrl+o': 'en nano, guardar',
  'ctrl+x': 'en nano, salir; prefijo de emacs',
  'ctrl+s': 'en nano y emacs, guardar; búsqueda hacia adelante',
  'ctrl+q': 'control de flujo; en algunos editores, salir',
  'ctrl+y': 'pega lo borrado (readline)',
  'ctrl+g': 'cancela (readline, emacs); en nano, ayuda',
  'ctrl+h': 'retroceso',
  'ctrl+j': 'Enter',
  'ctrl+m': 'Enter',
  'ctrl+\\': 'termina el programa (SIGQUIT)',
  'ctrl+[': 'Escape',
  'ctrl+]': 'en telnet y ssh, escape',
  'ctrl+space': 'autocompletado (PowerShell: MenuComplete)',
  'ctrl+left': 'una palabra atrás',
  'ctrl+right': 'una palabra adelante',
  'ctrl+backspace': 'borra la palabra anterior',
  'ctrl+delete': 'borra la palabra siguiente',
  'ctrl+home': 'borra hasta el inicio (PowerShell)',
  'ctrl+end': 'borra hasta el final (PowerShell)',
  'alt+b': 'una palabra atrás (readline)',
  'alt+f': 'una palabra adelante (readline)',
  'alt+d': 'borra la palabra siguiente (readline)',
  'alt+.': 'último argumento del comando anterior (readline)',
  escape: 'salir de modos en vim y los programas de pantalla completa',
  'shift+tab': 'autocompletado hacia atrás',
  up: 'historial y navegación',
  down: 'historial y navegación',
  left: 'mover el cursor',
  right: 'mover el cursor',
  home: 'inicio de la línea',
  end: 'fin de la línea',
  pageup: 'página arriba',
  pagedown: 'página abajo',
  delete: 'borra el carácter siguiente',
  insert: 'modo de inserción',
};

/** Keys without Ctrl/Alt that type something: taking one would stop it from being typed. */
export function blocksTyping(key: string): boolean {
  const c = parseCombo(key);
  if (!c || c.ctrl || c.alt || c.meta) return false;
  if (['space', 'backspace'].includes(c.key)) return true;
  if ((c.key === 'enter' || c.key === 'tab') && !c.shift) return true;
  return [...c.key].length === 1;
}

export type ConflictKind = 'duplicate' | 'reserved' | 'typing';

export interface Conflict {
  kind: ConflictKind;
  key: string;
  /** The actions involved (one for reserved/typing). */
  actions: ActionId[];
  message: string;
}

/**
 * The problems of a keymap: one key on two actions that can see the same press, keys that
 * would stop typing, and keys programs in the terminal use.
 */
export function keymapConflicts(keymap: Keymap): Conflict[] {
  const out: Conflict[] = [];
  for (const [key, ids] of keymap.byKey) {
    const actions = ids.map(actionById).filter((a): a is ActionDef => !!a);
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i]!;
      const clash = actions.filter((b, j) => j !== i && scopesClash(a.scope, b.scope));
      if (clash.length && !out.some((c) => c.kind === 'duplicate' && c.key === key)) {
        const all = [a, ...clash];
        out.push({
          kind: 'duplicate',
          key,
          actions: all.map((x) => x.id),
          message: `${formatKey(key)} está asignado a ${all.map((x) => `«${x.label}»`).join(' y ')}`,
        });
      }
    }
    for (const a of actions) {
      if (a.scope === 'explorer' || a.scope === 'chats') continue;
      if (blocksTyping(key)) {
        out.push({ kind: 'typing', key, actions: [a.id], message: `${formatKey(key)} sin Ctrl ni Alt no se podría escribir` });
      } else if (!a.passthrough && RESERVED_KEYS[key]) {
        out.push({
          kind: 'reserved',
          key,
          actions: [a.id],
          message: `Los programas usan ${formatKey(key)}: ${RESERVED_KEYS[key]}. Con este atajo no les llega.`,
        });
      }
    }
  }
  return out;
}

/** What assigning `key` to `id` would collide with (for the settings screen, before saving). */
export function conflictsFor(keymap: Keymap, id: ActionId, key: string): Conflict[] {
  const bindings = { ...keymap.bindings, [id]: [...(keymap.bindings[id] ?? []).filter((k) => k !== key), key] };
  const overrides: KeybindingOverrides = {};
  for (const action of ACTIONS) overrides[action.id] = bindings[action.id] ?? [];
  return keymapConflicts(resolveKeymap(overrides)).filter((c) => c.key === key && c.actions.includes(id));
}

// ---------------------------------------------------------------- settings.json

/** The `keybindings` section: a key or a list of keys per action ([] removes the defaults). */
export function keybindingsSchema(): Schema<KeybindingOverrides> {
  const keyList = (value: unknown, path: string, issues: Issue[], action: ActionDef): string[] | null => {
    const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
    if (!list || list.some((k) => typeof k !== 'string')) {
      issues.push({ path, message: 'tiene que ser una tecla ("ctrl+shift+t") o una lista de teclas', severity: 'error' });
      return null;
    }
    const keys: string[] = [];
    list.forEach((raw: string, i) => {
      const at = typeof value === 'string' ? path : `${path}[${i}]`;
      const key = normalizeKey(raw);
      if (!key) issues.push({ path: at, message: `"${raw}" no es una tecla válida (ejemplos: "ctrl+shift+t", "alt+left", "f2")`, severity: 'error' });
      else if (blocksTyping(key) && action.scope !== 'explorer' && action.scope !== 'chats') {
        issues.push({ path: at, message: `"${raw}" sin Ctrl ni Alt impediría escribir esa tecla`, severity: 'error' });
      } else if (!keys.includes(key)) keys.push(key);
    });
    return keys;
  };
  return {
    default: {},
    parse(value, path, issues) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        issues.push({ path, message: 'tiene que ser un objeto: { "acción": "tecla" }', severity: 'error' });
        return {};
      }
      const out: KeybindingOverrides = {};
      for (const [id, keys] of Object.entries(value as Record<string, unknown>)) {
        const at = path ? `${path}.${id}` : id;
        const action = actionById(id);
        if (!action) {
          issues.push({ path: at, message: 'acción desconocida: se ignora', severity: 'warning' });
          continue;
        }
        const parsed = keyList(keys, at, issues, action);
        if (parsed) out[id] = parsed;
      }
      return out;
    },
    json: (): JsonSchema => ({
      type: 'object',
      description:
        'Atajos de teclado: acción → tecla o lista de teclas ("ctrl+shift+t", "alt+left", "f2"). [] quita el atajo. Lo que no está usa el de por defecto.',
      properties: Object.fromEntries(
        ACTIONS.map((action) => [
          action.id,
          {
            description: `${action.label}. Por defecto: ${action.keys.length ? action.keys.map(formatKey).join(', ') : 'sin atajo'}.`,
            default: [...action.keys],
            anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
        ]),
      ),
      additionalProperties: false,
    }),
  };
}

/**
 * The key to store for a key press recorded in the settings screen: the readable form
 * ("ctrl+shift+1", not "ctrl+shift+!"; "alt+shift+-", not "alt+shift+_"). Null for a lone
 * modifier.
 */
export function keyFromEvent(event: KeyEventLike): string | null {
  const keys = eventKeys(event);
  if (keys.length === 0) return null;
  const mods = [event.ctrlKey && 'ctrl', event.altKey && 'alt', event.shiftKey && 'shift', event.metaKey && 'meta'].filter(Boolean);
  const altGr = event.ctrlKey && event.altKey && [...event.key].length === 1;
  const digit = /^Digit(\d)$/.exec(event.code)?.[1];
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase();
  const typed = [...event.key].length === 1 ? event.key.toLowerCase() : null;
  let key: string | undefined;
  if (!altGr && digit) key = digit;
  else if (!altGr && letter && !(typed && /^[a-z]$/.test(typed))) key = letter;
  else if (typed && event.shiftKey && SHIFTED[typed]) key = SHIFTED[typed];
  return key ? [...mods, key].join('+') : keys[0]!;
}
