// What the explorer does to terminals and files. Typing into a terminal is guarded: only an idle
// shell (OSC 133) with an empty prompt gets a `cd`; otherwise nothing is typed.
import { useExplorer } from '../store/explorer';
import { useOrchestrator } from '../store/orchestrator';
import { useSettings } from '../store/settings';
import { useSystem } from '../store/system';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import { spawnOf, type PaneId } from '../store/workspaceModel';
import { copyText } from './clipboard';
import { loadDir } from './explorerData';
import { baseName, cdCommand, isInside, normalizePath, parentDir, pathKey, quotePath, relativePath } from './explorerModel';
import { createEntry, listDir, openInFileManager, openInVscode, renameEntry, trashEntries } from './fsApi';
import { focusActiveTerminal } from './tabActions';
import { getPane } from './terminalRegistry';

const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Folder the explorer shows: the pinned one, else the active pane's cwd, else home. */
export function currentExplorerRoot(): string | null {
  const ws = useWorkspace.getState();
  return useExplorer.getState().pinned ?? spawnOf(ws, selectActivePaneId(ws)).cwd ?? useSystem.getState().homeDir;
}

const notify = (message: string, openTabAt?: string, error = false) =>
  useExplorer.getState().setNotice({ message, openTabAt, error });

/**
 * `cd` in the active pane, only if its shell says it is idle (no command running, per OSC 133)
 * and nothing is typed at the prompt. Otherwise nothing is typed and a notice offers a new tab.
 */
export function cdInActivePane(dir: string): boolean {
  const ws = useWorkspace.getState();
  const paneId = selectActivePaneId(ws);
  const pane = paneId ? ws.panes[paneId] : undefined;
  const handle = getPane(paneId);
  if (!pane || !handle || pane.status !== 'running') {
    notify('El panel activo no tiene una shell en ejecución.', dir);
    return false;
  }
  if (pane.integration !== 'ok') {
    const why =
      pane.integration === 'cwd'
        ? 'cmd informa su carpeta pero no si está ejecutando algo'
        : pane.integration === 'none'
          ? 'este perfil corre sin integración de shell'
          : 'sin integración de shell';
    notify(`La shell del panel activo no informa si está libre (${why}): no se escribe nada.`, dir);
    return false;
  }
  if (pane.commandRunning) {
    notify(`El panel activo está ejecutando «${clip(pane.lastCommand?.trim() || 'un comando')}»: no se escribe nada.`, dir);
    return false;
  }
  const typed = handle.integration.promptInput();
  if (typed === null || typed.trim() !== '') {
    notify(typed === null ? 'No se pudo confirmar que el prompt esté libre.' : 'Hay texto escrito en el prompt del panel activo: no se reemplaza.', dir);
    return false;
  }
  handle.session.sendText(`${cdCommand(dir, pane.shell)}\r`);
  useExplorer.getState().setNotice(null);
  focusActiveTerminal();
  return true;
}

/**
 * A click on a folder, as the settings say: `cd` in the active pane, or just show that folder in
 * the explorer (pinned, so it stays there). A breadcrumb of a pinned explorer always navigates.
 */
export function openFolder(dir: string, breadcrumb = false): void {
  const navigate = useSettings.getState().settings.explorer.folderClick === 'navigate';
  if (navigate || (breadcrumb && useExplorer.getState().pinned)) {
    useExplorer.getState().setPinned(dir);
    useExplorer.getState().setNotice(null);
    return;
  }
  cdInActivePane(dir);
}

/**
 * Shows a file in the explorer (a path clicked in an answer of the orchestrator): the sidebar on
 * the files, the folders down to it expanded, the row selected and scrolled into view. Outside
 * the explorer's folder, the explorer is pinned to the file's folder.
 */
export async function revealInExplorer(path: string): Promise<void> {
  const target = normalizePath(path);
  const parent = parentDir(target);
  const name = baseName(target).toLowerCase();
  const entry = parent ? await listDir(parent).then((entries) => entries.find((e) => e.name.toLowerCase() === name), () => undefined) : undefined;
  if (!parent || !entry) {
    useUi.getState().showToast(`No se encontró ${clip(path, 80)}.`, 'warning');
    return;
  }
  const explorer = useExplorer.getState();
  if (!explorer.visible) explorer.toggleVisible();
  if (useOrchestrator.getState().sidebarView !== 'files') useOrchestrator.setState({ sidebarView: 'files' });
  let root = currentExplorerRoot();
  if (!root || !isInside(target, root) || pathKey(target) === pathKey(root)) {
    explorer.setPinned(parent);
    root = parent;
  }
  // Every folder between the root and the file, open.
  for (let dir: string | null = parent; dir && isInside(dir, root) && pathKey(dir) !== pathKey(root); dir = parentDir(dir)) explorer.setExpanded(dir, true);
  if (entry.kind === 'dir') explorer.setExpanded(entry.path, true);
  explorer.select(entry.path);
  explorer.setRevealing(entry.path);
  if (entry.hidden && !explorer.showHidden) notify(`${entry.name} está oculto en el explorador: activá "ver ocultos" para verlo.`);
}

