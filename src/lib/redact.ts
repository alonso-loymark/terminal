// Secret redaction: everything the AI layer sends goes through here first (the user works with
// client projects, so this is not optional). Pure, no runtime imports (node --test).
//
// Known token formats are recognized by shape (GitHub, Anthropic, OpenAI, AWS, Google, Slack,
// Stripe, npm, JWT, private keys...); credentials by context (connection strings, URLs with a
// password, `NAME=value` and `-Password value` with a sensitive name, Authorization headers);
// .env files and environment listings whole; and long random-looking strings by entropy.
// What is hidden becomes `[REDACTED:<kind>]`, so the model knows something was there. The Rust
// side then replaces the values of this process's sensitive environment variables
// (src-tauri/src/ai/secrets.rs). The user can add their own patterns (`ai.redact`).

export interface RedactOptions {
  /** The text is (or contains) a .env file: every `NAME=value` loses its value. */
  envFile?: boolean;
  /** The text is a listing of environment variables (`Get-ChildItem env:`, `set`, `env`). */
  envDump?: boolean;
  /** `ai.redact`: the user's own patterns (regular expressions, case-insensitive). */
  extra?: readonly string[];
}

export interface RedactResult {
  text: string;
  /** Kind → how many were hidden. */
  found: Record<string, number>;
}

export const REDACTION_LABELS: Record<string, string> = {
  private_key: 'clave privada',
  jwt: 'JWT',
  anthropic_key: 'API key de Anthropic',
  openai_key: 'API key de OpenAI',
  github_token: 'token de GitHub',
  gitlab_token: 'token de GitLab',
  aws_key: 'clave de AWS',
  google_key: 'clave de Google',
  slack_token: 'token de Slack',
  stripe_key: 'clave de Stripe',
  npm_token: 'token de npm',
  pypi_token: 'token de PyPI',
  huggingface_token: 'token de Hugging Face',
  sendgrid_key: 'clave de SendGrid',
  azure_sas: 'firma SAS de Azure',
  webhook: 'URL de webhook',
  password: 'contraseña',
  connection_string: 'secreto de connection string',
  token: 'token',
  secret: 'secreto',
  env_file: 'valor de un archivo .env',
  env_var: 'variable de entorno sensible',
  high_entropy: 'posible secreto',
  custom: 'patrón propio (ai.redact)',
};

