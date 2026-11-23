/** Output handed to xterm and not parsed yet above which the backend stops reading the PTY. */
export const OUTPUT_HIGH_WATER = 128 * 1024;
/** ...and below which it reads again. */
export const OUTPUT_LOW_WATER = 16 * 1024;

/**
 * Flow control for one session (the watermarks of xterm.js's flow control guide): counts the
 * bytes handed to the terminal and the ones it finished parsing (write callbacks). Past the
 * high watermark it asks the backend to pause reading the PTY; under the low one, to resume.
 * ConPTY then waits and draws the latest screen when it can write again, instead of the page
 * piling up seconds of frames it cannot parse in time.
 *
 * One request in flight at a time and only the latest wish is sent: two independent invokes
 * may arrive in any order, and a resume overtaken by its pause would freeze the terminal.
 */
export class OutputFlow {
  #pending = 0;
  #want = false;
  #sent = false;
  #busy = false;
  #closed = false;
  #send: ((paused: boolean) => Promise<void>) | null = null;

  readonly high: number;
  readonly low: number;

  constructor(high = OUTPUT_HIGH_WATER, low = OUTPUT_LOW_WATER) {
    this.high = high;
    this.low = low;
  }

  /** Bytes still to parse. */
  get pending(): number {
    return this.#pending;
  }

  /** Whether the backend was asked to pause (or is about to be). */
  get paused(): boolean {
    return this.#want;
  }

  /** Where requests go, once the session id is known (output may arrive before). */
  attach(send: (paused: boolean) => Promise<void>): void {
    this.#send = send;
    this.#sync();
  }

  /** Bytes handed to the terminal. */
  received(bytes: number): void {
    this.#pending += bytes;
    if (this.#pending > this.high) this.#set(true);
  }

  /** Bytes the terminal finished parsing. */
  parsed(bytes: number): void {
    this.#pending -= bytes;
    if (this.#pending < this.low) this.#set(false);
  }

  /** The session is gone: nothing more to send. */
  close(): void {
    this.#closed = true;
  }

  #set(paused: boolean): void {
    if (this.#want === paused) return;
    this.#want = paused;
    this.#sync();
  }

  #sync(): void {
    const send = this.#send;
    if (!send || this.#busy || this.#closed || this.#want === this.#sent) return;
    this.#busy = true;
    const target = this.#want;
    send(target)
      .then(
        () => (this.#sent = target),
        // The session ended (or never existed): its reader no longer matters.
        () => (this.#closed = true),
      )
      .finally(() => {
        this.#busy = false;
        this.#sync();
      });
  }
}
