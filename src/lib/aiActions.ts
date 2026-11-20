// The AI features: "Explicar / arreglar" on failed blocks, natural language to a command
// (Ctrl+I), the chat panel (Ctrl+Shift+I) and inserting what the AI suggests.
//
// Rules: with `ai.enabled: false` nothing here sends anything (and the backend refuses
// anyway); every piece of context is redacted before it is shown or sent (lib/aiPrompts.ts +
// the Rust environment pass), and what is shown in "Ver qué se envía" is byte for byte what is
// sent; nothing the AI suggests ever runs by itself (lib/aiSafety.ts).
import { selectGitFor, useGit } from '../store/git';
import { profileFor } from '../store/profiles';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import type { PaneId } from '../store/workspaceModel';
import { findTurn, isRunning, patchTurn, updateConversation, useAi, type AiTurn, type SentContext } from '../store/ai';
import { aiCancel, aiConfigure, aiQuery, aiScrubEnv, isFailure, type AiFailure, type AiMessage, type AiPayload } from './aiApi';
import {
  chatMessage,
  commandPrompt,
  EFFORT,
  explainPrompt,
  flattenChat,
  recentHistory,
  SYSTEM_PROMPTS,
  type AiKind,
  type BlockContext,
  type Built,
  type ChatMessage,
  type TerminalContext,
} from './aiPrompts';
import { prepareInsert } from './aiSafety';
import { blockText, paneBlocks } from './blockActions';
import { gitStatus } from './fsApi';
import { initSettings } from './settingsSync';
import { focusActiveTerminal } from './tabActions';
import { getPane } from './terminalRegistry';

/** Room for the model's (adaptive) thinking plus a short answer. */
const MAX_TOKENS = 16_000;

const ai = () => useSettings.getState().settings.ai;
export const aiEnabled = (): boolean => ai().enabled;
const ws = () => useWorkspace.getState();

let nextId = 0;
const newId = (prefix: string) => `${prefix}-${++nextId}`;

/** Turn → backend request id (once `ai_query` answered). */
const requests = new Map<string, number>();
/** Turns cancelled before their request id arrived. */
const cancelled = new Set<string>();

const SHELL_NAMES: Record<string, string> = {
  powershell: 'Windows PowerShell',
  pwsh: 'PowerShell 7',
  cmd: 'Símbolo del sistema (cmd)',
  gitbash: 'Git Bash',
  wsl: 'WSL',
  other: 'shell',
};

// ---------------------------------------------------------------- context

async function branchOf(cwd: string | null): Promise<string | null> {
  if (!cwd) return null;
  const known = selectGitFor(cwd)(useGit.getState());
  const status =
    known ??
    (await Promise.race([gitStatus(cwd).catch(() => null), new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 2500))]));
  if (!status) return null;
  return status.branch ?? (status.commit ? `HEAD separado en ${status.commit}` : null);
}

/** Shell, folder and branch of a pane. */
export async function terminalContext(paneId: PaneId): Promise<TerminalContext> {
  const pane = ws().panes[paneId];
  const cwd = pane?.cwd ?? pane?.startCwd ?? null;
  const shell = pane?.shell ?? null;
  const profile = profileFor(pane?.profile ?? null);
  return {
    shell,
    shellName: profile?.name ?? SHELL_NAMES[shell ?? 'other'] ?? 'shell',
    cwd,
    gitBranch: await branchOf(cwd),
  };
}

const blockContext = (paneId: PaneId, blockId: number): BlockContext | null => {
  const block = blockText(paneId, blockId);
  return block ? { command: block.command, output: block.output, exitCode: block.exitCode, cwd: block.cwd } : null;
};

/**
 * The exact payload: provider-specific messages (the CLI gets one prompt), then Rust's pass
 * over the app's sensitive environment variables.
 */
async function finalize(kind: AiKind, messages: ChatMessage[], found: Record<string, number>): Promise<SentContext> {
  const settings = ai();
  const shaped: AiMessage[] = settings.provider === 'claude-cli' ? [{ role: 'user', content: flattenChat(messages) }] : messages;
  const scrubbed = await aiScrubEnv(shaped.map((m) => m.content)).catch(() => null);
  const payload: AiPayload = {
    provider: settings.provider,
    model: settings.model.trim(),
    system: SYSTEM_PROMPTS[kind],
    messages: shaped.map((m, i) => ({ role: m.role, content: scrubbed?.texts[i] ?? m.content })),
    effort: EFFORT[kind],
    maxTokens: MAX_TOKENS,
    claudePath: settings.claudePath.trim() || null,
  };
  const redactions = { ...found };
  if (scrubbed?.count) redactions.env_var = (redactions.env_var ?? 0) + scrubbed.count;
  return { payload, redactions, envNames: scrubbed?.names ?? [] };
}

