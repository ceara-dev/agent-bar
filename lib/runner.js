'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(value) {
  return String(value).replace(ANSI_PATTERN, '');
}

function expandTemplate(template, args) {
  const argumentText = String(args || '').trim();
  const parts = argumentText.length > 0 ? argumentText.split(/\s+/) : [];

  return String(template || '')
    .replace(/\$\{ARGUMENTS\}/g, argumentText)
    .replace(/\$ARGUMENTS/g, argumentText)
    .replace(/\$([1-9])/g, (_, index) => parts[Number(index) - 1] || '');
}

class Runner extends EventEmitter {
  constructor({ cwd, bin = process.env.OPENCODE_BIN || 'opencode' }) {
    super();
    this.cwd = cwd;
    this.bin = bin;
    this.supportsCommandFlag = false;
    this.executions = new Map();
    this.runningByAgent = new Map();
  }

  setCapabilities({ supportsCommandFlag }) {
    this.supportsCommandFlag = supportsCommandFlag === true;
  }

  isRunning(agent) {
    return this.runningByAgent.has(agent || '__general__');
  }

  buildInvocation({ agent, command, args, prompt, template }) {
    const invocation = ['run'];
    const agentName = agent && agent !== '__general__' ? agent : null;

    if (agentName) {
      invocation.push('--agent', agentName);
    }

    if (command) {
      if (this.supportsCommandFlag) {
        invocation.push('--command', command);
        if (args) invocation.push(String(args));
      } else if (template) {
        invocation.push(expandTemplate(template, args));
      } else {
        invocation.push(`/${command}${args ? ` ${args}` : ''}`);
      }
    } else {
      invocation.push(String(prompt || ''));
    }

    return { args: invocation, agent: agentName || '__general__', command: command || null };
  }

  run(payload) {
    const agentKey = payload.agent || '__general__';
    if (this.isRunning(agentKey)) {
      const error = new Error(
        `O agente "${agentKey}" já está em execução neste projeto. Aguarde a conclusão.`,
      );
      error.code = 'AGENT_BUSY';
      throw error;
    }

    const invocation = this.buildInvocation(payload);
    const executionId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const execution = {
      id: executionId,
      agent: invocation.agent,
      command: invocation.command,
      args: payload.args || '',
      prompt: payload.prompt || '',
      startedAt,
      finishedAt: null,
      status: 'running',
      exitCode: null,
      signal: null,
      log: '',
    };

    this.executions.set(executionId, execution);
    this.runningByAgent.set(agentKey, executionId);

    this.emit('event', {
      type: 'start',
      executionId,
      agent: execution.agent,
      command: execution.command,
      args: execution.args,
      prompt: execution.prompt,
      startedAt,
    });

    const child = spawn(this.bin, invocation.args, {
      cwd: this.cwd,
      shell: false,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    });

    execution.child = child;

    const emitChunk = (stream, chunk) => {
      const text = stripAnsi(chunk.toString());
      execution.log += text;
      this.emit('event', {
        type: 'log',
        executionId,
        agent: execution.agent,
        stream,
        chunk: text,
      });
    };

    child.stdout.on('data', (chunk) => emitChunk('stdout', chunk));
    child.stderr.on('data', (chunk) => emitChunk('stderr', chunk));

    child.on('error', (error) => {
      if (execution.finishedAt) return;
      execution.status = 'error';
      execution.finishedAt = new Date().toISOString();
      this.runningByAgent.delete(agentKey);
      this.emit('event', {
        type: 'error',
        executionId,
        agent: execution.agent,
        message: error.message,
      });
      this.emit('event', {
        type: 'exit',
        executionId,
        agent: execution.agent,
        code: null,
        signal: null,
        status: 'error',
        finishedAt: execution.finishedAt,
      });
    });

    child.on('close', (code, signal) => {
      if (execution.finishedAt) return;
      execution.exitCode = code;
      execution.signal = signal;
      execution.finishedAt = new Date().toISOString();
      execution.status = code === 0 ? 'done' : 'error';
      this.runningByAgent.delete(agentKey);
      this.emit('event', {
        type: 'exit',
        executionId,
        agent: execution.agent,
        code,
        signal,
        status: execution.status,
        finishedAt: execution.finishedAt,
      });
    });

    return {
      executionId,
      agent: execution.agent,
      command: execution.command,
      args: invocation.args,
    };
  }

  cancel(executionId) {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return { ok: false, message: 'Execução não encontrada.' };
    }
    if (!execution.child || execution.status !== 'running') {
      return { ok: false, message: 'Execução já finalizada.' };
    }

    execution.child.kill('SIGTERM');
    setTimeout(() => {
      if (execution.child && execution.status === 'running') {
        execution.child.kill('SIGKILL');
      }
    }, 3000).unref?.();

    return { ok: true };
  }

  getExecution(executionId) {
    const execution = this.executions.get(executionId);
    if (!execution) return null;
    const { child, ...rest } = execution;
    return rest;
  }
}

module.exports = {
  Runner,
  expandTemplate,
  stripAnsi,
};