/** A summary for the user: "2 tokens de GitHub, 1 contraseña". */
export function describeRedactions(found: Record<string, number>): string {
  return Object.entries(found)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} × ${REDACTION_LABELS[kind] ?? kind}`)
    .join(', ');
}

/** Words that make a variable, key or flag name sensitive. */
const SENSITIVE_WORD =
  'pass(?:word|wd|phrase)?(?![a-z])|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth[_-]?(?:key|token)|authorization|conn(?:ection)?[_-]?str(?:ing)?|signing[_-]?key|encryption[_-]?key|master[_-]?key|sas[_-]?token|session[_-]?key|cookie|webhook[_-]?url|dsn|database[_-]?url|db[_-]?url';
const SENSITIVE_NAME = new RegExp(`(?:${SENSITIVE_WORD})`, 'i');

export const isSensitiveName = (name: string): boolean => SENSITIVE_NAME.test(name) && !/^(?:old)?pwd$/i.test(name);

/** Values that are clearly not secrets (placeholders, numbers, other variables). */
function placeholder(value: string): boolean {
  const v = value.replace(/^["']|["']$/g, '').trim();
  return (
    v === '' ||
    v.length < 4 ||
    /^\[REDACTED/.test(v) ||
    /^(?:true|false|null|none|undefined|yes|no|on|off)$/i.test(v) ||
    /^-?\d+(?:\.\d+)?$/.test(v) ||
    /^\$\{?[A-Za-z_][\w:]*\}?$/.test(v) || // $VAR, ${VAR}, $env:VAR
    /^%[A-Za-z_]\w*%$/.test(v) || // %VAR%
    /^<[^>]*>$/.test(v) || // <your-token>
    /^\*+$/.test(v) ||
    /^(?:x+|\.{3}|…)$/i.test(v)
  );
}

/** Commands that print a .env file. */
export function readsEnvFile(command: string): boolean {
  return /(?:^|[\s"'\\/=(,])\.env(?:\.[\w.-]+)?(?=$|[\s"'),;|&>])/i.test(command);
}

/** Commands that list environment variables. */
export function listsEnv(command: string): boolean {
  return /(?:^|[;|&(]\s*|\s)(?:(?:Get-ChildItem|gci|dir|ls|Get-Item|gi)\s+env:|printenv\b|env\s*(?:$|[|;&])|set\s*(?:$|[|;&])|export\s+-p\b|\[Environment\]::GetEnvironmentVariables)/i.test(
    command.trim(),
  );
}

/** Output that looks like a .env file: mostly `UPPER_NAME=value` lines. */
export function looksLikeDotenv(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const pairs = lines.filter((l) => /^\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}\s*=\s*\S/.test(l));
  return pairs.length >= 3 && pairs.length >= lines.length * 0.6;
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const charClass = (ch: string) => (/[A-Z]/.test(ch) ? 1 : /[a-z]/.test(ch) ? 2 : /\d/.test(ch) ? 3 : 4);

/**
 * A long, random-looking string that is not a hash (hex), a UUID or an identifier: random
 * base62/base64 switches between upper case, lower case and digits all the time, CamelCase
 * words only at the start of each word.
 */
function randomLooking(s: string): boolean {
  if (s.length < 32) return false;
  if (/^[0-9a-f-]+$/i.test(s)) return false; // git SHAs, UUIDs, digests
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  if (count(/[A-Z]/g) < 2 || count(/[a-z]/g) < 2 || count(/\d/g) < 3) return false;
  let changes = 0;
  for (let i = 1; i < s.length; i++) if (charClass(s[i] ?? '') !== charClass(s[i - 1] ?? '')) changes++;
  return changes / (s.length - 1) >= 0.3 && entropy(s) >= 4.2;
}

export function redact(input: string, options: RedactOptions = {}): RedactResult {
  const found: Record<string, number> = {};
  let text = input;
  const mark = (kind: string) => {
    found[kind] = (found[kind] ?? 0) + 1;
    return `[REDACTED:${kind}]`;
  };
  /** Replaces matches of `re`; `fn` returns the replacement, or null to keep the match. */
  const sub = (re: RegExp, fn: (match: string, ...groups: string[]) => string | null) => {
    text = text.replace(re, (match: string, ...rest: unknown[]) => {
      const groups = rest.filter((g): g is string => typeof g === 'string' || g === undefined).map((g) => g ?? '');
      return fn(match, ...groups) ?? match;
    });
  };
  const whole = (re: RegExp, kind: string) => sub(re, () => mark(kind));

  // Private keys (a truncated one, to the end of the text).
  whole(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, 'private_key');
  // JWTs: header and payload are base64url JSON ("eyJ").
  whole(/\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, 'jwt');

  // Known token formats.
  whole(/\bsk-ant-[a-z]{2,6}\d{2}-[A-Za-z0-9_-]{16,}/g, 'anthropic_key');
  whole(/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'anthropic_key');
  whole(/\bsk-(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{16,}/g, 'openai_key');
  whole(/\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g, 'openai_key');
  whole(/\bsk-[A-Za-z0-9]{32,}\b/g, 'openai_key');
  whole(/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, 'github_token');
  whole(/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'github_token');
  whole(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, 'gitlab_token');
  whole(/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, 'aws_key');
  whole(/\bAIza[0-9A-Za-z_-]{35}\b/g, 'google_key');
  whole(/\bya29\.[0-9A-Za-z_-]{20,}/g, 'google_key');
  whole(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'slack_token');
  whole(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, 'stripe_key');
  whole(/\bwhsec_[A-Za-z0-9]{20,}\b/g, 'stripe_key');
  whole(/\bnpm_[A-Za-z0-9]{36}\b/g, 'npm_token');
  whole(/\bpypi-AgE[A-Za-z0-9_-]{40,}/g, 'pypi_token');
  whole(/\bhf_[A-Za-z0-9]{30,}\b/g, 'huggingface_token');
  whole(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{30,}\b/g, 'sendgrid_key');
  whole(/\b(?:dop|doo|dor)_v1_[a-f0-9]{64}\b/g, 'token');
  whole(/\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g, 'token');
  whole(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, 'webhook');
  whole(/https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/[A-Za-z0-9/_-]+/g, 'webhook');
  whole(/https:\/\/[\w.-]+\.webhook\.office\.com\/[^\s"'<>]+/g, 'webhook');
  // Azure SAS signatures in URLs and connection strings.
  sub(/([?&]sig=)([A-Za-z0-9%+/=]{16,})/g, (_m, pre) => `${pre}${mark('azure_sas')}`);

  // Credentials inside URLs: scheme://user:password@host, scheme://token@host.
  sub(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@'"]+):([^@\s/'"]+)@/gi, (_m, scheme, user, pass) =>
    pass.startsWith('[REDACTED') ? null : `${scheme}${user}:${mark('password')}@`,
  );
  sub(/\b([a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9_-]{20,})@/gi, (_m, scheme) => `${scheme}${mark('token')}@`);

  // Connection strings (SQL Server, Azure Storage / Service Bus, ODBC): Key=value; pairs.
  sub(
    /\b(password|pwd|accountkey|sharedaccesskey|sharedaccesssignature|client ?secret|access ?token|api ?key)(\s*=\s*)(\\"[^"\r\n]*?\\"|"[^"]*"|'[^']*'|\{[^}]*\}|[^;\r\n"'\\]*)/gi,
    (_m, key, eq, value) => (placeholder(value) ? null : `${key}${eq}${mark('connection_string')}`),
  );

  // Authorization headers and bearer tokens.
  sub(/\b(authorization\s*[:=]\s*)(["']?)(?:(bearer|basic|token|digest|negotiate)\s+)?([^\s"',;]+)/gi, (_m, pre, quote, scheme, value) =>
    placeholder(value) ? null : `${pre}${quote}${scheme ? `${scheme} ` : ''}${mark('token')}`,
  );
  sub(/\b(bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi, (_m, pre, value) => (value.startsWith('[REDACTED') ? null : `${pre}${mark('token')}`));

  sub(/(ConvertTo-SecureString\s+(?:-String\s+)?)(["'])(.*?)\2/gi, (_m, pre, quote, value) =>
    placeholder(value) ? null : `${pre}${quote}${mark('password')}${quote}`,
  );
  // Flags with a secret value: --password x, --token=x, -Password 'x', -ApiKey x (not an
  // expression: -Password (ConvertTo-SecureString ...), -Token $t).
  sub(
    new RegExp(`((?:^|\\s)--?[\\w-]*(?:${SENSITIVE_WORD})[\\w-]*)(=|\\s+)(?![-($@{[])("[^"]*"|'[^']*'|[^\\s"'|;&]+)`, 'gim'),
    (_m, flag, sep, value) => (placeholder(value) ? null : `${flag}${sep}${mark('secret')}`),
  );

  // NAME=value, NAME: value, "name": "value", $env:NAME = 'value', set NAME=value...
  sub(
    new RegExp(`((?:\\$env:)?["']?(?<![\\w.-])[\\w.-]*?(?:${SENSITIVE_WORD})[\\w.-]*["']?\\s*(?::=|=|:)\\s*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;"'}{)\\]]+)`, 'gi'),
    (_m, pre, value) => {
      const name = pre.replace(/^\$env:/i, '').replace(/["'\s:=]/g, '');
      // "Authorization: Bearer <token>": the scheme is not the secret (the token was handled).
      if (!isSensitiveName(name) || placeholder(value) || /^(?:bearer|basic|token|digest|negotiate)$/i.test(value)) return null;
      const quote = /^["']/.test(value) ? value[0] : '';
      return `${pre}${quote}${mark('secret')}${quote}`;
    },
  );

  // A .env file: every value, whatever the name.
  if (options.envFile || looksLikeDotenv(text)) {
    sub(/^(\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*=\s*)(.+)$/gm, (_m, pre, value) =>
      value.trim().startsWith('[REDACTED') || value.trim() === '' ? null : `${pre}${mark('env_file')}`,
    );
  }
  // An environment listing: PowerShell's table (NAME   value) and NAME=value lines.
  if (options.envDump) {
    sub(/^([A-Za-z_][\w().-]*)(\s{2,}|=)(.+)$/gm, (_m, name, sep, value) =>
      !isSensitiveName(name) || value.trim().startsWith('[REDACTED') || placeholder(value) ? null : `${name}${sep}${mark('env_var')}`,
    );
  }

  // Long random-looking strings that matched nothing above.
  sub(/(?<![\w+/=-])[A-Za-z0-9+/_-]{32,}={0,2}(?![\w+/=-])/g, (m) => (randomLooking(m.replace(/=+$/, '')) ? mark('high_entropy') : null));

  // The user's own patterns.
  for (const pattern of options.extra ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'giu');
    } catch {
      continue;
    }
    sub(re, (m) => (m === '' ? null : mark('custom')));
  }
  return { text, found };
}
