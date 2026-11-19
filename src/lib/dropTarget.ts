// Dropping paths on a terminal: which pane is under the pointer, its highlight while dragging, and
// files dropped from Windows Explorer (Tauri's native drag & drop, which on Windows replaces the
// browser's HTML5 one: drags inside the page use pointer events instead).
import { useExplorer } from '../store/explorer';
import { insertPaths } from './explorerActions';
import { onFileDrop } from './fsApi';
import { getPane } from './terminalRegistry';

/** The visible pane at these page coordinates, if any. */
export function paneAt(x: number, y: number): string | null {
  const element = document.elementFromPoint(x, y);
  const pane = element instanceof Element ? element.closest<HTMLElement>('.terminal-pane[data-pane-id]') : null;
  return pane && !pane.hidden ? (pane.dataset.paneId ?? null) : null;
}

let highlighted: string | null = null;

/** Outlines the pane a drop would go to (null clears it). Imperative: the panes never re-render. */
export function markDropTarget(paneId: string | null): void {
  if (paneId === highlighted) return;
  if (highlighted) delete getPane(highlighted)?.host.dataset.dropTarget;
  highlighted = paneId;
  if (paneId) {
    const host = getPane(paneId)?.host;
    if (host) host.dataset.dropTarget = '';
  }
}

/** Paths dropped on the page: into the pane under the pointer, quoted for its shell. */
export function dropPaths(paths: string[], x: number, y: number): boolean {
  markDropTarget(null);
  const paneId = paneAt(x, y);
  if (!paneId) return false;
  const ok = insertPaths(paneId, paths);
  if (!ok) useExplorer.getState().setNotice({ message: 'Ese panel no tiene una shell en ejecución.', error: true });
  return ok;
}

/** Other drop zones (the theme import on the settings screen): `[data-file-drop]` elements. */
const zones = new Map<string, (paths: string[]) => void>();

/** Files dropped on the element with `data-file-drop="<name>"` go to `handler`. */
export function registerDropZone(name: string, handler: (paths: string[]) => void): () => void {
  zones.set(name, handler);
  return () => {
    if (zones.get(name) === handler) zones.delete(name);
  };
}

function zoneAt(x: number, y: number): HTMLElement | null {
  const element = document.elementFromPoint(x, y);
  return element instanceof Element ? element.closest<HTMLElement>('[data-file-drop]') : null;
}

let zoneHighlighted: HTMLElement | null = null;
function markZone(zone: HTMLElement | null): void {
  if (zone === zoneHighlighted) return;
  if (zoneHighlighted) delete zoneHighlighted.dataset.dropTarget;
  zoneHighlighted = zone;
  if (zone) zone.dataset.dropTarget = '';
}

/** Files dragged in from other apps. Returns the uninstaller. */
export function installFileDrop(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void onFileDrop((event) => {
    const zone = event.type === 'leave' ? null : zoneAt(event.x, event.y);
    markZone(event.type === 'over' ? zone : null);
    if (zone && event.type === 'drop') {
      zones.get(zone.dataset.fileDrop ?? '')?.(event.paths);
      return;
    }
    if (event.type === 'over') markDropTarget(zone ? null : paneAt(event.x, event.y));
    else if (event.type === 'leave') markDropTarget(null);
    else dropPaths(event.paths, event.x, event.y);
  })
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((error: unknown) => console.warn('[brisa] arrastrar archivos no disponible', error));
  return () => {
    disposed = true;
    unlisten?.();
    markDropTarget(null);
  };
}
