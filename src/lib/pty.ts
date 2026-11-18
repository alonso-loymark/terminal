// The only module that talks to the Rust PTY commands. Components never call `invoke` directly.
import { Channel, invoke } from '@tauri-apps/api/core';

/** Session id assigned by the Rust `PtyManager`. */
export type SessionId = number;

export interface SessionExit {
  exitCode: number | null;
}

export interface PtyBackend {
  backend: 'conpty' | 'winpty';
  buildNumber: number | null;
}

export interface CreateSessionOptions {
  cols: number;
  rows: number;
  cwd?: string;
  /** Raw PTY output; a batch may end in the middle of a UTF-8 sequence (xterm copes). */
  onData: (data: Uint8Array) => void;
  /** Fires once, after the last `onData`. */
  onExit: (exit: SessionExit) => void;
}

export function createSession({ cols, rows, cwd, onData, onExit }: CreateSessionOptions): Promise<SessionId> {
  // Per-session channels (not global events). Raw bytes arrive as ArrayBuffers.
  const dataChannel = new Channel<ArrayBuffer>((buffer) => onData(new Uint8Array(buffer)));
  const exitChannel = new Channel<SessionExit>(onExit);
  return invoke<SessionId>('create_session', {
    cols,
    rows,
    cwd: cwd ?? null,
    onData: dataChannel,
    onExit: exitChannel,
  });
}

export function writeToSession(sessionId: SessionId, data: string): Promise<void> {
  return invoke('write_to_session', { sessionId, data });
}

export function resizeSession(sessionId: SessionId, cols: number, rows: number): Promise<void> {
  return invoke('resize_session', { sessionId, cols, rows });
}

/** What the backend turned Shift+Enter into for the program currently running. */
export type ShiftEnterTarget = { mode: 'agent'; agent: string } | { mode: 'native' };

/**
 * Shift+Enter: a newline for AI agents (each one's own sequence), a real Shift+Enter for
 * everything else (PowerShell: AddLine). The backend decides from the session's process tree.
 */
export function sendShiftEnter(sessionId: SessionId): Promise<ShiftEnterTarget> {
  return invoke('send_shift_enter', { sessionId });
}

export function closeSession(sessionId: SessionId): Promise<void> {
  return invoke('close_session', { sessionId });
}

/** ConPTY details for xterm's `windowsPty` option; `null` outside Windows. */
export function getPtyBackend(): Promise<PtyBackend | null> {
  return invoke('pty_backend');
}
