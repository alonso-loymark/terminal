// Pure logic of the file explorer: paths, quoting for each shell, the flattened (virtualized)
// tree and git decorations. No runtime imports: covered by node --test (explorerModel.test.ts).
import type { ShellKind } from '../store/workspaceModel';

export type EntryKind = 'dir' | 'file';
/** default: node_modules, .git, target...; ignored: .gitignore; system: hidden attribute. */
export type HiddenReason = 'default' | 'ignored' | 'system';

export interface DirEntry {
  name: string;
  path: string;
  kind: EntryKind;
  hidden: HiddenReason | null;
  link: boolean;
}

export interface Listing {
  path: string;
  status: 'loading' | 'ok' | 'error';
  entries: DirEntry[];
  error: string | null;
}

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface GitStatus {
  root: string;
  branch: string | null;
  commit: string | null;
  ahead: number;
  behind: number;
  changes: { path: string; status: GitFileStatus }[];
}

// ---------------------------------------------------------------- paths

/** Backslashes, no trailing separator except for a drive root (C:\). */
export function normalizePath(path: string): string {
  const p = path.replace(/\//g, '\\');
  if (/^[A-Za-z]:\\?$/.test(p)) return `${p.slice(0, 2).toUpperCase()}\\`;
  return p.replace(/\\+$/, '');
}

/** Case-insensitive identity of a path (Windows). */
export const pathKey = (path: string): string => normalizePath(path).toLowerCase();

export function joinPath(dir: string, name: string): string {
  const base = normalizePath(dir);
  return base.endsWith('\\') ? `${base}${name}` : `${base}\\${name}`;
}

export function parentDir(path: string): string | null {
  const p = normalizePath(path);
  if (/^[A-Za-z]:\\$/.test(p)) return null;
  const unc = /^\\\\[^\\]+\\[^\\]+$/.exec(p);
  if (unc) return null;
  const at = p.lastIndexOf('\\');
  if (at < 0) return null;
  const parent = p.slice(0, at);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

export function baseName(path: string): string {
  const p = normalizePath(path);
  if (/^[A-Za-z]:\\$/.test(p)) return p.slice(0, 2);
  return p.slice(p.lastIndexOf('\\') + 1);
}

/** `path` is `dir` or lies somewhere inside it. */
export function isInside(path: string, dir: string): boolean {
  const p = pathKey(path);
  const d = pathKey(dir);
  return p === d || p.startsWith(d.endsWith('\\') ? d : `${d}\\`);
}

/** Path of `target` relative to `base` (".\" style without the dot); "." for the same folder. */
export function relativePath(base: string, target: string): string {
  const b = normalizePath(base).split('\\').filter(Boolean);
  const t = normalizePath(target).split('\\').filter(Boolean);
  if (!b[0] || !t[0] || b[0].toLowerCase() !== t[0].toLowerCase()) return normalizePath(target);
  let same = 0;
  while (same < b.length && same < t.length && b[same]!.toLowerCase() === t[same]!.toLowerCase()) same++;
  const parts = [...Array<string>(b.length - same).fill('..'), ...t.slice(same)];
  return parts.length ? parts.join('\\') : '.';
}

export interface Crumb {
  label: string;
  path: string;
}

/** C:\Users\Ana → C: › Users › Ana, each with the path it stands for. */
export function breadcrumbs(path: string): Crumb[] {
  const p = normalizePath(path);
  const unc = /^(\\\\[^\\]+\\[^\\]+)(.*)$/.exec(p);
  const drive = /^[A-Za-z]:/.exec(p);
  const rootPath = unc ? unc[1]! : drive ? `${drive[0]}\\` : '';
  if (!rootPath) return [{ label: p, path: p }];
  const crumbs: Crumb[] = [{ label: unc ? rootPath : rootPath.slice(0, 2), path: rootPath }];
  let current = rootPath;
  for (const part of (unc ? unc[2]! : p.slice(3)).split('\\').filter(Boolean)) {
    current = joinPath(current, part);
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

// ---------------------------------------------------------------- shells

/** C:\Users\Ana → /c/Users/Ana (Git Bash / MSYS); UNC \\srv\share → //srv/share. */
export function toMsysPath(path: string): string {
  const p = normalizePath(path);
  const drive = /^([A-Za-z]):\\?(.*)$/.exec(p);
  if (drive) return `/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`.replace(/\/$/, '') || '/';
  return p.replace(/\\/g, '/');
}

/**
 * C:\x \u2192 /mnt/c/x and \\wsl.localhost\<distro>\home\ana (or \\wsl$\...) \u2192 /home/ana, for typing
 * a path into a WSL shell (assumes WSL's default /mnt automount root).
 */
export function toWslPath(path: string): string {
  const p = normalizePath(path);
  const distro = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)?$/i.exec(p);
  if (distro) return (distro[1] ?? '\\').replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\\?(.*)$/.exec(p);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`.replace(/\/$/, '');
  return p.replace(/\\/g, '/');
}

const posixQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/**
 * A path as one argument for the shell, always quoted: PowerShell single quotes (doubling '
 * and its typographic variants, which PowerShell also treats as quotes); Git Bash and WSL
 * single quotes around the MSYS / Linux path ('\'' for a quote); cmd and anything else double
 * quotes (Windows paths cannot contain them).
 */
export function quotePath(path: string, shell: ShellKind | null): string {
  if (shell === 'gitbash') return posixQuote(toMsysPath(path));
  if (shell === 'wsl') return posixQuote(toWslPath(path));
  if (shell === 'cmd' || shell === 'other') return `"${normalizePath(path)}"`;
  return `'${normalizePath(path).replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}'`;
}

/** The line that moves the shell to `dir` (Enter not included). */
export function cdCommand(dir: string, shell: ShellKind | null): string {
  switch (shell) {
    case 'gitbash':
      return `cd -- ${quotePath(dir, shell)}`;
    // wslpath knows the distro's real mount points (and \\wsl.localhost paths).
    case 'wsl':
      return `cd -- "$(wslpath -u ${posixQuote(normalizePath(dir))})"`;
    case 'cmd':
      return `cd /d ${quotePath(dir, shell)}`;
    default:
      return `Set-Location -LiteralPath ${quotePath(dir, shell)}`;
  }
}

// ---------------------------------------------------------------- tree

export type TreeRow =
  | {
      type: 'entry';
      key: string;
      path: string;
      name: string;
      kind: EntryKind;
      depth: number;
      expanded: boolean;
      /** Own reason, or inherited from a hidden folder above (shown only with "ver ocultos"). */
      hidden: HiddenReason | null;
      link: boolean;
    }
  | { type: 'message'; key: string; depth: number; text: string; error: boolean }
  | { type: 'new'; key: string; depth: number; dir: string; kind: EntryKind };

export interface TreeInput {
  root: string;
  listings: Record<string, Listing>;
  expanded: Record<string, true>;
  showHidden: boolean;
  /** A "new file/folder" input row inside this folder. */
  creating?: { dir: string; kind: EntryKind } | null;
}

/** Visible rows, in order: the root's entries and, recursively, those of expanded folders. */
export function flattenTree({ root, listings, expanded, showHidden, creating }: TreeInput): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number, inherited: HiddenReason | null) => {
    const dirKey = pathKey(dir);
    if (creating && pathKey(creating.dir) === dirKey) {
      rows.push({ type: 'new', key: `new:${dirKey}`, depth, dir, kind: creating.kind });
    }
    const listing = listings[dirKey];
    if (!listing || listing.status === 'loading') {
      rows.push({ type: 'message', key: `msg:${dirKey}`, depth, text: 'Cargando…', error: false });
      return;
    }
    if (listing.status === 'error') {
      rows.push({ type: 'message', key: `msg:${dirKey}`, depth, text: listing.error ?? 'No se pudo leer', error: true });
      return;
    }
    let shown = 0;
    for (const entry of listing.entries) {
      const hidden = entry.hidden ?? inherited;
      if (hidden && !showHidden) continue;
      shown++;
      const key = pathKey(entry.path);
      const isOpen = entry.kind === 'dir' && !!expanded[key];
      rows.push({ type: 'entry', key, path: entry.path, name: entry.name, kind: entry.kind, depth, expanded: isOpen, hidden, link: entry.link });
      if (isOpen) walk(entry.path, depth + 1, hidden);
    }
    if (shown === 0 && !(creating && pathKey(creating.dir) === dirKey)) {
      const text = listing.entries.length ? 'Solo elementos ocultos' : 'Carpeta vacía';
      rows.push({ type: 'message', key: `msg:${dirKey}`, depth, text, error: false });
    }
  };
  walk(root, 0, null);
  return rows;
}

/** Folders on screen (the root and every expanded folder whose rows are visible): what to watch. */
export function visibleDirs(root: string, rows: TreeRow[]): string[] {
  const dirs = [normalizePath(root)];
  for (const row of rows) if (row.type === 'entry' && row.expanded) dirs.push(normalizePath(row.path));
  return dirs;
}

// ---------------------------------------------------------------- git

export interface GitDecorations {
  /** pathKey → status, for changed files and (aggregated) the folders that contain them. */
  byPath: Map<string, GitFileStatus>;
  /** Untracked folders: everything inside is untracked. */
  untrackedDirs: string[];
}

const RANK: Record<GitFileStatus, number> = { conflict: 4, modified: 3, deleted: 3, renamed: 3, added: 2, untracked: 1 };
/** What a folder shows for a change inside it. */
const FOLDER_STATUS: Record<GitFileStatus, GitFileStatus> = {
  conflict: 'conflict',
  modified: 'modified',
  deleted: 'modified',
  renamed: 'modified',
  added: 'added',
  untracked: 'untracked',
};

export function gitDecorations(status: GitStatus): GitDecorations {
  const byPath = new Map<string, GitFileStatus>();
  const untrackedDirs: string[] = [];
  const rootKey = pathKey(status.root);
  const bump = (key: string, value: GitFileStatus) => {
    const current = byPath.get(key);
    if (!current || RANK[value] > RANK[current]) byPath.set(key, value);
  };
  for (const change of status.changes) {
    const isDir = change.path.endsWith('/');
    const abs = pathKey(joinPath(status.root, change.path.replace(/\/$/, '')));
    if (isDir && change.status === 'untracked') untrackedDirs.push(abs);
    bump(abs, change.status);
    // Every folder up to the root shows that something inside changed.
    let dir = parentDir(abs);
    while (dir && dir.length >= rootKey.length && isInside(dir, rootKey)) {
      bump(dir, FOLDER_STATUS[change.status]);
      if (dir === rootKey) break;
      dir = parentDir(dir);
    }
  }
  return { byPath, untrackedDirs };
}

export function gitStatusOf(path: string, decorations: GitDecorations | null): GitFileStatus | null {
  if (!decorations) return null;
  const key = pathKey(path);
  const own = decorations.byPath.get(key);
  if (own) return own;
  return decorations.untrackedDirs.some((dir) => key.startsWith(`${dir}\\`)) ? 'untracked' : null;
}
