import type { IDisposable, Terminal } from '@xterm/xterm';
import type { SessionStatus } from '../store/workspaceModel';
import { InputQueue, type InputItem } from './inputQueue';
import { OutputFlow } from './outputFlow';
import {
  closeSession,
  createSession,
  pauseOutput,
  resizeSession,
  sendShiftEnter,
  writeToSession,
  type SessionId,
  type SessionInfo,
  type ShellSpec,
} from './pty';

export type { SessionStatus };

/** What to start and where (null: the backend's default shell, the home folder). */
export interface SpawnRequest {
  shell: ShellSpec | null;
  cwd: string | null;
}

export interface TerminalSessionCallbacks {
  /** Shell and folder for each start (asked again on restart: the folder may have changed). */
  spawn?: () => SpawnRequest;
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
  /**
   * Everything typed, pasted or answered by xterm, in order and never dropped: it waits while
   * the session starts and is retried if a delivery fails (see `inputQueue.ts`).
   */
  readonly #input = new InputQueue(
    (id, item: InputItem) =>
      item.kind === 'text' ? writeToSession(id, item.data) : sendShiftEnter(id).then(() => undefined),
    {
      onRetry: (item, error) =>
        console.warn('[brisa] reintentando una escritura a la sesión', item.kind, String(error)),
    },
  );
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
    if (this.#status !== 'running') return false;
    this.#input.push({ kind: 'text', data: text });
    return true;
  }

  /** Shift+Enter, translated by the backend for whatever runs in the session. */
  shiftEnter(): void {
    if (this.#status === 'exited' || this.#status === 'failed') {
      // No process: behave like Enter (which starts a new session).
      this.#handleInput('\r');
      return;
    }
    // Queued like any key, so it keeps its place among them (also while starting).
    this.#input.push({ kind: 'shiftEnter' });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const subscription of this.#subscriptions) subscription.dispose();
    this.#input.setTarget(null);
    this.#input.clear();
    if (this.#id !== null) closeSession(this.#id).catch(ignore);
    this.#id = null;
  }

  async #start(): Promise<void> {
    if (this.#disposed) return;
    const generation = ++this.#generation;
    this.#setStatus('starting');
    const { cols, rows } = this.#term;
    const { shell, cwd } = this.#callbacks.spawn?.() ?? { shell: null, cwd: null };
    // Flow control for this session (a restart gets a new one): see OutputFlow.
    const flow = new OutputFlow();
    try {
      const info = await createSession({
        cols,
        rows,
        shell,
        cwd,
        onData: (data) => {
          if (this.#disposed) return;
          const bytes = data.length;
          flow.received(bytes);
          this.#term.write(data, () => flow.parsed(bytes));
          this.#callbacks.onOutput?.();
        },
        onExit: ({ exitCode }) => {
          flow.close();
          this.#handleExit(generation, exitCode);
        },
      });
      const id = info.sessionId;
      if (this.#disposed) {
        closeSession(id).catch(ignore);
        return;
      }
      flow.attach((paused) => pauseOutput(id, paused));
      this.#id = id;
      this.#callbacks.onStarted?.(info);
      this.#setStatus('running');
      // ConPTY asks for the cursor position (ESC[6n) as soon as it starts and renders nothing
      // until it gets an answer. xterm may answer before we knew the id: it waited in the
      // queue, which delivers from now on.
      this.#input.setTarget(id);
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
      // No process to type into: Enter starts a new session, other keys have nowhere to go.
      if (data === '\r') this.start();
      return;
    }
    this.#input.push({ kind: 'text', data });
  }

  #handleResize(cols: number, rows: number): void {
    if (this.#id !== null) resizeSession(this.#id, cols, rows).catch(ignore);
  }

  #handleExit(generation: number, exitCode: number | null): void {
    if (this.#disposed || generation !== this.#generation) return;
    this.#id = null;
    // The process is gone: input still queued for it has nowhere to go.
    this.#input.setTarget(null);
    this.#input.clear();
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
