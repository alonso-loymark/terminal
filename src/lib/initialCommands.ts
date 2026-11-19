// Commands a layout types in its panes when it opens. Only once the shell is ready according to
// its integration: the prompt is drawn (OSC 133;B), no command is running and nothing is typed.
// Never before, and never in a shell that does not report its prompt (cmd, a custom program, an
// integration that did not load): the command is dropped and the user is told why.
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { tabOfPane, tabTitle, type IntegrationState, type PaneId } from '../store/workspaceModel';
import { getPane } from './terminalRegistry';

/** A shell that takes longer than this to show its first prompt (a hung profile) gets nothing. */
const READY_TIMEOUT_MS = 30_000;

interface Pending {
  command: string;
  timer: number;
  unsubscribe: () => void;
}

const pending = new Map<PaneId, Pending>();

const WHY_NOT: Partial<Record<IntegrationState, string>> = {
  none: 'el perfil no tiene integración de shell',
  cwd: 'cmd no avisa cuándo está lista',
  unavailable: 'falta el script de integración de shell',
  error: 'la integración de shell no cargó',
};

function drop(paneId: PaneId): void {
  const entry = pending.get(paneId);
  if (!entry) return;
  pending.delete(paneId);
  window.clearTimeout(entry.timer);
  entry.unsubscribe();
}

function giveUp(paneId: PaneId, reason: string): void {
  const entry = pending.get(paneId);
  if (!entry) return;
  drop(paneId);
  const ws = useWorkspace.getState();
  const tabId = tabOfPane(ws, paneId);
  const where = tabId ? ` en «${tabTitle(ws, tabId)}»` : '';
  useUi.getState().showToast(`No se escribió «${entry.command}»${where}: ${reason}.`, 'warning');
}

/** Types `command` (and Enter) in the pane as soon as its shell is ready. */
export function queueInitialCommand(paneId: PaneId, command: string): void {
  drop(paneId);
  const unsubscribe = useWorkspace.subscribe((s) => {
    const pane = s.panes[paneId];
    if (!pane) return drop(paneId);
    const why = WHY_NOT[pane.integration];
    if (why) giveUp(paneId, why);
    else if (pane.status === 'exited' || pane.status === 'failed') giveUp(paneId, 'la shell terminó');
  });
  const timer = window.setTimeout(() => giveUp(paneId, 'la shell no mostró su prompt a tiempo'), READY_TIMEOUT_MS);
  pending.set(paneId, { command, timer, unsubscribe });
}

/** The pane's shell has just drawn its prompt (OSC 133;B). */
export function promptReady(paneId: PaneId): void {
  const entry = pending.get(paneId);
  if (!entry) return;
  const pane = useWorkspace.getState().panes[paneId];
  const handle = getPane(paneId);
  if (!pane || !handle || pane.integration !== 'ok' || pane.commandRunning) return;
  const typed = handle.integration.promptInput();
  if (typed === null) return;
  // Something typed ahead would be mixed with the command: leave it to the user.
  if (typed.trim() !== '') return giveUp(paneId, 'ya había texto escrito en el prompt');
  if (handle.session.sendText(`${entry.command}\r`)) drop(paneId);
}

/** Panes still waiting for their shell (for tests and diagnostics). */
export const pendingInitialCommands = (): PaneId[] => [...pending.keys()];
