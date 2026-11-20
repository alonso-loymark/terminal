import { create } from 'zustand';
import type { AiErrorCode, AiPayload } from '../lib/aiApi';
import type { AiKind, BlockContext } from '../lib/aiPrompts';
import type { PaneId } from './workspaceModel';

/** Exactly what a request sent (already redacted), for "Ver qué se envía". */
export interface SentContext {
  payload: AiPayload;
  /** Kind → how many secrets were hidden (frontend rules + Rust's environment pass). */
  redactions: Record<string, number>;
  /** Environment variables whose values were found (names only). */
  envNames: string[];
}

export type TurnStatus = 'thinking' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface AiTurn {
  id: string;
  kind: AiKind;
  paneId: PaneId;
  /** The user's side, as shown in the panel ("Explicar: npm test", a question). */
  question: string;
  /** This turn's own message to the model (redacted): the chat history is made of these. */
  prompt: string | null;
  sent: SentContext | null;
  status: TurnStatus;
  text: string;
  /** Informational (a retry, a fallback model). */
  note: string | null;
  error: { code: AiErrorCode; message: string } | null;
}

/** A block added to the chat as context: copied when added (it may leave the scrollback). */
export interface Attachment {
  id: string;
  blockId: number;
  block: BlockContext;
}

export interface Conversation {
  turns: AiTurn[];
  attachments: Attachment[];
}

export const AI_PANEL_DEFAULT = 380;
export const AI_PANEL_MIN = 260;

/** The command bar (Ctrl+I) over a pane, and its current proposal. */
export interface CommandBar {
  paneId: PaneId;
  turn: AiTurn | null;
  /** The text the proposal answers (typing something else asks again on Enter). */
  askedFor: string | null;
}

/**
 * The AI panel (Ctrl+Shift+I), one short conversation per pane, the command bar and the "what
 * is sent" dialog. Serializable state only: request ids and timers live in lib/aiActions.ts.
 */
interface AiState {
  panelOpen: boolean;
  panelWidth: number;
  conversations: Record<PaneId, Conversation>;
  bar: CommandBar | null;
  preview: SentContext | null;
  /** Bumped to move the keyboard to the panel's input. */
  inputRequest: number;
}

export const useAi = create<AiState>()(() => ({
  panelOpen: false,
  panelWidth: AI_PANEL_DEFAULT,
  conversations: {},
  bar: null,
  preview: null,
  inputRequest: 0,
}));

const EMPTY: Conversation = { turns: [], attachments: [] };

export const conversationOf = (s: AiState, paneId: PaneId | null): Conversation => (paneId ? (s.conversations[paneId] ?? EMPTY) : EMPTY);

export function updateConversation(paneId: PaneId, fn: (c: Conversation) => Conversation): void {
  useAi.setState((s) => ({ conversations: { ...s.conversations, [paneId]: fn(s.conversations[paneId] ?? EMPTY) } }));
}

/** Changes a turn wherever it is (a conversation or the command bar). */
export function patchTurn(turnId: string, patch: (turn: AiTurn) => Partial<AiTurn>): void {
  useAi.setState((s) => {
    if (s.bar?.turn?.id === turnId) return { bar: { ...s.bar, turn: { ...s.bar.turn, ...patch(s.bar.turn) } } };
    for (const [paneId, conversation] of Object.entries(s.conversations)) {
      const i = conversation.turns.findIndex((t) => t.id === turnId);
      if (i < 0) continue;
      const turns = conversation.turns.slice();
      const turn = turns[i] as AiTurn;
      turns[i] = { ...turn, ...patch(turn) };
      return { conversations: { ...s.conversations, [paneId]: { ...conversation, turns } } };
    }
    return {};
  });
}

export function findTurn(turnId: string): AiTurn | null {
  const s = useAi.getState();
  if (s.bar?.turn?.id === turnId) return s.bar.turn;
  for (const conversation of Object.values(s.conversations)) {
    const turn = conversation.turns.find((t) => t.id === turnId);
    if (turn) return turn;
  }
  return null;
}

export const isRunning = (turn: AiTurn | null | undefined): boolean => turn?.status === 'thinking' || turn?.status === 'streaming';
