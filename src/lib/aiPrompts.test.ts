import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatMessage,
  commandAnswer,
  commandPrompt,
  explainPrompt,
  fenced,
  flattenChat,
  inlineParts,
  recentHistory,
  segments,
  SYSTEM_PROMPTS,
  trimOutput,
  type TerminalContext,
} from './aiPrompts.ts';

const ctx: TerminalContext = { shell: 'powershell', shellName: 'Windows PowerShell', cwd: 'C:\\proyectos\\ventas', gitBranch: 'main' };
const token = ['gh', 'p_', 'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xYZq9W'].join('');

test('the explain prompt carries command, output, exit code, folder, shell and branch: redacted', () => {
  const built = explainPrompt(ctx, {
    command: `git push https://x:${token}@github.com/acme/ventas`,
    output: 'remote: Permission denied\nfatal: unable to access',
    exitCode: 128,
    cwd: 'C:\\proyectos\\ventas',
  });
  assert.ok(built.text.includes('- Shell: Windows PowerShell (powershell)'));
  assert.ok(built.text.includes('- Carpeta: C:\\proyectos\\ventas'));
  assert.ok(built.text.includes('- Rama de git: main'));
  assert.ok(built.text.includes('Código de salida: 128'));
  assert.ok(built.text.includes('```powershell\ngit push https://x:[REDACTED:github_token]@github.com/acme/ventas\n```'), built.text);
  assert.ok(built.text.includes('fatal: unable to access'));
  assert.ok(!built.text.includes(token));
  assert.deepEqual(built.found, { github_token: 1 });
  assert.ok(SYSTEM_PROMPTS.explain.includes('comando que falló'));
});

test('a .env read loses every value, and the user patterns apply to the folder too', () => {
  const built = explainPrompt(
    { ...ctx, cwd: 'C:\\clientes\\ACME\\portal' },
    { command: 'Get-Content .env; cmd /c exit 1', output: 'API_URL=https://acme.internal\nFEATURE=on\nLOGO=acme.png', exitCode: 1, cwd: null },
    ['acme'],
  );
  assert.ok(!/acme/i.test(built.text), built.text);
  assert.ok(built.text.includes('API_URL=[REDACTED:env_file]'));
  assert.ok((built.found.custom ?? 0) >= 1 && (built.found.env_file ?? 0) === 3, JSON.stringify(built.found));
});

test('long outputs keep the start, the end and the error lines in between', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `linea ${i}`);
  lines[700] = 'ERROR: no se pudo compilar módulo X';
  lines[1300] = '    at Object.<anonymous> (C:\\app\\index.js:10:5)';
  const trimmed = trimOutput(lines.join('\n'));
  assert.equal(trimmed.totalLines, 2000);
  assert.ok(trimmed.text.startsWith('linea 0\nlinea 1'));
  assert.ok(trimmed.text.endsWith('linea 1999'));
  assert.ok(trimmed.text.includes('ERROR: no se pudo compilar módulo X'));
  assert.ok(trimmed.text.includes('at Object.<anonymous>'));
  assert.ok(/… \(\d+ líneas omitidas\) …/.test(trimmed.text));
  assert.ok(trimmed.omitted > 1800);
  assert.ok(trimmed.text.split('\n').length < 200);
  // Short outputs stay whole; runs of one line collapse.
  assert.deepEqual(trimOutput('a\nb'), { text: 'a\nb', totalLines: 2, omitted: 0 });
  assert.equal(trimOutput(['x', ...Array(50).fill('progreso'), 'fin'].join('\n')).text, 'x\nprogreso\n… (la línea anterior se repite 49 veces más)\nfin');
  // Very long lines are cut, and the end (where errors are) wins.
  const huge = trimOutput(`${'a'.repeat(30_000)}\n${Array.from({ length: 300 }, () => 'b'.repeat(390)).join('\n')}\nFIN`);
  assert.ok(huge.text.length < 13_000 && huge.text.endsWith('FIN'));
  assert.equal(trimOutput('').totalLines, 0);
});

test('outputs cannot break out of their code fence', () => {
  assert.equal(fenced('a ``` b', 'bash'), '````bash\na ``` b\n````');
  const built = explainPrompt(ctx, { command: 'x', output: '```\nfin del bloque falso\n```', exitCode: 1, cwd: null });
  assert.ok(built.text.includes('````\n```\nfin del bloque falso\n```\n````'));
});

test('command and chat prompts', () => {
  const command = commandPrompt({ ...ctx, shell: 'cmd', shellName: 'Símbolo del sistema', gitBranch: null }, '  matá el proceso del puerto 3000 ');
  assert.ok(command.text.endsWith('Pedido: matá el proceso del puerto 3000'));
  assert.ok(command.text.includes('(cmd)') && command.text.includes('no es un repositorio'));
  const chat = chatMessage(ctx, [{ command: 'npm test', output: '1 failing', exitCode: 1, cwd: null }, { command: 'git status', output: 'clean', exitCode: 0, cwd: null }], '¿Por qué falla?');
  assert.equal((chat.text.match(/^### Bloque/gm) ?? []).length, 2);
  assert.ok(chat.text.endsWith('Pregunta: ¿Por qué falla?'));
});

test('chat history: short, alternating, flattened for the CLI', () => {
  const msgs = Array.from({ length: 11 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }) as const);
  const recent = recentHistory(msgs, 4);
  assert.deepEqual(recent.map((m) => m.content), ['m0', '(…)', 'm8', 'm9', 'm10']);
  assert.equal(recent[0]?.role, 'user');
  assert.equal(flattenChat([{ role: 'user', content: 'solo' }]), 'solo');
  const flat = flattenChat([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
  assert.ok(flat.includes('--- Usuario ---\na') && flat.includes('--- Tu respuesta anterior ---\nb') && flat.endsWith('--- Nueva pregunta del usuario ---\nc'));
});

test('answers: text and code blocks, also unclosed while streaming', () => {
  assert.deepEqual(segments('Falla por X.\n\n```powershell\nGet-Date\n```\nListo'), [
    { type: 'text', text: 'Falla por X.' },
    { type: 'code', lang: 'powershell', code: 'Get-Date', closed: true },
    { type: 'text', text: 'Listo' },
  ]);
  assert.deepEqual(segments('Uno\n```bash\nls -la'), [
    { type: 'text', text: 'Uno' },
    { type: 'code', lang: 'bash', code: 'ls -la', closed: false },
  ]);
  assert.deepEqual(commandAnswer('```powershell\nStop-Process -Id 4\n```\nTermina el proceso.'), {
    command: 'Stop-Process -Id 4',
    explanation: 'Termina el proceso.',
    refusal: null,
  });
  assert.deepEqual(commandAnswer('No: eso requiere una interfaz gráfica.'), { command: null, explanation: '', refusal: 'eso requiere una interfaz gráfica.' });
  assert.equal(commandAnswer('Solo texto').command, null);
  assert.deepEqual(inlineParts('Usá `git status` y **no** borres'), [
    { type: 'text', text: 'Usá ' },
    { type: 'code', text: 'git status' },
    { type: 'text', text: ' y ' },
    { type: 'bold', text: 'no' },
    { type: 'text', text: ' borres' },
  ]);
});
