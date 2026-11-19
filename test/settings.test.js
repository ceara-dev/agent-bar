'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSettings, merge } = require('../lib/settings');

test('mescla configuração parcial com defaults', () => {
  const merged = merge(
    { history: { retentionDays: 90, maxSessionBytes: 100 }, meeting: { maxAgents: 4 } },
    { history: { retentionDays: 10 } },
  );

  assert.equal(merged.history.retentionDays, 10);
  assert.equal(merged.history.maxSessionBytes, 100);
  assert.equal(merged.meeting.maxAgents, 4);
});

test('lê settings.json e valida limites', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bar-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      history: { retentionDays: 7, maxSessionBytes: 1024 },
      meeting: { maxAgents: 99, maxRounds: 0 },
    }),
  );

  const { values, warning } = readSettings(dir);
  assert.equal(warning, null);
  assert.equal(values.history.retentionDays, 7);
  assert.equal(values.history.maxSessionBytes, 64 * 1024);
  assert.equal(values.meeting.maxAgents, 12);
  assert.equal(values.meeting.maxRounds, 3);
});

test('retorna defaults e aviso para JSON inválido', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bar-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'settings.json'), '{ inválido');
  const { values, warning } = readSettings(dir);
  assert.match(warning, /settings\.json/);
  assert.equal(values.history.retentionDays, 90);
});
