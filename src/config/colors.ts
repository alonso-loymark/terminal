import type { TabColor } from '../store/workspaceModel';

/** Colors for tabs and groups: CSS variables set by the theme (lib/appearance.ts), readable on it. */
export const TAB_COLORS: Record<TabColor, string> = {
  blue: 'var(--tab-blue)',
  red: 'var(--tab-red)',
  yellow: 'var(--tab-yellow)',
  green: 'var(--tab-green)',
  pink: 'var(--tab-pink)',
  purple: 'var(--tab-purple)',
  cyan: 'var(--tab-cyan)',
  orange: 'var(--tab-orange)',
  grey: 'var(--tab-grey)',
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
