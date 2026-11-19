'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SpecStore,
  SpecRunner,
  parseTasks,
  updateTaskStatus,
  taskProgress,
  nextTask,
  slugify,
} = require('../lib/specs');

const TASKS = `# Plano de Implementação

- [ ] 1. Criar modelo de dados
  - Criar tabela posts
  - _Requisitos: 1.1, 2.3_

- [ ] 2. Implementar API
- [x] 2.1 Rota de listagem
  - _Requirements: 1.2_
- [ ] 2.2 Rota de criação
- [ ]* 2.3 Testes extras

- [-] 3. Tela no app
`;

test('lê tarefas, subtarefas, detalhes, requisitos e opcionais', () => {
  const tasks = parseTasks(TASKS);
  assert.deepEqual(
    tasks.map((task) => [task.id, task.status, task.depth, task.leaf]),
    [
      ['1', 'todo', 0, true],
      ['2', 'todo', 0, false],
      ['2.1', 'done', 1, true],
      ['2.2', 'todo', 1, true],
      ['2.3', 'todo', 1, true],
      ['3', 'in_progress', 0, true],
    ],
  );
  assert.equal(tasks[0].title, 'Criar modelo de dados');
  assert.deepEqual(tasks[0].details, ['Criar tabela posts']);
  assert.deepEqual(tasks[0].requirements, ['1.1', '2.3']);
  assert.deepEqual(tasks[2].requirements, ['1.2']);
  assert.equal(tasks[4].optional, true);
  assert.deepEqual(tasks[1].children, ['2.1', '2.2', '2.3']);
});

test('subtarefas indentadas sem numeração também têm pai', () => {
  const tasks = parseTasks('- [ ] Pai\n  - [ ] Filha A\n  - [x] Filha B\n- [ ] Outra');
  assert.equal(tasks[1].parentId, tasks[0].id);
  assert.equal(tasks[2].parentId, tasks[0].id);
  assert.equal(tasks[3].parentId, null);
});

test('progresso e próxima tarefa ignoram opcionais', () => {
  const tasks = parseTasks(TASKS);
  assert.deepEqual(taskProgress(tasks), { total: 5, done: 1, requiredTotal: 4, requiredDone: 1 });
  assert.equal(nextTask(tasks).id, '1');
});

test('concluir as subtarefas obrigatórias conclui o pai; desmarcar reabre', () => {
  let markdown = updateTaskStatus(TASKS, '2.2', 'done');
  let tasks = parseTasks(markdown);
  assert.equal(tasks.find((task) => task.id === '2').status, 'done', 'a 2.3 é opcional');
  assert.equal(tasks.find((task) => task.id === '2.3').status, 'todo');
  markdown = updateTaskStatus(markdown, '2.3', 'done');
  tasks = parseTasks(markdown);
  assert.equal(tasks.find((task) => task.id === '2').status, 'done');
  markdown = updateTaskStatus(markdown, '2.1', 'todo');
  tasks = parseTasks(markdown);
  assert.equal(tasks.find((task) => task.id === '2').status, 'in_progress');
  assert.match(markdown, /- \[ \]\* 2\.3|- \[x\]\* 2\.3/);
  assert.match(markdown, /_Requisitos: 1\.1, 2\.3_/);
});

test('marcar o pai marca as subtarefas e preserva CRLF', () => {
  const crlf = TASKS.replace(/\n/g, '\r\n');
  const markdown = updateTaskStatus(crlf, '2', 'done');
  assert.ok(markdown.includes('\r\n'));
  const tasks = parseTasks(markdown);
  assert.ok(['2', '2.1', '2.2', '2.3'].every((id) => tasks.find((task) => task.id === id).status === 'done'));
});

test('slugify gera nomes de pasta válidos', () => {
  assert.equal(slugify('Notificações Push!'), 'notificacoes-push');
  assert.equal(slugify('  Login com Google  '), 'login-com-google');
});

function tempStore(t) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bar-specs-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  return { projectDir, store: new SpecStore({ projectDir }) };
}

