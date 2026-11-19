// Color themes: the terminal palette plus the UI around it (tabs, explorer, status bar, menus).
// Built-in themes, custom ones from settings.json, and imports in two formats:
//
//   ours:              { "name": "Mi tema", "terminal": { "background": "#…", "red": "#…" }, "ui": { "accent": "#…" } }
//   Windows Terminal:  { "name": "Dracula", "background": "#…", "cursorColor": "#…", "purple": "#…", … }
//
// Missing colors are filled in: the terminal palette from the built-in theme of the same
// lightness, the UI colors derived from the terminal palette. Pure (tested with node --test).
import type { Issue, JsonSchema, Schema } from './schema.ts';

export const TERMINAL_KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;
export type TerminalColorKey = (typeof TERMINAL_KEYS)[number];
/** The xterm palette (a subset of xterm's ITheme, all set). */
export type TerminalColors = Record<TerminalColorKey, string>;

export const UI_KEYS = ['background', 'chrome', 'panel', 'border', 'text', 'muted', 'accent', 'danger', 'warning', 'success'] as const;
export type UiColorKey = (typeof UI_KEYS)[number];
export type UiColors = Record<UiColorKey, string>;

/** A theme as written by the user (any color may be missing). */
export interface ThemeSpec {
  name: string;
  terminal: Partial<TerminalColors>;
  ui: Partial<UiColors>;
}

/** A theme ready to apply. */
export interface Theme {
  /** What settings.json refers to (`"theme": "dracula"`). */
  id: string;
  label: string;
  dark: boolean;
  builtin: boolean;
  terminal: TerminalColors;
  ui: UiColors;
}

// ---------------------------------------------------------------- built-in themes

interface Builtin {
  id: string;
  label: string;
  terminal: TerminalColors;
  ui?: Partial<UiColors>;
}

const GITHUB_DARK: TerminalColors = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selectionBackground: '#264f78',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

const GITHUB_LIGHT: TerminalColors = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: '#b6d7ff',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#7d4e00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

export const BUILTIN_THEMES: readonly Builtin[] = [
  {
    id: 'dark',
    label: 'Oscuro',
    terminal: GITHUB_DARK,
    ui: {
      background: '#0d1117',
      chrome: '#010409',
      panel: '#161b22',
      border: '#30363d',
      text: '#c9d1d9',
      muted: '#8b949e',
      accent: '#58a6ff',
      danger: '#f85149',
    },
  },
  {
    id: 'light',
    label: 'Claro',
    terminal: GITHUB_LIGHT,
    ui: {
      background: '#ffffff',
      chrome: '#f6f8fa',
      panel: '#eaeef2',
      border: '#d0d7de',
      text: '#1f2328',
      muted: '#59636e',
      accent: '#0969da',
      danger: '#cf222e',
      warning: '#9a6700',
      success: '#1a7f37',
    },
  },
  {
    id: 'catppuccin',
    label: 'Catppuccin Mocha',
    terminal: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#585b70',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    },
    ui: { chrome: '#11111b', panel: '#313244', border: '#45475a', muted: '#9399b2', accent: '#cba6f7' },
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    terminal: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#dc8a78',
      cursorAccent: '#eff1f5',
      selectionBackground: '#acb0be',
      black: '#5c5f77',
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#df8e1d',
      blue: '#1e66f5',
      magenta: '#ea76cb',
      cyan: '#179299',
      white: '#acb0be',
      brightBlack: '#6c6f85',
      brightRed: '#d20f39',
      brightGreen: '#40a02b',
      brightYellow: '#df8e1d',
      brightBlue: '#1e66f5',
      brightMagenta: '#ea76cb',
      brightCyan: '#179299',
      brightWhite: '#bcc0cc',
    },
    ui: { chrome: '#e6e9ef', panel: '#dce0e8', border: '#bcc0cc', muted: '#6c6f85', accent: '#8839ef', warning: '#df8e1d' },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    terminal: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
    ui: { chrome: '#21222c', panel: '#343746', border: '#44475a', muted: '#9ea4c4', accent: '#bd93f9' },
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    terminal: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selectionBackground: '#33467c',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5',
    },
    ui: { chrome: '#16161e', panel: '#1f2335', border: '#3b4261', muted: '#737aa2' },
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    terminal: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      cursorAccent: '#282c34',
      selectionBackground: '#3e4451',
      black: '#3f4451',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#d7dae0',
      brightBlack: '#5c6370',
      brightRed: '#ff7b86',
      brightGreen: '#b1e18b',
      brightYellow: '#efd08f',
      brightBlue: '#84c0f4',
      brightMagenta: '#d898eb',
      brightCyan: '#6bcbd6',
      brightWhite: '#e6e6e6',
    },
    ui: { chrome: '#21252b', panel: '#2c313a', border: '#3e4451', muted: '#7f848e' },
  },
];

