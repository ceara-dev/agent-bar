'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matches, staticBase, toPatternList } = require('../lib/glob');

test('** casa zero ou mais pastas', () => {
  assert.equal(matches('APP/lib/**/*.dart', 'APP/lib/main.dart'), true);
  assert.equal(matches('APP/lib/**/*.dart', 'APP/lib/a/b/c.dart'), true);
  assert.equal(matches('APP/lib/**/*.dart', 'APP/test/a.dart'), false);
  assert.equal(matches('**/*.php', 'API/app/Http/Kernel.php'), true);
  assert.equal(matches('src/**', 'src/a/b.ts'), true);
});

test('* não atravessa pastas e ? casa um caractere', () => {
  assert.equal(matches('src/*.ts', 'src/a.ts'), true);
  assert.equal(matches('src/*.ts', 'src/a/b.ts'), false);
  assert.equal(matches('file?.md', 'file1.md'), true);
  assert.equal(matches('file?.md', 'file10.md'), false);
});

test('chaves e classes', () => {
  assert.equal(matches('**/*.{ts,tsx}', 'web/a.tsx'), true);
  assert.equal(matches('**/*.{ts,tsx}', 'web/a.js'), false);
  assert.equal(matches('v[0-9].txt', 'v3.txt'), true);
  assert.equal(matches('v[!0-9].txt', 'v3.txt'), false);
});

test('padrão sem barra casa pelo nome do arquivo', () => {
  assert.equal(matches('*.dart', 'APP/lib/main.dart'), true);
  assert.equal(matches('pubspec.yaml', 'APP/pubspec.yaml'), true);
});

test('pontos e caracteres especiais são literais', () => {
  assert.equal(matches('a.b', 'axb'), false);
  assert.equal(matches('(x)+.md', '(x)+.md'), true);
});

test('staticBase devolve o prefixo sem curingas', () => {
  assert.equal(staticBase('APP/lib/**/*.dart'), 'APP/lib');
  assert.equal(staticBase('**/*.php'), '');
  assert.equal(staticBase('*.md'), '');
  assert.equal(staticBase('docs/README.md'), 'docs');
});

test('toPatternList aceita lista, JSON, vírgula e linhas', () => {
  assert.deepEqual(toPatternList(['a', ' b ']), ['a', 'b']);
  assert.deepEqual(toPatternList('["a/**", "b"]'), ['a/**', 'b']);
  assert.deepEqual(toPatternList('a/*.ts, b/*.{js,jsx}'), ['a/*.ts', 'b/*.{js,jsx}']);
  assert.deepEqual(toPatternList('a\nb'), ['a', 'b']);
  assert.deepEqual(toPatternList(''), []);
});
