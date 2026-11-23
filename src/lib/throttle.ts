/** A function that forwards its latest value at most once per window (see `throttleLatest`). */
export interface Throttled<T> {
  (value: T): void;
  /** Drops a value still waiting for the end of the window. */
  cancel(): void;
}

/**
 * Calls `fn` at most once every `ms`: a call after a quiet spell goes through at once; calls
 * inside the window merge into one at its end, with the last value. For state that changes
 * faster than anyone can see it (an agent's spinner in its title, every frame).
 */
export function throttleLatest<T>(fn: (value: T) => void, ms: number): Throttled<T> {
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { value: T } | null = null;
  const run = (value: T) => {
    last = Date.now();
    fn(value);
  };
  const throttled = (value: T) => {
    const wait = last + ms - Date.now();
    if (wait <= 0 && timer === undefined) {
      run(value);
      return;
    }
    pending = { value };
    timer ??= setTimeout(() => {
      timer = undefined;
      const next = pending;
      pending = null;
      if (next) run(next.value);
    }, Math.max(0, wait));
  };
  throttled.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = null;
  };
  return throttled;
}
