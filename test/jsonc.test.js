'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonc } = require('../lib/jsonc');

test('lê JSON puro', () => {
  const { value, error } = parseJsonc('{"agent":{"atlas":{"mode":"all"}}}');
  assert.equal(error, null);
  assert.equal(value.agent.atlas.mode, 'all');
});

test('remove comentários de linha e de bloco', () => {
  const input = `{
    // comentário
    "agent": {
      /* bloco */
      "atlas": { "mode": "all" }
    }
  }`;
  const { value, error } = parseJsonc(input);
  assert.equal(error, null);
  assert.equal(value.agent.atlas.mode, 'all');
});

test('remove vírgula final', () => {
  const { value, error } = parseJsonc('{"a": 1, "b": [1, 2,],}');
  assert.equal(error, null);
  assert.deepEqual(value, { a: 1, b: [1, 2] });
});

test('não confunde // dentro de string', () => {
  const { value, error } = parseJsonc('{"url": "https://example.com/a//b"}');
  assert.equal(error, null);
  assert.equal(value.url, 'https://example.com/a//b');
});

test('retorna erro em JSON inválido sem lançar', () => {
  const { value, error } = parseJsonc('{"a": }', 'x.json');
  assert.equal(value, null);
  assert.match(error, /x\.json/);
});