test('fases seguem aprovação: requisitos → design → tarefas → implementação', (t) => {
  const { projectDir, store } = tempStore(t);
  const created = store.create({ title: 'Login com Google', idea: 'OAuth', agent: 'build' });
  assert.equal(created.name, 'login-com-google');
  assert.equal(created.phase, 'requirements');
  const config = JSON.parse(fs.readFileSync(path.join(projectDir, '.kiro/specs/login-com-google/.config.kiro'), 'utf8'));
  assert.equal(config.workflowType, 'requirements-first');
  assert.equal(config.agentBar.agent, 'build');

  assert.throws(() => store.approve('login-com-google', 'requirements'), /Gere requisitos/);
  const dir = path.join(projectDir, '.kiro/specs/login-com-google');
  fs.writeFileSync(path.join(dir, 'requirements.md'), '# Req');
  store.approve('login-com-google', 'requirements');
  assert.equal(store.summary('login-com-google').phase, 'design');

  assert.throws(() => store.approve('login-com-google', 'tasks'), /Gere tarefas/);
  fs.writeFileSync(path.join(dir, 'design.md'), '# Design');
  store.approve('login-com-google', 'design');
  fs.writeFileSync(path.join(dir, 'tasks.md'), '- [ ] 1. A\n- [ ] 2. B\n');
  store.approve('login-com-google', 'tasks');
  let summary = store.summary('login-com-google');
  assert.equal(summary.phase, 'implementation');
  assert.deepEqual(summary.next, { id: '1', number: '1', title: 'A' });

  store.setTaskStatus('login-com-google', '1', 'done');
  store.setTaskStatus('login-com-google', '2', 'done');
  summary = store.summary('login-com-google');
  assert.equal(summary.phase, 'done');
  assert.equal(summary.approvals.tasks.stale, false, 'checkbox não invalida aprovação');

  store.approve('login-com-google', 'design', false);
  summary = store.summary('login-com-google');
  assert.equal(summary.approvals.design.approved, false);
  assert.equal(summary.approvals.tasks.approved, false, 'desaprovar reabre fases seguintes');
  assert.throws(() => store.create({ title: 'Login com Google' }), /Já existe/);
});

test('SpecRunner marca a tarefa e encadeia "executar todas"', async (t) => {
  const { projectDir, store } = tempStore(t);
  store.create({ title: 'Feed', agent: 'build' });
  const dir = path.join(projectDir, '.kiro/specs/feed');
  fs.writeFileSync(path.join(dir, 'requirements.md'), 'r');
  store.approve('feed', 'requirements');
  fs.writeFileSync(path.join(dir, 'design.md'), 'd');
  store.approve('feed', 'design');
  fs.writeFileSync(path.join(dir, 'tasks.md'), '- [ ] 1. A\n- [ ] 2. B\n- [ ]* 3. C\n');
  store.approve('feed', 'tasks');

  const started = [];
  let counter = 0;
  const runner = new SpecRunner({
    store,
    startRun: async (payload) => {
      started.push(payload);
      counter += 1;
      return { executionId: `exec-${counter}` };
    },
    cancelRun: async () => ({ ok: true }),
  });

  await runner.runAll('feed');
  assert.equal(started[0].agent, 'build');
  assert.match(started[0].prompt, /Tarefa: 1\. A/);
  assert.deepEqual(started[0].origin, { kind: 'spec', spec: 'feed', task: '1', phase: null });
  assert.equal(store.read('feed').tasks[0].status, 'in_progress');
  await assert.rejects(runner.runTask('feed', '2'), /já tem uma execução/);

  runner.handleFinished({ executionId: 'exec-1', status: 'succeeded' });
  assert.equal(store.read('feed').tasks[0].status, 'done');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(started.length, 2);
  assert.match(started[1].prompt, /Tarefa: 2\. B/);

  runner.handleFinished({ executionId: 'exec-2', status: 'failed' });
  assert.equal(store.read('feed').tasks[1].status, 'todo');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(started.length, 2, 'falha interrompe a sequência');
});

test('SpecRunner exige a fase anterior aprovada', async (t) => {
  const { store } = tempStore(t);
  store.create({ title: 'X' });
  const runner = new SpecRunner({ store, startRun: async () => ({ executionId: 'e' }), cancelRun: async () => ({}) });
  await assert.rejects(runner.runPhase('x', 'design'), /Aprove requisitos/);
  await assert.rejects(runner.runPhase('x', 'requirements', { feedback: 'mude' }), /Gere requisitos/);
  const entry = await runner.runPhase('x', 'requirements');
  assert.equal(entry.agent, '__general__');
});

test('"executar todas" espera o agente ocupado e retoma', async (t) => {
  const { projectDir, store } = tempStore(t);
  store.create({ title: 'Fila', agent: 'build' });
  const dir = path.join(projectDir, '.kiro/specs/fila');
  for (const [phase, file, text] of [
    ['requirements', 'requirements.md', 'r'],
    ['design', 'design.md', 'd'],
    ['tasks', 'tasks.md', '- [ ] 1. A\n- [ ] 2. B\n'],
  ]) {
    fs.writeFileSync(path.join(dir, file), text);
    store.approve('fila', phase);
  }
  let busy = false;
  let counter = 0;
  const runner = new SpecRunner({
    store,
    startRun: async () => {
      if (busy) throw new Error('O agente "build" já está em execução neste projeto.');
      counter += 1;
      return { executionId: `e${counter}` };
    },
    cancelRun: async () => ({ ok: true }),
  });
  await runner.runAll('fila');
  busy = true; // um hook pegou o agente
  runner.handleFinished({ executionId: 'e1', status: 'succeeded' });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(runner.state().fila.kind, 'waiting');
  assert.equal(store.read('fila').tasks[1].status, 'todo');

  busy = false;
  runner.handleFinished({ executionId: 'hook-run', status: 'succeeded' });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(runner.state().fila.kind, 'task');
  assert.equal(runner.state().fila.taskId, '2');
});