// ---------------------------------------------------------------- running a turn

function newTurn(kind: AiKind, paneId: PaneId, question: string): AiTurn {
  return { id: newId('turn'), kind, paneId, question, prompt: null, sent: null, status: 'thinking', text: '', note: null, error: null };
}

const failTurn = (turnId: string, failure: AiFailure) =>
  patchTurn(turnId, () => (failure.code === 'cancelled' ? { status: 'cancelled', error: null } : { status: 'error', error: failure }));

/** Sends a turn whose `sent` is set; text streams into it. */
async function run(turn: AiTurn): Promise<void> {
  const sent = turn.sent;
  if (!sent) return;
  if (!aiEnabled()) {
    failTurn(turn.id, { code: 'disabled', message: 'La IA está desactivada (ai.enabled: false).' });
    return;
  }
  // Deltas arrive in bursts: one store update per frame.
  let pending = '';
  let frame = 0;
  const flush = () => {
    frame = 0;
    if (!pending || cancelled.has(turn.id)) return;
    const text = pending;
    pending = '';
    patchTurn(turn.id, (t) => ({ text: t.text + text, status: 'streaming' }));
  };
  try {
    const id = await aiQuery(sent.payload, (event) => {
      if (cancelled.has(turn.id)) return;
      if (event.kind === 'delta') {
        pending += event.text;
        if (!frame) frame = requestAnimationFrame(flush);
      } else if (event.kind === 'status') {
        patchTurn(turn.id, () => ({ note: event.message }));
      } else {
        cancelAnimationFrame(frame);
        flush();
        requests.delete(turn.id);
        if (event.kind === 'done') patchTurn(turn.id, () => ({ status: 'done', note: null }));
        else failTurn(turn.id, { code: event.code, message: event.message });
      }
    });
    requests.set(turn.id, id);
    if (cancelled.has(turn.id)) void aiCancel(id);
  } catch (error) {
    failTurn(turn.id, isFailure(error) ? error : { code: 'failed', message: String(error) });
  }
}

export function cancelTurn(turnId: string): void {
  const turn = findTurn(turnId);
  if (!isRunning(turn)) return;
  cancelled.add(turnId);
  const id = requests.get(turnId);
  if (id !== undefined) void aiCancel(id);
  patchTurn(turnId, () => ({ status: 'cancelled', note: null }));
}

/**
 * Esc in a terminal: cancels the pane's running query, but only when the shell sits idle at its
 * prompt (known through the integration): never a key a command, a full-screen program or an
 * agent is waiting for.
 */
export function cancelPaneQuery(paneId: PaneId | null): boolean {
  if (!paneId) return false;
  const turn = useAi.getState().conversations[paneId]?.turns.find(isRunning);
  const pane = ws().panes[paneId];
  if (!turn || !pane || pane.integration !== 'ok' || pane.commandRunning) return false;
  if (pane.agent && pane.agent.state !== 'finished') return false;
  if (getPane(paneId)?.term.buffer.active.type === 'alternate') return false;
  cancelTurn(turn.id);
  return true;
}

function cancelAll(): void {
  const s = useAi.getState();
  const turns = [...Object.values(s.conversations).flatMap((c) => c.turns), ...(s.bar?.turn ? [s.bar.turn] : [])];
  for (const turn of turns) if (isRunning(turn)) cancelTurn(turn.id);
}

/** A turn of a pane's conversation: shown at once ("pensando"), sent once its context is ready. */
async function converse(paneId: PaneId, turn: AiTurn, build: () => Promise<{ messages: ChatMessage[]; found: Record<string, number>; own: string }>): Promise<void> {
  updateConversation(paneId, (c) => ({ ...c, turns: [...c.turns, turn] }));
  try {
    const { messages, found, own } = await build();
    const sent = await finalize(turn.kind, messages, found);
    if (cancelled.has(turn.id)) return;
    patchTurn(turn.id, () => ({ sent, prompt: own }));
    await run({ ...turn, sent });
  } catch (error) {
    failTurn(turn.id, { code: 'failed', message: String(error) });
  }
}

// ---------------------------------------------------------------- explain / fix

