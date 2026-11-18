import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { dividerStyle, MIN_PANE_PX } from '../lib/paneGeometry';
import { focusActiveTerminal } from '../lib/tabActions';
import { useWorkspace } from '../store/workspace';
import type { Divider } from '../store/workspaceModel';

interface PaneDividerProps {
  divider: Divider;
  /** The pane area, to turn pointer pixels into split percentages. */
  area: RefObject<HTMLDivElement | null>;
}

/** Drag to resize the two panes around it; double click to give every child of the split the same space. */
export function PaneDivider({ divider, area }: PaneDividerProps) {
  const horizontal = divider.direction === 'horizontal';

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = area.current?.getBoundingClientRect();
    const first = divider.sizes[divider.index];
    const second = divider.sizes[divider.index + 1];
    if (event.button !== 0 || !box || first === undefined || second === undefined) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = '';

    const splitPx = horizontal ? divider.split.w * box.width : divider.split.h * box.height;
    const start = horizontal ? event.clientX : event.clientY;
    const pair = first + second;
    const min = Math.min((MIN_PANE_PX / Math.max(splitPx, 1)) * 100, pair / 2);

    const onMove = (move: PointerEvent) => {
      const delta = (((horizontal ? move.clientX : move.clientY) - start) / Math.max(splitPx, 1)) * 100;
      const size = Math.min(pair - min, Math.max(min, first + delta));
      const sizes = [...divider.sizes];
      sizes[divider.index] = size;
      sizes[divider.index + 1] = pair - size;
      // Panes follow the new sizes; their ResizeObservers refit and resize each PTY.
      useWorkspace.getState().setSplitSizes(divider.splitId, sizes);
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      delete handle.dataset.dragging;
      focusActiveTerminal();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  };

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-label="Redimensionar paneles"
      title="Arrastrar para redimensionar; doble clic para igualar"
      className="pane-divider"
      data-split-id={divider.splitId}
      data-index={divider.index}
      data-direction={divider.direction}
      style={dividerStyle(divider)}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        useWorkspace.getState().equalizeSplit(divider.splitId);
        focusActiveTerminal();
      }}
    />
  );
}
