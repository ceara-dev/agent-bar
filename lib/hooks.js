'use strict';

/*
 * Hooks no formato do Kiro: arquivos JSON `.kiro/hooks/<nome>.kiro.hook`:
 *
 *   {
 *     "enabled": true,
 *     "name": "Atualizar testes",
 *     "description": "Quando um arquivo Dart mudar, ajuste os testes",
 *     "version": "1",
 *     "when": { "type": "fileEdited", "patterns": ["APP/lib/**\/*.dart"] },
 *     "then": { "type": "askAgent", "prompt": "..." }
 *   }
 *
 * Gatilhos (when.type): fileEdited, fileCreated, fileDeleted, userTriggered,
 * promptSubmit, agentStop. Ações (then.type): askAgent (prompt) e runCommand
 * (command). Extensões do Agent Bar, ignoradas pelo Kiro: then.agent (agente
 * do OpenCode que executa o askAgent) e then.timeoutMs (runCommand).
 *
 * Segurança: um hook só roda depois de autorizado nesta máquina. A
 * autorização é o hash de when+then guardado em data/hooks-trust.json (fora
 * do repositório); hooks salvos pela interface já nascem autorizados, e
 * qualquer edição externa do arquivo exige nova autorização. Isso impede que
 * um repositório clonado, ou um agente sem permissão de bash, crie um hook
 * que execute comandos sozinho.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { matchAny, staticBase, toPatternList, normalizePath } = require('./glob');

const TRIGGERS = {
  fileEdited: { label: 'arquivo editado', files: true },
  fileCreated: { label: 'arquivo criado', files: true },
  fileDeleted: { label: 'arquivo apagado', files: true },
  userTriggered: { label: 'manual', files: false },
  promptSubmit: { label: 'envio de prompt', files: false },
  agentStop: { label: 'agente terminou', files: false },
};
const ACTIONS = ['askAgent', 'runCommand'];
const FILE_EVENT_TO_TRIGGER = {
  created: 'fileCreated',
  edited: 'fileEdited',
  deleted: 'fileDeleted',
};
const FILE_EVENT_LABEL = { created: 'criado', edited: 'editado', deleted: 'apagado' };
const HOOK_SUFFIX = '.kiro.hook';
const MAX_OUTPUT = 64 * 1024;
const MAX_RUNS = 80;
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;

function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

function normalizeHook(raw, id, file) {
  const warnings = [];
  const value = raw && typeof raw === 'object' ? raw : {};
  const when = value.when && typeof value.when === 'object' ? value.when : {};
  const then = value.then && typeof value.then === 'object' ? value.then : {};

  let whenType = String(when.type || '');
  if (!TRIGGERS[whenType]) {
    warnings.push(`Gatilho "${whenType || '(vazio)'}" não suportado.`);
    whenType = 'userTriggered';
  }
  const patterns = toPatternList(when.patterns);
  if (TRIGGERS[whenType].files && patterns.length === 0) {
    warnings.push('Gatilho de arquivo sem "patterns"; nunca vai disparar.');
  }

  let thenType = String(then.type || '');
  if (!ACTIONS.includes(thenType)) {
    warnings.push(`Ação "${thenType || '(vazia)'}" não suportada.`);
    thenType = 'askAgent';
  }
  const prompt = typeof then.prompt === 'string' ? then.prompt : '';
  const command = typeof then.command === 'string' ? then.command : '';
  if (thenType === 'askAgent' && !prompt.trim()) warnings.push('askAgent sem "prompt".');
  if (thenType === 'runCommand' && !command.trim()) warnings.push('runCommand sem "command".');

  return {
    id,
    file,
    enabled: value.enabled !== false,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id,
    description: typeof value.description === 'string' ? value.description : '',
    version: value.version ? String(value.version) : '1',
    when: { type: whenType, patterns },
    then: {
      type: thenType,
      prompt,
      command,
      agent: typeof then.agent === 'string' && then.agent ? then.agent : null,
      timeoutMs: Number.isFinite(then.timeoutMs) ? then.timeoutMs : null,
    },
    warning: warnings.length > 0 ? warnings.join(' ') : null,
    valid: warnings.length === 0,
  };
}

function serializeHook(hook) {
  const then = { type: hook.then.type };
  if (hook.then.type === 'askAgent') {
    then.prompt = hook.then.prompt;
    if (hook.then.agent) then.agent = hook.then.agent;
  } else {
    then.command = hook.then.command;
    if (hook.then.timeoutMs) then.timeoutMs = hook.then.timeoutMs;
  }
  const when = { type: hook.when.type };
  if (TRIGGERS[hook.when.type]?.files) when.patterns = hook.when.patterns;
  return `${JSON.stringify(
    {
      enabled: hook.enabled,
      name: hook.name,
      description: hook.description || '',
      version: hook.version || '1',
      when,
      then,
    },
    null,
    2,
  )}\n`;
}

function fingerprint(hook) {
  const payload = JSON.stringify({
    when: { type: hook.when.type, patterns: hook.when.patterns },
    then: {
      type: hook.then.type,
      prompt: hook.then.prompt,
      command: hook.then.command,
      agent: hook.then.agent,
    },
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function truncate(text, max = MAX_OUTPUT) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}\n… (saída truncada)` : value;
}

class HookManager extends EventEmitter {
  constructor({
    projectDir,
    dataDir,
    startAgentRun,
    watcher = null,
    settings = {},
  }) {
    super();
    this.projectDir = projectDir;
    this.dataDir = dataDir;
    this.startAgentRun = startAgentRun;
    this.watcher = watcher;
    this.settings = {
      debounceMs: 1500,
      maxRunsPerMinute: 12,
      commandTimeoutMs: 120_000,
      promptCommandTimeoutMs: 30_000,
      ...settings,
    };
    this.hooks = [];
    this.trust = {};
    this.runs = [];
    this.running = new Map(); // hookId → run
    this.waiting = []; // runs esperando o agente liberar
    this.pendingFiles = new Map(); // hookId → { files: Map, timer }
    this.recentStarts = [];
    this.pausedUntil = 0;
    this.trustFile = path.join(dataDir, 'hooks-trust.json');

    if (this.watcher) {
      this.watcher.on('change', (event) => this.handleFileChange(event));
      this.watcher.on('warning', (message) => this.emit('warning', message));
    }
  }

  get dir() {
    return path.join(this.projectDir, '.kiro', 'hooks');
  }

  /* ---------- Carga e persistência ---------- */

  loadTrust() {
    try {
      const value = JSON.parse(fs.readFileSync(this.trustFile, 'utf8'));
      this.trust = value && typeof value === 'object' ? value : {};
    } catch {
      this.trust = {};
    }
  }

  saveTrust() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.trustFile, `${JSON.stringify(this.trust, null, 2)}\n`);
  }

  load() {
    this.loadTrust();
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    this.hooks = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(HOOK_SUFFIX))
      .map((entry) => {
        const file = path.join(this.dir, entry.name);
        const id = entry.name.slice(0, -HOOK_SUFFIX.length);
        try {
          return normalizeHook(JSON.parse(fs.readFileSync(file, 'utf8')), id, file);
        } catch (error) {
          return {
            ...normalizeHook({}, id, file),
            warning: `JSON inválido: ${error.message}`,
            valid: false,
          };
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    this.updateWatcher();
    this.emit('update');
    return this.hooks;
  }

  isTrusted(hook) {
    return this.trust[hook.id] === fingerprint(hook);
  }

  get(id) {
    const hook = this.hooks.find((item) => item.id === id);
    if (!hook) throw new Error('Hook não encontrado.');
    return hook;
  }

  publicHook(hook) {
    const lastRun = this.runs.find((run) => run.hookId === hook.id) || null;
    return {
      ...hook,
      file: path.relative(this.projectDir, hook.file),
      trusted: this.isTrusted(hook),
      running: this.running.has(hook.id),
      lastRun: lastRun
        ? { status: lastRun.status, startedAt: lastRun.startedAt, finishedAt: lastRun.finishedAt }
        : null,
    };
  }

  list() {
    return this.hooks.map((hook) => this.publicHook(hook));
  }

  listRuns() {
    return this.runs.map((run) => ({ ...run }));
  }

  status() {
    return {
      pausedUntil: this.pausedUntil > Date.now() ? this.pausedUntil : null,
      watchedDirs: this.watcher ? this.watcher.watchedDirCount() : 0,
    };
  }

  validateInput(input, knownAgents) {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Dê um nome ao hook.');
    if (name.length > 120) throw new Error('Nome muito longo.');
    const whenType = String(input.when?.type || '');
    if (!TRIGGERS[whenType]) throw new Error('Gatilho inválido.');
    const patterns = toPatternList(input.when?.patterns);
    if (TRIGGERS[whenType].files && patterns.length === 0) {
      throw new Error('Informe ao menos um padrão de arquivo (ex.: APP/lib/**/*.dart).');
    }
    const thenType = String(input.then?.type || '');
    if (!ACTIONS.includes(thenType)) throw new Error('Ação inválida.');
    const prompt = String(input.then?.prompt || '');
    const command = String(input.then?.command || '');
    if (thenType === 'askAgent' && !prompt.trim()) throw new Error('Escreva as instruções para o agente.');
    if (thenType === 'runCommand' && !command.trim()) throw new Error('Informe o comando.');
    if (prompt.length > 20_000 || command.length > 4_000) throw new Error('Texto muito longo.');
    const agent = input.then?.agent ? String(input.then.agent) : null;
    if (agent && knownAgents && !knownAgents.has(agent)) {
      throw new Error(`Agente "${agent}" não encontrado.`);
    }
    const timeoutMs = Number(input.then?.timeoutMs);
    return {
      enabled: input.enabled !== false,
      name,
      description: String(input.description || '').trim().slice(0, 1000),
      version: '1',
      when: { type: whenType, patterns: TRIGGERS[whenType].files ? patterns : [] },
      then: {
        type: thenType,
        prompt: thenType === 'askAgent' ? prompt : '',
        command: thenType === 'runCommand' ? command.trim() : '',
        agent: thenType === 'askAgent' ? agent : null,
        timeoutMs:
          thenType === 'runCommand' && Number.isFinite(timeoutMs) && timeoutMs > 0
            ? Math.min(timeoutMs, 30 * 60 * 1000)
            : null,
      },
    };
  }

  save(input = {}, { previousId = null, knownAgents = null } = {}) {
    const clean = this.validateInput(input, knownAgents);
    let id = previousId || slugify(clean.name) || `hook-${Date.now()}`;
    if (!previousId) {
      let suffix = 2;
      const base = id;
      while (fs.existsSync(path.join(this.dir, `${id}${HOOK_SUFFIX}`))) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
    }
    const file = path.join(this.dir, `${id}${HOOK_SUFFIX}`);
    fs.mkdirSync(this.dir, { recursive: true });
    const hook = normalizeHook(JSON.parse(serializeHook({ ...clean, id })), id, file);
    fs.writeFileSync(file, serializeHook(hook));
    // Quem salva pela interface é o próprio usuário: autoriza na hora.
    this.trust[id] = fingerprint(hook);
    this.saveTrust();
    this.load();
    return this.publicHook(this.get(id));
  }

  setEnabled(id, enabled) {
    const hook = this.get(id);
    const updated = { ...hook, enabled: Boolean(enabled) };
    fs.writeFileSync(hook.file, serializeHook(updated));
    this.load();
    return this.publicHook(this.get(id));
  }

  authorize(id) {
    const hook = this.get(id);
    if (!hook.valid) throw new Error(`Corrija o hook antes de autorizar: ${hook.warning}`);
    this.trust[id] = fingerprint(hook);
    this.saveTrust();
    this.emit('update');
    return this.publicHook(hook);
  }

  remove(id) {
    const hook = this.get(id);
    fs.rmSync(hook.file, { force: true });
    delete this.trust[id];
    this.saveTrust();
    this.load();
    return { ok: true };
  }

  /* ---------- Observação de arquivos ---------- */

  updateWatcher() {
    if (!this.watcher) return;
    const bases = [];
    for (const hook of this.hooks) {
      if (!hook.enabled || !hook.valid || !TRIGGERS[hook.when.type].files) continue;
      for (const pattern of hook.when.patterns) bases.push(staticBase(pattern));
    }
    this.watcher.setBases(bases);
  }

  handleFileChange({ type, file }) {
    const trigger = FILE_EVENT_TO_TRIGGER[type];
    if (!trigger) return;
    const rel = normalizePath(path.relative(this.projectDir, file));
    if (!rel || rel.startsWith('..')) return;
    for (const hook of this.hooks) {
      if (!hook.enabled || !hook.valid || hook.when.type !== trigger) continue;
      if (!matchAny(hook.when.patterns, rel)) continue;
      // Mudanças feitas enquanto o próprio hook roda são dele mesmo: ignora
      // para não entrar em loop (ex.: hook que formata o arquivo salvo).
      if (this.running.has(hook.id)) continue;
      this.queueFile(hook, rel, type);
    }
  }

  queueFile(hook, rel, type) {
    let pending = this.pendingFiles.get(hook.id);
    if (!pending) {
      pending = { files: new Map(), timer: null };
      this.pendingFiles.set(hook.id, pending);
    }
    pending.files.set(rel, type);
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.pendingFiles.delete(hook.id);
      const current = this.hooks.find((item) => item.id === hook.id);
      if (!current || !current.enabled) return;
      const files = Array.from(pending.files.entries()).map(([file, event]) => ({ file, event }));
      this.fire(current, { trigger: current.when.type, files }).catch((error) => {
        this.emit('warning', `Hook "${current.name}": ${error.message}`);
      });
    }, this.settings.debounceMs);
    pending.timer.unref?.();
  }

  /* ---------- Execução ---------- */

  rateLimited() {
    const now = Date.now();
    if (this.pausedUntil > now) return true;
    this.recentStarts = this.recentStarts.filter((at) => now - at < 60_000);
    if (this.recentStarts.length >= this.settings.maxRunsPerMinute) {
      this.pausedUntil = now + 60_000;
      this.emit(
        'warning',
        `Mais de ${this.settings.maxRunsPerMinute} hooks em um minuto: hooks automáticos pausados por 1 minuto (possível loop).`,
      );
      return true;
    }
    return false;
  }

  newRun(hook, context) {
    const run = {
      id: crypto.randomUUID(),
      hookId: hook.id,
      name: hook.name,
      trigger: context.trigger,
      action: hook.then.type,
      files: (context.files || []).map((item) => `${item.file} (${FILE_EVENT_LABEL[item.event] || item.event})`),
      agent: hook.then.type === 'askAgent' ? context.agent || hook.then.agent || '__general__' : null,
      status: 'running',
      message: '',
      output: '',
      executionId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.runs.unshift(run);
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
    return run;
  }

  finishRun(run, status, extra = {}) {
    Object.assign(run, extra, { status, finishedAt: new Date().toISOString() });
    if (this.running.get(run.hookId) === run) this.running.delete(run.hookId);
    this.emit('run', run);
    this.emit('update');
  }

  async fire(hook, context) {
    const manual = context.trigger === 'userTriggered' || context.manual;
    if (this.running.has(hook.id)) {
      if (manual) throw new Error('Este hook já está em execução.');
      return null;
    }
    if (!this.isTrusted(hook)) {
      const last = this.runs.find((item) => item.hookId === hook.id);
      if (!manual && last?.status === 'blocked' && Date.now() - Date.parse(last.startedAt) < 60_000) {
        return null; // não repete o aviso a cada arquivo salvo
      }
      const run = this.newRun(hook, context);
      this.finishRun(run, 'blocked', {
        message: 'Hook não autorizado nesta máquina. Revise e clique em Autorizar.',
      });
      if (manual) throw new Error(run.message);
      return run;
    }
    if (!hook.valid) throw new Error(hook.warning || 'Hook inválido.');
    if (!manual && this.rateLimited()) return null;
    this.recentStarts.push(Date.now());

    const run = this.newRun(hook, context);
    this.running.set(hook.id, run);
    this.emit('update');

    if (hook.then.type === 'runCommand') {
      this.runCommand(hook, run, context).catch(() => {});
      return run;
    }

    await this.dispatchAgent(hook, run, context);
    return run;
  }

  composePrompt(hook, context) {
    const lines = [`[Hook "${hook.name}" · gatilho: ${TRIGGERS[context.trigger]?.label || context.trigger}]`];
    if (context.files && context.files.length > 0) {
      lines.push('Arquivos envolvidos:');
      for (const item of context.files.slice(0, 50)) {
        lines.push(`- ${item.file} (${FILE_EVENT_LABEL[item.event] || item.event})`);
      }
      if (context.files.length > 50) lines.push(`- … e mais ${context.files.length - 50}`);
    }
    if (context.trigger === 'agentStop') {
      lines.push(
        `O agente "${context.stoppedAgent}" terminou uma execução com status "${context.status}".`,
      );
      if (context.summary) {
        lines.push('Final da resposta dele:', truncate(context.summary.slice(-2000), 2000));
      }
    }
    lines.push('', hook.then.prompt.trim());
    return lines.join('\n');
  }

  async dispatchAgent(hook, run, context) {
    const agent = run.agent;
    try {
      const result = await this.startAgentRun({
        agent,
        prompt: this.composePrompt(hook, context),
        files: (context.files || []).map((item) => item.file),
        label: `hook ${hook.name}`,
        origin: { kind: 'hook', hookId: hook.id, runId: run.id },
      });
      run.executionId = result.executionId;
      run.status = 'running';
      run.message = `Executando com o agente ${agent === '__general__' ? 'padrão' : agent}.`;
      this.emit('update');
    } catch (error) {
      if (/já está em execução|reunião ativa/.test(error.message)) {
        run.status = 'waiting';
        run.message = `Aguardando o agente ${agent} ficar livre.`;
        this.waiting.push({ hook, run, context, since: Date.now() });
        this.emit('update');
        return;
      }
      this.finishRun(run, 'failed', { message: error.message });
    }
  }

  retryWaiting() {
    const queue = this.waiting.splice(0);
    for (const item of queue) {
      if (Date.now() - item.since > WAIT_TIMEOUT_MS) {
        this.finishRun(item.run, 'failed', { message: 'Desistiu: o agente ficou ocupado por mais de 10 minutos.' });
        continue;
      }
      const current = this.hooks.find((hook) => hook.id === item.hook.id);
      if (!current || !current.enabled) {
        this.finishRun(item.run, 'cancelled', { message: 'Hook desativado ou removido.' });
        continue;
      }
      this.dispatchAgent(current, item.run, item.context).catch(() => {});
    }
  }

  runShell(command, { timeoutMs, env }) {
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      const child = spawn(command, {
        cwd: this.projectDir,
        shell: true,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const append = (chunk) => {
        if (output.length < MAX_OUTPUT * 2) output += chunk.toString();
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timer = setTimeout(() => {
        output += `\n… tempo limite de ${Math.round(timeoutMs / 1000)}s atingido; processo encerrado.`;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref?.();
      }, timeoutMs);
      const done = (code, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, output: truncate(output), error });
      };
      child.on('error', (error) => done(null, error));
      child.on('close', (code) => done(code, null));
    });
  }

  async runCommand(hook, run, context) {
    const timeoutMs = hook.then.timeoutMs || this.settings.commandTimeoutMs;
    const result = await this.runShell(hook.then.command, {
      timeoutMs,
      env: {
        AGENT_BAR_HOOK: hook.name,
        AGENT_BAR_TRIGGER: context.trigger,
        AGENT_BAR_FILES: (context.files || []).map((item) => item.file).join('\n'),
      },
    });
    const ok = result.code === 0;
    this.finishRun(run, ok ? 'succeeded' : 'failed', {
      output: result.output,
      message: result.error
        ? `Falha ao iniciar: ${result.error.message}`
        : `Saiu com código ${result.code ?? 'desconhecido'}.`,
    });
    return result;
  }

  async runManual(id) {
    const hook = this.get(id);
    return this.fire(hook, { trigger: hook.when.type, manual: true, files: [] });
  }

  /**
   * promptSubmit: roda antes de um prompt do usuário ser enviado.
   * askAgent acrescenta instruções; runCommand acrescenta a saída do comando.
   */
  async applyPromptSubmit({ agent, prompt }) {
    const applied = [];
    if (this.settings.enabled === false) return { prompt, applied };
    const extra = [];
    for (const hook of this.hooks) {
      if (!hook.enabled || !hook.valid || hook.when.type !== 'promptSubmit') continue;
      const run = this.newRun(hook, { trigger: 'promptSubmit', agent });
      if (!this.isTrusted(hook)) {
        this.finishRun(run, 'blocked', { message: 'Hook não autorizado nesta máquina.' });
        continue;
      }
      if (hook.then.type === 'askAgent') {
        extra.push(`[Hook "${hook.name}"]\n${hook.then.prompt.trim()}`);
        this.finishRun(run, 'succeeded', { message: 'Instruções adicionadas ao prompt.' });
      } else {
        const result = await this.runShell(hook.then.command, {
          timeoutMs: Math.min(
            hook.then.timeoutMs || this.settings.promptCommandTimeoutMs,
            this.settings.promptCommandTimeoutMs,
          ),
          env: { AGENT_BAR_HOOK: hook.name, AGENT_BAR_TRIGGER: 'promptSubmit' },
        });
        extra.push(
          `[Hook "${hook.name}" — saída de \`${hook.then.command}\` (código ${result.code ?? '?'})]\n\`\`\`\n${truncate(result.output, 8000).trim()}\n\`\`\``,
        );
        this.finishRun(run, result.code === 0 ? 'succeeded' : 'failed', {
          output: result.output,
          message: `Saída anexada ao prompt (código ${result.code ?? '?'}).`,
        });
      }
      applied.push(hook.name);
    }
    if (extra.length === 0) return { prompt, applied };
    return { prompt: `${prompt}\n\n${extra.join('\n\n')}`, applied };
  }

  /** Chamado quando qualquer execução termina. */
  handleExecutionFinished({ executionId, status, agent, origin, summary }) {
    const run = this.runs.find((item) => item.executionId === executionId && item.status === 'running');
    if (run) {
      this.finishRun(run, status === 'succeeded' ? 'succeeded' : status === 'interrupted' ? 'cancelled' : 'failed', {
        message: `Execução ${status === 'succeeded' ? 'concluída' : status}.`,
        output: truncate(summary || '', 4000),
      });
    }

    if (this.waiting.length > 0) setTimeout(() => this.retryWaiting(), 400);

    if (origin?.kind === 'hook' || status === 'interrupted' || this.settings.enabled === false) return;
    for (const hook of this.hooks) {
      if (!hook.enabled || !hook.valid || hook.when.type !== 'agentStop') continue;
      this.fire(hook, {
        trigger: 'agentStop',
        agent: hook.then.agent || agent,
        stoppedAgent: agent,
        status,
        summary,
      }).catch((error) => this.emit('warning', `Hook "${hook.name}": ${error.message}`));
    }
  }

  stop() {
    for (const pending of this.pendingFiles.values()) clearTimeout(pending.timer);
    this.pendingFiles.clear();
    if (this.watcher) this.watcher.stop();
  }
}

module.exports = {
  HookManager,
  TRIGGERS,
  ACTIONS,
  normalizeHook,
  serializeHook,
  fingerprint,
};
