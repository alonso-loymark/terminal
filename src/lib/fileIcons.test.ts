import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileIcon, folderIcon } from './fileIcons.ts';

const icon = (name: string) => fileIcon(name).icon;
const tone = (name: string) => fileIcon(name).tone;

test('images, archives, media, fonts and documents by extension (any case)', () => {
  for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg', 'g.ico', 'h.bmp', 'i.avif']) assert.equal(icon(name), 'file-image', name);
  for (const name of ['a.zip', 'b.rar', 'c.7z', 'd.tar', 'e.gz']) assert.equal(icon(name), 'file-archive', name);
  assert.equal(icon('clip.mp4'), 'file-video');
  assert.equal(icon('song.mp3'), 'file-audio');
  assert.equal(icon('Inter.woff2'), 'file-font');
  assert.equal(icon('setup.exe'), 'app');
  assert.equal(icon('notes.md'), 'file-text');
  assert.equal(icon('todo.txt'), 'file-text');
  assert.equal(icon('manual.pdf'), 'file-text');
  assert.equal(tone('manual.pdf'), 'red');
  assert.equal(icon('informe.docx'), 'file-text');
  assert.equal(icon('cuentas.xlsx'), 'file-spreadsheet');
});

test('code gets one accent per language; web, data and .NET their own icons', () => {
  const tones = Object.fromEntries(['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.cs', 'a.php', 'a.dart', 'a.py', 'a.rs', 'a.java', 'a.go'].map((n) => [n, fileIcon(n)]));
  for (const [name, s] of Object.entries(tones)) assert.equal(s.icon, 'file-code', name);
  assert.equal(tones['a.ts']?.tone, 'blue');
  assert.equal(tones['a.js']?.tone, 'yellow');
  assert.equal(tones['a.py']?.tone, 'green');
  assert.equal(tones['a.rs']?.tone, 'orange');
  assert.equal(tones['a.cs']?.tone, 'magenta');
  assert.notEqual(tones['a.ts']?.tone, tones['a.js']?.tone);
  assert.equal(icon('query.sql'), 'file-database');
  assert.equal(icon('index.html'), 'file-markup');
  assert.equal(icon('app.css'), 'file-markup');
  assert.equal(icon('app.scss'), 'file-markup');
  for (const name of ['data.json', 'a.yaml', 'b.yml', 'c.xml', 'd.toml', 'e.csv']) assert.notEqual(icon(name), 'file', name);
  assert.equal(icon('Brisa.sln'), 'file-project');
  assert.equal(icon('Api.csproj'), 'file-project');
  assert.equal(icon('build.ps1'), 'file-terminal');
});

test('special names: package.json, lockfiles, Docker, git, README, agent instructions, secrets', () => {
  assert.equal(icon('package.json'), 'package');
  for (const name of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'bun.lockb', 'go.sum']) assert.equal(icon(name), 'file-lock', name);
  for (const name of ['Dockerfile', 'dockerfile', 'api.Dockerfile', 'Dockerfile.dev', 'docker-compose.yml', '.dockerignore']) assert.equal(icon(name), 'container', name);
  assert.equal(icon('.gitignore'), 'git');
  assert.equal(icon('README.md'), 'readme');
  assert.equal(icon('readme'), 'readme');
  assert.equal(icon('AGENTS.md'), 'agents');
  assert.equal(icon('CLAUDE.md'), 'agents');
  assert.equal(tone('AGENTS.md'), 'accent');
  assert.notEqual(icon('OTRO.md'), 'agents');
  for (const name of ['.env', '.env.local', '.env.production']) assert.equal(icon(name), 'file-key', name);
  assert.equal(icon('vite.config.ts'), 'file-cog');
  assert.equal(icon('tsconfig.json'), 'file-cog');
  assert.equal(icon('LICENSE'), 'file-badge');
});

test('anything else is a generic file, never nothing', () => {
  for (const name of ['sin-extension', 'archivo.raro', '.oculto', 'x.', '.']) {
    assert.equal(icon(name), 'file', name);
    assert.equal(tone(name), 'muted', name);
  }
  assert.equal(fileIcon('enlace.ts', true).icon, 'file-symlink');
});

test('folders: open and closed, and the common ones told apart', () => {
  assert.deepEqual(folderIcon('cualquiera', false), { icon: 'folder', tone: 'folder' });
  assert.deepEqual(folderIcon('cualquiera', true), { icon: 'folder-open', tone: 'folder' });
  assert.equal(folderIcon('src', true).icon, 'folder-code');
  assert.equal(folderIcon('tests', false).icon, 'folder-tests');
  assert.equal(folderIcon('node_modules', false).icon, 'folder-modules');
  assert.equal(folderIcon('.git', false).icon, 'folder-git');
  assert.equal(folderIcon('SRC', false).icon, 'folder-code');
  assert.equal(folderIcon('enlace', false, true).icon, 'folder-symlink');
});
