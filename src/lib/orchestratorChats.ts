// The orchestrator's chats (ronda 1 del rediseño): a project has several, each with its own
// context (the planner only sees that chat's messages); the decision log and the preferences
// stay per project. Pure: the index file, titles, search, totals and the migration of the single
// chat of before (Fase 8A). No runtime imports besides other pure modules (node --test).
import { fuzzyMatch } from './fuzzy.ts';
import { redact } from './redact.ts';
import type { OrchMessage } from './orchestratorModel.ts';

export interface ChatMeta {
  /** Lowercase letters, digits and dashes: it names the chat's file (Rust checks it too). */
  id: string;
  title: string;
  /** auto: from the first message; plan: suggested by the planner in its answer; user: renamed. */
  titleFrom: 'auto' | 'plan' | 'user';
  createdAt: number;
  updatedAt: number;
  /** How many messages it has (an empty chat is not saved). */
  count: number;
  /** The user's messages, flattened: searching does not load every chat. */
  search: string;
  costUsd: number;
  tokens: number;
}

export const CHATS_VERSION = 1;
/** Kept in the index: the user's text of a chat, enough to find it. */
const MAX_SEARCH = 4000;
const MAX_TITLE = 48;
export const NEW_CHAT_TITLE = 'Chat nuevo';

let seq = 0;
/** `chat-<time>-<n>`: unique in this process, valid as a file name. */
export const newChatId = (now = Date.now()): string => `chat-${now.toString(36)}-${(++seq).toString(36)}`;

export const validChatId = (id: string): boolean => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);

export function emptyChat(now = Date.now(), id = newChatId(now)): ChatMeta {
  return { id, title: NEW_CHAT_TITLE, titleFrom: 'auto', createdAt: now, updatedAt: now, count: 0, search: '', costUsd: 0, tokens: 0 };
}

/**
 * A title from the first message, without asking any model: the first sentence (or line), without
 * a leading `@modelo`, cut at a word near 48 characters, with secrets redacted (it shows in the
 * sidebar and lives in the config folder).
 */
export function chatTitle(text: string, extra: readonly string[] = []): string {
  let t = text.replace(/^\s*@[A-Za-z][\w.[\]-]*\s*/, '');
  t = redact(t, { extra }).text;
  // The first line, then the first sentence of it.
  t = (t.split(/\r?\n/).find((line) => line.trim()) ?? '').trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(t);
  if (sentence?.[1] && sentence[1].length >= 12) t = sentence[1];
  t = t.replace(/[.!?:;,]+$/, '').replace(/\s+/g, ' ').trim();
  if (!t) return NEW_CHAT_TITLE;
  if ([...t].length > MAX_TITLE) {
    const cut = [...t].slice(0, MAX_TITLE).join('');
    const space = cut.lastIndexOf(' ');
    t = `${(space > MAX_TITLE * 0.5 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, '')}…`;
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** A title the planner suggested: one short line, or nothing. */
export function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[`*_#]/g, '')
    .replace(/^["'«“\s]+|["'»”\s.]+$/g, '')
    .trim();
  if (!t || [...t].length > 60) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** What the index keeps of a chat's messages: count, the user's text, cost and tokens. */
export function chatStats(messages: readonly OrchMessage[]): Pick<ChatMeta, 'count' | 'search' | 'costUsd' | 'tokens'> {
  let costUsd = 0;
  let tokens = 0;
  const texts: string[] = [];
  for (const m of messages) {
    if (m.kind === 'user') texts.push(m.text);
    if ((m.kind === 'plan' || m.kind === 'run') && m.usage) {
      costUsd += m.usage.costUsd;
      tokens += m.usage.inputTokens + m.usage.cacheReadTokens + m.usage.cacheCreationTokens + m.usage.outputTokens;
    }
  }
  return { count: messages.length, search: texts.join('\n').slice(0, MAX_SEARCH), costUsd, tokens };
}

/** Newest activity first. */
export const sortChats = <T extends ChatMeta>(chats: readonly T[]): T[] => [...chats].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);

/** The chats that match a query (title first, then what the user wrote), best first. */
export function searchChats<T extends ChatMeta>(chats: readonly T[], query: string): T[] {
  if (!query.trim()) return sortChats(chats);
  return chats
    .map((chat) => {
      const title = fuzzyMatch(query, chat.title);
      // In the text, every word must appear as such (a fuzzy match over 4000 characters
      // matches almost anything).
      const words = query.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(/\s+/).filter(Boolean);
      const body = chat.search.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
      const inText = words.length > 0 && words.every((w) => body.includes(w));
      const score = title ? 100 + title.score : inText ? 10 : null;
      return score === null ? null : { chat, score };
    })
    .filter((x): x is { chat: T; score: number } => x !== null)
    .sort((a, b) => b.score - a.score || b.chat.updatedAt - a.chat.updatedAt)
    .map((x) => x.chat);
}

export interface ChatIndex {
  chats: ChatMeta[];
  active: string | null;
}

/** The index as stored: chats with messages only (an empty "Chat nuevo" is not kept). */
export function serializeChats(chats: readonly ChatMeta[], active: string | null): string {
  const kept = sortChats(chats.filter((c) => c.count > 0));
  return `${JSON.stringify({ version: CHATS_VERSION, active: kept.some((c) => c.id === active) ? active : (kept[0]?.id ?? null), chats: kept }, null, 1)}\n`;
}

export function parseChats(text: string | null): ChatIndex | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as { version?: unknown; active?: unknown; chats?: unknown };
    if (value.version !== CHATS_VERSION || !Array.isArray(value.chats)) return null;
    const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const chats: ChatMeta[] = [];
    for (const raw of value.chats as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const c = raw as Record<string, unknown>;
      if (typeof c.id !== 'string' || !validChatId(c.id) || chats.some((x) => x.id === c.id)) continue;
      const titleFrom = c.titleFrom === 'plan' || c.titleFrom === 'user' ? c.titleFrom : 'auto';
      chats.push({
        id: c.id,
        title: typeof c.title === 'string' && c.title.trim() ? c.title : NEW_CHAT_TITLE,
        titleFrom,
        createdAt: num(c.createdAt),
        updatedAt: num(c.updatedAt, num(c.createdAt)),
        count: num(c.count),
        search: typeof c.search === 'string' ? c.search.slice(0, MAX_SEARCH) : '',
        costUsd: num(c.costUsd),
        tokens: num(c.tokens),
      });
    }
    const active = typeof value.active === 'string' && chats.some((c) => c.id === value.active) ? value.active : (sortChats(chats)[0]?.id ?? null);
    return { chats, active };
  } catch {
    return null;
  }
}

/** The single chat of before (conversation.json) as the project's first chat. */
export function migratedChat(messages: readonly OrchMessage[], id: string, now = Date.now()): ChatMeta {
  const first = messages.find((m) => m.kind === 'user');
  const times = messages.map((m) => m.at).filter((t) => typeof t === 'number' && t > 0);
  return {
    id,
    title: first?.kind === 'user' ? chatTitle(first.text) : NEW_CHAT_TITLE,
    titleFrom: 'auto',
    createdAt: times.length ? Math.min(...times) : now,
    updatedAt: times.length ? Math.max(...times) : now,
    ...chatStats(messages),
  };
}

/** A title for a renamed chat: one line, not empty, not too long. */
export function renamedTitle(raw: string): string | null {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return [...t].slice(0, 80).join('');
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** When a chat was last active, short: "recién", "hace 5 min", "hace 3 h", "ayer", "12 nov". */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'recién';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return `hace ${hours} h`;
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} días`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('es', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}
