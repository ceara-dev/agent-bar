'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HistoryStore } = require('../lib/history');

function tempStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bar-history-'));
  const store = new HistoryStore({
    dir,
    retentionDays: options.retentionDays ?? 90,
    maxSessionBytes: options.maxSessionBytes ?? 5 * 1024 * 1024,
  });
  return { dir, store };
}

test('grava, lista, lê e exporta uma sessão', (t) => {
  const { dir, store } = tempStore();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  store.init();
  store.ensureSession({
    id: 'ses_1',
    agent: 'atlas',
    projectDir: '/tmp/projeto',
    title: 'Teste',
    prompt: 'Faça algo',
  });
  store.recordPrompt('ses_1', 'Faça algo');
  store.recordText('ses_1', 'Resposta do agente');
  store.recordTool('ses_1', {
    phase: 'called',
    toolId: 't1',
    name: 'editando',
    input: { filePath: '/tmp/projeto/a.dart' },
  });
  store.recordFile('ses_1', '/tmp/projeto/a.dart', 'change');
  store.endSession('ses_1', { status: 'succeeded' });

  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].agent, 'atlas');
  assert.equal(list[0].status, 'succeeded');
  assert.equal(list[0].actions, 1);
  assert.ok(list[0].files.includes('/tmp/projeto/a.dart'));

  const read = store.read('ses_1');
  assert.ok(read.events.some((event) => event.type === 'text'));
  assert.ok(read.events.some((event) => event.type === 'tool'));

  const markdown = store.exportMarkdown('ses_1');
  assert.match(markdown, /# Agent Bar — atlas/);
  assert.match(markdown, /Resposta do agente/);
  assert.match(markdown, /a\.dart/);

  store.delete('ses_1');
  assert.equal(store.list().length, 0);
});

test('trunca sessão que excede o limite', (t) => {
  const { dir, store } = tempStore({ maxSessionBytes: 600 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  store.init();
  store.ensureSession({ id: 'ses_big', agent: 'atlas', projectDir: '/tmp' });
  store.recordPrompt('ses_big', 'x'.repeat(400));
  store.recordText('ses_big', 'y'.repeat(400));

  const entry = store.list()[0];
  assert.equal(entry.truncated, true);
  const read = store.read('ses_big');
  assert.ok(read.events.some((event) => event.type === 'truncated'));
});

test('remove sessões antigas na retenção', (t) => {
  const { dir, store } = tempStore({ retentionDays: 1 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  store.init();
  store.ensureSession({
    id: 'ses_old',
    agent: 'atlas',
    projectDir: '/tmp',
    startedAt: '2020-01-01T00:00:00.000Z',
  });
  store.endSession('ses_old', { status: 'succeeded' });
  store.saveIndexNow();

  store.entries[0].endedAt = '2020-01-01T00:00:00.000Z';
  store.prune();
  assert.equal(store.list().length, 0);
});
