import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInfo, ModelInfo } from './agentsApi.ts';
import {
  activityNow,
  activitySummary,
  agentsUpdatePrompt,
  allowedCommands,
  buildBrief,
  decisionOf,
  decisionsSummary,
  extractJson,
  formatCost,
  markdownAnswer,
  MINIMAL_CLAUDE_MD,
  lineDiff,
  modelMention,
  parseWorkerResult,
  usageDetail,
  usageShort,
  type ActivityItem,
  parseConversation,
  parseForcedModel,
  parsePrefs,
  plannerPrompt,
  rankModels,
  relativeTo,
  serializeConversation,
  touchedFiles,
  validatePlan,
  withAgentsImport,
  type OrchMessage,
} from './orchestratorModel.ts';

const model = (value: string, description: string, efforts = ['low', 'medium', 'high', 'xhigh', 'max']): ModelInfo => ({
  value,
  displayName: value[0]!.toUpperCase() + value.slice(1),
  description,
  resolved: null,
  efforts,
});

// The list claude 2.1.329 answers to `initialize` (haiku's price is the fake's).
const MODELS = [
  model('default', 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok'),
  model('opus', 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok'),
  model('fable', 'Fable 5.2 · Most capable for your hardest and longest-running tasks · $8/$40 per Mtok'),
  model('sonnet', 'Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok'),
  model('haiku', 'Haiku 5.5 · Fastest · $1/$5 per Mtok', ['low', 'medium', 'high']),
];

const AGENTS: AgentInfo[] = [
  { id: 'claude', name: 'Claude Code', installed: true, path: 'claude.exe', version: '2.1.329', loggedIn: true, authMethod: 'claude.ai', models: MODELS, error: null },
];

test('models are ranked by price with a tier, without the CLI default alias', () => {
  const ranked = rankModels(MODELS);
  assert.deepEqual(
    ranked.map((m) => [m.value, m.tier]),
    [
      ['haiku', 'rápido'],
      ['sonnet', 'medio'],
      ['opus', 'potente'],
      ['fable', 'máximo'],
    ],
  );
  assert.equal(ranked[1]?.outputPrice, 10);
  // Without prices, the family order.
  assert.deepEqual(
    rankModels([model('opus', 'x'), model('haiku', 'y'), model('sonnet', 'z')]).map((m) => m.tier),
    ['rápido', 'medio', 'potente'],
  );
});

test('@model at the start forces one the CLI offers', () => {
  assert.deepEqual(parseForcedModel('@opus arreglá el bug del login', MODELS), { model: 'opus', rest: 'arreglá el bug del login' });
  assert.deepEqual(parseForcedModel('  @Haiku renombrá x', MODELS), { model: 'haiku', rest: 'renombrá x' });
  assert.deepEqual(parseForcedModel('@gpt5 hacé algo', MODELS), { model: null, rest: '@gpt5 hacé algo' });
  assert.deepEqual(parseForcedModel('@default x', MODELS), { model: null, rest: '@default x' });
  assert.deepEqual(parseForcedModel('mandale un mail a @sonnet', MODELS), { model: null, rest: 'mandale un mail a @sonnet' });
});

test('a plan is read from a json block and validated against the detected models', () => {
  const answer = 'Listo:\n```json\n{"task":"Renombrar x a total en src/a.ts","agent":"claude","model":"haiku","effort":"low","why":"Trivial.","files":["src/a.ts"]}\n```';
  const result = validatePlan(extractJson(answer), AGENTS);
  assert.ok('plan' in result);
  assert.deepEqual(result.plan, { task: 'Renombrar x a total en src/a.ts', agent: 'claude', model: 'haiku', effort: 'low', why: 'Trivial.', files: ['src/a.ts'], title: null });
  // Bare JSON works too; the forced model wins; an effort the model lacks becomes the nearest.
  const forced = validatePlan(extractJson('{"task":"t","agent":"claude","model":"sonnet","effort":"max","why":"w"}'), AGENTS, 'haiku');
  assert.ok('plan' in forced);
  assert.equal(forced.plan.model, 'haiku');
  assert.equal(forced.plan.effort, 'high');
  // Errors say what is wrong.
  assert.deepEqual(validatePlan(extractJson('no sé'), AGENTS), { error: 'no es un objeto JSON' });
  assert.deepEqual(validatePlan({ task: 't', agent: 'claude', model: 'gpt-5' }, AGENTS), { error: 'modelo desconocido: "gpt-5"' });
  assert.deepEqual(validatePlan({ task: 't', agent: 'codex', model: 'opus' }, AGENTS), { error: 'agente desconocido: "codex"' });
  assert.deepEqual(validatePlan({ agent: 'claude', model: 'opus' }, AGENTS), { error: 'falta "task"' });
  assert.deepEqual(validatePlan({ task: 't', model: 'default' }, AGENTS), { error: 'modelo desconocido: "default"' });
});

test('the planner gets the models, criteria inputs and a redacted message, never raw secrets', () => {
  const built = plannerPrompt({
    message: 'usá el token ghp_abcdefghijklmnopqrstuvwxyz0123456789 para el deploy',
    forced: 'opus',
    projectName: 'cliente-app',
    agents: AGENTS,
    commands: ['npm run build *'],
    hasAgentsMd: true,
    decisions: [],
    recent: [],
  });
  assert.match(built.text, /## Mensaje del usuario\nusá el token \[REDACTED:github_token\] para el deploy/);
  assert.match(built.text, /Modelo elegido por el usuario: opus/);
  assert.match(built.text, /- sonnet \(Sonnet; medio\): .*\$2\/\$10.*Esfuerzos: low, medium, high, xhigh, max\./);
  assert.doesNotMatch(built.text, /- default /);
  assert.match(built.text, /- npm run build \*/);
  assert.equal(built.found.github_token, 1);
  const retry = plannerPrompt({ message: 'x', forced: null, projectName: 'p', agents: AGENTS, commands: [], hasAgentsMd: false, decisions: [], recent: [], correction: 'falta "task"' });
  assert.match(retry.text, /## Corrección\n.*falta "task"/);
});

test('a worker gets a brief: task, decisions and files, not the conversation', () => {
  const decisions = [
    { at: 1, task: 'Agregar login', model: 'sonnet', effort: 'medium', why: 'normal', outcome: 'done' as const, summary: 'Agregué el login con OAuth.', files: ['src/login.ts'], costUsd: 0.1 },
  ];
  const brief = buildBrief({
    plan: { task: 'Arreglar el test de login (password=hunter2hunter2)', agent: 'claude', model: 'haiku', effort: 'low', why: 'w', files: ['src/login.test.ts'] },
    projectName: 'app',
    decisions,
    hasAgentsMd: true,
    commands: ['npm test *'],
  });
  assert.match(brief.text, /^## Tarea\nArreglar el test de login \(password=\[REDACTED/);
  assert.match(brief.text, /Leé primero AGENTS\.md/);
  assert.match(brief.text, /\[hecha\] Agregar login \(sonnet, medium\)\. Agregué el login con OAuth\. Archivos: src\/login\.ts\./);
  assert.match(brief.text, /## Archivos relevantes\n- src\/login\.test\.ts/);
  assert.match(brief.text, /- npm test \*/);
  assert.equal(decisionsSummary([]), '(ninguna todavía)');
});

test('the decision log entry comes from the plan and the run', () => {
  const plan = { task: 'T', agent: 'claude', model: 'haiku', effort: 'low', why: 'w', files: [] };
  const activity = [
    { id: '1', action: 'edit' as const, tool: 'Edit', target: 'C:\\p\\a.ts', ok: true },
    { id: '2', action: 'write' as const, tool: 'Write', target: 'C:\\p\\b.ts', ok: false },
    { id: '3', action: 'read' as const, tool: 'Read', target: 'C:\\p\\c.ts', ok: true },
  ];
  assert.deepEqual(touchedFiles(activity), ['C:\\p\\a.ts']);
  const d = decisionOf(
    plan,
    {
      status: 'done',
      result: 'Listo:\n edité a.ts',
      error: null,
      diff: { git: true, files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, binary: false, diff: '', truncated: false }], touched: [] },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.004, durationMs: 1, turns: 1, models: [] },
      activity,
      model: 'haiku',
      effort: 'low',
    },
    5,
  );
  assert.deepEqual(d, { at: 5, task: 'T', model: 'haiku', effort: 'low', why: 'w', outcome: 'done', summary: 'Listo: edité a.ts', files: ['a.ts'], costUsd: 0.004 });
});

test('the conversation file settles running work and survives bad input', () => {
  const messages: OrchMessage[] = [
    { id: 'u1', kind: 'user', at: 1, text: 'hola', forced: null },
    { id: 'p1', kind: 'plan', at: 2, status: 'thinking', plan: null, chosen: false, usage: null, error: null, sent: null, text: '' },
  ];
  const back = parseConversation(serializeConversation(messages));
  assert.equal(back.length, 2);
  assert.equal(back[1]?.kind === 'plan' && back[1].status, 'cancelled');
  assert.deepEqual(parseConversation('{roto'), []);
  assert.deepEqual(parseConversation('{"version":99,"messages":[]}'), []);
  assert.deepEqual(parsePrefs('{"mainModel":"opus","allowed":["curl x",3]}', 'C:\\p'), { dir: 'C:\\p', mainModel: 'opus', allowed: ['curl x'] });
  assert.deepEqual(parsePrefs(null, 'C:\\p'), { dir: 'C:\\p', mainModel: null, allowed: [] });
});

test('CLAUDE.md: a minimal one imports AGENTS.md; an existing one gets the import without losing anything', () => {
  assert.match(MINIMAL_CLAUDE_MD, /^@AGENTS\.md$/m);
  assert.equal(withAgentsImport('# Mi proyecto\nUsar pnpm.\n'), '# Mi proyecto\n\n@AGENTS.md\nUsar pnpm.\n');
  assert.equal(withAgentsImport('Usar pnpm.\r\n'), '@AGENTS.md\r\n\r\nUsar pnpm.\r\n');
  assert.equal(markdownAnswer('```markdown\n# AGENTS.md\nx\n```'), '# AGENTS.md\nx\n');
});

test('small helpers', () => {
  assert.equal(relativeTo('C:\\Repos\\App\\', 'C:\\Repos\\App\\src\\a.ts'), 'src/a.ts');
  assert.equal(relativeTo('C:\\Repos\\App', 'D:\\otro.ts'), 'D:/otro.ts');
  assert.equal(formatCost(0.0042), 'US$0.0042');
  assert.equal(formatCost(0.123), 'US$0.123');
  assert.equal(formatCost(2.5), 'US$2.50');
  assert.deepEqual(allowedCommands([{ pattern: 'npm test *', source: 'package.json' }], [' npm run e2e * ', ''], ['curl x', 'npm test *']), ['npm test *', 'npm run e2e *', 'curl x']);
});

test('the chat title comes in the first plan, in the same answer (no other call)', () => {
  const base = { message: 'renombrá total', forced: null, projectName: 'cliente', agents: AGENTS, commands: [], hasAgentsMd: false, decisions: [], recent: [] };
  assert.ok(plannerPrompt({ ...base, needsTitle: true }).text.includes('## Título del chat'));
  assert.ok(!plannerPrompt(base).text.includes('## Título del chat'));
  const plan = validatePlan(extractJson('{"task":"t","agent":"claude","model":"haiku","effort":"low","why":"w","title":" Renombrar total "}'), AGENTS);
  assert.ok('plan' in plan && plan.plan.title === 'Renombrar total');
  // Images: the planner is told they exist (the worker gets them).
  const withImages = plannerPrompt({ ...base, images: 2 }).text;
  assert.ok(withImages.includes('2 imágenes') && withImages.includes('el trabajador las recibe'), withImages);
});

const item = (action: ActivityItem['action'], target: string, ok: boolean | null = true): ActivityItem => ({ id: `${action}-${target}`, action, tool: 'X', target, ok });

test('activity in one line, and what is happening now', () => {
  assert.equal(activitySummary([]), '');
  assert.equal(
    activitySummary([item('read', 'package.json'), item('read', 'src/app.js'), item('read', 'src/app.js'), item('write', 'NOTAS.md'), item('edit', 'src/app.js'), item('command', 'npm run build')]),
    'Leyó 2 archivos, creó 1, editó 1 y ejecutó 1 comando',
  );
  assert.equal(activitySummary([item('edit', 'a.ts'), item('edit', 'b.ts')]), 'Editó 2 archivos');
  assert.equal(activitySummary([item('command', 'npm test', false), item('command', 'npm test')]), 'Ejecutó 2 comandos (1 con error)');
  assert.equal(activitySummary([item('search', '*.ts')]), 'Buscó 1 vez');
  // Live: the tool still running, else the last line written, else thinking.
  assert.equal(activityNow([item('read', 'a.ts'), item('command', 'npm test', null)], 'texto'), 'Ejecutando npm test…');
  assert.equal(activityNow([item('read', 'a.ts')], 'Voy a revisar.\n**Ahora** el build'), 'Ahora el build');
  assert.equal(activityNow([], ''), 'Pensando…');
});

test("the worker's summary, and the line that says AGENTS.md is out of date", () => {
  const plain = parseWorkerResult('**Qué cambió:** x.\n**Cómo probarlo:** y.\n**Pendiente:** Nada.');
  assert.equal(plain.agentsStale, null);
  assert.ok(plain.body.startsWith('**Qué cambió:**'));
  const stale = parseWorkerResult('**Qué cambió:** x.\n**Pendiente:** Nada.\n\nAGENTS.md desactualizado: el comando de tests ahora es `npm run test:unit`.');
  assert.equal(stale.agentsStale, 'el comando de tests ahora es `npm run test:unit`.');
  assert.ok(!stale.body.includes('desactualizado'));
  assert.equal(parseWorkerResult('- **AGENTS.md desactualizado:** falta la carpeta api/**').agentsStale, 'falta la carpeta api/');
  // A mention inside a sentence is not the marker.
  assert.equal(parseWorkerResult('No creo que AGENTS.md desactualizado: sea un problema.').agentsStale, null);
  assert.ok(agentsUpdatePrompt('falta api/').includes('falta api/'));
});

test('usage: a short footer and the detail on hover', () => {
  const usage = { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000, cacheCreationTokens: 800, costUsd: 0.0042, durationMs: 2100, turns: 3, models: ['claude-haiku-5-5'] };
  assert.equal(usageShort(usage), 'US$0.0042 · 7.3 k tokens');
  const detail = usageDetail(usage, 'Tarea');
  for (const part of ['Tarea', 'Entrada: 1.2 k', 'Caché leída: 5.0 k', 'Salida: 340', 'US$0.0042', 'Turnos: 3', '2.1 s', 'claude-haiku-5-5']) assert.ok(detail.includes(part), part);
});

test('@ at the start suggests the models the CLI offers', () => {
  const ranked = rankModels(MODELS);
  assert.deepEqual(modelMention('@', ranked), { query: '', start: 0, items: ['haiku', 'sonnet', 'opus', 'fable'] });
  assert.deepEqual(modelMention('  @op', ranked), { query: 'op', start: 2, items: ['opus'] });
  assert.equal(modelMention('@opus', ranked), null, 'already complete');
  assert.equal(modelMention('@zz', ranked), null);
  assert.equal(modelMention('hola @op', ranked), null, 'only at the start');
  assert.equal(modelMention('@opus arreglá', ranked), null);
});

test('a line diff shows what an update of AGENTS.md changes', () => {
  const diff = lineDiff('# A\n- uno\n- dos\n', '# A\n- uno\n- tres\n- dos\n');
  assert.deepEqual(
    diff.map((d) => `${d.type[0]}${d.text}`),
    ['s# A', 's- uno', 'a- tres', 's- dos'],
  );
  assert.deepEqual(
    lineDiff('x\r\ny', 'x\nz').map((d) => d.type),
    ['same', 'del', 'add'],
  );
  assert.deepEqual(lineDiff('', 'nuevo').map((d) => d.type).sort(), ['add', 'del']);
});