/** "Explicar / arreglar": the block, its output and its context go to the AI; the answer streams in the panel. */
export async function explainBlock(paneId: PaneId, blockId: number): Promise<void> {
  if (!aiEnabled()) return;
  const block = blockContext(paneId, blockId);
  if (!block) {
    useUi.getState().showToast('Ese bloque ya no está en el historial de la terminal.', 'warning');
    return;
  }
  ws().focusPane(paneId);
  useAi.setState({ panelOpen: true });
  const turn = newTurn('explain', paneId, `Explicar / arreglar: ${block.command}${block.exitCode !== null ? ` (código ${block.exitCode})` : ''}`);
  await converse(paneId, turn, async () => {
    const built = explainPrompt(await terminalContext(paneId), block, ai().redact);
    return { messages: [{ role: 'user', content: built.text }], found: built.found, own: built.text };
  });
  focusActiveTerminal();
}

/** The last failed block of the active pane. */
export function explainLastFailed(): void {
  const paneId = selectActivePaneId(ws());
  const failed = paneId ? paneBlocks(paneId).filter((b) => b.exitCode !== null && b.exitCode !== 0).at(-1) : undefined;
  if (!paneId || !failed) {
    useUi.getState().showToast('No hay ningún comando fallido en este panel.', 'info');
    return;
  }
  void explainBlock(paneId, failed.id);
}

// ---------------------------------------------------------------- chat

export function togglePanel(): void {
  const open = !useAi.getState().panelOpen;
  useAi.setState((s) => ({ panelOpen: open, inputRequest: open ? s.inputRequest + 1 : s.inputRequest }));
  if (!open) focusActiveTerminal();
}

export function closePanel(): void {
  useAi.setState({ panelOpen: false });
  focusActiveTerminal();
}

/** "Agregar al chat": the block becomes context of the next question in this pane's chat. */
export function attachBlock(paneId: PaneId, blockId: number): void {
  if (!aiEnabled()) return;
  const block = blockContext(paneId, blockId);
  if (!block) {
    useUi.getState().showToast('Ese bloque ya no está en el historial de la terminal.', 'warning');
    return;
  }
  ws().focusPane(paneId);
  updateConversation(paneId, (c) =>
    c.attachments.some((a) => a.blockId === blockId) ? c : { ...c, attachments: [...c.attachments, { id: newId('att'), blockId, block }] },
  );
  useAi.setState((s) => ({ panelOpen: true, inputRequest: s.inputRequest + 1 }));
}

export function detachBlock(paneId: PaneId, attachmentId: string): void {
  updateConversation(paneId, (c) => ({ ...c, attachments: c.attachments.filter((a) => a.id !== attachmentId) }));
}

/** The conversation so far, as the model saw it (finished turns only). */
function historyOf(paneId: PaneId): ChatMessage[] {
  const turns = useAi.getState().conversations[paneId]?.turns ?? [];
  const out: ChatMessage[] = [];
  for (const turn of turns) {
    if (turn.status !== 'done' || !turn.prompt || !turn.text) continue;
    out.push({ role: 'user', content: turn.prompt }, { role: 'assistant', content: turn.text });
  }
  return out;
}

async function chatBuild(paneId: PaneId, question: string): Promise<{ messages: ChatMessage[]; found: Record<string, number>; own: string }> {
  const attachments = useAi.getState().conversations[paneId]?.attachments ?? [];
  const built: Built = chatMessage(await terminalContext(paneId), attachments.map((a) => a.block), question, ai().redact);
  const messages = recentHistory([...historyOf(paneId), { role: 'user', content: built.text }]);
  return { messages, found: built.found, own: built.text };
}

/** "Ver qué se envía" before sending: the payload the current question would send. */
export async function previewChat(paneId: PaneId, question: string): Promise<void> {
  const { messages, found } = await chatBuild(paneId, question || '(tu pregunta)');
  useAi.setState({ preview: await finalize('chat', messages, found) });
}

export async function sendChat(paneId: PaneId, question: string): Promise<void> {
  if (!aiEnabled() || !question.trim()) return;
  const attachments = useAi.getState().conversations[paneId]?.attachments ?? [];
  const label = attachments.length ? `${question.trim()}  (+${attachments.length} ${attachments.length === 1 ? 'bloque' : 'bloques'})` : question.trim();
  const turn = newTurn('chat', paneId, label);
  await converse(paneId, turn, async () => {
    const built = await chatBuild(paneId, question);
    updateConversation(paneId, (c) => ({ ...c, attachments: [] }));
    return built;
  });
}

// ---------------------------------------------------------------- command bar (Ctrl+I)

export function toggleCommandBar(paneId?: PaneId | null): void {
  const s = useAi.getState();
  if (s.bar) {
    closeCommandBar();
    return;
  }
  const target = paneId ?? selectActivePaneId(ws());
  if (!target) return;
  useAi.setState({ bar: { paneId: target, turn: null, askedFor: null } });
}

