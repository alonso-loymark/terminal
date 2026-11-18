import type { TabColor } from '../store/workspaceModel';

/** Colors for tabs and groups (readable on the dark theme). */
export const TAB_COLORS: Record<TabColor, string> = {
  blue: '#58a6ff',
  red: '#ff7b72',
  yellow: '#d29922',
  green: '#3fb950',
  pink: '#f778ba',
  purple: '#bc8cff',
  cyan: '#39c5cf',
  orange: '#f0883e',
  grey: '#8b949e',
};

export const COLOR_NAMES: Record<TabColor, string> = {
  blue: 'Azul',
  red: 'Rojo',
  yellow: 'Amarillo',
  green: 'Verde',
  pink: 'Rosa',
  purple: 'Violeta',
  cyan: 'Cian',
  orange: 'Naranja',
  grey: 'Gris',
};
