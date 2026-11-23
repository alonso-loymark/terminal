import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { dropPaths, markDropTarget, paneAt } from '../lib/dropTarget';
import { loadDir } from '../lib/explorerData';
import {
  commitCreate,
  commitRename,
  insertInActivePane,
  openFolder,
  requestTrash,
} from '../lib/explorerActions';
import { gitDecorations, gitStatusOf, type GitDecorations, type TreeRow } from '../lib/explorerModel';
import { useExplorer } from '../store/explorer';
import { eventMatches } from '../store/keymap';
import { selectGitFor, useGit } from '../store/git';
import { useUi } from '../store/ui';
import { ChevronRight } from 'lucide-react';
import { FileIcon } from './FileIcon';
import { RenameInput } from './RenameInput';

export const ROW_HEIGHT = 22;
const OVERSCAN = 10;
const INDENT = 14;
/** Pointer travel that turns a press into a drag (like dnd-kit's 6 px for tabs). */
const DRAG_DISTANCE = 6;

interface DragGhost {
  label: string;
  x: number;
  y: number;
}

/**
 * The folder tree, virtualized: only the rows in view (plus a margin) are in the DOM, so a
 * folder with thousands of files costs the same as one with twenty.
 */
export function FileTree({ rows, root }: { rows: TreeRow[]; root: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const selected = useExplorer((s) => s.selected);
  const editing = useExplorer((s) => s.editing);
  const git = useGit(selectGitFor(root));
  const decorations = useMemo(() => (git ? gitDecorations(git) : null), [git]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setView({ top: element.scrollTop, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || !selected) return;
    const row = rows.find((r) => r.type === 'entry' && r.key === selected);
    if (!row || row.type !== 'entry') return;
    // F2 and Supr by default (settings.json: explorer.rename, explorer.delete).
    if (eventMatches(event, 'explorer.rename')) {
      event.preventDefault();
      useExplorer.getState().setEditing({ kind: 'rename', path: row.path });
    } else if (eventMatches(event, 'explorer.delete')) {
      event.preventDefault();
      requestTrash(row.path);
    }
  };

  return (
    <div
      ref={ref}
      className="file-tree"
      role="tree"
      aria-label="Archivos"
      tabIndex={-1}
      data-row-count={rows.length}
      onScroll={(event) => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        // The empty area stands for the root folder.
        if (event.defaultPrevented) return;
        event.preventDefault();
        useUi.getState().openMenu({ kind: 'explorer', path: root, isDir: true, isRoot: true, x: event.clientX, y: event.clientY });
      }}
    >
      <div className="file-tree-canvas" style={{ height: rows.length * ROW_HEIGHT }}>
        {rows.slice(first, last).map((row, i) => (
          <Row
            key={row.key}
            row={row}
            top={(first + i) * ROW_HEIGHT}
            selected={row.key === selected}
            renaming={row.type === 'entry' && editing?.kind === 'rename' && editing.path === row.path}
            decorations={decorations}
            onDrag={setGhost}
          />
        ))}
      </div>
      {ghost && (
        <div className="drag-ghost" style={{ left: ghost.x + 14, top: ghost.y + 10 }}>
          {ghost.label}
        </div>
      )}
    </div>
  );
}

interface RowProps {
  row: TreeRow;
  top: number;
  selected: boolean;
  renaming: boolean;
  decorations: GitDecorations | null;
  onDrag: (ghost: DragGhost | null) => void;
}

const Row = memo(function Row({ row, top, selected, renaming, decorations, onDrag }: RowProps) {
  const indent = 6 + row.depth * INDENT;
  if (row.type === 'message') {
    return (
      <div className="tree-message" data-error={row.error || undefined} style={{ top, paddingLeft: indent + 18 }}>
        {row.text}
      </div>
    );
  }
  if (row.type === 'new') {
    const cancel = () => useExplorer.getState().setEditing(null);
    return (
      <div className="tree-row" data-editing="" style={{ top, paddingLeft: indent + 18 }}>
        <FileIcon name="" dir={row.kind === 'dir'} />
        <RenameInput
          initial=""
          label={row.kind === 'dir' ? 'Nombre de la carpeta nueva' : 'Nombre del archivo nuevo'}
          onCommit={(value) => (value.trim() ? void commitCreate(row.dir, value, row.kind) : cancel())}
          onCancel={cancel}
        />
      </div>
    );
  }

  const isDir = row.kind === 'dir';
  const git = gitStatusOf(row.path, decorations);

  const toggle = () => {
    const open = !row.expanded;
    useExplorer.getState().setExpanded(row.path, open);
    if (open) void loadDir(row.path);
  };

  /**
   * Click: a folder moves the active shell there if it is idle (or, per the settings, only the
   * explorer); a file is typed at the active prompt.
   */
  const activate = () => {
    useExplorer.getState().select(row.path);
    if (isDir) openFolder(row.path);
    else insertInActivePane([row.path]);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || renaming) return;
    event.preventDefault();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    const onMove = (move: PointerEvent) => {
      if (!dragging && Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_DISTANCE) return;
      dragging = true;
      onDrag({ label: row.name, x: move.clientX, y: move.clientY });
      markDropTarget(paneAt(move.clientX, move.clientY));
    };
    const onUp = (up: PointerEvent) => {
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
      onDrag(null);
      if (dragging) {
        // Dropped on a terminal: its path, quoted, in THAT pane.
        useExplorer.getState().select(row.path);
        dropPaths([row.path], up.clientX, up.clientY);
      } else {
        activate();
      }
    };
    const onCancel = () => {
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
      onDrag(null);
      markDropTarget(null);
    };
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onCancel);
  };

  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={isDir ? row.expanded : undefined}
      aria-selected={selected}
      className="tree-row"
      title={row.path}
      data-path={row.path}
      data-kind={row.kind}
      data-git={git ?? undefined}
      data-hidden={row.hidden ?? undefined}
      data-selected={selected || undefined}
      style={{ top, paddingLeft: indent }}
      onPointerDown={onPointerDown}
      onContextMenu={(event) => {
        event.preventDefault();
        useExplorer.getState().select(row.path);
        useUi.getState().openMenu({ kind: 'explorer', path: row.path, isDir, isRoot: false, x: event.clientX, y: event.clientY });
      }}
    >
      {isDir ? (
        <span
          className="tree-twisty"
          data-open={row.expanded || undefined}
          role="button"
          aria-label={row.expanded ? 'Colapsar' : 'Expandir'}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          <ChevronRight aria-hidden="true" />
        </span>
      ) : (
        <span className="tree-twisty-space" />
      )}
      <FileIcon name={row.name} dir={isDir} open={row.expanded} link={row.link} />
      {renaming ? (
        <RenameInput
          initial={row.name}
          label="Nuevo nombre"
          onCommit={(value) =>
            value.trim() && value.trim() !== row.name ? void commitRename(row.path, value) : useExplorer.getState().setEditing(null)
          }
          onCancel={() => useExplorer.getState().setEditing(null)}
        />
      ) : (
        <span className="tree-name">{row.name}</span>
      )}
    </div>
  );
});
