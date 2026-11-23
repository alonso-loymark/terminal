import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { loadDir, syncWatches } from '../lib/explorerData';
import { openFolder, openTabAt } from '../lib/explorerActions';
import { breadcrumbs, fitCrumbs, flattenTree, pathKey, visibleDirs, type Crumb, type FittedCrumbs } from '../lib/explorerModel';
import { flushExplorerPrefs } from '../lib/settingsSync';
import { focusActiveTerminal } from '../lib/tabActions';
import { SIDEBAR_DEFAULT, SIDEBAR_MIN, useExplorer } from '../store/explorer';
import { refreshGit } from '../store/git';
import { useSystem } from '../store/system';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import { spawnOf } from '../store/workspaceModel';
import { ChevronRight, Ellipsis, Eye, EyeOff, Pin, PinOff, X } from 'lucide-react';
import { useSettings } from '../store/settings';
import { FileTree } from './FileTree';

/** At most this share of the window, so the terminals keep room. */
const MAX_SHARE = 0.6;
/** Plain notices go away by themselves; errors stay until closed. */
const NOTICE_MS = 15_000;

/** The folder on display: pinned, else the active pane's cwd, else home. */
function useExplorerRoot(): string | null {
  const pinned = useExplorer((s) => s.pinned);
  const cwd = useWorkspace((s) => spawnOf(s, selectActivePaneId(s)).cwd);
  const home = useSystem((s) => s.homeDir);
  return pinned ?? cwd ?? home;
}

/** File explorer on the left (Ctrl+B). It follows the active pane's cwd unless pinned. */
export function Sidebar() {
  const visible = useExplorer((s) => s.visible);
  const width = useExplorer((s) => s.width);
  const root = useExplorerRoot();
  const listings = useExplorer((s) => s.listings);
  const expanded = useExplorer((s) => s.expanded);
  const showHidden = useExplorer((s) => s.showHidden);
  const editing = useExplorer((s) => s.editing);
  const creating = editing?.kind === 'create' ? { dir: editing.dir, kind: editing.entry } : null;

  const rows = useMemo(
    () => (root && visible ? flattenTree({ root, listings, expanded, showHidden, creating }) : []),
    // `creating` is derived from `editing`.
    [root, visible, listings, expanded, showHidden, editing],
  );
  const dirs = useMemo(() => (root && visible ? visibleDirs(root, rows) : []), [root, visible, rows]);
  const dirsKey = dirs.join('\n');

  // Read what is on screen, forget the rest, and watch exactly those folders.
  useEffect(() => {
    for (const dir of dirs) void loadDir(dir);
    useExplorer.getState().keepListings(new Set(dirs.map(pathKey)));
    syncWatches(root, dirs);
    // dirsKey stands for dirs (a new array on every render).
  }, [dirsKey]);

  useEffect(() => {
    if (visible && root) refreshGit(root);
  }, [visible, root]);
  const fileIcons = useSettings((st) => st.settings.explorer.fileIcons);

  if (!visible) return null;

  return (
    <aside className="sidebar" style={{ width }} aria-label="Explorador de archivos" data-root={root ?? undefined} data-file-icons={fileIcons}>
      <ExplorerHeader root={root} />
      {root ? <FileTree rows={rows} root={root} /> : <div className="tree-message">Sin carpeta</div>}
      <ExplorerNotice />
      <Resizer />
    </aside>
  );
}

/**
 * The path as breadcrumbs. When it does not fit, the first and the last always show and the
 * middle folders collapse into "…", which lists them (lib/explorerModel.ts → fitCrumbs).
 */
