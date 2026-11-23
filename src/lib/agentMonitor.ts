// AI agents in the panes. Which one runs is asked to the backend (it looks at each session's
// process tree, like Shift+Enter does), only for panes running a command; what it is doing is
// read from the terminal (lib/agentState.ts): idle when it starts, working while its working hint
// is on screen (or, for an agent that never showed one, while its output lasts), waiting for the
// user once it stops, rings (BEL) or sends a notification (OSC 9 / OSC 777), finished when it
// exits. Requests for attention become native Windows notifications when the pane is
// not on screen (another tab, a zoomed sibling, the window minimized or in the background); a
// click on one brings Brisa forward with that pane focused.
import { useSettings } from '../store/settings';
import { useWorkspace } from '../store/workspace';
import { isPaneVisible, tabOfPane, tabTitle, type AgentName, type AgentState, type PaneId } from '../store/workspaceModel';
import { GAP_MS, GRACE_MS, SUSTAIN_MS, hasWorkingHint, nextAgentState } from './agentState';
import { listenNotifications, notify, sessionAgents } from './pty';
import type { TerminalNotification } from './shellIntegration';
import { focusActiveTerminal } from './tabActions';
import { getPane } from './terminalRegistry';

export const AGENT_LABELS: Record<AgentName, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', agy: 'agy' };

/** How often the backend is asked which agents run (only for panes running something). */
const POLL_MS = 2000;
const TICK_MS = 1000;
/**
 * Output this soon after a keystroke is its echo (or the prompt reacting to it), not the agent
 * working. Generous: in a long conversation a TUI's echo can take hundreds of ms.
 */
const ECHO_MS = 1000;
/** At most one bell notification per pane this often (a burst of bells is one). */
const BELL_GAP_MS = 5000;

interface Activity {
  /** Last output that was not an echo, and when its run started (see agentState.ts). */
  output: number;
  runStart: number;
  input: number;
  /** When it became idle or started waiting. */
  waitingSince: number;
  /** The agent has shown its working hint, and when last. */
  hintSeen: boolean;
  hintLastSeen: number;
  notified: number;
}

const activity = new Map<PaneId, Activity>();
const act = (paneId: PaneId): Activity => {
  let a = activity.get(paneId);
  if (!a) {
    a = { output: 0, runStart: 0, input: 0, waitingSince: 0, hintSeen: false, hintLastSeen: 0, notified: 0 };
    activity.set(paneId, a);
  }
  return a;
};

const settings = () => useSettings.getState().settings;
const ws = () => useWorkspace.getState();

function setState(paneId: PaneId, name: AgentName, state: AgentState): void {
  if (state === 'waiting' || state === 'idle') act(paneId).waitingSince = Date.now();
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

/** A batch of output arrived from the pane's program (hot path: O(1), no store write unless it changes). */
export function noteOutput(paneId: PaneId): void {
  const a = act(paneId);
  const now = Date.now();
  if (now - a.input < ECHO_MS) return;
  if (now - a.output > GAP_MS) a.runStart = now;
  a.output = now;
  // Output that lasts says "working" at once for an agent that never showed its hint (the tick,
  // which reads the screen, would take up to a second). A redraw, a blink or a burst does not.
  if (a.hintSeen || now - a.runStart < SUSTAIN_MS || now - a.waitingSince < GRACE_MS) return;
  const agent = ws().panes[paneId]?.agent;
  if (agent?.state === 'waiting' || agent?.state === 'idle') setState(paneId, agent.name, 'working');
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
      // A new agent: nothing known about it yet (its startup render is not work).
      Object.assign(act(paneId), { output: 0, runStart: 0, hintSeen: false, hintLastSeen: 0 });
      setState(paneId, name, 'idle');
    }
  } else if (current && current.state !== 'finished') {
    setState(paneId, current.name, 'finished');
    if (settings().notifications.agents) notifyHidden(paneId, `${AGENT_LABELS[current.name]} terminó`, where(paneId));
  }
}

/** The pane's current screen (not where the user scrolled to), wrapped rows joined. */
function screenLines(paneId: PaneId): string[] {
  const term = getPane(paneId)?.term;
  if (!term) return [];
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = buffer.baseY; y < buffer.baseY + term.rows; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines;
}

/**
 * Once a second, for the panes with an agent: is its working hint on screen? Then what it is
 * doing (agentState.ts): an agent that stopped working is waiting for the user.
 */
function tick(): void {
  const idleMs = settings().agents.idleSeconds * 1000;
  const now = Date.now();
  for (const pane of Object.values(ws().panes)) {
    const agent = pane.agent;
    if (!agent || agent.state === 'finished') continue;
    const a = act(pane.id);
    const hint = hasWorkingHint(screenLines(pane.id));
    if (hint) {
      a.hintSeen = true;
      a.hintLastSeen = now;
    }
    const next = nextAgentState({
      now,
      state: agent.state,
      hint,
      hintSeen: a.hintSeen,
      hintLastSeen: a.hintLastSeen,
      lastOutput: a.output,
      runStart: a.runStart,
      waitingSince: a.waitingSince,
      idleMs,
    });
    if (next === agent.state) continue;
    if (next === 'waiting') agentWaiting(pane.id, agent.name, null);
    else setState(pane.id, agent.name, next);
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
