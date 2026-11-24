// The orchestrator: an "Orquestador" tab per project folder, with any number of chats. For each
// message the main model proposes a plan (task, agent, model, effort, why: JSON, validated);
// once approved (or with `orchestrator.autoApprove`) a worker (Claude Code) runs it in the
// project folder with limited permissions; the live activity, the summary, the diff, tokens
// and cost come back; the decision log is updated.
//
// Chats (ronda 1 del rediseño): each one has its own context (the planner only sees that chat);
// the decision log and the preferences are per project. One thing runs per project at a time
// (workers share the folder), whatever chat started it.
//
// Rules: with `orchestrator.enabled: false` nothing runs (the backend refuses too); everything
// sent goes through the AI layer's secret redaction and Rust's environment pass, and "Ver qué
// se envió" shows it; chats, decisions and preferences live in Brisa's config folder (never in
// the repo); AGENTS.md / CLAUDE.md are only written with the exact text the user saw and
// confirmed, never committed.
import { useExplorer } from '../store/explorer';
import { profileFor } from '../store/profiles';
import {
  activeChatOf,
  chatOfMessage,
  patchChat,
  patchMessage,
  patchProject,
  projectKey,
  useOrchestrator,
  type ChatState,
  type DraftState,
  type ProjectState,
} from '../store/orchestrator';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import { tabOfPane, type PaneId } from '../store/workspaceModel';
import { aiScrubEnv, isFailure, type AiFailure } from './aiApi';
import {
  agentsDetect,
  orchAsk,
  orchCancel,
  orchChatDelete,
  orchChatLoad,
  orchChatSave,
  orchConfigure,
  orchDiff,
  orchLoad,
  orchProject,
  orchRun,
  orchSave,
  orchSnapshot,
  orchWriteInstructions,
  type AgentInfo,
  type TaskEvent,
  type TaskMode,
} from './agentsApi';
import { chatStats, chatTitle, emptyChat, migratedChat, newChatId, parseChats, renamedTitle, serializeChats, sortChats } from './orchestratorChats';
import {
  AGENTS_DRAFT_PROMPT,
  agentsUpdatePrompt,
  allowedCommands,
  buildBrief,
  continuePrompt,
  decisionOf,
  extractJson,
  markdownAnswer,
  MINIMAL_CLAUDE_MD,
  parseConversation,
  parseDecisions,
  parseForcedModel,
  parsePrefs,
  parseWorkerResult,
  plannerPrompt,
  PLANNER_SYSTEM,
  rankModels,
  relativeTo,
  serializeConversation,
  serializeDecisions,
  serializePrefs,
  touchedFiles,
  validatePlan,
  withAgentsImport,
  type ActivityItem,
  type OrchMessage,
  type Plan,
  type RunInfo,
  type Sent,
} from './orchestratorModel';
import { initSettings } from './settingsSync';
import { focusActiveTerminal } from './tabActions';

const settings = () => useSettings.getState().settings;
const orch = () => settings().orchestrator;
export const orchestratorEnabled = (): boolean => orch().enabled;
const store = () => useOrchestrator.getState();
const project = (dir: string): ProjectState | undefined => store().projects[projectKey(dir)];
const chatState = (dir: string, chatId: string): ChatState | undefined => project(dir)?.chats.find((c) => c.id === chatId);

/** A message of the project and the chat that has it. */
function findMessage(dir: string, id: string): { chat: ChatState; message: OrchMessage } | null {
  const chat = chatOfMessage(project(dir), id);
  const message = chat?.messages?.find((m) => m.id === id);
  return chat && message ? { chat, message } : null;
}

