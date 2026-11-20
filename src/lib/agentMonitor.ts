// AI agents in the panes. Which one runs is asked to the backend (it looks at each session's
// process tree, like Shift+Enter does), only for panes running a command; what it is doing is
// read from the terminal: working while it produces output, waiting for the user when it rings
// (BEL), sends a notification (OSC 9 / OSC 777) or goes quiet for `agents.idleSeconds`, finished
// when it exits. Requests for attention become native Windows notifications when the pane is
// not on screen (another tab, a zoomed sibling, the window minimized or in the background); a
// click on one brings Brisa forward with that pane focused.
import { useSettings } from '../store/settings';
import { useWorkspace } from '../store/workspace';
import { isPaneVisible, tabOfPane, tabTitle, type AgentName, type AgentState, type PaneId } from '../store/workspaceModel';
import { listenNotifications, notify, sessionAgents } from './pty';
import type { TerminalNotification } from './shellIntegration';
import { focusActiveTerminal } from './tabActions';

export const AGENT_LABELS: Record<AgentName, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };

/** How often the backend is asked which agents run (only for panes running something). */
const POLL_MS = 2000;
const TICK_MS = 1000;
/** Output this soon after a keystroke is its echo, not the agent working. */
const ECHO_MS = 300;
/** After an agent asks for the user, a redraw this soon does not mean it went back to work. */
const GRACE_MS = 1500;
/** At most one bell notification per pane this often (a burst of bells is one). */
const BELL_GAP_MS = 5000;

interface Activity {
  output: number;
  input: number;
  waitingSince: number;
  notified: number;
}

const activity = new Map<PaneId, Activity>();
const act = (paneId: PaneId): Activity => {
  let a = activity.get(paneId);
  if (!a) {
    a = { output: Date.now(), input: 0, waitingSince: 0, notified: 0 };
    activity.set(paneId, a);
  }
  return a;
};

const settings = () => useSettings.getState().settings;
const ws = () => useWorkspace.getState();

function setState(paneId: PaneId, name: AgentName, state: AgentState): void {
  if (state === 'waiting') act(paneId).waitingSince = Date.now();
  ws().setPaneAgent(paneId, { name, state });
}

/** "Claude Code espera tu respuesta" in «tab». */
function where(paneId: PaneId): string {
  const tabId = tabOfPane(ws(), paneId);
  return tabId ? `En «${tabTitle(ws(), tabId)}»` : '';
}

/**
 * A native notification, only if the pane is not in front of the user. `bell`: bells come in
 * bursts (a failed completion beeps): one per pane every few seconds is enough.
 */
function notifyHidden(paneId: PaneId, title: string, body: string, bell = false): void {
  if (!settings().notifications.enabled) return;
  const visible = document.visibilityState === 'visible' && document.hasFocus() && isPaneVisible(ws(), paneId);
  if (visible) return;
  const a = act(paneId);
  const now = Date.now();
  if (bell && now - a.notified < BELL_GAP_MS) return;
  if (bell) a.notified = now;
  notify(title, body, paneId).catch((error: unknown) => console.warn('[brisa] no se pudo notificar', error));
}

function agentWaiting(paneId: PaneId, name: AgentName, message: string | null, bell = false): void {
  setState(paneId, name, 'waiting');
  if (settings().notifications.agents) {
    notifyHidden(paneId, `${AGENT_LABELS[name]} espera tu respuesta`, [message, where(paneId)].filter(Boolean).join('\n'), bell);
  }
}

// ---------------------------------------------------------------- what the terminal sees

/** A batch of output arrived from the pane's program. */
export function noteOutput(paneId: PaneId): void {
  const a = act(paneId);
  const now = Date.now();
  if (now - a.input < ECHO_MS) return;
  a.output = now;
  const agent = ws().panes[paneId]?.agent;
  if (agent?.state === 'waiting' && now - a.waitingSince > GRACE_MS) setState(paneId, agent.name, 'working');
}

/** The user typed in the pane. */
export function noteInput(paneId: PaneId): void {
  act(paneId).input = Date.now();
  const agent = ws().panes[paneId]?.agent;
  // "Finished" stays until the pane is used again.
  if (agent?.state === 'finished') ws().setPaneAgent(paneId, null);
}

