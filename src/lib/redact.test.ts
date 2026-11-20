import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRedactions, listsEnv, looksLikeDotenv, readsEnvFile, redact } from './redact.ts';

// Fixtures in the real formats, built from pieces so that secret scanners (GitHub push
// protection) never see a token-shaped literal in this file. None of them is a real secret.
const join = (...parts: string[]) => parts.join('');
const alnum = 'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY';
const GITHUB_CLASSIC = join('gh', 'p_', alnum, 'Zq9W');
const GITHUB_OAUTH = join('gh', 'o_', alnum, 'Zq9W');
const GITHUB_FINE = join('github', '_pat_', '11ABCDEFG0', alnum.slice(0, 12), '_', alnum, alnum.slice(0, 27));
const ANTHROPIC = join('sk-', 'ant-', 'api03-', alnum, alnum, alnum, 'Kq7-xY_92', 'AA');
const ANTHROPIC_OAUTH = join('sk-', 'ant-', 'oat01-', alnum, alnum, 'AA');
const OPENAI_PROJECT = join('sk-', 'proj-', alnum, '_', alnum, '-', alnum);
const OPENAI_LEGACY = join('sk-', alnum.slice(0, 20), 'T3Blbk', 'FJ', alnum.slice(0, 20));
const AWS_ID = join('AK', 'IA', 'IOSFODNN7', 'EXAMPLE');
const GOOGLE = join('AI', 'za', 'SyA-', alnum.slice(0, 28), 'q1w');
const STRIPE = join('sk', '_live_', alnum);
const SLACK = join('xo', 'xb-', '1234567890-', '0987654321-', alnum.slice(0, 24));
const NPM = join('np', 'm_', alnum, 'abcd');
// jwt.io's public example token.
const JWT = join(
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  '.',
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ',
  '.',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
);

const hidden = (text: string, secret: string, kind?: string) => {
  const result = redact(text);
  assert.ok(!result.text.includes(secret), `still visible: ${result.text}`);
  if (kind) assert.ok((result.found[kind] ?? 0) > 0, `${kind} not counted: ${JSON.stringify(result.found)} → ${result.text}`);
  return result.text;
};

test('GitHub tokens: classic, OAuth and fine-grained', () => {
  assert.equal(hidden(`git push https://x:${GITHUB_CLASSIC}@github.com/acme/app`, GITHUB_CLASSIC), 'git push https://x:[REDACTED:github_token]@github.com/acme/app');
  hidden(`token: ${GITHUB_OAUTH}`, GITHUB_OAUTH, 'github_token');
  assert.equal(hidden(`GH_TOKEN=${GITHUB_FINE}`, GITHUB_FINE, 'github_token'), 'GH_TOKEN=[REDACTED:github_token]');
});

test('Anthropic and OpenAI keys', () => {
  assert.equal(hidden(`$env:ANTHROPIC_API_KEY = '${ANTHROPIC}'`, ANTHROPIC, 'anthropic_key'), "$env:ANTHROPIC_API_KEY = '[REDACTED:anthropic_key]'");
  hidden(`CLAUDE_CODE_OAUTH_TOKEN=${ANTHROPIC_OAUTH}`, ANTHROPIC_OAUTH, 'anthropic_key');
  hidden(`openai.api_key = "${OPENAI_PROJECT}"`, OPENAI_PROJECT, 'openai_key');
  hidden(`Incorrect API key provided: ${OPENAI_LEGACY}.`, OPENAI_LEGACY, 'openai_key');
});

