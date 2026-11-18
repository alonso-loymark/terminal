// Turns the layout's fractional rectangles into CSS for panes and dividers.
import type { CSSProperties } from 'react';
import type { Divider, Rect } from '../store/workspaceModel';

/** Space between panes; the divider's grab area fills it. */
export const PANE_GAP = 6;
/** A divider drag never shrinks a pane below this. */
export const MIN_PANE_PX = 60;
const EPS = 1e-6;

const pct = (fraction: number) => `${(fraction * 100).toFixed(4)}%`;

/** Absolute position of a pane inside the pane area; inner edges leave half a gap each. */
export function paneStyle(rect: Rect): CSSProperties {
  const half = PANE_GAP / 2;
  const left = rect.x > EPS ? half : 0;
  const top = rect.y > EPS ? half : 0;
  const right = rect.x + rect.w < 1 - EPS ? half : 0;
  const bottom = rect.y + rect.h < 1 - EPS ? half : 0;
  return {
    left: `calc(${pct(rect.x)} + ${left}px)`,
    top: `calc(${pct(rect.y)} + ${top}px)`,
    width: `calc(${pct(rect.w)} - ${left + right}px)`,
    height: `calc(${pct(rect.h)} - ${top + bottom}px)`,
  };
}

/** The divider's grab area, centered on the boundary and as long as its split. */
export function dividerStyle(divider: Divider): CSSProperties {
  const { split, offset } = divider;
  const half = PANE_GAP / 2;
  return divider.direction === 'horizontal'
    ? { left: `calc(${pct(split.x + offset * split.w)} - ${half}px)`, top: pct(split.y), width: PANE_GAP, height: pct(split.h) }
    : { top: `calc(${pct(split.y + offset * split.h)} - ${half}px)`, left: pct(split.x), height: PANE_GAP, width: pct(split.w) };
}

export const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
