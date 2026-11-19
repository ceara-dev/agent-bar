'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MeetingManager } = require('../lib/meeting');
const { HistoryStore } = require('../lib/history');

function waitFor(condition, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timeout esperando condição'));
      }
    }, 20);
  });
}

test('mesa-redonda conclui, gera ata e encerra o histórico', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bar-roundtable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const history = new HistoryStore({
    dir: path.join(root, 'history'),
    retentionDays: 90,
    maxSessionBytes: 1024 * 1024,
  });
  history.init();

  const sessions = new Map();
  const meetingRef = { current: null };
  const api = {
    async createSession({ agent }) {
      const id = `ses_${agent}_${sessions.size + 1}`;
      sessions.set(id, agent);
      return { data: { id } };
    },
    async sendPrompt(sessionID, text) {
      const agent = sessions.get(sessionID);
      const response =
        text.includes('Gere a ata final')
          ? '### Decisões\n- Ata de teste'
          : agent === 'atlas'
            ? 'CONCLUÍDO. Vamos seguir o plano.'
            : 'Minha parte está pronta.';
      setTimeout(() => {
        meetingRef.current.onServerEvent({
          type: 'session.execution.started',
          data: { sessionID },
        });
        meetingRef.current.onServerEvent({
          type: 'session.text.ended',
          data: { sessionID, text: response, assistantMessageID: 'm1' },
        });
        meetingRef.current.onServerEvent({
          type: 'session.execution.succeeded',
          data: { sessionID },
        });
      }, 5);
      return { data: {} };
    },
    async interrupt() {
      return { interrupted: true };
    },
  };

  const events = [];
  const manager = new MeetingManager({
    api,
    history,
    getAgents: () => [
      { name: 'atlas', mode: 'all', hidden: false },
      { name: 'dedalo', mode: 'all', hidden: false },
    ],
    getProjectDir: () => root,
    emit: (event) => events.push(event),
    dataDir: root,
    settings: { maxAgents: 4, maxRounds: 3, turnTimeoutMs: 1000 },
  });
  meetingRef.current = manager;
  manager.init();

  const state = await manager.start({
    host: 'atlas',
    participants: ['dedalo'],
    agenda: 'Decidir o próximo passo',
    projectDir: root,
    mode: 'roundtable',
    order: 'fixed',
    maxRounds: 1,
    stopCriterion: 'host',
  });

  assert.equal(state.status, 'running');
  await waitFor(() => manager.publicState()?.status === 'done');

  const done = manager.publicState();
  assert.equal(done.status, 'done');
  assert.ok(done.ataPath);
  assert.ok(fs.existsSync(done.ataPath));
  assert.match(fs.readFileSync(done.ataPath, 'utf8'), /Ata de teste/);
  assert.ok(done.chat.some((item) => item.agent === 'atlas' && /CONCLUÍDO/.test(item.text || '')));
  assert.ok(history.list().every((entry) => entry.status === 'succeeded'));
  assert.ok(events.some((event) => event.type === 'finished'));
});
