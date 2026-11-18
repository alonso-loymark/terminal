// Windows path helpers for the UI. Pure (no runtime imports): covered by node --test.

/** Last segment of a path: C:\Users\Ana → "Ana"; C:\ → "C:"; \\server\share → "share". */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed.toUpperCase();
  const at = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

const sameStart = (path: string, prefix: string) =>
  path.length >= prefix.length &&
  path.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase() &&
  (path.length === prefix.length || path[prefix.length] === '\\');

/**
 * Shortens a directory for the status bar: the home folder becomes "~", then middle
 * segments collapse into "…" until it fits `max` characters, always keeping the root and the
 * last segment. C:\Users\ana\Proyectos\cliente\app\src → ~\…\app\src
 */
export function shortenPath(path: string, home: string | null, max = 48): string {
  let shown = path;
  if (home && sameStart(path, home.replace(/\\+$/, ''))) {
    shown = `~${path.slice(home.replace(/\\+$/, '').length)}`;
  }
  if (shown.length <= max) return shown;
  // Root: "~", "C:" or "\\server\share".
  const unc = /^(\\\\[^\\]+\\[^\\]+)(.*)$/.exec(shown);
  const root = unc ? unc[1]! : shown.split('\\')[0]!;
  const rest = (unc ? unc[2]! : shown.slice(root.length)).split('\\').filter(Boolean);
  const kept: string[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const candidate = [root, '…', rest[i]!, ...kept].join('\\');
    if (kept.length > 0 && candidate.length > max) break;
    kept.unshift(rest[i]!);
  }
  return kept.length === rest.length ? shown : [root, '…', ...kept].join('\\');
}
