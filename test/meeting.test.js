'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MeetingManager } = require('../lib/meeting');

test('salva, lista e apaga modelos de reunião', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bar-meeting-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const manager = new MeetingManager({
    api: {},
    history: { ensureSession() {}, recordPrompt() {}, recordText() {} },
    getAgents: () => [
      { name: 'atlas', mode: 'all', hidden: false },
      { name: 'dedalo', mode: 'all', hidden: false },
    ],
    getProjectDir: () => '/tmp/projeto',
    emit: () => {},
    dataDir: dir,
    settings: { maxAgents: 4, maxRounds: 3, turnTimeoutMs: 1000 },
  });
  manager.init();

  const template = manager.saveTemplate({
    name: 'Planejamento',
    host: 'atlas',
    participants: ['dedalo'],
    agenda: 'Revisar backlog',
    mode: 'roundtable',
    order: 'fixed',
    maxRounds: 2,
    stopCriterion: 'host',
  });

  assert.ok(template.id);
  assert.equal(manager.listTemplates().length, 1);
  assert.equal(manager.listTemplates()[0].name, 'Planejamento');

  manager.deleteTemplate(template.id);
  assert.equal(manager.listTemplates().length, 0);
});
