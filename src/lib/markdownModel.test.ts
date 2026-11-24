import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEntities, filePathOf, grammarOf, hiddenContentTag, htmlToText, isLineBreakTag, linkTarget, pathParts, resolvePath } from './markdownModel.ts';

test('links: only web pages and mail open; scripts and data never', () => {
  assert.deepEqual(linkTarget('https://code.claude.com/docs'), { kind: 'url', href: 'https://code.claude.com/docs' });
  assert.deepEqual(linkTarget('mailto:a@b.com'), { kind: 'url', href: 'mailto:a@b.com' });
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'java\tscript:alert(1)', ' javascript:x', 'data:text/html,<b>x', 'vbscript:x', 'file:///C:/x.txt', '//evil.com/x', '#ancla', '', 'http://']) {
    assert.equal(linkTarget(bad), null, bad);
  }
  // A link to a file of the project opens it in the explorer.
  assert.deepEqual(linkTarget('src/app.js'), { kind: 'path', path: 'src/app.js', line: null });
  assert.deepEqual(linkTarget('src/lib/a%20b.ts:12'), null, 'spaces are not paths');
  assert.deepEqual(linkTarget('C:\\Repos\\x\\main.rs:7'), { kind: 'path', path: 'C:\\Repos\\x\\main.rs', line: 7 });
  assert.equal(linkTarget('docs'), null);
});

test('file paths: whole strings (inside backticks) and inside running text', () => {
  assert.deepEqual(filePathOf('src/app.js'), { path: 'src/app.js', line: null });
  assert.deepEqual(filePathOf('package.json'), { path: 'package.json', line: null });
  assert.deepEqual(filePathOf('src\\lib\\x.ts:42:3'), { path: 'src\\lib\\x.ts', line: 42 });
  assert.deepEqual(filePathOf('./AGENTS.md'), { path: './AGENTS.md', line: null });
  for (const not of ['npm run build', 'v1.2', '1.5', 'https://x.com/a.png', 'src/', '.env', 'a b.ts', '']) assert.equal(filePathOf(not), null, not);

  const parts = pathParts('Edité src/app.js:12 y docs\\guia.md; Node.js y https://example.com/a/b.png no son archivos.');
  assert.deepEqual(
    parts.filter((p) => p.type === 'path').map((p) => (p.type === 'path' ? [p.path, p.line] : null)),
    [
      ['src/app.js', 12],
      ['docs\\guia.md', null],
    ],
  );
  assert.equal(parts.map((p) => p.text).join(''), 'Edité src/app.js:12 y docs\\guia.md; Node.js y https://example.com/a/b.png no son archivos.');
  assert.deepEqual(pathParts('sin rutas'), [{ type: 'text', text: 'sin rutas' }]);
});

test('paths resolve against the project', () => {
  assert.equal(resolvePath('C:\\Repos\\Cliente', 'src/app.js'), 'C:\\Repos\\Cliente\\src\\app.js');
  assert.equal(resolvePath('C:\\Repos\\Cliente\\', './a/../b.md'), 'C:\\Repos\\Cliente\\b.md');
  assert.equal(resolvePath('C:\\Repos\\Cliente', 'D:/otro/x.ts'), 'D:\\otro\\x.ts');
  assert.equal(resolvePath('\\\\server\\share\\p', 'x.md'), '\\\\server\\share\\p\\x.md');
});

test('raw HTML from a model becomes text: no markup, no scripts', () => {
  assert.equal(htmlToText('<img src="x" onerror="window.__xss=1">hola'), 'hola');
  assert.equal(htmlToText('a<script>window.__xss=2</script>b'), 'ab');
  assert.equal(htmlToText('<style>body{display:none}</style><b>negrita</b> &amp; &lt;tag&gt;'), 'negrita & <tag>');
  assert.equal(htmlToText('uno<br>dos<br/>tres'), 'uno\ndos\ntres');
  assert.equal(htmlToText('<iframe src="https://evil"></iframe><!-- oculto -->visible'), 'visible');
  assert.equal(htmlToText('<a href="javascript:x" onclick="y">link</a>'), 'link');
  assert.equal(htmlToText('&#60;&#x3e;&#0;&bogus;'), '<>&#0;&bogus;');
  // Nested tricks end up as text too (and here, as nothing).
  assert.equal(htmlToText('<scr<script>ipt>x</script>'), '');
  assert.equal(htmlToText('texto <sin cerrar'), 'texto ');
  assert.ok(isLineBreakTag('<br>') && isLineBreakTag('<BR />') && !isLineBreakTag('<b>'));
  assert.equal(hiddenContentTag('<script>'), 'open');
  assert.equal(hiddenContentTag('<STYLE type="x">'), 'open');
  assert.equal(hiddenContentTag('</script >'), 'close');
  assert.equal(hiddenContentTag('<b>'), null);
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#233; &#x41; &copy; &#7;'), 'a & b <c> "d" é A &copy; &#7;');
});

test('code fences pick a grammar by name or alias', () => {
  assert.equal(grammarOf('ts'), 'typescript');
  assert.equal(grammarOf('PowerShell'), 'powershell');
  assert.equal(grammarOf('ps1'), 'powershell');
  assert.equal(grammarOf('sh'), 'bash');
  assert.equal(grammarOf('json title="x"'), 'json');
  assert.equal(grammarOf('brainfuck'), null);
  assert.equal(grammarOf(''), null);
});
