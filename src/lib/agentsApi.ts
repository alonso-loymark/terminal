// The only module that talks to the Rust orchestrator commands
// (src-tauri/src/orchestrator_commands.rs): agent adapters, plans, workers, the project's
// files and diffs.
import { Channel, invoke } from '@tauri-apps/api/core';
import type { AiErrorCode, AiFailure } from './aiApi';

export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  resolved: string | null;
  efforts: string[];
}

export interface AgentInfo {
  id: string;
  name: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean | null;
  authMethod: string | null;
  models: ModelInfo[];
  error: AiFailure | null;
}

export type ToolAction = 'read' | 'edit' | 'write' | 'command' | 'search' | 'other';

export interface Denial {
  tool: string;
  action: ToolAction;
  target: string;
  /** Command patterns that would allow it; empty = cannot be allowed from Brisa. */
  allow: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  turns: number;
  models: string[];
}

export type TaskEvent =
  | { kind: 'started'; sessionId: string | null; model: string | null }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; tool: string; action: ToolAction; target: string }
  | { kind: 'toolDone'; id: string; ok: boolean }
  | { kind: 'denied'; denial: Denial }
  | { kind: 'status'; message: string }
  | { kind: 'done'; result: string; sessionId: string | null; usage: Usage; denials: Denial[] }
  | { kind: 'error'; code: AiErrorCode; message: string; usage: Usage | null };

export type TaskMode = 'work' | 'analyze';

export interface TaskSpec {
  agent: string;
  dir: string;
  prompt: string;
  model: string;
  effort: string | null;
  resume: string | null;
  mode: TaskMode;
  allowedCommands: string[];
  maxTurns: number | null;
  agentPath: string | null;
  /** Pasted images (PNGs Brisa saved): they go with the brief. */
  images?: string[];
}

export interface AskSpec {
  agent: string;
  model: string;
  effort: string | null;
  system: string;
  prompt: string;
  agentPath: string | null;
}

export interface ProjectCommand {
  pattern: string;
  source: string;
}

export interface InstructionFileState {
  path: string;
  content: string;
}

export interface Instructions {
  agents: InstructionFileState | null;
  claude: InstructionFileState | null;
  claudeImportsAgents: boolean;
}

export interface ProjectInfo {
  dir: string;
  name: string;
  git: boolean;
  commands: ProjectCommand[];
  instructions: Instructions;
  store: string;
}

export interface ProjectFiles {
  /** The single chat of before (Fase 8A), migrated when there is no `chats`. */
  conversation: string | null;
  chats: string | null;
  decisions: string | null;
  project: string | null;
}

export type ProjectFile = 'chats' | 'decisions' | 'project';

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  binary: boolean;
  diff: string;
  truncated: boolean;
}

export interface TaskDiff {
  git: boolean;
  files: FileDiff[];
  touched: string[];
}

/** Tells the backend whether `orchestrator.enabled` is on: off, it refuses to launch anything. */
export const orchConfigure = (enabled: boolean) => invoke<void>('orch_configure', { enabled });

/** Installed, logged in and models of every agent CLI (cached unless `refresh`). */
export const agentsDetect = (agentPath: string | null, refresh: boolean) => invoke<AgentInfo[]>('agents_detect', { agentPath, refresh });

export const orchProject = (dir: string) => invoke<ProjectInfo>('orch_project', { dir });

/** Normalized pattern, or rejects with why it is not accepted. */
export const orchCheckPattern = (pattern: string) => invoke<string>('orch_check_pattern', { pattern });

/** Starts the plan question; resolves with its id (for `orchCancel`), rejects with an `AiFailure`. */
export const orchAsk = (spec: AskSpec, onEvent: (event: TaskEvent) => void) =>
  invoke<number>('orch_ask', { spec, onEvent: new Channel<TaskEvent>(onEvent) });

/** Starts a worker; resolves with its id, rejects with an `AiFailure`. */
export const orchRun = (spec: TaskSpec, onEvent: (event: TaskEvent) => void) =>
  invoke<number>('orch_run', { spec, onEvent: new Channel<TaskEvent>(onEvent) });

export const orchCancel = (id: number) => invoke<void>('orch_cancel', { id });

export const orchLoad = (dir: string) => invoke<ProjectFiles>('orch_load', { dir });

export const orchSave = (dir: string, file: ProjectFile, text: string) => invoke<void>('orch_save', { dir, file, text });

/** One chat's messages (null: no file yet). */
export const orchChatLoad = (dir: string, id: string) => invoke<string | null>('orch_chat_load', { dir, id });

export const orchChatSave = (dir: string, id: string, text: string) => invoke<void>('orch_chat_save', { dir, id, text });

export const orchChatDelete = (dir: string, id: string) => invoke<void>('orch_chat_delete', { dir, id });

/** Notes the repository's state before a task. */
export const orchSnapshot = (dir: string) => invoke<number>('orch_snapshot', { dir });

/** What changed since the snapshot (released afterwards). */
export const orchDiff = (id: number, touched: string[]) => invoke<TaskDiff>('orch_diff', { id, touched });

/** Writes AGENTS.md / CLAUDE.md with the text the user confirmed; `expected` = what they saw (null: create). */
export const orchWriteInstructions = (dir: string, file: 'agents' | 'claude', content: string, expected: string | null) =>
  invoke<Instructions>('orch_write_instructions', { dir, file, content, expected });
