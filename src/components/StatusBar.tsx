import { useEffect, useRef, useState } from 'react';
import { folderName, shortenPath } from '../lib/paths';
import { refreshGit, selectGitFor, useGit } from '../store/git';
import { useProfile } from '../store/profiles';
import { useSettings } from '../store/settings';
import { useSystem } from '../store/system';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import type { Pane } from '../store/workspaceModel';

const MAX_COMMAND = 60;
/** Approximate width of a status bar character (11px UI font), to fit the path to the bar. */
const CHAR_PX = 6.5;
/** Share of the bar the folder may take; the rest is for the command status and the shell. */
const CWD_SHARE = 0.55;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Last command: running, or how it ended. Nothing before the first command. */
function CommandStatus({ pane }: { pane: Pane }) {
  const command = pane.lastCommand?.trim() ?? '';
  if (pane.commandRunning) {
    return (
      <span className="status-command" data-state="running" title={`En ejecución: ${command}`}>
        <span className="status-dot" />
        <span className="status-command-text">{clip(command || 'comando en ejecución', MAX_COMMAND)}</span>
      </span>
    );
  }
  if (pane.lastExitCode === null) return null;
  const ok = pane.lastExitCode === 0;
  return (
    <span
      className="status-command"
      data-state={ok ? 'ok' : 'error'}
      title={`Último comando: ${command}\nCódigo de salida: ${pane.lastExitCode}`}
    >
      {ok ? '✓' : `✗ ${pane.lastExitCode}`}
    </span>
  );
}

/** Discreet notice when the shell integration is not working (the terminal still is). */
function IntegrationNotice({ pane }: { pane: Pane }) {
  if (pane.status !== 'running' || (pane.integration !== 'error' && pane.integration !== 'unavailable')) return null;
  const reason =
    pane.integration === 'unavailable'
      ? 'No se encontró el script de integración de la shell.'
      : `No se pudo cargar la integración de la shell${pane.integrationError ? `: ${pane.integrationError}` : '.'}`;
  return (
    <span
      className="status-notice"
      data-integration={pane.integration}
      title={`${reason}\nLa terminal funciona igual, pero sin carpeta actual ni estado de los comandos.`}
    >
      ⚠ Sin integración de shell
    </span>
  );
}

/** settings.json has errors: the last valid settings stay in use. Click: the settings screen. */
function SettingsNotice() {
  const status = useSettings((s) => s.status);
  const issues = useSettings((s) => s.issues);
  if (status !== 'invalid') return null;
  const lines = issues
    .filter((issue) => issue.severity === 'error')
    .slice(0, 6)
    .map((issue) => `• ${issue.line ? `línea ${issue.line}: ` : ''}${issue.path ? `${issue.path}: ` : ''}${issue.message}`);
  return (
    <button
      type="button"
      className="status-notice status-settings"
      data-settings="invalid"
      title={`settings.json tiene errores: se sigue usando la última configuración válida.\n${lines.join('\n')}`}
      onClick={() => useUi.getState().openSettings()}
    >
      ⚠ settings.json
    </button>
  );
}

/** Branch of the repository the active pane is in (git runs in the background). */
function GitBranch({ cwd }: { cwd: string }) {
  const git = useGit(selectGitFor(cwd));
  useEffect(() => refreshGit(cwd), [cwd]);
  if (!git) return null;
  const name = git.branch ?? (git.commit ? `HEAD ${git.commit}` : 'sin commits');
  const sync = `${git.ahead ? ` ↑${git.ahead}` : ''}${git.behind ? ` ↓${git.behind}` : ''}`;
  const changes = git.changes.length;
  return (
    <span
      className="status-git"
      data-branch={git.branch ?? undefined}
      title={`Rama: ${name}${sync}
${changes ? `${changes} cambio${changes === 1 ? '' : 's'} sin confirmar` : 'Sin cambios'}
${git.root}`}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 3.3a1.8 1.8 0 1 0-1.5 1.8v5.8a1.8 1.8 0 1 0 1.5 0V9.4c.6.4 1.4.6 2.3.6h1.4a1.3 1.3 0 0 1 1.3 1.1 1.8 1.8 0 1 0 1.5-.1A2.8 2.8 0 0 0 8.7 8.5H7.3C6 8.5 5 7.7 5 6.6V5.1a1.8 1.8 0 0 0 0-1.8z" />
      </svg>
      {name}
      {sync}
      {changes > 0 && <span className="status-git-dirty">•</span>}
    </span>
  );
}

/** Below the panes: the active pane's folder (shortened; full path in the tooltip), last command and shell. */
export function StatusBar() {
  const pane = useWorkspace((s) => {
    const id = selectActivePaneId(s);
    return id ? s.panes[id] : undefined;
  });
  const home = useSystem((s) => s.homeDir);
  const profile = useProfile(pane?.profile);
  const shellName = pane ? (profile?.name ?? '') : '';
  // Long paths collapse only as much as the window needs.
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);
  const maxChars = width ? Math.max(24, Math.floor((width * CWD_SHARE) / CHAR_PX)) : 48;

  return (
    <footer ref={ref} className="status-bar" aria-label="Barra de estado" data-active-pane={pane?.id}>
      {pane?.cwd && (
        <span className="status-cwd" title={pane.cwd} data-cwd={pane.cwd}>
          {shortenPath(pane.cwd, home, maxChars) || folderName(pane.cwd)}
        </span>
      )}
      {pane?.cwd && <GitBranch cwd={pane.cwd} />}
      {pane && <CommandStatus pane={pane} />}
      <span className="status-spacer" />
      <SettingsNotice />
      {pane && <IntegrationNotice pane={pane} />}
      {shellName && <span className="status-shell">{shellName}</span>}
    </footer>
  );
}
