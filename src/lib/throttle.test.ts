// Unit tests for throttleLatest (npm test).
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { throttleLatest } from './throttle.ts';

test('throttleLatest: the first call goes at once, a burst ends with its last value', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  try {
    const seen: string[] = [];
    const title = throttleLatest((value: string) => seen.push(value), 150);
    title('a');
    assert.deepEqual(seen, ['a']);
    // A spinner, every 40 ms: one update per window, with the latest frame.
    for (const frame of ['b', 'c', 'd']) {
      mock.timers.tick(40);
      title(frame);
    }
    assert.deepEqual(seen, ['a']);
    mock.timers.tick(30);
    assert.deepEqual(seen, ['a', 'd']);
    title('e');
    mock.timers.tick(100);
    assert.deepEqual(seen, ['a', 'd'], 'right after the trailing call: waits for a new window');
    mock.timers.tick(50);
    assert.deepEqual(seen, ['a', 'd', 'e']);
    // Quiet for longer than the window: straight through again.
    mock.timers.tick(1000);
    title('f');
    assert.deepEqual(seen, ['a', 'd', 'e', 'f']);
  } finally {
    mock.timers.reset();
  }
});

test('throttleLatest: cancel drops the value waiting for the window', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  try {
    const seen: number[] = [];
    const update = throttleLatest((value: number) => seen.push(value), 100);
    update(1);
    update(2);
    update.cancel();
    mock.timers.tick(500);
    assert.deepEqual(seen, [1]);
  } finally {
    mock.timers.reset();
  }
});