test('SQL Server, Azure and URL connection strings', () => {
  const sql = 'Server=tcp:acme-prod.database.windows.net,1433;Initial Catalog=Ventas;User ID=sa;Password=S3cr3t!Pa$$;Encrypt=True;';
  const out = hidden(sql, 'S3cr3t!Pa$$', 'connection_string');
  assert.equal(out, 'Server=tcp:acme-prod.database.windows.net,1433;Initial Catalog=Ventas;User ID=sa;Password=[REDACTED:connection_string];Encrypt=True;');
  hidden('Data Source=.\\SQLEXPRESS;Database=app;Uid=admin;Pwd={a;b c};', 'a;b c');
  hidden('"ConnectionStrings": { "Default": "Server=db;Database=x;User Id=app;Password=\\"q w e\\";" }', 'q w e');
  const azure = `DefaultEndpointsProtocol=https;AccountName=acmestore;AccountKey=${alnum}${alnum}k9Q==;EndpointSuffix=core.windows.net`;
  hidden(azure, `${alnum}${alnum}k9Q==`, 'connection_string');
  assert.ok(redact(azure).text.includes('AccountName=acmestore'), 'account names stay');
  hidden('Endpoint=sb://acme.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==');
  assert.equal(
    hidden('psql postgres://admin:hunter2-prod@db.acme.local:5432/ventas', 'hunter2-prod', 'password'),
    'psql postgres://admin:[REDACTED:password]@db.acme.local:5432/ventas',
  );
  hidden('mongodb+srv://svc:p%40ss.w0rd@cluster0.abcd.mongodb.net/test', 'p%40ss.w0rd');
  hidden('https://acme.blob.core.windows.net/c/f.zip?sv=2022-11-02&se=2026-01-01&sig=Zm9vYmFyYmF6cXV4MTIz%2BNDU2Nzg5MA%3D', 'Zm9vYmFyYmF6cXV4MTIz%2BNDU2Nzg5MA%3D', 'azure_sas');
});

test('JWT, bearer tokens and Authorization headers', () => {
  assert.equal(hidden(`curl -H "Authorization: Bearer ${JWT}" https://api.acme.com`, JWT), 'curl -H "Authorization: Bearer [REDACTED:jwt]" https://api.acme.com');
  hidden(`id_token=${JWT}`, JWT, 'jwt');
  hidden('Authorization: Basic YWRtaW46c3VwZXJzZWNyZXQ=', 'YWRtaW46c3VwZXJzZWNyZXQ=');
  hidden('fetch(url, { headers: { Authorization: "token abcdef1234567890abcdef" } })', 'abcdef1234567890abcdef');
});

