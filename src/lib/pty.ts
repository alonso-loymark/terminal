// The only module that talks to the Rust PTY commands. Components never call `invoke` directly.
import { Channel, invoke } from '@tauri-apps/api/core';
import type { DetectedShell, ShellSpec } from '../config/profiles';
import type { IntegrationLevel, ShellKind } from '../store/workspaceModel';

export type { DetectedShell, ShellKind, ShellSpec };

/** Session id assigned by the Rust `PtyManager`. */
export type SessionId = number;

/** What `create_session` started. */
export interface SessionInfo {
  sessionId: SessionId;
  shell: ShellKind;
  /** What the shell will report: cwd and command marks (full), only the cwd, or nothing. */
  integration: IntegrationLevel;
}

export interface SystemInfo {
  homeDir: string | null;
  /** Shells found on this machine, the default first. */
  shells: DetectedShell[];
}

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
  /** Starting folder; missing or inaccessible folders fall back to the user's home. */
  cwd?: string | null;
  /** What to start (a profile); default: the first shell detected. */
  shell?: ShellSpec | null;
  /** Raw PTY output; a batch may end in the middle of a UTF-8 sequence (xterm copes). */
  onData: (data: Uint8Array) => void;
  /** Fires once, after the last `onData`. */
  onExit: (exit: SessionExit) => void;
}

export function createSession({ cols, rows, cwd, shell, onData, onExit }: CreateSessionOptions): Promise<SessionInfo> {
  // Per-session channels (not global events). Raw bytes arrive as ArrayBuffers.
  const dataChannel = new Channel<ArrayBuffer>((buffer) => onData(new Uint8Array(buffer)));
  const exitChannel = new Channel<SessionExit>(onExit);
  return invoke<SessionInfo>('create_session', {
    cols,
    rows,
    cwd: cwd ?? null,
    shell: shell ?? null,
    onData: dataChannel,
    onExit: exitChannel,
  });
}

/** Home folder and available shells (asked once at startup). */
export function getSystemInfo(): Promise<SystemInfo> {
  return invoke('system_info');
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

/** A process that closing the session would kill besides the shell. */
export interface BusyProcess {
  pid: number;
  name: string;
}

/** What closing the session would kill (dev servers, agents...). Windowed apps are not listed. */
export function sessionBusy(sessionId: SessionId): Promise<BusyProcess[]> {
  return invoke('session_busy', { sessionId });
}

export function closeSession(sessionId: SessionId): Promise<void> {
  return invoke('close_session', { sessionId });
}

/** ConPTY details for xterm's `windowsPty` option; `null` outside Windows. */
export function getPtyBackend(): Promise<PtyBackend | null> {
  return invoke('pty_backend');
}

// ---------------------------------------------------------------- agents and notifications

export type AgentName = 'claude' | 'codex' | 'gemini' | 'agy';

/** The AI agent running in each session, with one look at the process table. */
export function sessionAgents(sessionIds: SessionId[]): Promise<{ sessionId: SessionId; agent: AgentName | null }[]> {
  return invoke('session_agents', { sessionIds });
}

/** A native Windows notification; `tag` comes back when it is clicked (the pane to focus). */
export function notify(title: string, body: string, tag: string): Promise<void> {
  return invoke('notify', { title, body, tag });
}

/** Where clicks on notifications go (the backend has already brought the window forward). */
export function listenNotifications(onActivate: (tag: string) => void): Promise<void> {
  const channel = new Channel<{ tag: string }>((activation) => onActivate(activation.tag));
  return invoke('notifications_listen', { onActivate: channel });
}

/** Development only: what clicking a notification does (end-to-end tests). */
export function debugNotificationClick(tag: string): Promise<void> {
  return invoke('debug_notification_click', { tag });
}

/** Output counters of one session (bytes read from the PTY, batches sent, backlog). */
export interface PtyOutputStats {
  bytesRead: number;
  reads: number;
  batches: number;
  maxBatch: number;
  backlog: number;
  maxBacklog: number;
  /** Flow-control pauses asked by the page. */
  pauses: number;
}

/** Development only: the output counters of every session (the performance e2e reads them). */
export function debugPtyStats(): Promise<[SessionId, PtyOutputStats][]> {
  return invoke('debug_pty_stats');
}

/** Flow control: stop reading the session's output while its terminal catches up, or resume. */
export function pauseOutput(sessionId: SessionId, paused: boolean): Promise<void> {
  return invoke('pause_output', { sessionId, paused });
}
