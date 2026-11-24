import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Usage } from './agentsApi.ts';
import {
  chatStats,
  chatTitle,
  cleanTitle,
  emptyChat,
  migratedChat,
  newChatId,
  parseChats,
  relativeTime,
  renamedTitle,
  searchChats,
  serializeChats,
  validChatId,
  type ChatMeta,
} from './orchestratorChats.ts';
import type { OrchMessage } from './orchestratorModel.ts';

const usage = (costUsd: number, input = 100, output = 50): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd,
  durationMs: 0,
  turns: 1,
  models: [],
});

test('a title from the first message, without any model', () => {
  assert.equal(chatTitle('renombrá la variable total en src/app.js'), 'Renombrá la variable total en src/app.js');
  assert.equal(chatTitle('@opus arreglá el bug del login. Después vemos los tests.'), 'Arreglá el bug del login');
  assert.equal(chatTitle('\n\n  agregá tests\ncon más detalle abajo'), 'Agregá tests');
  const long = chatTitle('quiero que revises toda la arquitectura del módulo de pagos y propongas cómo separarlo en servicios');
  assert.ok(long.length <= 49 && long.endsWith('…') && !long.includes(' …'), long);
  // Secrets never end up in the sidebar.
  const token = ['ghp_', 'Orq81Kd93LmXp02Qw7Er4Ty6Ui8Op1As3Df5'].join('');
  assert.ok(!chatTitle(`usá el token ${token}`).includes(token));
  assert.equal(chatTitle('   '), 'Chat nuevo');
  assert.equal(cleanTitle('  "Renombrar total"  '), 'Renombrar total');
  assert.equal(cleanTitle('**Tests** del\ncontador'), 'Tests del contador');
  assert.equal(cleanTitle(42), null);
  assert.equal(cleanTitle('x'.repeat(61)), null);
  assert.equal(renamedTitle('  Mi   chat  '), 'Mi chat');
  assert.equal(renamedTitle('   '), null);
});

test('chat ids are valid file names', () => {
  const a = newChatId(1_700_000_000_000);
  const b = newChatId(1_700_000_000_000);
  assert.notEqual(a, b);
  assert.ok(validChatId(a) && validChatId(b), a);
  for (const bad of ['', '-x', 'A', '../x', 'a/b', 'a.json']) assert.ok(!validChatId(bad), bad);
});

const messages: OrchMessage[] = [
  { id: 'u1', kind: 'user', at: 1000, text: 'agregá un test', forced: null },
  { id: 'p1', kind: 'plan', at: 1001, status: 'approved', plan: null, chosen: false, usage: usage(0.002), error: null, sent: null, text: '' },
  {
    id: 'r1',
    kind: 'run',
    at: 1002,
    planId: 'p1',
    status: 'done',
    model: 'haiku',
    effort: 'low',
    activity: [],
    text: '',
    result: 'ok',
    sessionId: null,
    usage: usage(0.01, 1000, 200),
    denials: [],
    diff: null,
    error: null,
    sent: null,
    resumed: false,
  },
  { id: 'u2', kind: 'user', at: 2000, text: 'y otro para el contador', forced: null },
];

test('the index keeps what the list and the search need, and the totals', () => {
  const stats = chatStats(messages);
  assert.equal(stats.count, 4);
  assert.equal(stats.search, 'agregá un test\ny otro para el contador');
  assert.ok(Math.abs(stats.costUsd - 0.012) < 1e-9);
  assert.equal(stats.tokens, 150 + 1200);
  const migrated = migratedChat(messages, 'chat-x-1', 5);
  assert.equal(migrated.title, 'Agregá un test');
  assert.equal(migrated.createdAt, 1000);
  assert.equal(migrated.updatedAt, 2000);
  assert.equal(migrated.count, 4);
});

test('the index round-trips; empty chats are not saved; a broken file is no index', () => {
  const full: ChatMeta = { ...emptyChat(10, 'chat-a-1'), title: 'Tests', count: 3, updatedAt: 50, search: 'tests' };
  const older: ChatMeta = { ...emptyChat(5, 'chat-b-2'), title: 'Viejo', count: 1, updatedAt: 20 };
  const empty = emptyChat(60, 'chat-c-3');
  const text = serializeChats([older, full, empty], 'chat-c-3');
  const parsed = parseChats(text);
  assert.deepEqual(
    parsed?.chats.map((c) => c.id),
    ['chat-a-1', 'chat-b-2'],
  );
  // The active one was empty (not saved): the newest is.
  assert.equal(parsed?.active, 'chat-a-1');
  assert.equal(parseChats(serializeChats([older, full], 'chat-b-2'))?.active, 'chat-b-2');
  assert.equal(parseChats('{roto'), null);
  assert.equal(parseChats(JSON.stringify({ version: 9, chats: [] })), null);
  // Invalid ids (a path) and duplicates are dropped.
  const odd = parseChats(JSON.stringify({ version: 1, active: '../x', chats: [{ id: '../x', title: 'a' }, { id: 'chat-a-1' }, { id: 'chat-a-1' }] }));
  assert.deepEqual(
    odd?.chats.map((c) => [c.id, c.title]),
    [['chat-a-1', 'Chat nuevo']],
  );
  assert.equal(odd?.active, 'chat-a-1');
});

test('search: by title first, then by what the user wrote (whole words, any accent)', () => {
  const chats: ChatMeta[] = [
    { ...emptyChat(1, 'chat-a-1'), title: 'Renombrar total', search: 'renombrá total', count: 2, updatedAt: 1 },
    { ...emptyChat(2, 'chat-b-2'), title: 'Tests del contador', search: 'agregá un test al contador', count: 2, updatedAt: 2 },
    { ...emptyChat(3, 'chat-c-3'), title: 'Login', search: 'el botón de sesión falla', count: 2, updatedAt: 3 },
  ];
  assert.deepEqual(
    searchChats(chats, '').map((c) => c.id),
    ['chat-c-3', 'chat-b-2', 'chat-a-1'],
  );
  assert.deepEqual(
    searchChats(chats, 'contador').map((c) => c.id),
    ['chat-b-2'],
  );
  assert.deepEqual(
    searchChats(chats, 'sesion').map((c) => c.id),
    ['chat-c-3'],
  );
  assert.deepEqual(searchChats(chats, 'zzz'), []);
});

test('when a chat was last active, short', () => {
  const now = new Date(2026, 10, 24, 15, 0, 0).getTime();
  assert.equal(relativeTime(now - 20_000, now), 'recién');
  assert.equal(relativeTime(now - 5 * 60_000, now), 'hace 5 min');
  assert.equal(relativeTime(now - 3 * 3_600_000, now), 'hace 3 h');
  assert.equal(relativeTime(new Date(2026, 10, 23, 22, 0).getTime(), now), 'ayer');
  assert.equal(relativeTime(new Date(2026, 10, 20, 10, 0).getTime(), now), 'hace 4 días');
  assert.match(relativeTime(new Date(2026, 9, 2).getTime(), now), /2/);
});