function Breadcrumbs({ root }: { root: string }) {
  const crumbs = useMemo(() => breadcrumbs(root), [root]);
  const nav = useRef<HTMLElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<FittedCrumbs>(() => ({ shown: crumbs.map((_, i) => i), hidden: [] }));

  // The widths come from an invisible copy of every crumb; the room, from the nav itself.
  useLayoutEffect(() => {
    const navEl = nav.current;
    const copy = measure.current;
    if (!navEl || !copy) return;
    const compute = () => {
      const widths = [...copy.querySelectorAll<HTMLElement>('[data-measure="crumb"]')].map((el) => el.getBoundingClientRect().width);
      const ellipsis = copy.querySelector<HTMLElement>('[data-measure="ellipsis"]')?.getBoundingClientRect().width ?? 24;
      const next = fitCrumbs(widths, navEl.clientWidth, ellipsis);
      setFit((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(navEl);
    return () => observer.disconnect();
  }, [crumbs]);

  // Pinned: browse the pinned folder. Following: like a click on a folder (cd, or navigate).
  const onCrumb = (path: string) => openFolder(path, true);
  const last = crumbs.length - 1;
  const hidden = fit.hidden.map((i) => crumbs[i]).filter((c): c is Crumb => !!c);

  return (
    <>
      <div ref={measure} className="breadcrumbs-measure" aria-hidden="true">
        {crumbs.map((crumb, i) => (
          <span key={crumb.path} className="crumb-wrap" data-measure="crumb">
            {i > 0 && <ChevronRight className="crumb-sep" aria-hidden="true" />}
            <span className="crumb" data-current={i === last || undefined}>
              {crumb.label}
            </span>
          </span>
        ))}
        <span className="crumb-wrap" data-measure="ellipsis">
          <ChevronRight className="crumb-sep" aria-hidden="true" />
          <span className="crumb crumb-more">
            <Ellipsis aria-hidden="true" />
          </span>
        </span>
      </div>
      <nav ref={nav} className="breadcrumbs" aria-label="Ruta actual" title={root}>
        {fit.shown.map((index, k) => {
          const crumb = crumbs[index];
          if (!crumb) return null;
          return (
            <Fragment key={crumb.path}>
              {k === 1 && hidden.length > 0 && (
                <span className="crumb-wrap">
                  <ChevronRight className="crumb-sep" aria-hidden="true" />
                  <button
                    type="button"
                    className="crumb crumb-more"
                    data-action="crumbs-more"
                    aria-haspopup="menu"
                    aria-label="Carpetas ocultas de la ruta"
                    title={hidden.map((c) => c.label).join(' › ')}
                    onClick={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      useUi.getState().openMenu({ kind: 'crumbs', crumbs: hidden, x: box.left, y: box.bottom });
                    }}
                  >
                    <Ellipsis aria-hidden="true" />
                  </button>
                </span>
              )}
              <span className="crumb-wrap" data-last={index === last || undefined}>
                {index > 0 && <ChevronRight className="crumb-sep" aria-hidden="true" />}
                <button type="button" className="crumb" data-path={crumb.path} data-current={index === last || undefined} title={crumb.path} onClick={() => onCrumb(crumb.path)}>
                  {crumb.label}
                </button>
              </span>
            </Fragment>
          );
        })}
      </nav>
    </>
  );
}

function ExplorerHeader({ root }: { root: string | null }) {
  const pinned = useExplorer((s) => s.pinned);
  const showHidden = useExplorer((s) => s.showHidden);

  return (
    <div className="explorer-header">
      {root ? <Breadcrumbs key={root} root={root} /> : <nav className="breadcrumbs" aria-label="Ruta actual" />}
      <button
        type="button"
        className="explorer-button"
        data-action="pin"
        aria-pressed={!!pinned}
        title={pinned ? 'Fijado: no sigue al panel activo. Clic para volver a seguirlo' : 'Fijar esta carpeta (dejar de seguir el cwd)'}
        onClick={() => {
          useExplorer.getState().setPinned(pinned ? null : root);
          focusActiveTerminal();
        }}
      >
        {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="explorer-button"
        data-action="toggle-hidden"
        aria-pressed={showHidden}
        title={showHidden ? 'Ocultar node_modules, .git, ignorados por .gitignore…' : 'Mostrar node_modules, .git, ignorados por .gitignore…'}
        onClick={() => {
          useExplorer.getState().toggleHidden();
          focusActiveTerminal();
        }}
      >
        {showHidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
      </button>
    </div>
  );
}

function ExplorerNotice() {
  const notice = useExplorer((s) => s.notice);

  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = window.setTimeout(() => {
      if (useExplorer.getState().notice === notice) useExplorer.getState().setNotice(null);
    }, NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;
  return (
    <div className="explorer-notice" role="status" data-error={notice.error || undefined}>
      <span className="explorer-notice-text">{notice.message}</span>
      {notice.openTabAt && (
        <button type="button" data-action="notice-open-tab" onClick={() => notice.openTabAt && openTabAt(notice.openTabAt)}>
          Abrir tab aquí
        </button>
      )}
      <button type="button" className="explorer-notice-close" aria-label="Cerrar aviso" onClick={() => useExplorer.getState().setNotice(null)}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

/** Drag to resize; double click for the default width. The terminals refit as it moves. */
function Resizer() {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = '';
    const startX = event.clientX;
    const startWidth = useExplorer.getState().width;
    const onMove = (move: PointerEvent) => {
      const max = Math.max(SIDEBAR_MIN, window.innerWidth * MAX_SHARE);
      useExplorer.getState().setWidth(Math.min(max, startWidth + move.clientX - startX));
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      delete handle.dataset.dragging;
      flushExplorerPrefs();
      focusActiveTerminal();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Ancho del explorador"
      title="Arrastrar para cambiar el ancho; doble clic para el ancho por defecto"
      className="sidebar-resizer"
      onPointerDown={onPointerDown}
      onDoubleClick={() => useExplorer.getState().setWidth(SIDEBAR_DEFAULT)}
    />
  );
}
