// Unit tests for the shell integration parsers and path helpers (npm test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { folderName, shortenPath } from './paths.ts';
import {
  cwdFromFileUri,
  cwdFromOsc9,
  notificationFromOsc777,
  notificationFromOsc9,
  parseOsc133,
  parseOsc633,
  unescapeOsc633,
} from './shellIntegration.ts';

test('OSC 7: percent-encoded UTF-8 with spaces, accents and ñ', () => {
  assert.equal(
    cwdFromFileUri('file://PC/C:/Users/Ana%20Mar%C3%ADa/carpeta%20con%20espacios/%C3%91and%C3%BA'),
    'C:\\Users\\Ana María\\carpeta con espacios\\Ñandú',
  );
  assert.equal(cwdFromFileUri('file://PC/c:/'), 'C:\\');
  assert.equal(cwdFromFileUri('file://PC/C:'), 'C:\\');
});

test('OSC 7: UNC paths, junk and bad encodings', () => {
  assert.equal(cwdFromFileUri('file://server/share/dir'), '\\\\server\\share\\dir');
  assert.equal(cwdFromFileUri('file://localhost/home/ana'), null, 'not a Windows path');
  assert.equal(cwdFromFileUri('https://example.com/x'), null);
  assert.equal(cwdFromFileUri('file://PC/C:/%E0%A4%A'), null, 'broken escape');
});

test('OSC 633: VS Code escaping is reversed', () => {
  assert.equal(unescapeOsc633('echo a\\x3b b \\\\ c\\x0a'), 'echo a; b \\ c\n');
  assert.deepEqual(parseOsc633('E;git commit -m "a\\x3b b"'), { type: 'commandLine', commandLine: 'git commit -m "a; b"' });
  assert.deepEqual(parseOsc633('E;ls;nonce123'), { type: 'commandLine', commandLine: 'ls' });
  assert.deepEqual(parseOsc633('P;Shell=powershell'), { type: 'integration', ok: true });
  assert.deepEqual(parseOsc633('P;IntegrationError=running scripts is disabled '), {
    type: 'integration',
    ok: false,
    error: 'running scripts is disabled',
  });
  assert.equal(parseOsc633('P;Other=1'), null);
});

test('OSC 133: marks and exit codes', () => {
  assert.deepEqual(parseOsc133('A'), { type: 'prompt' });
  assert.equal(parseOsc133('B'), null);
  assert.deepEqual(parseOsc133('C'), { type: 'commandStart' });
  assert.deepEqual(parseOsc133('D;0'), { type: 'commandEnd', exitCode: 0 });
  assert.deepEqual(parseOsc133('D;-1073741510'), { type: 'commandEnd', exitCode: -1073741510 });
  assert.deepEqual(parseOsc133('D'), { type: 'commandEnd', exitCode: null }, 'unknown code');
});

test('folder names for tab subtitles', () => {
  assert.equal(folderName('C:\\Users\\Ana\\Ñandú áé'), 'Ñandú áé');
  assert.equal(folderName('C:\\'), 'C:');
  assert.equal(folderName('\\\\server\\share'), 'share');
});

test('status bar paths: home as ~, middle segments collapsed', () => {
  const home = 'C:\\Users\\Ana';
  assert.equal(shortenPath('C:\\Users\\Ana', home), '~');
  assert.equal(shortenPath('c:\\users\\ana\\src', home), '~\\src', 'case-insensitive home');
  assert.equal(shortenPath('C:\\Users\\Anabel', home), 'C:\\Users\\Anabel', 'not a prefix match');
  const deep = 'C:\\Users\\Ana\\Proyectos\\cliente-grande\\aplicacion-web\\paquetes\\interfaz\\src';
  const short = shortenPath(deep, home, 30);
  assert.equal(short, '~\\…\\paquetes\\interfaz\\src');
  assert.ok(short.length <= 30);
  assert.equal(shortenPath('D:\\a-very-long-folder-name-that-does-not-fit-at-all', null, 20), 'D:\\a-very-long-folder-name-that-does-not-fit-at-all', 'the last segment is always kept');
  assert.equal(shortenPath('\\\\server\\share\\uno\\dos\\tres\\cuatro', null, 25), '\\\\server\\share\\…\\cuatro');
});

test('OSC 9;9 (cmd): the raw Windows path; other OSC 9 payloads are not a folder', () => {
  assert.equal(cwdFromOsc9('9;C:\\Users\\Ana María\\Ñandú'), 'C:\\Users\\Ana María\\Ñandú');
  assert.equal(cwdFromOsc9('9;"D:\\a b"'), 'D:\\a b');
  assert.equal(cwdFromOsc9('9;c:\\x'), 'C:\\x');
  assert.equal(cwdFromOsc9('9;\\\\server\\share\\dir'), '\\\\server\\share\\dir');
  assert.equal(cwdFromOsc9('4;1;50'), null, 'progress');
  assert.equal(cwdFromOsc9('Build finished'), null, 'notification');
  assert.equal(cwdFromOsc9('9;relative'), null);
});

test('notifications: OSC 9 messages and OSC 777 notify; ConEmu commands are not', () => {
  assert.deepEqual(notificationFromOsc9('Claude necesita tu respuesta'), { source: 'osc9', title: null, body: 'Claude necesita tu respuesta' });
  assert.equal(notificationFromOsc9('9;C:\Users'), null);
  assert.equal(notificationFromOsc9('4;1;50'), null);
  assert.equal(notificationFromOsc9('  '), null);
  assert.deepEqual(notificationFromOsc777('notify;Claude Code;Listo; sin errores'), { source: 'osc777', title: 'Claude Code', body: 'Listo; sin errores' });
  assert.deepEqual(notificationFromOsc777('notify;;Solo cuerpo'), { source: 'osc777', title: null, body: 'Solo cuerpo' });
  assert.equal(notificationFromOsc777('preexec'), null);
  assert.equal(notificationFromOsc777('notify;;'), null);
});
