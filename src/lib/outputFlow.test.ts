// Unit tests for output flow control (npm test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OutputFlow } from './outputFlow.ts';

/** A backend whose answers arrive when the test says so. */
function backend() {
  const calls: { paused: boolean; resolve: () => void; reject: () => void }[] = [];
  const send = (paused: boolean) => new Promise<void>((resolve, reject) => calls.push({ paused, resolve, reject: () => reject(new Error('gone')) }));
  return { calls, send };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('OutputFlow: pauses past the high watermark and resumes under the low one', async () => {
  const b = backend();
  const flow = new OutputFlow(100, 20);
  flow.attach(b.send);
  flow.received(60);
  assert.equal(b.calls.length, 0);
  flow.received(60);
  assert.deepEqual(b.calls.map((c) => c.paused), [true]);
  b.calls[0]!.resolve();
  await settle();
  flow.parsed(60);
  assert.equal(b.calls.length, 1, 'between the watermarks: stays paused');
  flow.parsed(50);
  assert.deepEqual(b.calls.map((c) => c.paused), [true, false]);
  assert.equal(flow.pending, 10);
});

test('OutputFlow: one request at a time, only the latest wish (never resume before pause)', async () => {
  const b = backend();
  const flow = new OutputFlow(100, 20);
  flow.attach(b.send);
  flow.received(150); // pause sent
  flow.parsed(140); // resume wanted while the pause is in flight
  flow.received(150); // ...and pause again
  assert.equal(b.calls.length, 1, 'waits for the first answer');
  b.calls[0]!.resolve();
  await settle();
  assert.equal(b.calls.length, 1, 'the latest wish (paused) is what was already sent');
  flow.parsed(150);
  assert.deepEqual(b.calls.map((c) => c.paused), [true, false]);
});

test('OutputFlow: output before the session id is known counts; the wish goes once attached', async () => {
  const b = backend();
  const flow = new OutputFlow(100, 20);
  flow.received(300);
  assert.equal(flow.paused, true);
  flow.attach(b.send);
  assert.deepEqual(b.calls.map((c) => c.paused), [true]);
});

test('OutputFlow: a failed request (session gone) stops sending', async () => {
  const b = backend();
  const flow = new OutputFlow(100, 20);
  flow.attach(b.send);
  flow.received(150);
  b.calls[0]!.reject();
  await settle();
  flow.parsed(150);
  flow.received(150);
  assert.equal(b.calls.length, 1);
});