let nextId = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++nextId}`;

/** Message id → backend request id, to cancel it. */
const requests = new Map<string, number>();
const cancelled = new Set<string>();

const DISABLED: AiFailure = { code: 'disabled', message: 'El modo orquestador está desactivado (orchestrator.enabled: false).' };

const agentPath = () => settings().ai.claudePath.trim() || null;
const redactExtra = () => settings().ai.redact;

// ---------------------------------------------------------------- agents and projects

/** Detects the agent CLIs (cached by the backend unless `refresh`). */
export async function detectAgents(refresh = false): Promise<void> {
  if (!orchestratorEnabled() || store().detecting) return;
  useOrchestrator.setState({ detecting: true });
  try {
    const agents = await agentsDetect(agentPath(), refresh);
    useOrchestrator.setState({ agents, agentsError: null, detecting: false });
  } catch (error) {
    useOrchestrator.setState({ agentsError: isFailure(error) ? error : { code: 'failed', message: String(error) }, detecting: false });
  }
}

const claude = (): AgentInfo | undefined => store().agents?.find((a) => a.id === 'claude');

/** The main model of a project: its selector, else `orchestrator.mainModel`. */
export function mainModel(dir: string): string {
  return project(dir)?.prefs.mainModel ?? orch().mainModel;
}

/** Loads a project's info, its chats' index and the open chat once (the tab calls it when it mounts). */
export async function ensureProject(dir: string): Promise<void> {
  const key = projectKey(dir);
  if (store().projects[key]) return;
  const first: ChatState = { ...emptyChat(), messages: [] };
  const initial: ProjectState = {
    dir,
    info: null,
    loadError: null,
    loaded: false,
    chats: [first],
    activeChat: first.id,
    decisions: [],
    prefs: { dir, mainModel: null, allowed: [] },
    busy: null,
    draft: null,
  };
  useOrchestrator.setState((s) => ({ projects: { ...s.projects, [key]: initial } }));
  if (!store().agents) void detectAgents();
  try {
    const [info, files] = await Promise.all([orchProject(dir), orchLoad(dir)]);
    const index = parseChats(files.chats);
    let chats: ChatState[] = [first];
    let active = first.id;
    let migrated: string | null = null;
    if (index?.chats.length) {
      chats = index.chats.map((c) => ({ ...c, messages: null }));
      active = index.active ?? chats[0]?.id ?? first.id;
    } else {
      // The single chat of before (Fase 8A) becomes the first one; conversation.json stays as it was.
      const legacy = parseConversation(files.conversation);
      if (legacy.length) {
        const meta = migratedChat(legacy, newChatId());
        chats = [{ ...meta, messages: legacy }];
        active = meta.id;
        migrated = meta.id;
      }
    }
    patchProject(dir, () => ({
      info,
      loaded: true,
      chats,
      activeChat: active,
      decisions: parseDecisions(files.decisions),
      prefs: parsePrefs(files.project, info.dir),
    }));
    if (migrated) scheduleSave(dir, migrated);
    await loadChat(dir, active);
  } catch (error) {
    patchProject(dir, () => ({ loadError: String(error), loaded: true }));
  }
}

/** Reads a chat's messages the first time it is opened. */
async function loadChat(dir: string, chatId: string): Promise<void> {
  const chat = chatState(dir, chatId);
  if (!chat || chat.messages !== null) return;
  try {
    const text = await orchChatLoad(project(dir)?.dir ?? dir, chatId);
    patchChat(dir, chatId, (c) => (c.messages === null ? { messages: parseConversation(text) } : {}));
  } catch (error) {
    patchChat(dir, chatId, (c) => (c.messages === null ? { messages: [] } : {}));
    useUi.getState().showToast(`No se pudo leer el chat: ${String(error)}`, 'warning');
  }
}

/** Reads the project again (commands, AGENTS.md / CLAUDE.md). */
export async function refreshProject(dir: string): Promise<void> {
  try {
    const info = await orchProject(dir);
    patchProject(dir, () => ({ info, loadError: null }));
  } catch (error) {
    patchProject(dir, () => ({ loadError: String(error) }));
  }
}

// ---------------------------------------------------------------- persistence

interface PendingSave {
  timer: number;
  /** Chats whose messages changed. */
  chats: Set<string>;
}
const pending = new Map<string, PendingSave>();

/** The changed chats, the index, decisions and preferences, 300 ms after the last change. */
function scheduleSave(dir: string, chatId: string | null = null): void {
  const key = projectKey(dir);
  const entry = pending.get(key) ?? { timer: 0, chats: new Set<string>() };
  if (chatId) entry.chats.add(chatId);
  window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => void saveNow(dir), 300);
  pending.set(key, entry);
}

async function saveNow(dir: string): Promise<void> {
  const key = projectKey(dir);
  const entry = pending.get(key);
  pending.delete(key);
  if (entry) window.clearTimeout(entry.timer);
  const before = project(dir);
  if (!before?.loaded || before.loadError) return;
  const changed = entry?.chats ?? new Set<string>();
  // What the list shows (and the search reads) comes from the messages.
  if (changed.size) patchProject(dir, (p) => ({ chats: p.chats.map((c) => (changed.has(c.id) && c.messages ? { ...c, ...chatStats(c.messages) } : c)) }));
  const p = project(dir);
  if (!p) return;
  try {
    for (const id of changed) {
      const chat = p.chats.find((c) => c.id === id);
      if (chat?.messages?.length) await orchChatSave(p.dir, id, serializeConversation(chat.messages));
    }
    await orchSave(p.dir, 'chats', serializeChats(p.chats, p.activeChat));
    await orchSave(p.dir, 'decisions', serializeDecisions(p.decisions));
    await orchSave(p.dir, 'project', serializePrefs(p.prefs));
  } catch (error) {
    console.warn('[brisa] orch_save', error);
  }
}

function addMessage(dir: string, chatId: string, message: OrchMessage): void {
  patchChat(dir, chatId, (c) => ({ messages: [...(c.messages ?? []), message], count: (c.messages?.length ?? 0) + 1, updatedAt: Date.now() }));
  scheduleSave(dir, chatId);
}

function update(dir: string, id: string, fn: (m: OrchMessage) => OrchMessage): void {
  patchMessage(dir, id, fn);
  const chat = chatOfMessage(project(dir), id);
  if (chat) scheduleSave(dir, chat.id);
}

const note = (dir: string, chatId: string, text: string) => addMessage(dir, chatId, { id: newId('note'), kind: 'note', at: Date.now(), text });

export function setMainModel(dir: string, model: string): void {
  patchProject(dir, (p) => ({ prefs: { ...p.prefs, mainModel: model === orch().mainModel ? null : model } }));
  scheduleSave(dir);
}

// ---------------------------------------------------------------- chats

/** The project of the active tab, if it is an orchestrator. */
export function activeOrchestratorDir(): string | null {
  const ws = useWorkspace.getState();
  const pane = ws.panes[selectActivePaneId(ws) ?? ''];
  return pane?.kind === 'orchestrator' ? (pane.cwd ?? null) : null;
}

const isEmpty = (chat: ChatState | undefined) => !!chat && (chat.messages ? chat.messages.length === 0 : chat.count === 0);

/** Opens a chat of the project (a "Chat nuevo" left empty behind goes away). */
export function openChat(dir: string, chatId: string): void {
  const p = project(dir);
  if (!p || p.activeChat === chatId || !p.chats.some((c) => c.id === chatId)) return;
  const previous = activeChatOf(p);
  patchProject(dir, (pp) => ({
    activeChat: chatId,
    chats: isEmpty(previous) && previous?.id !== pp.busy?.chatId ? pp.chats.filter((c) => c.id !== previous?.id) : pp.chats,
  }));
  if (store().renamingChat) useOrchestrator.setState({ renamingChat: null });
  scheduleSave(dir);
  void loadChat(dir, chatId);
}

/** A new chat (if the open one is still empty, that one). The keyboard goes to its input. */
export function newChat(dir: string): void {
  const p = project(dir);
  if (!p?.loaded || p.loadError) return;
  if (!isEmpty(activeChatOf(p))) {
    const chat: ChatState = { ...emptyChat(), messages: [] };
    patchProject(dir, (pp) => ({ chats: [chat, ...pp.chats], activeChat: chat.id }));
  }
  useOrchestrator.setState({ renamingChat: null });
  queueMicrotask(() => focusActiveTerminal());
}

/** The sidebar with the project's chats (Ctrl+B may have hidden it). */
export function showChatList(): void {
  if (!useExplorer.getState().visible) useExplorer.getState().toggleVisible();
  if (store().sidebarView !== 'chats') useOrchestrator.setState({ sidebarView: 'chats' });
}

export function setSidebarView(view: 'chats' | 'files'): void {
  useOrchestrator.setState({ sidebarView: view });
}

/** The chat list's search box (the shortcut, the palette). */
export function focusChatSearch(): void {
  showChatList();
  useOrchestrator.setState((s) => ({ searchRequest: s.searchRequest + 1 }));
}

export function startRenameChat(dir: string, chatId = project(dir)?.activeChat ?? ''): void {
  if (!chatState(dir, chatId)) return;
  showChatList();
  useOrchestrator.setState({ renamingChat: chatId });
}

export function renameChat(dir: string, chatId: string, raw: string): void {
  useOrchestrator.setState({ renamingChat: null });
  const title = renamedTitle(raw);
  const chat = chatState(dir, chatId);
  if (!title || !chat || title === chat.title) return;
  patchChat(dir, chatId, () => ({ title, titleFrom: 'user' }));
  scheduleSave(dir);
}

/** Asks first (Cancel focused). A chat with a task running cannot go. */
export function requestDeleteChat(dir: string, chatId = project(dir)?.activeChat ?? ''): void {
  const p = project(dir);
  const chat = chatState(dir, chatId);
  if (!p || !chat) return;
  if (p.busy?.chatId === chatId) {
    useUi.getState().showToast('Ese chat tiene una tarea en curso: detenela antes de eliminarlo.', 'warning');
    return;
  }
  if (isEmpty(chat) && p.chats.length > 1) {
    deleteChat(dir, chatId);
    return;
  }
  useUi.getState().openConfirm({
    title: '¿Eliminar el chat?',
    message: 'Se borran sus mensajes. El registro de decisiones y las preferencias del proyecto se conservan.',
    details: [chat.title],
    confirmLabel: 'Eliminar',
    target: { kind: 'chat', dir, chatId },
  });
}

export function deleteChat(dir: string, chatId: string): void {
  const p = project(dir);
  if (!p?.chats.some((c) => c.id === chatId)) return;
  const rest = p.chats.filter((c) => c.id !== chatId);
  const next = p.activeChat === chatId ? sortChats(rest)[0] : rest.find((c) => c.id === p.activeChat);
  const fallback: ChatState | null = next ? null : { ...emptyChat(), messages: [] };
  patchProject(dir, () => ({ chats: fallback ? [fallback] : rest, activeChat: next?.id ?? fallback?.id ?? p.activeChat }));
  pending.get(projectKey(dir))?.chats.delete(chatId);
  void orchChatDelete(p.dir, chatId).catch((error: unknown) => useUi.getState().showToast(`No se pudo borrar el chat: ${String(error)}`, 'warning'));
  scheduleSave(dir);
  if (next) void loadChat(dir, next.id);
}

// ---------------------------------------------------------------- sending

/** Rust's pass over the app's sensitive environment variables, on top of the redaction. */
async function finalizeSent(base: Omit<Sent, 'envNames'>): Promise<Sent> {
  const pieces = [base.prompt, base.system ?? ''];
  const scrubbed = await aiScrubEnv(pieces).catch(() => null);
  const redactions = { ...base.redactions };
  if (scrubbed?.count) redactions.env_var = (redactions.env_var ?? 0) + scrubbed.count;
  return {
    ...base,
    prompt: scrubbed?.texts[0] ?? base.prompt,
    system: base.system === null ? null : (scrubbed?.texts[1] ?? base.system),
    redactions,
    envNames: scrubbed?.names ?? [],
  };
}

/** Streams a backend request; resolves with its last event (done or error). */
function stream(
  messageId: string,
  start: (onEvent: (event: TaskEvent) => void) => Promise<number>,
  onEvent: (event: TaskEvent) => void,
): Promise<Extract<TaskEvent, { kind: 'done' | 'error' }>> {
  return new Promise((resolve) => {
    // Text arrives in bursts: one store update per frame.
    let queued: TaskEvent[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = queued;
      queued = [];
      if (cancelled.has(messageId)) return;
      for (const event of batch) onEvent(event);
    };
    start((event) => {
      if (event.kind === 'done' || event.kind === 'error') {
        if (frame) cancelAnimationFrame(frame);
        flush();
        requests.delete(messageId);
        resolve(event);
        return;
      }
      queued.push(event);
      if (!frame) frame = requestAnimationFrame(flush);
    })
      .then((id) => {
        requests.set(messageId, id);
        if (cancelled.has(messageId)) void orchCancel(id);
      })
      .catch((error: unknown) => {
        const failure = isFailure(error) ? error : { code: 'failed' as const, message: String(error) };
        resolve({ kind: 'error', code: failure.code, message: failure.message, usage: null });
      });
  });
}

function setBusy(dir: string, busy: ProjectState['busy']): void {
  patchProject(dir, () => ({ busy }));
}

/**
 * Sends a message in the open chat: the main model proposes a plan; with auto-approve it runs
 * right away. `images`: PNGs pasted in the input (they go to the worker).
 */
export async function sendMessage(dir: string, raw: string, images: string[] = []): Promise<void> {
  const p = project(dir);
  const chat = activeChatOf(p);
  const text = raw.trim();
  if (!p?.info || !chat || !text || p.busy) return;
  const chatId = chat.id;
  const models = claude()?.models ?? [];
  const { model: forced, rest } = parseForcedModel(text, models);
  const first = !(chat.messages ?? []).some((m) => m.kind === 'user');
  const needsTitle = first && chat.titleFrom === 'auto';
  addMessage(dir, chatId, { id: newId('user'), kind: 'user', at: Date.now(), text, forced, ...(images.length ? { images } : {}) });
  // A title right away, from the message; the planner may suggest a better one in its answer.
  if (needsTitle) patchChat(dir, chatId, () => ({ title: chatTitle(text, redactExtra()) }));
  const planId = newId('plan');
  addMessage(dir, chatId, { id: planId, kind: 'plan', at: Date.now(), status: 'thinking', plan: null, chosen: forced !== null, usage: null, error: null, sent: null, text: '' });
  if (!orchestratorEnabled()) {
    update(dir, planId, (m) => (m.kind === 'plan' ? { ...m, status: 'error', error: DISABLED } : m));
    return;
  }
  setBusy(dir, { kind: 'plan', messageId: planId, chatId });
  try {
    await plan(dir, chatId, planId, rest || text, forced, null, { needsTitle, images: images.length });
  } finally {
    if (project(dir)?.busy?.messageId === planId) setBusy(dir, null);
  }
  const after = findMessage(dir, planId)?.message;
  if (after?.kind === 'plan' && after.status === 'proposed' && after.plan && orch().autoApprove) await approvePlan(dir, planId);
}

async function plan(
  dir: string,
  chatId: string,
  planId: string,
  message: string,
  forced: string | null,
  correction: string | null,
  extra: { needsTitle: boolean; images: number },
): Promise<void> {
  const p = project(dir);
  const agents = store().agents ?? [];
  if (!p?.info) return;
  const commands = allowedCommands(p.info.commands, orch().allowedCommands, p.prefs.allowed);
  const built = plannerPrompt(
    {
      message,
      forced,
      projectName: p.info.name,
      agents,
      commands,
      hasAgentsMd: p.info.instructions.agents !== null,
      decisions: p.decisions,
      // This chat only: each chat has its own context.
      recent: (chatState(dir, chatId)?.messages ?? []).filter((m) => m.id !== planId),
      correction,
      needsTitle: extra.needsTitle,
      images: extra.images,
    },
    redactExtra(),
  );
  const model = mainModel(dir);
  const sent = await finalizeSent({ kind: 'plan', agent: 'claude', model, effort: 'low', system: PLANNER_SYSTEM, prompt: built.text, redactions: built.found });
  update(dir, planId, (m) => (m.kind === 'plan' ? { ...m, sent, text: '' } : m));
  const last = await stream(
    planId,
    (onEvent) => orchAsk({ agent: 'claude', model, effort: 'low', system: sent.system ?? PLANNER_SYSTEM, prompt: sent.prompt, agentPath: agentPath() }, onEvent),
    (event) => {
      if (event.kind === 'text') update(dir, planId, (m) => (m.kind === 'plan' ? { ...m, text: m.text + event.text } : m));
    },
  );
  if (cancelled.has(planId) || (last.kind === 'error' && last.code === 'cancelled')) {
    update(dir, planId, (m) => (m.kind === 'plan' ? { ...m, status: 'cancelled' } : m));
    return;
  }
  if (last.kind === 'error') {
    update(dir, planId, (m) => (m.kind === 'plan' ? { ...m, status: 'error', error: { code: last.code, message: last.message }, usage: last.usage } : m));
    return;
  }
  const result = validatePlan(extractJson(last.result), agents, forced);
  if ('error' in result) {
    if (correction === null) {
      // One retry, telling the model what was wrong.
      await plan(dir, chatId, planId, message, forced, result.error, extra);
      return;
    }
    update(dir, planId, (m) => (m.kind === 'plan' ? { ...m, status: 'error', error: { code: 'invalid', message: `El plan no es válido: ${result.error}.` }, usage: last.usage } : m));
    return;
  }
  update(dir, planId, (m) => (m.kind === 'plan' ? { ...m, status: 'proposed', plan: result.plan, usage: last.usage } : m));
  const title = result.plan.title;
  if (title && chatState(dir, chatId)?.titleFrom === 'auto') {
    patchChat(dir, chatId, () => ({ title, titleFrom: 'plan' }));
    scheduleSave(dir);
  }
}

/** "Cambiar modelo" on a proposed plan. */
export function changePlanModel(dir: string, planId: string, model: string, effort: string | null): void {
  update(dir, planId, (m) => {
    if (m.kind !== 'plan' || !m.plan || m.status !== 'proposed') return m;
    const info = claude()?.models.find((x) => x.value === model);
    const valid = effort && info?.efforts.includes(effort) ? effort : info?.efforts.includes(m.plan.effort ?? '') ? m.plan.effort : (info?.efforts[0] ?? null);
    return { ...m, chosen: true, plan: { ...m.plan, model, effort: valid } };
  });
}

export function cancelPlan(dir: string, planId: string): void {
  const message = findMessage(dir, planId)?.message;
  if (message?.kind !== 'plan') return;
  if (message.status === 'thinking') {
    cancelRequest(planId);
    return;
  }
  if (message.status === 'proposed') update(dir, planId, (m) => (m.kind === 'plan' ? { ...m, status: 'cancelled' } : m));
}

function cancelRequest(messageId: string): void {
  cancelled.add(messageId);
  const id = requests.get(messageId);
  if (id !== undefined) void orchCancel(id);
}

/** Cancels whatever the project runs now (Esc, "Detener"). */
export function cancelBusy(dir: string): boolean {
  const busy = project(dir)?.busy;
  if (!busy?.messageId) return false;
  cancelRequest(busy.messageId);
  return true;
}

// ---------------------------------------------------------------- running

export async function approvePlan(dir: string, planId: string): Promise<void> {
  const p = project(dir);
  const message = findMessage(dir, planId)?.message;
  if (!p || message?.kind !== 'plan' || message.status !== 'proposed' || !message.plan || p.busy) return;
  update(dir, planId, (m) => (m.kind === 'plan' ? { ...m, status: 'approved' } : m));
  await runTask(dir, planId, message.plan, null);
}

const emptyRun = (plan: Plan, resumed: boolean): RunInfo => ({
  status: 'running',
  model: plan.model,
  effort: plan.effort,
  activity: [],
  text: '',
  result: null,
  sessionId: null,
  usage: null,
  denials: [],
  diff: null,
  error: null,
  sent: null,
  resumed,
  agentsStale: null,
});

/** The images of the message a plan answers (they go to its worker). */
function imagesOfPlan(chat: ChatState, planId: string): string[] {
  const messages = chat.messages ?? [];
  const at = messages.findIndex((m) => m.id === planId);
  const user = messages
    .slice(0, Math.max(0, at))
    .reverse()
    .find((m) => m.kind === 'user');
  return user?.kind === 'user' ? (user.images ?? []) : [];
}

/** Runs a plan (or continues a previous run's session with more commands allowed). */
async function runTask(dir: string, planId: string, plan: Plan, resume: { sessionId: string; allowed: string[] } | null): Promise<void> {
  const p = project(dir);
  const chat = chatOfMessage(p, planId);
  if (!p?.info || !chat) return;
  const chatId = chat.id;
  const runId = newId('run');
  addMessage(dir, chatId, { id: runId, kind: 'run', at: Date.now(), planId, ...emptyRun(plan, resume !== null) });
  if (!orchestratorEnabled()) {
    update(dir, runId, (m) => (m.kind === 'run' ? { ...m, status: 'error', error: DISABLED } : m));
    return;
  }
  setBusy(dir, { kind: 'run', messageId: runId, chatId });
  try {
    const commands = allowedCommands(p.info.commands, orch().allowedCommands, [...p.prefs.allowed, ...(resume?.allowed ?? [])]);
    const built = resume
      ? { text: continuePrompt(resume.allowed), found: {} }
      : buildBrief({ plan, projectName: p.info.name, decisions: p.decisions, hasAgentsMd: p.info.instructions.agents !== null, commands }, redactExtra());
    // A continuation resumes the session, which already has the images.
    const images = resume ? [] : imagesOfPlan(chat, planId);
    const sent = await finalizeSent({
      kind: 'task',
      agent: plan.agent,
      model: plan.model,
      effort: plan.effort,
      system: null,
      prompt: built.text,
      redactions: built.found,
      ...(images.length ? { images } : {}),
    });
    update(dir, runId, (m) => (m.kind === 'run' ? { ...m, sent } : m));
    const snapshot = await orchSnapshot(p.info.dir).catch(() => null);
    const last = await runStream(dir, runId, 'work', plan, sent.prompt, commands, resume?.sessionId ?? null, images);
    const run = findMessage(dir, runId)?.message;
    const activity = run?.kind === 'run' ? run.activity : [];
    const diff = snapshot !== null ? await orchDiff(snapshot, touchedFiles(activity)).catch(() => null) : null;
    const status: RunInfo['status'] = last.kind === 'done' ? 'done' : last.code === 'cancelled' || cancelled.has(runId) ? 'cancelled' : 'error';
    const hasAgentsMd = project(dir)?.info?.instructions.agents != null;
    update(dir, runId, (m) => {
      if (m.kind !== 'run') return m;
      if (last.kind === 'done') {
        const denials = [...m.denials];
        for (const d of last.denials) if (!denials.some((x) => x.tool === d.tool && x.target === d.target)) denials.push(d);
        // The summary without the line that says AGENTS.md is out of date: that becomes an offer.
        const { body, agentsStale } = parseWorkerResult(last.result);
        return {
          ...m,
          status,
          result: body,
          sessionId: last.sessionId ?? m.sessionId,
          usage: last.usage,
          denials,
          diff,
          agentsStale: agentsStale && hasAgentsMd ? { reason: agentsStale, status: 'offered' } : null,
        };
      }
      return { ...m, status, error: status === 'cancelled' ? null : { code: last.code, message: last.message }, usage: last.usage, diff };
    });
    const finished = findMessage(dir, runId)?.message;
    if (finished?.kind === 'run') {
      const decision = decisionOf(plan, finished, Date.now());
      patchProject(dir, (pp) => ({ decisions: [...pp.decisions, decision] }));
      scheduleSave(dir, chatId);
    }
    // The worker may have changed the project's scripts or its instructions.
    void refreshProject(dir);
  } finally {
    if (project(dir)?.busy?.messageId === runId) setBusy(dir, null);
  }
}

/** A worker's events into its run message. */
function runStream(dir: string, runId: string, mode: TaskMode, plan: Plan, prompt: string, commands: string[], resume: string | null, images: string[]) {
  const base = project(dir)?.info?.dir ?? dir;
  return stream(
    runId,
    (onEvent) =>
      orchRun(
        {
          agent: plan.agent,
          dir: base,
          prompt,
          model: plan.model,
          effort: plan.effort,
          resume,
          mode,
          allowedCommands: commands,
          maxTurns: orch().maxTurns,
          agentPath: agentPath(),
          images,
        },
        onEvent,
      ),
    (event) =>
      update(dir, runId, (m) => {
        if (m.kind !== 'run') return m;
        return { ...m, ...applyEvent(m, event, base) };
      }),
  );
}

/** One worker event on a run (or an AGENTS.md draft). */
function applyEvent(run: Pick<RunInfo, 'activity' | 'text' | 'denials' | 'sessionId'>, event: TaskEvent, base: string): Partial<RunInfo> {
  switch (event.kind) {
    case 'started':
      return { sessionId: event.sessionId ?? run.sessionId };
    case 'text':
      return { text: run.text + event.text };
    case 'tool': {
      const target = event.action === 'command' || event.action === 'search' ? event.target : relativeTo(base, event.target);
      const item: ActivityItem = { id: event.id, action: event.action, tool: event.tool, target, ok: null };
      return { activity: [...run.activity, item] };
    }
    case 'toolDone':
      return { activity: run.activity.map((a) => (a.id === event.id ? { ...a, ok: event.ok } : a)) };
    case 'denied': {
      const d = event.denial;
      if (run.denials.some((x) => x.tool === d.tool && x.target === d.target)) return {};
      return { denials: [...run.denials, { ...d, target: d.action === 'command' ? d.target : relativeTo(base, d.target) }] };
    }
    default:
      return {};
  }
}

/**
 * A denied command: "Permitir y continuar" (this run only) or "Permitir siempre" (this project,
 * kept in Brisa's config folder) resume the worker's session with it allowed.
 */
export async function allowDenials(dir: string, runId: string, always: boolean): Promise<void> {
  const p = project(dir);
  const found = findMessage(dir, runId);
  const run = found?.message;
  if (!p || !found || run?.kind !== 'run' || !run.sessionId || p.busy) return;
  const planMessage = found.chat.messages?.find((m) => m.id === run.planId);
  const plan = planMessage?.kind === 'plan' ? planMessage.plan : null;
  const patterns = [...new Set(run.denials.flatMap((d) => d.allow))];
  if (!plan || patterns.length === 0) return;
  update(dir, runId, (m) => (m.kind === 'run' ? { ...m, denials: [] } : m));
  if (always) {
    patchProject(dir, (pp) => ({ prefs: { ...pp.prefs, allowed: [...new Set([...pp.prefs.allowed, ...patterns])] } }));
    note(dir, found.chat.id, `Permitido siempre en este proyecto: ${patterns.map((x) => `\`${x}\``).join(', ')}.`);
  }
  await runTask(dir, run.planId ?? '', { ...plan, model: run.model, effort: run.effort }, { sessionId: run.sessionId, allowed: always ? [] : patterns });
}

export function ignoreDenials(dir: string, runId: string): void {
  const found = findMessage(dir, runId);
  if (!found) return;
  update(dir, runId, (m) => (m.kind === 'run' ? { ...m, denials: [] } : m));
  note(dir, found.chat.id, 'No se permitió: el agente no lo ejecutó.');
}

/** "Reintentar" a failed or cancelled plan with the same message (and its images). */
export async function retryPlan(dir: string, planId: string): Promise<void> {
  const p = project(dir);
  const found = findMessage(dir, planId);
  if (!p || !found || p.busy) return;
  const messages = found.chat.messages ?? [];
  const at = messages.findIndex((m) => m.id === planId);
  const user = messages
    .slice(0, at)
    .reverse()
    .find((m) => m.kind === 'user');
  if (user?.kind === 'user') {
    if (p.activeChat !== found.chat.id) openChat(dir, found.chat.id);
    await sendMessage(dir, user.text, user.images ?? []);
  }
}

// ---------------------------------------------------------------- AGENTS.md / CLAUDE.md

/**
 * A read-only worker writes AGENTS.md: the first draft, or the file updated after a task that
 * left it out of date. The result is shown (editable) before anything is written.
 */
async function analyzeAgentsMd(dir: string, purpose: DraftState['purpose'], prompt: string, runId: string | null): Promise<void> {
  const p = project(dir);
  if (!p?.info || p.busy) return;
  const draft: DraftState = { status: 'running', purpose, activity: [], text: '', usage: null, error: null };
  patchProject(dir, () => ({ draft }));
  if (!orchestratorEnabled()) {
    patchProject(dir, () => ({ draft: { ...draft, status: 'error', error: DISABLED } }));
    return;
  }
  const draftId = newId('draft');
  setBusy(dir, { kind: 'draft', messageId: draftId, chatId: null });
  const base = p.info.dir;
  const model = mainModel(dir);
  const efforts = claude()?.models.find((m) => m.value === model)?.efforts ?? [];
  const effort = efforts.includes('medium') ? 'medium' : null;
  try {
    const last = await stream(
      draftId,
      (onEvent) => orchRun({ agent: 'claude', dir: base, prompt, model, effort, resume: null, mode: 'analyze', allowedCommands: [], maxTurns: orch().maxTurns, agentPath: agentPath() }, onEvent),
      (event) =>
        patchProject(dir, (pp) => {
          const d = pp.draft;
          if (!d) return {};
          const next = applyEvent({ activity: d.activity, text: d.text, denials: [], sessionId: null }, event, base);
          return { draft: { ...d, activity: next.activity ?? d.activity, text: next.text ?? d.text } };
        }),
    );
    if (last.kind === 'done') {
      patchProject(dir, (pp) => ({ draft: pp.draft && { ...pp.draft, status: 'ready', text: markdownAnswer(last.result), usage: last.usage } }));
      showInstructions(dir, 'agents', markdownAnswer(last.result), runId);
    } else {
      const status = last.code === 'cancelled' || cancelled.has(draftId) ? 'cancelled' : 'error';
      patchProject(dir, (pp) => ({ draft: pp.draft && { ...pp.draft, status, error: status === 'error' ? { code: last.code, message: last.message } : null, usage: last.usage } }));
    }
  } finally {
    if (project(dir)?.busy?.messageId === draftId) setBusy(dir, null);
  }
}

/** Drafts AGENTS.md with a read-only worker; the draft is shown before anything is written. */
export function draftAgentsMd(dir: string): Promise<void> {
  return analyzeAgentsMd(dir, 'create', AGENTS_DRAFT_PROMPT, null);
}

/** "Actualizar AGENTS.md…" after a task said it went out of date. */
export function updateAgentsMd(dir: string, runId: string): Promise<void> {
  const run = findMessage(dir, runId)?.message;
  if (run?.kind !== 'run' || !run.agentsStale) return Promise.resolve();
  return analyzeAgentsMd(dir, 'update', agentsUpdatePrompt(run.agentsStale.reason), runId);
}

export function dismissAgentsStale(dir: string, runId: string): void {
  update(dir, runId, (m) => (m.kind === 'run' && m.agentsStale ? { ...m, agentsStale: { ...m.agentsStale, status: 'dismissed' } } : m));
}

/** Opens the confirmation with the exact text to write. */
export function showInstructions(dir: string, file: 'agents' | 'claude', content: string, runId: string | null = null): void {
  const info = project(dir)?.info;
  if (!info) return;
  const current = file === 'agents' ? info.instructions.agents : info.instructions.claude;
  useOrchestrator.setState({
    dialog: {
      kind: 'instructions',
      dir,
      file,
      path: current?.path ?? (file === 'agents' ? 'AGENTS.md' : 'CLAUDE.md'),
      content,
      expected: current?.content ?? null,
      error: null,
      writing: false,
      runId,
    },
  });
}

/** CLAUDE.md: a minimal one that imports AGENTS.md, or the import added to the existing one. */
export function offerClaudeMd(dir: string): void {
  const claudeMd = project(dir)?.info?.instructions.claude;
  showInstructions(dir, 'claude', claudeMd ? withAgentsImport(claudeMd.content) : MINIMAL_CLAUDE_MD);
}

export function editDialogContent(content: string): void {
  useOrchestrator.setState((s) => (s.dialog?.kind === 'instructions' ? { dialog: { ...s.dialog, content } } : s));
}

export function closeDialog(): void {
  useOrchestrator.setState({ dialog: null });
}

/** Writes what the dialog shows (the user confirmed it). Never commits. */
export async function confirmInstructions(): Promise<void> {
  const dialog = store().dialog;
  if (dialog?.kind !== 'instructions' || dialog.writing) return;
  useOrchestrator.setState({ dialog: { ...dialog, writing: true, error: null } });
  try {
    const instructions = await orchWriteInstructions(dialog.dir, dialog.file, dialog.content, dialog.expected);
    patchProject(dialog.dir, (p) => ({ info: p.info && { ...p.info, instructions }, draft: dialog.file === 'agents' ? null : p.draft }));
    useOrchestrator.setState({ dialog: null });
    const runId = dialog.runId;
    if (runId) update(dialog.dir, runId, (m) => (m.kind === 'run' && m.agentsStale ? { ...m, agentsStale: { ...m.agentsStale, status: 'done' } } : m));
    const chatId = (runId ? chatOfMessage(project(dialog.dir), runId)?.id : null) ?? project(dialog.dir)?.activeChat;
    if (chatId) note(dialog.dir, chatId, dialog.expected === null ? `Se creó ${dialog.path} (sin commit).` : `Se actualizó ${dialog.path} (sin commit).`);
    // After AGENTS.md, Claude Code needs CLAUDE.md to read it.
    if (dialog.file === 'agents' && !instructions.claudeImportsAgents) offerClaudeMd(dialog.dir);
  } catch (error) {
    const current = store().dialog;
    if (current?.kind === 'instructions') useOrchestrator.setState({ dialog: { ...current, writing: false, error: String(error) } });
  }
}

export function showSent(sent: Sent | null): void {
  if (sent) useOrchestrator.setState({ dialog: { kind: 'sent', sent } });
}

// ---------------------------------------------------------------- tabs

/** The folder of the active pane (or of the explorer's root when nothing better is known). */
function activeFolder(): string | null {
  const ws = useWorkspace.getState();
  const pane = ws.panes[selectActivePaneId(ws) ?? ''];
  return pane?.cwd ?? pane?.startCwd ?? profileFor(pane?.profile ?? null)?.cwd ?? null;
}

/** "Abrir orquestador aquí": the project's tab if open, else a new one for the active folder. */
export function openOrchestrator(dir: string | null = activeFolder()): void {
  if (!orchestratorEnabled()) {
    useUi.getState().showToast('El modo orquestador está desactivado (orchestrator.enabled).');
    return;
  }
  if (!dir) {
    useUi.getState().showToast('No hay una carpeta para el orquestador: abrí una terminal en el proyecto.');
    return;
  }
  const ws = useWorkspace.getState();
  const existing = Object.values(ws.panes).find((x) => x.kind === 'orchestrator' && x.cwd && projectKey(x.cwd) === projectKey(dir));
  const existingTab = existing ? tabOfPane(ws, existing.id) : null;
  // The sidebar starts on the chats of the project.
  useOrchestrator.setState({ sidebarView: 'chats' });
  if (existingTab) {
    ws.activateTab(existingTab);
    return;
  }
  ws.newTab({ kind: 'orchestrator', cwd: dir });
}

/** The orchestrator pane's input, for focus after switching tabs. */
export function focusOrchestrator(paneId: PaneId): boolean {
  const input = document.querySelector<HTMLTextAreaElement>(`textarea[data-orch-input="${CSS.escape(paneId)}"]`);
  if (!input || input.offsetParent === null) return false;
  input.focus();
  return document.activeElement === input;
}

// ---------------------------------------------------------------- lifecycle

/**
 * Keeps the backend in step with `orchestrator.enabled` (it refuses to launch anything while
 * off) and cancels what a closed orchestrator tab was running. Returns the uninstaller.
 */
export function installOrchestrator(): () => void {
  let applied: boolean | null = null;
  const apply = () => {
    if (!useSettings.getState().loaded) return;
    const enabled = orchestratorEnabled();
    if (enabled === applied) return;
    applied = enabled;
    void orchConfigure(enabled).catch((error: unknown) => console.warn('[brisa] orch_configure', error));
    if (!enabled) {
      for (const p of Object.values(store().projects)) cancelBusy(p.dir);
      useOrchestrator.setState({ dialog: null });
    } else if (Object.keys(store().projects).length) {
      void detectAgents();
    }
  };
  void initSettings().then(apply);
  const unsubscribeSettings = useSettings.subscribe(apply);
  const unsubscribePanes = useWorkspace.subscribe((s, prev) => {
    if (s.panes === prev.panes) return;
    const open = new Set(
      Object.values(s.panes)
        .filter((p) => p.kind === 'orchestrator' && p.cwd)
        .map((p) => projectKey(p.cwd ?? '')),
    );
    for (const [key, p] of Object.entries(store().projects)) {
      if (open.has(key)) continue;
      // Its tab closed: stop what it runs and forget it (the files stay in the config folder).
      cancelBusy(p.dir);
      void saveNow(p.dir);
      useOrchestrator.setState((st) => {
        const projects = { ...st.projects };
        delete projects[key];
        return { projects };
      });
    }
  });
  return () => {
    unsubscribeSettings();
    unsubscribePanes();
  };
}

/** After an orchestrator action that leaves the chat (dialogs), the keyboard goes back. */
export function refocus(): void {
  focusActiveTerminal();
}

export { rankModels };
