import assert from 'node:assert/strict';
import test from 'node:test';
import { pickProfile, resolveProfiles, shellSpec, type DetectedShell } from './profiles.ts';

const DETECTED: DetectedShell[] = [
  { id: 'pwsh', kind: 'pwsh', name: 'PowerShell', program: 'C:\\ps7\\pwsh.exe', distro: null },
  { id: 'powershell', kind: 'powershell', name: 'Windows PowerShell', program: 'powershell.exe', distro: null },
  { id: 'cmd', kind: 'cmd', name: 'Símbolo del sistema', program: 'cmd.exe', distro: null },
  { id: 'gitbash', kind: 'gitbash', name: 'Git Bash', program: 'bash.exe', distro: null },
  { id: 'wsl-Ubuntu', kind: 'wsl', name: 'Ubuntu', program: 'wsl.exe', distro: 'Ubuntu' },
];

test('detected shells become profiles; the first one is the default', () => {
  const { profiles, defaultId, issues } = resolveProfiles(DETECTED, { default: null, list: [] });
  assert.deepEqual(
    profiles.map((p) => [p.id, p.icon]),
    [
      ['pwsh', 'pwsh'],
      ['powershell', 'powershell'],
      ['cmd', 'cmd'],
      ['gitbash', 'git'],
      ['wsl-Ubuntu', 'linux'],
    ],
  );
  assert.equal(defaultId, 'pwsh');
  assert.equal(issues.length, 0);
  assert.deepEqual(shellSpec(profiles[4]!), { kind: 'wsl', program: null, args: null, env: {}, distro: 'Ubuntu' });
});

test('an entry with a detected id customizes it', () => {
  const { profiles } = resolveProfiles(DETECTED, {
    default: 'cmd',
    list: [{ id: 'gitbash', name: 'Bash', icon: '🐚', env: { A: '1' }, theme: 'dracula', hidden: true, cwd: '~\\code' }],
  });
  const bash = profiles.find((p) => p.id === 'gitbash')!;
  assert.equal(bash.name, 'Bash');
  assert.equal(bash.icon, '🐚');
  assert.deepEqual(bash.env, { A: '1' });
  assert.equal(bash.theme, 'dracula');
  assert.equal(bash.hidden, true);
  assert.equal(bash.cwd, '~\\code');
  assert.equal(bash.kind, 'gitbash', 'still Git Bash: same integration');
  assert.equal(bash.args, null, 'default arguments (with integration)');
});

test('custom profiles need a command; ids are unique', () => {
  const { profiles, issues } = resolveProfiles(DETECTED, {
    default: null,
    list: [
      { name: 'Node', command: 'node.exe', args: ['-i'] },
      { name: 'Node', command: 'C:\\node\\node.exe' },
      { name: 'Sin comando' },
      { id: 'pwsh-preview' },
      { id: 'wsl-Debian', hidden: true },
    ],
  });
  const own = profiles.filter((p) => !p.detected);
  assert.deepEqual(
    own.map((p) => [p.id, p.name, p.kind, p.program]),
    [
      ['custom-node', 'Node', null, 'node.exe'],
      ['custom-node-2', 'Node', null, 'C:\\node\\node.exe'],
    ],
  );
  assert.deepEqual(own[0]?.args, ['-i']);
  // "Sin comando" and "pwsh-preview" are explained; a WSL distro missing here is not an error.
  assert.deepEqual(
    issues.map((i) => i.path),
    ['profiles.list[2]', 'profiles.list[3]'],
  );
});

test('a detected profile with its own command lets the backend guess the kind', () => {
  const { profiles } = resolveProfiles(DETECTED, { default: null, list: [{ id: 'powershell', command: 'C:\\otro\\powershell.exe', args: ['-NoProfile'] }] });
  const ps = profiles.find((p) => p.id === 'powershell')!;
  assert.equal(ps.kind, null);
  assert.equal(ps.program, 'C:\\otro\\powershell.exe');
  assert.deepEqual(ps.args, ['-NoProfile']);
});

test('the default profile, and what a pane gets when its profile is gone', () => {
  const resolved = resolveProfiles(DETECTED, { default: 'gitbash', list: [] });
  assert.equal(resolved.defaultId, 'gitbash');
  assert.equal(pickProfile(resolved, null)?.id, 'gitbash');
  assert.equal(pickProfile(resolved, 'cmd')?.id, 'cmd');
  assert.equal(pickProfile(resolved, 'borrado')?.id, 'gitbash');
  const missing = resolveProfiles(DETECTED, { default: 'no-existe', list: [] });
  assert.equal(missing.defaultId, 'pwsh');
  assert.equal(missing.issues[0]?.path, 'profiles.default');
  const nothing = resolveProfiles([], { default: null, list: [] });
  assert.equal(pickProfile(nothing, null), null);
});
