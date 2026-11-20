import { create } from 'zustand';
import type { AiFailure } from '../lib/aiApi';
import type { ActivityItem, Decision, OrchMessage, ProjectPrefs, Sent } from '../lib/orchestratorModel';
import type { AgentInfo, ProjectInfo, Usage } from '../lib/agentsApi';

/** The AGENTS.md draft (a read-only worker), until the user confirms or drops it. */
export interface DraftState {
  status: 'running' | 'ready' | 'error' | 'cancelled';
  activity: ActivityItem[];
  text: string;
  usage: Usage | null;
  error: AiFailure | null;
}

export interface ProjectState {
  /** As the backend normalized it. */
  dir: string;
  info: ProjectInfo | null;
  loadError: string | null;
  /** Conversation, decisions and preferences read from the config folder. */
  loaded: boolean;
  messages: OrchMessage[];
  decisions: Decision[];
  prefs: ProjectPrefs;
  /** What runs now (one thing per project at a time). */
  busy: { kind: 'plan' | 'run' | 'draft'; messageId: string | null } | null;
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
}

export const useOrchestrator = create<OrchestratorState>(() => ({
  agents: null,
  agentsError: null,
  detecting: false,
  projects: {},
  dialog: null,
}));

/** Projects are keyed case-insensitively, without a trailing separator (Windows paths). */
export const projectKey = (dir: string): string => dir.replace(/[\\/]+$/, '').toLowerCase();

export const selectProject =
  (dir: string | null) =>
  (s: OrchestratorState): ProjectState | undefined =>
    dir ? s.projects[projectKey(dir)] : undefined;

export function patchProject(dir: string, fn: (p: ProjectState) => Partial<ProjectState>): void {
  const key = projectKey(dir);
  useOrchestrator.setState((s) => {
    const project = s.projects[key];
    if (!project) return s;
    return { projects: { ...s.projects, [key]: { ...project, ...fn(project) } } };
  });
}

/** Replaces one message of a project (by id). */
export function patchMessage(dir: string, id: string, fn: (m: OrchMessage) => OrchMessage): void {
  patchProject(dir, (p) => ({ messages: p.messages.map((m) => (m.id === id ? fn(m) : m)) }));
}
