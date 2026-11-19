import type { IDisposable, Terminal } from '@xterm/xterm';
import type { PaneSpawn, SessionStatus } from '../store/workspaceModel';
import {
  closeSession,
  createSession,
  resizeSession,
  sendShiftEnter,
  writeToSession,
  type SessionId,
  type SessionInfo,
} from './pty';

export type { SessionStatus };

export interface TerminalSessionCallbacks {
  /** Shell and folder for each start (asked again on restart: the folder may have changed). */
  spawn?: () => PaneSpawn;
  onStatus?: (status: SessionStatus, exitCode: number | null) => void;
  /** The backend started the session (before the status turns 'running'). */
  onStarted?: (info: SessionInfo) => void;
  /** Called for every batch of output (used for the tab activity indicator). */
  onOutput?: () => void;
}

const ignore = () => {};

/**
 * Binds one xterm `Terminal` to one PTY session in the Rust backend. The terminal only
 * renders; this class forwards input and size changes and follows the session lifecycle.
 */
export class TerminalSession {
  readonly #term: Terminal;
  readonly #callbacks: TerminalSessionCallbacks;
  readonly #subscriptions: IDisposable[];
  #id: SessionId | null = null;
  #status: SessionStatus = 'starting';
  /** Input produced before the session id is known (see `#start`). */
  #pendingInput: string[] = [];
  /** Distinguishes the current session from earlier ones after a restart. */
  #generation = 0;
  #disposed = false;

  constructor(term: Terminal, callbacks: TerminalSessionCallbacks = {}) {
    this.#term = term;
    this.#callbacks = callbacks;
    this.#subscriptions = [
      term.onData((data) => this.#handleInput(data)),
      term.onResize(({ cols, rows }) => this.#handleResize(cols, rows)),
    ];
  }

  start(): void {
    void this.#start();
  }

  /** Backend session id while the shell is running; null before it starts or after it exits. */
  get sessionId(): SessionId | null {
    return this.#id;
  }

  /**
   * Types `text` into the running shell as if from the keyboard (used to run `cd` from the
   * explorer). Callers check first that the shell is idle at an empty prompt.
   */
  sendText(text: string): boolean {
    if (this.#status !== 'running' || this.#id === null) return false;
    this.#send(this.#id, text);
    return true;
  }

  /** Shift+Enter, translated by the backend for whatever runs in the session. */
  shiftEnter(): void {
    if (this.#status !== 'running' || this.#id === null) {
      // Not connected (starting, exited, failed): behave like Enter.
      this.#handleInput('\r');
      return;
    }
    sendShiftEnter(this.#id).catch(ignore);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const subscription of this.#subscriptions) subscription.dispose();
    if (this.#id !== null) closeSession(this.#id).catch(ignore);
    this.#id = null;
  }

  async #start(): Promise<void> {
    if (this.#disposed) return;
    const generation = ++this.#generation;
    this.#setStatus('starting');
    const { cols, rows } = this.#term;
    const { shell, cwd } = this.#callbacks.spawn?.() ?? { shell: null, cwd: null };
    try {
      const info = await createSession({
        cols,
        rows,
        shell,
        cwd,
        onData: (data) => {
          if (this.#disposed) return;
          this.#term.write(data);
          this.#callbacks.onOutput?.();
        },
        onExit: ({ exitCode }) => this.#handleExit(generation, exitCode),
      });
      const id = info.sessionId;
      if (this.#disposed) {
        closeSession(id).catch(ignore);
        return;
      }
      this.#id = id;
      this.#callbacks.onStarted?.(info);
      this.#setStatus('running');
      // ConPTY asks for the cursor position (ESC[6n) as soon as it starts and renders nothing
      // until it gets an answer. xterm may answer before we knew the id: deliver it now.
      const pending = this.#pendingInput;
      this.#pendingInput = [];
      for (const data of pending) this.#send(id, data);
      if (this.#term.cols !== cols || this.#term.rows !== rows) {
        this.#handleResize(this.#term.cols, this.#term.rows);
      }
    } catch (error) {
      if (this.#disposed) return;
      this.#setStatus('failed');
      this.#term.write(`\r\n\x1b[31mNo se pudo iniciar la shell: ${String(error)}\x1b[0m\r\n`);
      this.#term.write('\x1b[2mPresioná Enter para reintentar.\x1b[0m\r\n');
    }
  }

  #handleInput(data: string): void {
    if (this.#status === 'exited' || this.#status === 'failed') {
      if (data === '\r') this.start();
      return;
    }
    if (this.#id === null) {
      this.#pendingInput.push(data);
      return;
    }
    this.#send(this.#id, data);
  }

  #send(id: SessionId, data: string): void {
    // Rejects when the session is already gone (its exit notice is on the way). Anything else
    // means lost input: say so.
    writeToSession(id, data).catch((error: unknown) => {
      if (this.#id === id && this.#status === 'running') {
        console.warn('[terminal] no se pudo escribir en la sesión', id, JSON.stringify(data), error);
      }
    });
  }

  #handleResize(cols: number, rows: number): void {
    if (this.#id !== null) resizeSession(this.#id, cols, rows).catch(ignore);
  }

  #handleExit(generation: number, exitCode: number | null): void {
    if (this.#disposed || generation !== this.#generation) return;
    this.#id = null;
    this.#pendingInput = [];
    this.#setStatus('exited', exitCode);
    const code = exitCode === null ? '' : ` con código ${exitCode}`;
    // Soft reset (DECSTR) so modes left behind by the dead process don't leak into the next one.
    this.#term.write(
      `\x1b[!p\r\n\x1b[2m[Proceso finalizado${code}. Presioná Enter para abrir una nueva sesión.]\x1b[0m\r\n`,
    );
  }

  #setStatus(status: SessionStatus, exitCode: number | null = null): void {
    this.#status = status;
    this.#callbacks.onStatus?.(status, exitCode);
  }
}
