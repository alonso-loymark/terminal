import { create } from 'zustand';
import type { AiFailure } from '../lib/aiApi';
import type { ChatMeta } from '../lib/orchestratorChats';
import type { ActivityItem, Decision, OrchMessage, ProjectPrefs, Sent } from '../lib/orchestratorModel';
import type { AgentInfo, ProjectInfo, Usage } from '../lib/agentsApi';

/** AGENTS.md written by a read-only worker (a draft, or an update after a task), until confirmed. */
export interface DraftState {
  status: 'running' | 'ready' | 'error' | 'cancelled';
  /** create: AGENTS.md is missing; update: a task left it out of date. */
  purpose: 'create' | 'update';
  activity: ActivityItem[];
  text: string;
  usage: Usage | null;
  error: AiFailure | null;
}

/** A chat of the project: its entry in the index, and its messages once read. */
export interface ChatState extends ChatMeta {
  /** null until its file is read (only the open chats are). */
  messages: OrchMessage[] | null;
}

export interface ProjectState {
  /** As the backend normalized it. */
  dir: string;
  info: ProjectInfo | null;
  loadError: string | null;
  /** Chats, decisions and preferences read from the config folder. */
  loaded: boolean;
  /** Every chat of the project (newest activity first in the list). */
  chats: ChatState[];
  /** The chat on screen. */
  activeChat: string;
  /** Per project, for every chat. */
  decisions: Decision[];
  prefs: ProjectPrefs;
  /** What runs now (one thing per project at a time: workers share the folder). */
  busy: { kind: 'plan' | 'run' | 'draft'; messageId: string | null; chatId: string | null } | null;
  draft: DraftState | null;
}

/** AGENTS.md / CLAUDE.md about to be written: the exact text, shown before anything is written. */
export interface InstructionsDialog {
  kind: 'instructions';
  dir: string;
  file: 'agents' | 'claude';
  /** Relative path shown (`AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`). */
  path: string;
  content: string;
  /** What the file has now (null: it does not exist and will be created). */
  expected: string | null;
  error: string | null;
  writing: boolean;
  /** The task that said AGENTS.md went out of date (its offer closes when this is written). */
  runId?: string | null;
}

export interface SentDialog {
  kind: 'sent';
  sent: Sent;
}

interface OrchestratorState {
  agents: AgentInfo[] | null;
  agentsError: AiFailure | null;
  detecting: boolean;
  projects: Record<string, ProjectState>;
  dialog: InstructionsDialog | SentDialog | null;
  /** What the sidebar shows while an orchestrator tab is active: its chats, or the files. */
  sidebarView: 'chats' | 'files';
  /** A chat being renamed in the list. */
  renamingChat: string | null;
  /** Bumped to focus the chat list's search box. */
  searchRequest: number;
}

export const useOrchestrator = create<OrchestratorState>(() => ({
  agents: null,
  agentsError: null,
  detecting: false,
  projects: {},
  dialog: null,
  sidebarView: 'chats',
  renamingChat: null,
  searchRequest: 0,
}));

/** Projects are keyed case-insensitively, without a trailing separator (Windows paths). */
export const projectKey = (dir: string): string => dir.replace(/[\\/]+$/, '').toLowerCase();

export const selectProject =
  (dir: string | null) =>
  (s: OrchestratorState): ProjectState | undefined =>
    dir ? s.projects[projectKey(dir)] : undefined;

export const activeChatOf = (project: ProjectState | undefined): ChatState | undefined => project?.chats.find((c) => c.id === project.activeChat);

export function patchProject(dir: string, fn: (p: ProjectState) => Partial<ProjectState>): void {
  const key = projectKey(dir);
  useOrchestrator.setState((s) => {
    const project = s.projects[key];
    if (!project) return s;
    return { projects: { ...s.projects, [key]: { ...project, ...fn(project) } } };
  });
}

/** Replaces one chat of a project (by id). */
export function patchChat(dir: string, chatId: string, fn: (c: ChatState) => Partial<ChatState>): void {
  patchProject(dir, (p) => ({ chats: p.chats.map((c) => (c.id === chatId ? { ...c, ...fn(c) } : c)) }));
}

/** The chat that has this message. */
export function chatOfMessage(project: ProjectState | undefined, messageId: string): ChatState | undefined {
  return project?.chats.find((c) => c.messages?.some((m) => m.id === messageId));
}

/** Replaces one message of a project (by id, in whichever chat has it). */
export function patchMessage(dir: string, id: string, fn: (m: OrchMessage) => OrchMessage): void {
  patchProject(dir, (p) => ({
    chats: p.chats.map((c) => (c.messages?.some((m) => m.id === id) ? { ...c, messages: c.messages.map((m) => (m.id === id ? fn(m) : m)) } : c)),
  }));
}
