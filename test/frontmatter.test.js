'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseFrontmatter,
  normalizeMode,
  formatModel,
} = require('../lib/frontmatter');

test('lê campos escalares do frontmatter', () => {
  const parsed = parseFrontmatter(`---
name: atlas
description: Agente de planejamento
mode: primary
model: opencode-go/deepseek
---

# Corpo
`);

  assert.equal(parsed.warning, null);
  assert.equal(parsed.data.name, 'atlas');
  assert.equal(parsed.data.description, 'Agente de planejamento');
  assert.equal(parsed.data.mode, 'primary');
  assert.equal(parsed.data.model, 'opencode-go/deepseek');
  assert.match(parsed.body, /# Corpo/);
});

test('lê descrição com bloco dobrado >-', () => {
  const parsed = parseFrontmatter(`---
description: >-
  Primeira linha
  segunda linha.
mode: all
---
texto`);

  assert.equal(parsed.data.description, 'Primeira linha segunda linha.');
  assert.equal(parsed.data.mode, 'all');
});

test('lê bloco literal |', () => {
  const parsed = parseFrontmatter(`---
description: |
  Linha 1
  Linha 2
---
texto`);

  assert.equal(parsed.data.description, 'Linha 1\nLinha 2');
});

test('lê model como objeto aninhado', () => {
  const parsed = parseFrontmatter(`---
model:
  providerID: opencode-go
  modelID: deepseek-v4
---
texto`);

  assert.deepEqual(parsed.data.model, {
    providerID: 'opencode-go',
    modelID: 'deepseek-v4',
  });
});

test('avisa quando falta o fechamento do frontmatter', () => {
  const parsed = parseFrontmatter('---\ndescription: sem fim\n');
  assert.match(parsed.warning, /fechamento/);
  assert.deepEqual(parsed.data, {});
});

test('normaliza modos', () => {
  assert.equal(normalizeMode('PRIMARY'), 'primary');
  assert.equal(normalizeMode('subagent'), 'subagent');
  assert.equal(normalizeMode('all'), 'all');
  assert.equal(normalizeMode('outro'), 'all');
  assert.equal(normalizeMode(null), 'all');
});

test('formata model string e objeto', () => {
  assert.equal(formatModel('opencode-go/deepseek'), 'opencode-go/deepseek');
  assert.equal(
    formatModel({ providerID: 'opencode-go', modelID: 'deepseek-v4' }),
    'opencode-go/deepseek-v4',
  );
  assert.equal(formatModel({ model: 'gpt-5' }), 'gpt-5');
  assert.equal(formatModel(null), null);
});
