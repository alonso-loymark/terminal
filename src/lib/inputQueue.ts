// What the user types into a terminal, on its way to the session: in order, never dropped.
// Pure (no runtime imports): covered by node --test (inputQueue.test.ts).
//
// Each keystroke used to be its own IPC call. Those calls are independent requests, so nothing
// guaranteed their order, and a failed one was simply lost. Here one delivery is in flight at a
// time (order guaranteed), whatever arrives meanwhile is merged into the next one (fewer calls
// when typing fast or pasting), and a failed delivery is retried, never skipped. Input is only
// discarded when there is no process left to receive it (the session ended).

export type InputItem = { kind: 'text'; data: string } | { kind: 'shiftEnter' };

export interface InputQueueOptions {
  /** Waits between retries (ms), the last one repeating. */
  retryDelays?: number[];
  /** A delivery failed and will be retried (once per item: for logging). */
  onRetry?: (item: InputItem, error: unknown) => void;
  wait?: (ms: number) => Promise<void>;
}

const DEFAULT_DELAYS = [10, 25, 50, 100, 250, 500, 1000];

export class InputQueue {
  readonly #deliver: (target: number, item: InputItem) => Promise<void>;
  readonly #delays: number[];
  readonly #onRetry: (item: InputItem, error: unknown) => void;
  readonly #wait: (ms: number) => Promise<void>;
  #items: InputItem[] = [];
  #target: number | null = null;
  #running = false;

  constructor(deliver: (target: number, item: InputItem) => Promise<void>, options: InputQueueOptions = {}) {
    this.#deliver = deliver;
    this.#delays = options.retryDelays?.length ? options.retryDelays : DEFAULT_DELAYS;
    this.#onRetry = options.onRetry ?? (() => {});
    this.#wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Items waiting (not counting the one in flight). */
  get pending(): number {
    return this.#items.length;
  }

  push(item: InputItem): void {
    const last = this.#items.at(-1);
    // Merging never touches the delivery in flight: it is no longer in the list.
    if (item.kind === 'text' && last?.kind === 'text') last.data += item.data;
    else this.#items.push(item.kind === 'text' ? { kind: 'text', data: item.data } : item);
    void this.#pump();
  }

  /** The session to deliver to; null pauses (not started yet, or ended). */
  setTarget(target: number | null): void {
    this.#target = target;
    void this.#pump();
  }

  /** The process is gone: nothing left to deliver to. */
  clear(): void {
    this.#items = [];
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      let failures = 0;
      while (this.#items.length > 0 && this.#target !== null) {
        const target = this.#target;
        const item = this.#items.shift() as InputItem;
        try {
          await this.#deliver(target, item);
          failures = 0;
        } catch (error) {
          // The session ended (or was replaced) meanwhile: its input has nowhere to go.
          if (this.#target !== target) continue;
          // Still the same session: put it back first (merged with text that came after) and
          // try again shortly.
          const next = this.#items[0];
          if (item.kind === 'text' && next?.kind === 'text') next.data = item.data + next.data;
          else this.#items.unshift(item);
          if (failures === 0) this.#onRetry(item, error);
          await this.#wait(this.#delays[Math.min(failures, this.#delays.length - 1)] ?? 1000);
          failures++;
        }
      }
    } finally {
      this.#running = false;
    }
    // Something may have arrived (or the target come back) while the last delivery finished.
    if (this.#items.length > 0 && this.#target !== null) void this.#pump();
  }
}