/** BEL, OSC 9 or OSC 777 from the pane's program. */
export function noteAttention(paneId: PaneId, request: { source: 'bell' } | TerminalNotification): void {
  if (request.source === 'bell' && !settings().notifications.bell) return;
  const agent = ws().panes[paneId]?.agent;
  const message = request.source === 'bell' ? null : request.body;
  const bell = request.source === 'bell';
  if (settings().agents.enabled && agent && agent.state !== 'finished') {
    agentWaiting(paneId, agent.name, message, bell);
    return;
  }
  const title = (!bell && request.title) || where(paneId).replace(/^En /, '') || 'Brisa';
  notifyHidden(paneId, title, message ?? 'La terminal pide tu atención (campana)', bell);
}

// ---------------------------------------------------------------- polling

let polling = false;

/** Panes worth asking about: running a command (or unable to say: cmd, custom programs), or with an agent. */
function targets(): { paneId: PaneId; sessionId: number }[] {
  return Object.values(ws().panes)
    .filter(
      (p) =>
        p.sessionId !== null &&
        p.status === 'running' &&
        (p.commandRunning || p.integration !== 'ok' || (p.agent !== null && p.agent.state !== 'finished')),
    )
    .map((p) => ({ paneId: p.id, sessionId: p.sessionId! }));
}

async function poll(): Promise<void> {
  if (polling || !settings().agents.enabled) return;
  const list = targets();
  if (list.length === 0) return;
  polling = true;
  try {
    const found = await sessionAgents(list.map((t) => t.sessionId));
    for (const { sessionId, agent } of found) {
      const target = list.find((t) => t.sessionId === sessionId);
      if (target) seen(target.paneId, agent);
    }
  } catch (error) {
    console.warn('[brisa] no se pudo consultar los agentes', error);
  } finally {
    polling = false;
  }
}

function seen(paneId: PaneId, name: AgentName | null): void {
  const pane = ws().panes[paneId];
  if (!pane || !settings().agents.enabled) return;
  const current = pane.agent;
  if (name) {
    if (!current || current.name !== name || current.state === 'finished') {
      act(paneId).output = Date.now();
      setState(paneId, name, 'working');
    }
  } else if (current && current.state !== 'finished') {
    setState(paneId, current.name, 'finished');
    if (settings().notifications.agents) notifyHidden(paneId, `${AGENT_LABELS[current.name]} terminó`, where(paneId));
  }
}

/** An agent that has been quiet long enough is waiting for the user. */
function tick(): void {
  const idle = settings().agents.idleSeconds * 1000;
  const now = Date.now();
  for (const pane of Object.values(ws().panes)) {
    if (pane.agent?.state === 'working' && now - act(pane.id).output >= idle) agentWaiting(pane.id, pane.agent.name, null);
  }
}

/** Starts watching; returns the uninstaller. */
export function installAgentMonitor(): () => void {
  const pollTimer = window.setInterval(() => void poll(), POLL_MS);
  const tickTimer = window.setInterval(tick, TICK_MS);
  let soon = 0;
  const unsubscribe = useWorkspace.subscribe((s, prev) => {
    // A command just started: it may be an agent, look a moment later instead of waiting.
    for (const pane of Object.values(s.panes)) {
      const before = prev.panes[pane.id];
      if (pane.commandRunning && !before?.commandRunning) {
        if (pane.agent?.state === 'finished') s.setPaneAgent(pane.id, null);
        window.clearTimeout(soon);
        soon = window.setTimeout(() => void poll(), 700);
      }
    }
    for (const id of activity.keys()) if (!s.panes[id]) activity.delete(id);
  });
  // Agents turned off: no indicators left behind.
  const unsubscribeSettings = useSettings.subscribe((s, prev) => {
    if (s.settings.agents.enabled || !prev.settings.agents.enabled) return;
    for (const pane of Object.values(ws().panes)) if (pane.agent) ws().setPaneAgent(pane.id, null);
  });
  // A click on a notification: the backend brought the window forward; focus the pane.
  void listenNotifications((paneId) => {
    if (!ws().panes[paneId]) return;
    ws().focusPane(paneId);
    focusActiveTerminal();
  }).catch((error: unknown) => console.warn('[brisa] notificaciones', error));
  return () => {
    window.clearInterval(pollTimer);
    window.clearInterval(tickTimer);
    window.clearTimeout(soon);
    unsubscribe();
    unsubscribeSettings();
  };
}
