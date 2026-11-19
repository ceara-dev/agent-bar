'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Runner, expandTemplate } = require('../lib/runner');

function invocation(options) {
  const runner = new Runner({ cwd: process.cwd(), bin: '/bin/true' });
  if (options.supportsCommandFlag) {
    runner.setCapabilities({ supportsCommandFlag: true });
  }
  return runner.buildInvocation(options);
}

test('prompt livre usa --agent antes da mensagem', () => {
  const result = invocation({ agent: 'build', prompt: 'Explique o projeto' });
  assert.deepEqual(result.args, ['run', '--agent', 'build', 'Explique o projeto']);
});

test('prompt geral não envia --agent', () => {
  const result = invocation({ agent: '__general__', prompt: 'Olá' });
  assert.deepEqual(result.args, ['run', 'Olá']);
});

test('usa --command quando a versão suporta', () => {
  const result = invocation({
    agent: 'atlas',
    command: 'planejar',
    args: 'turma 1',
    supportsCommandFlag: true,
  });
  assert.deepEqual(result.args, ['run', '--agent', 'atlas', '--command', 'planejar', 'turma 1']);
});

test('fallback expande o template quando --command não existe', () => {
  const result = invocation({
    agent: 'atlas',
    command: 'planejar',
    args: 'turma 1',
    template: 'Planeje $ARGUMENTS com prioridade $1.',
  });
  assert.deepEqual(result.args, [
    'run',
    '--agent',
    'atlas',
    'Planeje turma 1 com prioridade turma.',
  ]);
});

test('fallback sem template envia /comando', () => {
  const result = invocation({
    agent: 'atlas',
    command: 'planejar',
    args: 'turma 1',
    template: '',
  });
  assert.deepEqual(result.args, ['run', '--agent', 'atlas', '/planejar turma 1']);
});

test('rejeita execução simultânea do mesmo agente', () => {
  const runner = new Runner({ cwd: process.cwd(), bin: '/bin/true' });
  runner.runningByAgent.set('atlas', 'execucao-1');
  assert.throws(
    () => runner.run({ agent: 'atlas', prompt: 'x' }),
    /já está em execução/,
  );
});

test('expandTemplate substitui $ARGUMENTS, ${ARGUMENTS} e $1..$9', () => {
  assert.equal(
    expandTemplate('A=$ARGUMENTS B=${ARGUMENTS} C=$1 D=$2', 'um dois'),
    'A=um dois B=um dois C=um D=dois',
  );
});