export function closeCommandBar(): void {
  const turn = useAi.getState().bar?.turn;
  if (turn && isRunning(turn)) cancelTurn(turn.id);
  useAi.setState({ bar: null });
  focusActiveTerminal();
}

async function commandSent(paneId: PaneId, request: string): Promise<SentContext> {
  const built = commandPrompt(await terminalContext(paneId), request, ai().redact);
  return finalize('command', [{ role: 'user', content: built.text }], built.found);
}

export async function previewCommand(paneId: PaneId, request: string): Promise<void> {
  useAi.setState({ preview: await commandSent(paneId, request || '(tu pedido)') });
}

/** Asks for a command for the bar's pane. */
export async function askCommand(request: string): Promise<void> {
  const bar = useAi.getState().bar;
  if (!bar || !aiEnabled() || !request.trim()) return;
  if (bar.turn && isRunning(bar.turn)) cancelTurn(bar.turn.id);
  const turn = newTurn('command', bar.paneId, request.trim());
  useAi.setState({ bar: { ...bar, turn, askedFor: request } });
  try {
    const sent = await commandSent(bar.paneId, request);
    if (cancelled.has(turn.id) || useAi.getState().bar?.turn?.id !== turn.id) return;
    patchTurn(turn.id, () => ({ sent }));
    await run({ ...turn, sent });
  } catch (error) {
    failTurn(turn.id, { code: 'failed', message: String(error) });
  }
}

// ---------------------------------------------------------------- inserting

/**
 * Writes a suggested command at the pane's prompt WITHOUT running it. Refused when the shell is
 * busy (a command, a full-screen program or an agent would receive it as input).
 */
export function insertCommand(paneId: PaneId, command: string): boolean {
  const pane = ws().panes[paneId];
  const handle = getPane(paneId);
  const refuse = (message: string) => {
    useUi.getState().showToast(message, 'warning');
    return false;
  };
  if (!pane || !handle || pane.status !== 'running') return refuse('Ese panel ya no tiene una shell en marcha: no se insertó nada.');
  if (pane.commandRunning) return refuse('Hay un comando en ejecución en ese panel: no se insertó nada.');
  if (pane.agent && pane.agent.state !== 'finished') return refuse('Hay un agente corriendo en ese panel: no se insertó nada.');
  if (handle.term.buffer.active.type === 'alternate') return refuse('Hay un programa de pantalla completa en ese panel: no se insertó nada.');
  const text = prepareInsert(command, pane.shell, handle.term.modes.bracketedPasteMode);
  if (!text) return false;
  ws().focusPane(paneId);
  handle.term.paste(text);
  focusActiveTerminal();
  return true;
}

// ---------------------------------------------------------------- preview dialog

export const openPreview = (sent: SentContext | null) => sent && useAi.setState({ preview: sent });
export const closePreview = () => useAi.setState({ preview: null });

// ---------------------------------------------------------------- lifecycle

/**
 * Keeps the backend in step with `ai.enabled` (it refuses to launch anything while off), and
 * drops the conversations of closed panes. Returns the uninstaller.
 */
export function installAi(): () => void {
  let applied: boolean | null = null;
  const apply = () => {
    if (!useSettings.getState().loaded) return;
    const enabled = aiEnabled();
    if (enabled === applied) return;
    applied = enabled;
    void aiConfigure(enabled).catch((error: unknown) => console.warn('[brisa] ai_configure', error));
    if (!enabled) {
      cancelAll();
      useAi.setState({ panelOpen: false, bar: null, preview: null });
    }
  };
  void initSettings().then(apply);
  const unsubscribeSettings = useSettings.subscribe(apply);
  const unsubscribePanes = useWorkspace.subscribe((s, prev) => {
    const state = useAi.getState();
    // The bar belongs to its pane: another tab or pane takes the keyboard, the bar goes.
    if (state.bar && selectActivePaneId(s) !== state.bar.paneId) closeCommandBar();
    if (s.panes === prev.panes) return;
    const gone = Object.keys(state.conversations).filter((id) => !s.panes[id]);
    if (state.bar && !s.panes[state.bar.paneId]) closeCommandBar();
    if (!gone.length) return;
    for (const id of gone) for (const turn of state.conversations[id]?.turns ?? []) if (isRunning(turn)) cancelTurn(turn.id);
    useAi.setState((a) => ({ conversations: Object.fromEntries(Object.entries(a.conversations).filter(([id]) => s.panes[id])) }));
  });
  return () => {
    unsubscribeSettings();
    unsubscribePanes();
  };
}
