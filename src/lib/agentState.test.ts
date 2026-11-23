import assert from 'node:assert/strict';
import test from 'node:test';
import { GAP_MS, GRACE_MS, HINT_GONE_MS, SUSTAIN_MS, hasWorkingHint, nextAgentState, type AgentSignals } from './agentState.ts';

const base = (over: Partial<AgentSignals> = {}): AgentSignals => ({
  now: 100_000,
  state: 'idle',
  hint: false,
  hintSeen: false,
  hintLastSeen: 0,
  lastOutput: 0,
  runStart: 0,
  waitingSince: 0,
  idleMs: 6000,
  ...over,
});

test('the working hint of each agent, and what is not one', () => {
  assert.equal(hasWorkingHint(['✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)']), true);
  assert.equal(hasWorkingHint(['✻ Thinking… (esc to interrupt)']), true);
  assert.equal(hasWorkingHint(['• Working (5s • Esc to interrupt)']), true);
  assert.equal(hasWorkingHint(['⠋ Generando la respuesta (esc to cancel, 5s)']), true);
  assert.equal(hasWorkingHint(['⠙ Thinking… (1m 3s · esc to cancel)']), true);
  // An agent waiting for the user: its prompt, a dialog that cancels with Esc, a hint about
  // queued messages, the words in the conversation without the parentheses.
  assert.equal(hasWorkingHint(['> ', '? for shortcuts']), false);
  assert.equal(hasWorkingHint(['(Press Enter to submit, Esc to cancel, Ctrl+C to clear stored key)']), false);
  assert.equal(hasWorkingHint(['Send now got no answer from the session · esc to interrupt and send']), false);
  assert.equal(hasWorkingHint(['pulsá esc to interrupt cuando quieras']), false);
  assert.equal(hasWorkingHint([]), false);
});

test('a redraw, a blink or a short burst is not work; output that lasts is', () => {
  const now = 100_000;
  // One redraw a moment ago.
  assert.equal(nextAgentState(base({ lastOutput: now - 50, runStart: now - 50 })), 'idle');
  // A run that has not lasted enough yet.
  assert.equal(nextAgentState(base({ lastOutput: now - 50, runStart: now - SUSTAIN_MS + 200 })), 'idle');
  // Lasted, but it stopped (a startup render): not now.
  assert.equal(nextAgentState(base({ lastOutput: now - GAP_MS - 100, runStart: now - 5000 })), 'idle');
  // Still going and long enough: working (from idle or from waiting).
  assert.equal(nextAgentState(base({ lastOutput: now - 50, runStart: now - SUSTAIN_MS - 100 })), 'working');
  assert.equal(nextAgentState(base({ state: 'waiting', lastOutput: now - 50, runStart: now - SUSTAIN_MS - 100 })), 'working');
  // ... but not right after it asked for the user.
  assert.equal(nextAgentState(base({ state: 'waiting', waitingSince: now - GRACE_MS + 100, hint: true })), 'waiting');
});

test('once an agent showed its hint, only the hint says it works', () => {
  const now = 100_000;
  const seen = { hintSeen: true, hintLastSeen: now - 10_000 };
  // Lots of output (it redraws its prompt, a resize) but no hint: still waiting.
  assert.equal(nextAgentState(base({ ...seen, state: 'waiting', lastOutput: now - 10, runStart: now - 5000 })), 'waiting');
  assert.equal(nextAgentState(base({ ...seen, state: 'waiting', hint: true })), 'working');
  // Working: the hint gone for a moment is not enough; gone for HINT_GONE_MS is.
  assert.equal(nextAgentState(base({ state: 'working', hintSeen: true, hintLastSeen: now - 500, lastOutput: now })), 'working');
  assert.equal(nextAgentState(base({ state: 'working', hintSeen: true, hintLastSeen: now - HINT_GONE_MS, lastOutput: now })), 'waiting');
  // With idleSeconds shorter than that, the shorter wins.
  assert.equal(nextAgentState(base({ state: 'working', hintSeen: true, hintLastSeen: now - 900, idleMs: 800 })), 'waiting');
});

test('without a hint, quiet for idleSeconds means waiting', () => {
  const now = 100_000;
  assert.equal(nextAgentState(base({ state: 'working', lastOutput: now - 5000 })), 'working');
  assert.equal(nextAgentState(base({ state: 'working', lastOutput: now - 6000 })), 'waiting');
  assert.equal(nextAgentState(base({ state: 'working', hint: true, lastOutput: now - 60_000 })), 'working');
});
