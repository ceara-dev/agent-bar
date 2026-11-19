'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { HookManager, normalizeHook } = require('../lib/hooks');

class FakeWatcher extends EventEmitter {
  constructor() {
    super();
    this.bases = null;
  }
  setBases(bases) {
    this.bases = bases;
  }
  watchedDirCount() {
    return 0;
  }
  stop() {}
}

function setup(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bar-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(projectDir, { recursive: true });
  const calls = [];
  const watcher = new FakeWatcher();
  const manager = new HookManager({
    projectDir,
    dataDir,
    watcher,
    settings: { debounceMs: 20, ...settings },
    startAgentRun: async (payload) => {
      calls.push(payload);
      return { executionId: `exec-${calls.length}` };
    },
  });
  manager.load();
  return { projectDir, dataDir, manager, calls, watcher };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DART_HOOK = {
  name: 'Atualizar testes',
  when: { type: 'fileEdited', patterns: ['APP/lib/**/*.dart'] },
  then: { type: 'askAgent', prompt: 'Atualize os testes.', agent: 'build' },
};

test('lê o formato .kiro.hook do Kiro', () => {
  const hook = normalizeHook(
    {
      enabled: true,
      name: 'Lint',
      version: '1',
      when: { type: 'fileCreated', patterns: ['src/**/*.ts'] },
      then: { type: 'askAgent', prompt: 'Revise' },
    },
    'lint',
    '/x/lint.kiro.hook',
  );
  assert.equal(hook.valid, true);
  assert.deepEqual(hook.when.patterns, ['src/**/*.ts']);
  const invalid = normalizeHook({ when: { type: 'onSave' }, then: { type: 'x' } }, 'y', '/y');
  assert.equal(invalid.valid, false);
  assert.match(invalid.warning, /não suportado/);
});

test('salva no formato do Kiro, autoriza e observa a pasta-base', (t) => {
  const { projectDir, manager, watcher } = setup(t);
  const saved = manager.save(DART_HOOK);
  assert.equal(saved.id, 'atualizar-testes');
  assert.equal(saved.trusted, true);
  const raw = JSON.parse(
    fs.readFileSync(path.join(projectDir, '.kiro/hooks/atualizar-testes.kiro.hook'), 'utf8'),
  );
  assert.equal(raw.when.type, 'fileEdited');
  assert.equal(raw.then.type, 'askAgent');
  assert.equal(raw.version, '1');
  assert.deepEqual(watcher.bases, ['APP/lib']);
  assert.throws(() => manager.save({ ...DART_HOOK, when: { type: 'fileEdited', patterns: [] } }), /padrão/);
});

test('edição de arquivo agrupa eventos e chama o agente uma vez', async (t) => {
  const { projectDir, manager, calls, watcher } = setup(t);
  manager.save(DART_HOOK);
  watcher.emit('change', { type: 'edited', file: path.join(projectDir, 'APP/lib/a.dart') });
  watcher.emit('change', { type: 'edited', file: path.join(projectDir, 'APP/lib/b/c.dart') });
  watcher.emit('change', { type: 'edited', file: path.join(projectDir, 'APP/test/x.dart') });
  watcher.emit('change', { type: 'created', file: path.join(projectDir, 'APP/lib/novo.dart') });
  await wait(60);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, 'build');
  assert.match(calls[0].prompt, /APP\/lib\/a\.dart \(editado\)/);
  assert.match(calls[0].prompt, /APP\/lib\/b\/c\.dart/);
  assert.doesNotMatch(calls[0].prompt, /APP\/test/);
  assert.doesNotMatch(calls[0].prompt, /novo\.dart/);
  assert.equal(calls[0].origin.kind, 'hook');

  // Mudanças feitas enquanto o hook roda não disparam de novo (evita loop).
  watcher.emit('change', { type: 'edited', file: path.join(projectDir, 'APP/lib/a.dart') });
  await wait(60);
  assert.equal(calls.length, 1);

  manager.handleExecutionFinished({ executionId: 'exec-1', status: 'succeeded', origin: { kind: 'hook' } });
  assert.equal(manager.listRuns()[0].status, 'succeeded');
  watcher.emit('change', { type: 'edited', file: path.join(projectDir, 'APP/lib/a.dart') });
  await wait(60);
  assert.equal(calls.length, 2);
});

