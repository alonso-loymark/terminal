// Applies the theme to the whole UI (CSS variables on <html>) and to the window (background
// color, Mica / Acrylic), and computes each terminal's options. Terminals with a profile theme
// get their own palette; the UI follows the global theme.
import type { ITerminalOptions } from '@xterm/xterm';
import { resolveTheme, withAlpha, type Theme } from '../config/themes';
import type { Settings } from '../config/settingsSchema';
import { profileFor } from '../store/profiles';
import { selectFontSize, useSettings } from '../store/settings';
import type { ProfileId } from '../store/workspaceModel';
import { setWindowLook } from './settingsApi';

/** Last applied UI colors, so the next start paints the right theme before settings load. */
const CACHE_KEY = 'terminal.themeCache';

/** Tab and group colors, readable on dark and on light themes. */
const TAB_PALETTES = {
  dark: { blue: '#58a6ff', red: '#ff7b72', yellow: '#d29922', green: '#3fb950', pink: '#f778ba', purple: '#bc8cff', cyan: '#39c5cf', orange: '#f0883e', grey: '#8b949e' },
  light: { blue: '#0969da', red: '#cf222e', yellow: '#bf8700', green: '#1a7f37', pink: '#bf3989', purple: '#8250df', cyan: '#1b7c83', orange: '#bc4c00', grey: '#6e7781' },
};

type State = ReturnType<typeof useSettings.getState>;

/** The window shows what is behind it: it was created transparent and the settings ask for it. */
export const isTranslucent = (s: Pick<State, 'settings' | 'windowTransparent'>) =>
  s.windowTransparent && (s.settings.appearance.opacity < 100 || s.settings.appearance.backdrop !== 'none');

export const globalTheme = (settings: Settings): Theme => resolveTheme(settings.theme, settings.themes);

function uiVariables(theme: Theme, settings: Settings, translucent: boolean): Record<string, string> {
  const { ui } = theme;
  const opacity = settings.appearance.opacity / 100;
  // With a backdrop the chrome lets it through even at full terminal opacity (like Windows
  // Terminal's Mica title bar); menus and dialogs stay opaque to remain readable.
  const chromeAlpha = settings.appearance.backdrop !== 'none' ? Math.min(opacity, 0.7) : opacity;
  const tabs = theme.dark ? TAB_PALETTES.dark : TAB_PALETTES.light;
  return {
    '--bg': translucent ? withAlpha(ui.background, opacity) : ui.background,
    '--chrome': translucent ? withAlpha(ui.chrome, chromeAlpha) : ui.chrome,
    '--panel': ui.panel,
    '--border': ui.border,
    '--text': ui.text,
    '--muted': ui.muted,
    '--accent': ui.accent,
    '--danger': ui.danger,
    '--warning': ui.warning,
    '--success': ui.success,
    // Text on a group chip (its background is the group color).
    '--chip-text': theme.dark ? ui.chrome : '#ffffff',
    '--terminal-padding': `${settings.appearance.padding}px`,
    ...Object.fromEntries(Object.entries(tabs).map(([name, color]) => [`--tab-${name}`, color])),
  };
}

function setVariables(variables: Record<string, string>, dark: boolean): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

/** Paints the last theme right away (main.tsx, before React): no dark flash on a light theme. */
export function applyCachedTheme(): void {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { variables: Record<string, string>; dark: boolean } | null;
    if (cached?.variables) setVariables(cached.variables, cached.dark);
  } catch {
    // No cache: the stylesheet's defaults (dark) until the settings load.
  }
}

let lastWindowLook = '';

function applyUi(): void {
  const s = useSettings.getState();
  const theme = globalTheme(s.settings);
  const translucent = isTranslucent(s);
  const variables = uiVariables(theme, s.settings, translucent);
  setVariables(variables, theme.dark);
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.toggleAttribute('data-translucent', translucent);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ variables, dark: theme.dark }));
  } catch {
    // Only a convenience for the next start.
  }
  const look = {
    backdrop: s.settings.appearance.backdrop,
    translucent: s.settings.appearance.opacity < 100,
    dark: theme.dark,
    background: theme.ui.background,
  };
  const key = JSON.stringify(look);
  if (key === lastWindowLook) return;
  lastWindowLook = key;
  setWindowLook(look)
    .then((result) => useSettings.setState({ restartRequired: result.restartRequired }))
    .catch((error: unknown) => console.warn('[terminal] no se pudo aplicar el efecto de la ventana', error));
}

/** Follows the settings; returns the uninstaller. */
export function installAppearance(): () => void {
  applyUi();
  return useSettings.subscribe((s, prev) => {
    if (
      s.settings.theme !== prev.settings.theme ||
      s.settings.themes !== prev.settings.themes ||
      s.settings.appearance !== prev.settings.appearance ||
      s.windowTransparent !== prev.windowTransparent
    ) {
      applyUi();
    }
  });
}

/** What a terminal looks like: its profile's theme (or the global one) and the appearance settings. */
export interface TerminalLook {
  options: ITerminalOptions;
  /** The pane's background (behind the padding); translucent when the window is. */
  background: string;
  ligatures: boolean;
}

export function terminalLook(profileId: ProfileId | null): TerminalLook {
  const s = useSettings.getState();
  const { appearance, terminal } = s.settings;
  const themeName = profileFor(profileId)?.theme ?? s.settings.theme;
  const theme = resolveTheme(themeName, s.settings.themes);
  const translucent = isTranslucent(s);
  return {
    options: {
      fontFamily: appearance.fontFamily,
      fontSize: selectFontSize(s),
      lineHeight: appearance.lineHeight,
      cursorStyle: appearance.cursorStyle,
      cursorBlink: appearance.cursorBlink,
      scrollback: terminal.scrollback,
      allowTransparency: translucent,
      // Translucent: the pane paints the background (with its opacity) and xterm none, or the
      // two would stack.
      theme: { ...theme.terminal, background: translucent ? '#00000000' : theme.terminal.background },
    },
    background: translucent ? withAlpha(theme.terminal.background, appearance.opacity / 100) : theme.terminal.background,
    ligatures: appearance.ligatures,
  };
}