export const DEFAULT_THEME = 'dark';

// ---------------------------------------------------------------- colors

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export const isColor = (value: unknown): value is string => typeof value === 'string' && HEX.test(value.trim());

/** #rgb / #rgba / #rrggbb / #rrggbbaa → [r, g, b, a(0..1)]. */
export function rgba(color: string): [number, number, number, number] {
  let hex = color.trim().slice(1);
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
  const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
}

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

/** `weight` of b into a (0: a, 1: b), as an opaque #rrggbb. */
export function mix(a: string, b: string, weight: number): string {
  const [r1, g1, b1] = rgba(a);
  const [r2, g2, b2] = rgba(b);
  return toHex(r1 + (r2 - r1) * weight, g1 + (g2 - g1) * weight, b1 + (b2 - b1) * weight);
}

/** The color with this opacity (0..1), as #rrggbbaa. */
export function withAlpha(color: string, alpha: number): string {
  const [r, g, b] = rgba(color);
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${toHex(r, g, b)}${a.toString(16).padStart(2, '0')}`;
}

/** WCAG relative luminance (0 black .. 1 white). */
export function luminance(color: string): number {
  const [r, g, b] = rgba(color).map((v, i) => (i < 3 ? v / 255 : v)) as [number, number, number, number];
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** UI colors from the terminal palette, for themes that bring only that (Windows Terminal's). */
export function deriveUi(t: TerminalColors, dark: boolean): UiColors {
  return {
    background: t.background,
    chrome: dark ? mix(t.background, '#000000', 0.3) : mix(t.background, t.foreground, 0.04),
    panel: mix(t.background, t.foreground, dark ? 0.07 : 0.08),
    border: mix(t.background, t.foreground, dark ? 0.2 : 0.18),
    text: t.foreground,
    muted: mix(t.foreground, t.background, 0.38),
    accent: t.blue,
    danger: t.red,
    warning: t.yellow,
    success: t.green,
  };
}

// ---------------------------------------------------------------- resolve

const slug = (text: string) => text.trim().toLowerCase();

function build(id: string, label: string, builtin: boolean, terminal: Partial<TerminalColors>, ui: Partial<UiColors>): Theme {
  const background = terminal.background ?? ui.background ?? GITHUB_DARK.background;
  const dark = luminance(background) < 0.4;
  const base = dark ? GITHUB_DARK : GITHUB_LIGHT;
  const full: TerminalColors = { ...base, cursorAccent: background, ...terminal, background };
  return { id, label, dark, builtin, terminal: full, ui: { ...deriveUi(full, dark), ...ui } };
}

export const builtinThemes = (): Theme[] => BUILTIN_THEMES.map((t) => build(t.id, t.label, true, t.terminal, t.ui ?? {}));

/** Every theme the settings can name: the user's own first (they may shadow a built-in). */
export function allThemes(custom: readonly ThemeSpec[]): Theme[] {
  const own = custom.map((spec) => build(spec.name, spec.name, false, spec.terminal, spec.ui));
  const taken = new Set(own.map((t) => slug(t.id)));
  return [...own, ...builtinThemes().filter((t) => !taken.has(slug(t.id)) && !taken.has(slug(t.label)))];
}

/** The theme called `name` (id or label, any case); null if there is none. */
export function findTheme(name: string, custom: readonly ThemeSpec[]): Theme | null {
  const key = slug(name);
  return allThemes(custom).find((t) => slug(t.id) === key || slug(t.label) === key) ?? null;
}

export function resolveTheme(name: string, custom: readonly ThemeSpec[]): Theme {
  return findTheme(name, custom) ?? findTheme(DEFAULT_THEME, [])!;
}

// ---------------------------------------------------------------- parsing (settings and imports)

/** Windows Terminal's keys → ours. */
const WT_KEYS: Record<string, TerminalColorKey> = {
  cursorColor: 'cursor',
  purple: 'magenta',
  brightPurple: 'brightMagenta',
};
const FLAT_KEYS = new Set<string>([...TERMINAL_KEYS, ...Object.keys(WT_KEYS), 'selectionForeground']);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One theme in either format. Problems go to `issues` (bad colors are errors, unknown keys
 * warnings); returns null if it is not a theme at all.
 */
export function parseThemeSpec(value: unknown, path: string, issues: Issue[]): ThemeSpec | null {
  const at = (key: string) => (path ? `${path}.${key}` : key);
  if (!isObject(value)) {
    issues.push({ path, message: 'tiene que ser un objeto con "name" y colores', severity: 'error' });
    return null;
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) {
    issues.push({ path: at('name'), message: 'el tema necesita un nombre', severity: 'error' });
    return null;
  }
  const color = (key: string, raw: unknown): string | null => {
    if (isColor(raw)) return raw.trim();
    issues.push({ path: at(key), message: 'tiene que ser un color #rrggbb', severity: 'error' });
    return null;
  };
  const terminal: Partial<TerminalColors> = {};
  const ui: Partial<UiColors> = {};
  if ('terminal' in value || 'ui' in value) {
    for (const [group, keys, target] of [
      ['terminal', TERMINAL_KEYS, terminal],
      ['ui', UI_KEYS, ui],
    ] as const) {
      const section = value[group];
      if (section === undefined) continue;
      if (!isObject(section)) {
        issues.push({ path: at(group), message: 'tiene que ser un objeto', severity: 'error' });
        continue;
      }
      for (const [key, raw] of Object.entries(section)) {
        if (!(keys as readonly string[]).includes(key)) {
          issues.push({ path: at(`${group}.${key}`), message: 'color desconocido: se ignora', severity: 'warning' });
          continue;
        }
        const c = color(`${group}.${key}`, raw);
        if (c) (target as Record<string, string>)[key] = c;
      }
    }
    for (const key of Object.keys(value)) {
      if (!['name', 'terminal', 'ui'].includes(key)) {
        issues.push({ path: at(key), message: 'clave desconocida: se ignora', severity: 'warning' });
      }
    }
  } else {
    for (const [key, raw] of Object.entries(value)) {
      if (key === 'name') continue;
      if (!FLAT_KEYS.has(key)) {
        issues.push({ path: at(key), message: 'clave desconocida: se ignora', severity: 'warning' });
        continue;
      }
      const c = color(key, raw);
      // selectionForeground: xterm uses the cell colors on top of the selection.
      if (c && key !== 'selectionForeground') terminal[WT_KEYS[key] ?? (key as TerminalColorKey)] = c;
    }
  }
  return { name, terminal, ui };
}

/** Theme spec back to our JSON format (what the settings file stores after an import). */
export function themeToJson(spec: ThemeSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { name: spec.name, terminal: { ...spec.terminal } };
  if (Object.keys(spec.ui).length) out.ui = { ...spec.ui };
  return out;
}

/** Schema node for the `themes` list in settings.json (both formats). */
export function themeSchema(): Schema<ThemeSpec | null> {
  const colors = (keys: readonly string[]): JsonSchema => ({
    type: 'object',
    properties: Object.fromEntries(keys.map((k) => [k, { type: 'string', pattern: HEX.source }])),
    additionalProperties: false,
  });
  return {
    default: null,
    parse: parseThemeSpec,
    json: () => ({
      description:
        'Un tema propio: {"name", "terminal": {colores}, "ui": {colores}} o un esquema de Windows Terminal ' +
        '(name, background, foreground, cursorColor, selectionBackground, black…brightWhite, purple).',
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        terminal: colors(TERMINAL_KEYS),
        ui: colors(UI_KEYS),
        ...Object.fromEntries([...FLAT_KEYS].map((k) => [k, { type: 'string', pattern: HEX.source }])),
      },
    }),
  };
}

/**
 * What the user pasted (or dropped) to import: one theme, a list, or a Windows Terminal
 * settings fragment with "schemes". Returns the themes, or the reason it is not one.
 */
export function themesFromImport(value: unknown): { themes: ThemeSpec[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const list = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value.schemes)
      ? value.schemes
      : isObject(value) && Array.isArray(value.themes)
        ? value.themes
        : [value];
  const themes: ThemeSpec[] = [];
  list.forEach((item, i) => {
    const spec = parseThemeSpec(item, list.length > 1 ? `[${i}]` : '', issues);
    if (spec && Object.keys(spec.terminal).length + Object.keys(spec.ui).length > 0) themes.push(spec);
    else if (spec) issues.push({ path: list.length > 1 ? `[${i}]` : '', message: 'no tiene colores', severity: 'error' });
  });
  return { themes, issues };
}