test('cloud and service keys', () => {
  hidden(`aws configure set aws_access_key_id ${AWS_ID}`, AWS_ID, 'aws_key');
  hidden('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  hidden(`key=${GOOGLE}`, GOOGLE, 'google_key');
  hidden(`Stripe.api_key = '${STRIPE}'`, STRIPE, 'stripe_key');
  hidden(`SLACK_BOT=${SLACK}`, SLACK, 'slack_token');
  hidden(`//registry.npmjs.org/:_authToken=${NPM}`, NPM, 'npm_token');
});

test('passwords in commands and config', () => {
  hidden("New-LocalUser -Name svc -Password (ConvertTo-SecureString 'Pr0d!Pass#2026' -AsPlainText -Force)", 'Pr0d!Pass#2026', 'password');
  hidden('mysql --user=root --password=Tr1cky_one db', 'Tr1cky_one');
  hidden('gh auth login --with-token --token Zx9_tok3n_value', 'Zx9_tok3n_value', 'secret');
  hidden('az login --service-principal -u app -p x --tenant t --client-secret "kQ8~Abc.def_ghiJKL"', 'kQ8~Abc.def_ghiJKL');
  hidden('DB_PASS=sup3rsecret', 'sup3rsecret', 'secret');
  hidden('  password: "hunter2-yaml"', 'hunter2-yaml');
  hidden('{"client_secret": "abc123-very-secret"}', 'abc123-very-secret');
  hidden('set SMTP_PASSWORD=Correo2026!', 'Correo2026!');
  hidden('export STRIPE_WEBHOOK_SECRET=wh-local-dev-123', 'wh-local-dev-123');
  hidden(`-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----`, 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW', 'private_key');
  hidden('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7truncated', 'MIIEowIBAAKCAQEA7truncated', 'private_key');
});

test('.env files and environment listings', () => {
  assert.ok(readsEnvFile('cat .env'));
  assert.ok(readsEnvFile('Get-Content .\\.env.local'));
  assert.ok(readsEnvFile('type "C:\\app\\.env.production"'));
  assert.ok(readsEnvFile('docker compose --env-file .env up'));
  assert.ok(!readsEnvFile('cat environment.ts'));
  assert.ok(!readsEnvFile('npm run dev'));
  const env = 'APP_NAME=ventas\nDEBUG=true\nCLIENT_LOGO_URL=https://cdn.acme.com/logo.png\nREDIS_HOST=cache.acme.local\n# comentario\nFEATURE_X=on';
  const out = redact(env, { envFile: true });
  assert.ok(!out.text.includes('ventas') && !out.text.includes('cache.acme.local') && !out.text.includes('cdn.acme.com'), out.text);
  assert.ok(out.text.includes('APP_NAME=[REDACTED:env_file]'), 'names stay');
  assert.ok(out.text.includes('# comentario'));
  // Without knowing the command, output shaped like a .env file counts too.
  assert.ok(looksLikeDotenv(env));
  assert.ok(!redact(env).text.includes('cache.acme.local'));
  assert.ok(!looksLikeDotenv('uno\ndos\nX=1'));

  assert.ok(listsEnv('Get-ChildItem env:'));
  assert.ok(listsEnv('gci Env:'));
  assert.ok(listsEnv('printenv'));
  assert.ok(listsEnv('set'));
  assert.ok(!listsEnv('Set-Location C:\\'));
  const table = 'Name                           Value\n----                           -----\nGITHUB_TOKEN                   not-a-known-format-but-secret\nPATH                           C:\\Windows\\system32\nCOMPUTERNAME                   DESKTOP-1';
  const dump = redact(table, { envDump: true });
  assert.ok(!dump.text.includes('not-a-known-format-but-secret'), dump.text);
  assert.ok(dump.text.includes('C:\\Windows\\system32') && dump.text.includes('DESKTOP-1'), 'harmless variables stay');
});

test('high-entropy strings that match no known format', () => {
  hidden('X-Internal-Key: q8ZK3pV7nR2mT9xW4bY6cJ1dF5gH0sLa', 'q8ZK3pV7nR2mT9xW4bY6cJ1dF5gH0sLa');
  const random = 'value Zq81Kd93LmXp02Qw7Er4Ty6Ui8Op1As3Df5Gh end';
  assert.ok(!redact(random).text.includes('Zq81Kd93'), redact(random).text);
});

test('ordinary terminal output stays as it is', () => {
  const samples = [
    'commit 3f2c9a1b7d4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a',
    'Author: Ana <ana@example.com>',
    'Container 6d1f0e2c-7b9a-4c3d-8e5f-1a2b3c4d5e6f started',
    'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'npm ERR! code ERESOLVE',
    'Tests: 12 passed, 1 failed, 13 total',
    'Passed: 12  Failed: 1',
    'input_tokens: 512, max_tokens: 64000',
    'AbstractSingletonProxyFactoryBeanConfigurationLoader2 failed to start',
    'Listening on http://localhost:3000',
    'cd C:\\Users\\ana\\proyectos\\ventas',
    'password: <tu-contraseña>',
    'token = ${GITHUB_TOKEN}',
    'Remove-Item -Recurse -Force .\\build',
    'git push --force-with-lease origin main',
  ];
  for (const sample of samples) {
    const result = redact(sample);
    assert.equal(result.text, sample, `changed: ${sample} → ${result.text}`);
    assert.deepEqual(result.found, {});
  }
});

test('user patterns (ai.redact) and the summary', () => {
  const out = redact('Deploy de ACME-Ventas en acme-prod.internal falló', { extra: ['acme-\\w+', 'broken(['] });
  assert.equal(out.text, 'Deploy de [REDACTED:custom] en [REDACTED:custom].internal falló');
  const many = redact(`a ${GITHUB_CLASSIC} b ${GITHUB_OAUTH} Password=Abc12345;`);
  assert.equal(describeRedactions(many.found), '2 × token de GitHub, 1 × secreto de connection string');
});
