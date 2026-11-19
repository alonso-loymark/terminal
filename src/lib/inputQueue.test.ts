// Unit tests for the terminal input queue (npm test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputQueue, type InputItem } from './inputQueue.ts';

/** A backend whose deliveries complete when the test says so. */
function backend() {
  const delivered: string[] = [];
  const calls: { target: number; item: InputItem; resolve: () => void; reject: (e: unknown) => void }[] = [];
  const deliver = (target: number, item: InputItem) =>
    new Promise<void>((resolve, reject) => {
      calls.push({
        target,
        item,
        resolve: () => {
          delivered.push(item.kind === 'text' ? item.data : '<S-Enter>');
          resolve();
        },
        reject,
      });
    });
  return { delivered, calls, deliver };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const noWait = { wait: () => Promise.resolve() };

test('one delivery at a time, in order; what arrives meanwhile goes together next', async () => {
  const b = backend();
  const q = new InputQueue(b.deliver, noWait);
  q.setTarget(1);
  q.push({ kind: 'text', data: 'a' });
  q.push({ kind: 'text', data: 'b' });
  q.push({ kind: 'text', data: 'c' });
  await tick();
  assert.equal(b.calls.length, 1, 'only the first is in flight');
  assert.deepEqual(b.calls[0]?.item, { kind: 'text', data: 'a' });
  b.calls[0]?.resolve();
  await tick();
  assert.deepEqual(b.calls[1]?.item, { kind: 'text', data: 'bc' }, 'merged, never into the one in flight');
  b.calls[1]?.resolve();
  await tick();
  assert.deepEqual(b.delivered, ['a', 'bc']);
});

test('Shift+Enter keeps its place between text', async () => {
  const b = backend();
  const q = new InputQueue(b.deliver, noWait);
  q.push({ kind: 'text', data: 'uno' });
  q.push({ kind: 'shiftEnter' });
  q.push({ kind: 'text', data: 'dos' });
  q.setTarget(7);
  for (let i = 0; i < 3; i++) {
    await tick();
    b.calls[i]?.resolve();
  }
  await tick();
  assert.deepEqual(b.delivered, ['uno', '<S-Enter>', 'dos']);
  assert.ok(b.calls.every((c) => c.target === 7));
});

test('input before the session exists waits for it', async () => {
  const b = backend();
  const q = new InputQueue(b.deliver, noWait);
  q.push({ kind: 'text', data: '\x1b[1;1R' });
  await tick();
  assert.equal(b.calls.length, 0);
  q.setTarget(3);
  await tick();
  b.calls[0]?.resolve();
  await tick();
  assert.deepEqual(b.delivered, ['\x1b[1;1R']);
});

test('a failed delivery is retried, in place, until it goes through: nothing is lost', async () => {
  const b = backend();
  const retried: InputItem[] = [];
  const q = new InputQueue(b.deliver, { ...noWait, onRetry: (item) => retried.push(item) });
  q.setTarget(1);
  q.push({ kind: 'text', data: 'ab' });
  await tick();
  b.calls[0]?.reject(new Error('ipc'));
  q.push({ kind: 'text', data: 'cd' });
  await tick();
  b.calls[1]?.reject(new Error('ipc'));
  await tick();
  assert.deepEqual(b.calls[2]?.item, { kind: 'text', data: 'abcd' }, 'retried first, with what came after merged');
  b.calls[2]?.resolve();
  await tick();
  assert.deepEqual(b.delivered, ['abcd']);
  assert.equal(retried.length, 1, 'reported once, not on every retry');
});

test('a session that ends takes its undelivered input with it (no endless retries)', async () => {
  const b = backend();
  const q = new InputQueue(b.deliver, noWait);
  q.setTarget(1);
  q.push({ kind: 'text', data: 'x' });
  q.push({ kind: 'text', data: 'y' });
  await tick();
  q.setTarget(null);
  q.clear();
  b.calls[0]?.reject(new Error('session 1 does not exist'));
  await tick();
  assert.equal(b.calls.length, 1, 'no retry after the session is gone');
  // A restarted session gets only what is typed from then on.
  q.setTarget(2);
  q.push({ kind: 'text', data: 'z' });
  await tick();
  assert.deepEqual(b.calls[1], { ...b.calls[1], target: 2, item: { kind: 'text', data: 'z' } });
});

test('thousands of keystrokes in a burst arrive complete and in order', async () => {
  const delivered: string[] = [];
  let failNext = 3;
  const q = new InputQueue(
    async (_target, item) => {
      await Promise.resolve();
      if (failNext-- > 0) throw new Error('transient');
      if (item.kind === 'text') delivered.push(item.data);
    },
    noWait,
  );
  q.setTarget(1);
  let expected = '';
  for (let i = 0; i < 5000; i++) {
    const c = String.fromCharCode(33 + (i % 90));
    expected += c;
    q.push({ kind: 'text', data: c });
  }
  for (let i = 0; i < 50 && delivered.join('').length < expected.length; i++) await tick();
  assert.equal(delivered.join(''), expected);
  assert.ok(delivered.length < 50, `merged into few deliveries (${delivered.length})`);
});