/**
 * Types paths at the cursor of a pane, quoted for its shell, without running anything (a
 * paste: bracketed when the program asked for it, so agents take it as a paste too).
 */
export function insertPaths(paneId: PaneId, paths: string[]): boolean {
  const ws = useWorkspace.getState();
  const pane = ws.panes[paneId];
  const handle = getPane(paneId);
  if (!pane || !handle || pane.status !== 'running' || paths.length === 0) return false;
  ws.focusPane(paneId);
  handle.term.paste(`${paths.map((path) => quotePath(path, pane.shell)).join(' ')} `);
  handle.term.focus();
  return true;
}

export function insertInActivePane(paths: string[]): boolean {
  const paneId = selectActivePaneId(useWorkspace.getState());
  return paneId ? insertPaths(paneId, paths) : false;
}

/** The folder itself, or the one a file is in. */
const folderOf = (path: string, isDir: boolean) => (isDir ? path : (parentDir(path) ?? path));

export function openTabAt(path: string, isDir = true): void {
  useWorkspace.getState().newTab({ cwd: folderOf(path, isDir) });
  useExplorer.getState().setNotice(null);
  focusActiveTerminal();
}

export function splitAt(path: string, isDir = true): void {
  useWorkspace.getState().splitPane('horizontal', undefined, { cwd: folderOf(path, isDir) });
  focusActiveTerminal();
}

export async function copyPath(path: string, relative = false): Promise<void> {
  const root = currentExplorerRoot();
  const text = relative && root ? relativePath(root, path) : path;
  if (!(await copyText(text))) notify('No se pudo copiar al portapapeles.', undefined, true);
}

const report = (what: string) => (error: unknown) => notify(`${what}: ${String(error)}`, undefined, true);

export function openInEditor(path: string): void {
  openInVscode(path).catch(report('No se pudo abrir VS Code'));
}

export function openInWindowsExplorer(path: string): void {
  openInFileManager(path).catch(report('No se pudo abrir el Explorador'));
}

export function startCreate(dir: string, entry: 'file' | 'dir'): void {
  const explorer = useExplorer.getState();
  explorer.setExpanded(dir, true);
  void loadDir(dir);
  explorer.setEditing({ kind: 'create', dir, entry });
}

export async function commitCreate(dir: string, name: string, entry: 'file' | 'dir'): Promise<void> {
  const explorer = useExplorer.getState();
  try {
    const path = await createEntry(dir, name.trim(), entry);
    explorer.setEditing(null);
    await loadDir(dir, true);
    explorer.select(path);
  } catch (error) {
    report(entry === 'dir' ? 'No se pudo crear la carpeta' : 'No se pudo crear el archivo')(error);
  }
}

export async function commitRename(path: string, name: string): Promise<void> {
  const explorer = useExplorer.getState();
  try {
    const renamed = await renameEntry(path, name.trim());
    explorer.setEditing(null);
    const parent = parentDir(path);
    if (parent) await loadDir(parent, true);
    explorer.select(renamed);
  } catch (error) {
    report('No se pudo renombrar')(error);
  }
}

/** Asks first (the confirmation dialog, Cancel focused). */
export function requestTrash(path: string): void {
  useUi.getState().openConfirm({
    title: '¿Mover a la papelera?',
    message: 'Se puede recuperar desde la Papelera de reciclaje.',
    details: [path],
    confirmLabel: 'Mover a la papelera',
    target: { kind: 'trash', paths: [path] },
  });
}

export async function trashNow(paths: string[]): Promise<void> {
  try {
    await trashEntries(paths);
  } catch (error) {
    report('No se pudo mover a la papelera')(error);
  }
  const parents = new Set(paths.map((path) => parentDir(path)).filter((p): p is string => !!p));
  for (const parent of parents) void loadDir(parent, true);
}