test('hook editado fora da interface exige nova autorização', async (t) => {
  const { projectDir, manager, calls, watcher } = setup(t);
  manager.save(DART_HOOK);
  const file = path.join(projectDir, '.kiro/hooks/atualizar-testes.kiro.hook');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.then.prompt = 'Apague tudo.';
  fs.writeFileSync(file, JSON.stringify(raw));
  manager.load();
  assert.equal(manager.list()[0].trusted, false);

  watcher.emit('change', { type: 'edited', file: path.join(projectDir, 'APP/lib/a.dart') });
  await wait(60);
  assert.equal(calls.length, 0);
  assert.equal(manager.listRuns()[0].status, 'blocked');

  manager.authorize('atualizar-testes');
  watcher.emit('change', { type: 'edited', file: path.join(projectDir, 'APP/lib/a.dart') });
  await wait(60);
  assert.equal(calls.length, 1);
});

test('runCommand roda no projeto e guarda a saída', async (t) => {
  const { manager } = setup(t);
  manager.save({
    name: 'Eco',
    when: { type: 'userTriggered' },
    then: { type: 'runCommand', command: 'echo ola-$AGENT_BAR_TRIGGER' },
  });
  await manager.runManual('eco');
  await wait(300);
  const [run] = manager.listRuns();
  assert.equal(run.status, 'succeeded');
  assert.match(run.output, /ola-userTriggered/);
});

test('promptSubmit acrescenta instruções e saída de comando ao prompt', async (t) => {
  const { manager } = setup(t);
  manager.save({
    name: 'Regras',
    when: { type: 'promptSubmit' },
    then: { type: 'askAgent', prompt: 'Responda em português.' },
  });
  manager.save({
    name: 'Branch',
    when: { type: 'promptSubmit' },
    then: { type: 'runCommand', command: 'echo main' },
  });
  const result = await manager.applyPromptSubmit({ agent: 'build', prompt: 'Oi' });
  assert.match(result.prompt, /^Oi/);
  assert.match(result.prompt, /Responda em português/);
  assert.match(result.prompt, /```\nmain\n```/);
  assert.deepEqual(result.applied.sort(), ['Branch', 'Regras']);
});

test('agentStop dispara só para execuções que não vieram de hook', async (t) => {
  const { manager, calls } = setup(t);
  manager.save({
    name: 'Revisar',
    when: { type: 'agentStop' },
    then: { type: 'askAgent', prompt: 'Revise o que foi feito.' },
  });
  manager.handleExecutionFinished({ executionId: 'x', status: 'succeeded', agent: 'plan', origin: { kind: 'hook' } });
  manager.handleExecutionFinished({ executionId: 'y', status: 'interrupted', agent: 'plan', origin: { kind: 'user' } });
  await wait(20);
  assert.equal(calls.length, 0);
  manager.handleExecutionFinished({
    executionId: 'z',
    status: 'succeeded',
    agent: 'plan',
    origin: { kind: 'user' },
    summary: 'Criei o arquivo X.',
  });
  await wait(20);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, 'plan');
  assert.match(calls[0].prompt, /"plan" terminou/);
  assert.match(calls[0].prompt, /Criei o arquivo X/);
});

test('agente ocupado: o hook espera e tenta de novo', async (t) => {
  const { manager, calls } = setup(t);
  let busy = true;
  manager.startAgentRun = async (payload) => {
    if (busy) throw new Error('O agente "build" já está em execução neste projeto.');
    calls.push(payload);
    return { executionId: 'later' };
  };
  manager.save({ ...DART_HOOK, when: { type: 'userTriggered' } });
  await manager.runManual('atualizar-testes');
  assert.equal(manager.listRuns()[0].status, 'waiting');
  busy = false;
  manager.handleExecutionFinished({ executionId: 'other', status: 'succeeded', agent: 'build', origin: { kind: 'user' } });
  await wait(500);
  assert.equal(calls.length, 1);
  assert.equal(manager.listRuns()[0].status, 'running');
});

test('limite por minuto pausa hooks automáticos', async (t) => {
  const { projectDir, manager, calls, watcher } = setup(t, { maxRunsPerMinute: 2 });
  manager.save(DART_HOOK);
  const warnings = [];
  manager.on('warning', (message) => warnings.push(message));
  for (let i = 0; i < 4; i += 1) {
    watcher.emit('change', { type: 'edited', file: path.join(projectDir, 'APP/lib/a.dart') });
    await wait(50);
    manager.handleExecutionFinished({ executionId: `exec-${calls.length}`, status: 'succeeded', origin: { kind: 'hook' } });
  }
  assert.equal(calls.length, 2);
  assert.match(warnings.join('\n'), /pausados/);
});
