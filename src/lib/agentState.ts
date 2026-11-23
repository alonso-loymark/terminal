// What an AI agent in a pane is doing, from what the terminal sees. Pure: covered by node --test
// (agentState.test.ts); lib/agentMonitor.ts feeds it.
//
// Output alone used to be the signal, and any redraw counted: a TUI repaints on a resize, a focus
// change or its own timers, and its echo arrives late in a long conversation. An agent quietly
// waiting at its prompt showed "trabajando". Now:
// - Its working hint on screen is the strong signal. While they work, the four show it in
//   parentheses with the time: Claude Code "(12s · ↑ 1.2k tokens · esc to interrupt)", Codex
//   "(5s • esc to interrupt)", Gemini "(esc to cancel, 5s)", agy "(12s · esc to cancel)". Once
//   an agent has shown it, its absence means it is not working, whatever it redraws (a
//   permission prompt: it waits for the user).
// - Until then (an agent or a version that words it differently): output that lasts, a run of
//   batches with no gap over GAP_MS for SUSTAIN_MS or more. A redraw, a blink or the echo of
//   typing does not.

/** Longest pause inside a run of output (a working spinner redraws every ~100 ms). */
export const GAP_MS = 400;
/** How long a run of output must last to mean work. */
export const SUSTAIN_MS = 1500;
/** After the agent goes idle or asks for the user, this long before anything says it works again. */
export const GRACE_MS = 1500;
/** The hint gone this long (an agent known to show it): done working. */
export const HINT_GONE_MS = 1500;

/** The states an agent has while its process runs (`finished` is decided by the process table). */
export type LiveAgentState = 'idle' | 'working' | 'waiting';

export interface AgentSignals {
  now: number;
  state: LiveAgentState;
  /** The working hint is on screen now. */
  hint: boolean;
  /** This agent has shown it at least once. */
  hintSeen: boolean;
  /** When the hint was last on screen. */
  hintLastSeen: number;
  /** Last output that was not the echo of typing, and when its run started. */
  lastOutput: number;
  runStart: number;
  /** When it became idle or started waiting. */
  waitingSince: number;
  /** settings.json `agents.idleSeconds`, in ms. */
  idleMs: number;
}

/** A run of output that is still going and has lasted long enough to be work. */
export function sustainedOutput(s: Pick<AgentSignals, 'now' | 'lastOutput' | 'runStart'>): boolean {
  return s.now - s.lastOutput <= GAP_MS && s.lastOutput - s.runStart >= SUSTAIN_MS;
}

export function nextAgentState(s: AgentSignals): LiveAgentState {
  const working = s.hint || (!s.hintSeen && sustainedOutput(s));
  if (s.state !== 'working') return working && s.now - s.waitingSince >= GRACE_MS ? 'working' : s.state;
  if (s.hint) return 'working';
  if (s.hintSeen) return s.now - s.hintLastSeen >= Math.min(HINT_GONE_MS, s.idleMs) ? 'waiting' : 'working';
  return s.now - s.lastOutput >= s.idleMs ? 'waiting' : 'working';
}

const GROUP = /\(([^()\n]{0,200})\)/g;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s|m|h)\b/i;

/**
 * The screen (one string per line, wrapped rows joined) shows an agent's working hint: a group
 * in parentheses with "esc to interrupt", or with "esc to cancel" and a duration (dialogs say
 * "Esc to cancel" too, without a timer: those wait for the user).
 */
export function hasWorkingHint(lines: readonly string[]): boolean {
  for (const line of lines) {
    if (!/esc to (?:interrupt|cancel)/i.test(line)) continue;
    for (const [, group = ''] of line.matchAll(GROUP)) {
      if (/\besc to interrupt\b(?! and send)/i.test(group)) return true;
      if (/\besc to cancel\b/i.test(group) && DURATION.test(group)) return true;
    }
  }
  return false;
}
