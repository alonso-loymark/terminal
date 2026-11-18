import { useEffect, useRef, useState } from 'react';
import { folderName, shortenPath } from '../lib/paths';
import { useSystem } from '../store/system';
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

/** Below the panes: the active pane's folder (shortened; full path in the tooltip), last command and shell. */
export function StatusBar() {
  const pane = useWorkspace((s) => {
    const id = selectActivePaneId(s);
    return id ? s.panes[id] : undefined;
  });
  const home = useSystem((s) => s.homeDir);
  const shells = useSystem((s) => s.shells);
  const shellName = shells.find((profile) => profile.kind === pane?.shell)?.name ?? '';
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
      {pane && <CommandStatus pane={pane} />}
      <span className="status-spacer" />
      {pane && <IntegrationNotice pane={pane} />}
      {shellName && <span className="status-shell">{shellName}</span>}
    </footer>
  );
}
