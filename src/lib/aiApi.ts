// The only module that talks to the Rust AI commands (src-tauri/src/ai_commands.rs).
import { Channel, invoke } from '@tauri-apps/api/core';

export type AiProvider = 'claude-cli' | 'anthropic-api';

export type AiErrorCode =
  | 'disabled'
  | 'not-installed'
  | 'outdated'
  | 'auth'
  | 'limit'
  | 'no-key'
  | 'api-key'
  | 'rate-limit'
  | 'overloaded'
  | 'network'
  | 'refusal'
  | 'timeout'
  | 'cancelled'
  | 'invalid'
  | 'failed';

export interface AiFailure {
  code: AiErrorCode;
  message: string;
}

export type AiEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'status'; message: string }
  | { kind: 'done' }
  | { kind: 'error'; code: AiErrorCode; message: string };

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** One completion, exactly as shown to the user ("Ver qué se envía"). */
export interface AiPayload {
  provider: AiProvider;
  model: string;
  system: string;
  messages: AiMessage[];
  effort: 'low' | 'medium' | 'high' | null;
  maxTokens: number;
  claudePath: string | null;
}

export const isFailure = (value: unknown): value is AiFailure =>
  typeof value === 'object' && value !== null && 'code' in value && 'message' in value;

/** Starts a request; resolves with its id (for `aiCancel`), rejects with an `AiFailure`. */
export function aiQuery(payload: AiPayload, onEvent: (event: AiEvent) => void): Promise<number> {
  return invoke<number>('ai_query', { request: payload, onEvent: new Channel<AiEvent>(onEvent) });
}

export const aiCancel = (id: number) => invoke<void>('ai_cancel', { id });

/** Tells the backend whether `ai.enabled` is on: off, it refuses to launch anything. */
export const aiConfigure = (enabled: boolean) => invoke<void>('ai_configure', { enabled });

export interface ClaudeStatus {
  path: string;
  version: string | null;
  loggedIn: boolean | null;
  authMethod: string | null;
}

export interface AiStatus {
  enabled: boolean;
  claude: ClaudeStatus | null;
  error: AiFailure | null;
  /** "…abcd" when an API key is saved. */
  apiKey: string | null;
}

/** For the settings screen; with the CLI provider it runs `claude --version` and `claude auth status`. */
export const aiStatus = (provider: AiProvider, claudePath: string | null) => invoke<AiStatus>('ai_status', { provider, claudePath });

/** Saves the key in the Windows Credential Manager; resolves with its hint. */
export const aiSetApiKey = (key: string) => invoke<string>('ai_set_api_key', { key });

export const aiDeleteApiKey = () => invoke<boolean>('ai_delete_api_key');

export interface Scrubbed {
  texts: string[];
  /** Names (never values) of the environment variables whose values were found. */
  names: string[];
  count: number;
}

/** Replaces the values of the app's sensitive environment variables (done in Rust). */
export const aiScrubEnv = (texts: string[]) => invoke<Scrubbed>('ai_scrub_env', { texts });
