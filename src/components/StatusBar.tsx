import { ArrowDown, ArrowUp, Check, Dot, GitBranch as GitBranchIcon, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { folderName, shortenPath } from '../lib/paths';
import { refreshGit, selectGitFor, useGit } from '../store/git';
import { useProfile } from '../store/profiles';
import { useLayouts } from '../store/layouts';
import { useSettings } from '../store/settings';
import { useSystem } from '../store/system';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import type { Pane } from '../store/workspaceModel';

/** What the bar shows of the active pane: not its title or activity, which agents change all the time. */
type StatusPane = Pick<
  Pane,
  'id' | 'cwd' | 'profile' | 'status' | 'lastCommand' | 'lastExitCode' | 'commandRunning' | 'integration' | 'integrationError'
>;

const MAX_COMMAND = 60;
/** Approximate width of a status bar character (11px UI font), to fit the path to the bar. */
const CHAR_PX = 6.5;
/** Share of the bar the folder may take; the rest is for the command status and the shell. */
const CWD_SHARE = 0.55;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Last command: running, or how it ended. Nothing before the first command. */
function CommandStatus({ pane }: { pane: StatusPane }) {
  const command = pane.lastCommand?.trim() ?? '';
  if (pane.commandRunning) {
    return (
      <span className="status-command" data-state="running" title={`En ejecución: ${command}`}>
        <LoaderCircle className="status-spinner" aria-hidden="true" />
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
      {ok ? <Check aria-label="correcto" /> : <X aria-label="falló" />}
      {!ok && <span className="status-exit-code">{pane.lastExitCode}</span>}
    </span>
  );
}

/** Discreet notice when the shell integration is not working (the terminal still is). */
function IntegrationNotice({ pane }: { pane: StatusPane }) {
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
      <TriangleAlert aria-hidden="true" />
      Sin integración de shell
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
      <TriangleAlert aria-hidden="true" />
      settings.json
    </button>
  );
}

/** layouts.json has errors: broken JSON (the last good layouts stay) or layouts left out. */
function LayoutsNotice() {
  const status = useLayouts((s) => s.status);
  const issues = useLayouts((s) => s.issues);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (status !== 'invalid' && errors.length === 0) return null;
  const lines = errors
    .slice(0, 6)
    .map((issue) => `• ${issue.line ? `línea ${issue.line}: ` : ''}${issue.path ? `${issue.path}: ` : ''}${issue.message}`);
  const summary =
    status === 'invalid'
      ? 'layouts.json tiene errores: se siguen usando los layouts de antes.'
      : 'Hay layouts con errores en layouts.json: no se pueden abrir.';
  return (
    <button
      type="button"
      className="status-notice status-settings"
      data-layouts="invalid"
      title={`${summary}\n${lines.join('\n')}`}
      onClick={() => useUi.getState().openSettings('session')}
    >
      <TriangleAlert aria-hidden="true" />
      layouts.json
    </button>
  );
}

/** Branch of the repository the active pane is in (git runs in the background). */
function GitBranch({ cwd }: { cwd: string }) {
  const git = useGit(selectGitFor(cwd));
  useEffect(() => refreshGit(cwd), [cwd]);
  if (!git) return null;
  const name = git.branch ?? (git.commit ? `HEAD ${git.commit}` : 'sin commits');
  // For the tooltip; the bar shows arrows.
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
      <GitBranchIcon aria-hidden="true" />
      {name}
      {git.ahead > 0 && (
        <span className="status-git-sync">
          <ArrowUp aria-label="adelante" />
          {git.ahead}
        </span>
      )}
      {git.behind > 0 && (
        <span className="status-git-sync">
          <ArrowDown aria-label="atrás" />
          {git.behind}
        </span>
      )}
      {changes > 0 && <Dot className="status-git-dirty" aria-label="con cambios" />}
    </span>
  );
}

/** Below the panes: the active pane's folder (shortened; full path in the tooltip), last command and shell. */
export function StatusBar() {
  const pane = useWorkspace(
    useShallow((s): StatusPane | undefined => {
      const id = selectActivePaneId(s);
      const p = id ? s.panes[id] : undefined;
      if (!p) return undefined;
      const { cwd, profile, status, lastCommand, lastExitCode, commandRunning, integration, integrationError } = p;
      return { id: p.id, cwd, profile, status, lastCommand, lastExitCode, commandRunning, integration, integrationError };
    }),
  );
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
      <LayoutsNotice />
      {pane && <IntegrationNotice pane={pane} />}
      {shellName && <span className="status-shell">{shellName}</span>}
    </footer>
  );
}
