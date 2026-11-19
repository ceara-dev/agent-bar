'use strict';

const fs = require('node:fs');
const path = require('node:path');

function nowIso() {
  return new Date().toISOString();
}

function safeName(value) {
  return String(value || 'reuniao').replace(/[^A-Za-z0-9_.-]/g, '-');
}

function summarize(text, max = 280) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function toolLabel(input = {}) {
  if (input.command) return 'bash';
  if (input.filePath || input.file_path || input.path) return 'editando';
  if (input.pattern || input.query) return 'buscando';
  return 'ferramenta';
}

function fileName(input = {}) {
  const value = input.filePath || input.file_path || input.path || input.file;
  return value ? path.basename(String(value)) : '';
}

class MeetingManager {
  constructor({ api, history, getAgents, getProjectDir, emit, dataDir, settings }) {
    this.api = api;
    this.history = history;
    this.getAgents = getAgents;
    this.getProjectDir = getProjectDir;
    this.emit = emit;
    this.meetingsDir = path.join(dataDir, 'reunioes');
    this.templatesFile = path.join(this.meetingsDir, 'models.json');
    this.settings = settings;
    this.state = null;
    this.waiters = new Map();
    this.ended = new Map();
    this.streams = new Map();
    this.runPromise = null;
    this.finalizing = false;
    this.pauseResolvers = [];
    this.fileLocks = new Map();
  }

  init() {
    fs.mkdirSync(this.meetingsDir, { recursive: true });
  }

  listTemplates() {
    try {
      const raw = fs.readFileSync(this.templatesFile, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  saveTemplate(payload) {
    const templates = this.listTemplates();
    const template = {
      id: payload.id || `tpl_${Date.now()}`,
      name: String(payload.name || 'Reunião sem nome').trim(),
      host: payload.host,
      participants: Array.isArray(payload.participants) ? payload.participants : [],
      agenda: String(payload.agenda || ''),
      mode: payload.mode === 'delegation' ? 'delegation' : 'roundtable',
      order: payload.order === 'host' ? 'host' : 'fixed',
      maxRounds: Math.max(1, Math.min(20, Number(payload.maxRounds) || 3)),
      stopCriterion: payload.stopCriterion === 'limit' ? 'limit' : 'host',
      projectDir: payload.projectDir || this.getProjectDir(),
      savedAt: nowIso(),
    };

    const index = templates.findIndex((item) => item.id === template.id);
    if (index >= 0) templates[index] = template;
    else templates.unshift(template);

    fs.writeFileSync(this.templatesFile, JSON.stringify(templates.slice(0, 50), null, 2));
    return template;
  }

  deleteTemplate(id) {
    const templates = this.listTemplates().filter((item) => item.id !== id);
    fs.writeFileSync(this.templatesFile, JSON.stringify(templates, null, 2));
    return templates;
  }

  publicState() {
    if (!this.state) return null;
    const {
      waiters,
      ended,
      streams,
      runPromise,
      finalizing,
      pauseResolvers,
      fileLocks,
      ...rest
    } = this.state;
    return { ...rest, settings: { maxAgents: this.settings.maxAgents } };
  }

  emitState() {
    this.emit({ type: 'state', state: this.publicState() });
  }

  async start(payload) {
    if (this.state && ['running', 'paused', 'finalizing'].includes(this.state.status)) {
      throw new Error('Já existe uma reunião em andamento.');
    }

    const agents = this.getAgents().filter((agent) => !agent.hidden);
    const byName = new Map(agents.map((agent) => [agent.name, agent]));
    const host = String(payload.host || '').trim();
    if (!byName.has(host)) throw new Error('Anfitrião não encontrado ou oculto.');

    const participants = [...new Set((payload.participants || []).map((name) => String(name).trim()))]
      .filter((name) => name && name !== host);
    if (participants.some((name) => !byName.has(name))) {
      throw new Error('Um ou mais participantes não existem mais.');
    }

    const maxAgents = this.settings.maxAgents;
    if (participants.length + 1 > maxAgents) {
      throw new Error(`A reunião permite no máximo ${maxAgents} agentes (incluindo o anfitrião).`);
    }

    const mode = payload.mode === 'delegation' ? 'delegation' : 'roundtable';
    if (mode === 'delegation') {
      const primary = participants.filter((name) => byName.get(name).mode === 'primary');
      if (primary.length > 0) {
        const error = new Error(
          `No modo delegação, participantes primary não podem ser chamados como subagentes: ${primary.join(
            ', ',
          )}. Use a mesa-redonda.`,
        );
        error.suggestRoundtable = true;
        throw error;
      }
    }

    const projectDir = payload.projectDir || this.getProjectDir();
    const meetingId = `mtg_${Date.now().toString(36)}`;
    const maxRounds = Math.max(
      1,
      Math.min(20, Number(payload.maxRounds) || this.settings.maxRounds),
    );

    this.state = {
      id: meetingId,
      host,
      participants: [...participants],
      projectDir,
      agenda: String(payload.agenda || '').trim(),
      mode,
      order: payload.order === 'host' ? 'host' : 'fixed',
      maxRounds,
      stopCriterion: payload.stopCriterion === 'limit' ? 'limit' : 'host',
      status: 'running',
      paused: false,
      stopped: false,
      userStopped: false,
      hostConcluded: false,
      round: 0,
      turnCount: 0,
      currentAgent: null,
      sessions: {},
      dynamicSessions: {},
      chat: [],
      files: [],
      warnings: [],
      moderatorMessages: [],
      ataPath: null,
      createdAt: nowIso(),
      endedAt: null,
      lastTextBySession: {},
    };

    try {
      if (mode === 'roundtable') {
        for (const name of [host, ...participants]) {
          await this.#ensureSession(name, 'participant');
        }
      } else {
        await this.#ensureSession(host, 'host');
      }
    } catch (error) {
      this.state.status = 'error';
      this.state.warnings.push(error.message);
      this.emitState();
      this.state = null;
      throw error;
    }

    this.emitState();
    this.runPromise = (mode === 'delegation' ? this.#runDelegation() : this.#runRoundtable())
      .catch((error) => this.#fail(error))
      .finally(() => {
        this.runPromise = null;
      });

    return this.publicState();
  }

  async #ensureSession(agent, role) {
    if (this.state.sessions[agent]) return this.state.sessions[agent];

    const created = await this.api.createSession({
      directory: this.state.projectDir,
      agent,
      title: `Reunião ${this.state.id} · ${agent}`,
    });
    const sessionID = created?.data?.id;
    if (!sessionID) throw new Error(`Não foi possível criar sessão para ${agent}.`);

    this.state.sessions[agent] = sessionID;
    this.state.dynamicSessions[sessionID] = { agent, role };
    this.history.ensureSession({
      id: sessionID,
      agent,
      projectDir: this.state.projectDir,
      title: `Reunião ${this.state.id} · ${agent}`,
      meetingId: this.state.id,
      prompt: this.state.agenda,
    });
    return sessionID;
  }

  #chatEntry(partial) {
    const entry = {
      id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      ts: nowIso(),
      ...partial,
    };
    this.state.chat.push(entry);
    this.emit({ type: 'chat', message: entry });
    return entry;
  }

  #waitForSession(sessionID) {
    const ended = this.ended.get(sessionID);
    if (ended) {
      this.ended.delete(sessionID);
      return Promise.resolve(ended);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(sessionID);
        reject(new Error('Tempo limite do turno da reunião excedido.'));
      }, this.settings.turnTimeoutMs);

      this.waiters.set(sessionID, { resolve, reject, timer });
    });
  }

  #resolveWaiter(sessionID, payload) {
    const waiter = this.waiters.get(sessionID);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(sessionID);
      waiter.resolve(payload);
    } else {
      this.ended.set(sessionID, payload);
    }
  }

  async #sendTurn(agent, text) {
    const sessionID = await this.#ensureSession(agent, 'participant');
    this.history.recordPrompt(sessionID, text);
    const waiter = this.#waitForSession(sessionID);

    try {
      await this.api.sendPrompt(sessionID, text);
    } catch (error) {
      const active = this.waiters.get(sessionID);
      if (active) {
        clearTimeout(active.timer);
        this.waiters.delete(sessionID);
        active.reject(error);
      }
      throw error;
    }

    return waiter;
  }

  #buildTranscript(limit = 12_000) {
    const parts = [];
    for (const item of this.state.chat) {
      if (item.role === 'tool') {
        parts.push(`[${item.agent} · ferramenta ${item.name}]: ${item.status || ''} ${item.detail || ''}`);
      } else {
        parts.push(`[${item.agent}${item.role === 'host' ? ' (anfitrião)' : ''}]: ${item.text}`);
      }
    }
    const text = parts.join('\n\n');
    return text.length > limit ? `…${text.slice(-limit)}` : text;
  }

  #buildTurnPrompt(agent, round, order) {
    const role = agent === this.state.host ? 'anfitrião' : 'participante';
    const moderator = this.state.moderatorMessages.length
      ? `Mensagens do moderador:\n${this.state.moderatorMessages.map((m) => `- ${m}`).join('\n')}\n`
      : '';

    return [
      `Você é ${agent}, ${role} da reunião ${this.state.id}.`,
      `Pauta: ${this.state.agenda || '(não informada)'}`,
      `Participantes: ${[this.state.host, ...this.state.participants].join(', ')}.`,
      `Rodada ${round} de ${this.state.maxRounds}. Ordem desta rodada: ${order.join(' → ')}.`,
      moderator,
      'Transcrição até aqui:',
      this.#buildTranscript(),
      '',
      `Sua vez, ${agent}.`,
      'Responda apenas a sua parte, de forma objetiva. Se o grupo já concluiu, comece a resposta com "CONCLUÍDO".',
      'Não altere arquivos que outro participante esteja editando sem avisar.',
    ].join('\n');
  }

  async #orderForRound(round) {
    const base = [this.state.host, ...this.state.participants];
    if (this.state.order !== 'host' || round === 1) return base;

    const prompt = [
      `Como anfitrião da reunião ${this.state.id}, defina a ordem dos participantes para a rodada ${round}.`,
      `Participantes disponíveis: ${[this.state.host, ...this.state.participants].join(', ')}.`,
      'Responda somente os nomes separados por vírgula, sem explicações.',
    ].join('\n');

    try {
      const result = await this.#sendTurn(this.state.host, prompt);
      const text = result.text || '';
      const names = text
        .split(/[,\n]/)
        .map((name) => name.trim())
        .filter((name) => base.includes(name));
      return names.length > 0 ? [...new Set(names)] : base;
    } catch {
      return base;
    }
  }

  async #waitIfPaused() {
    while (this.state.paused && !this.state.stopped) {
      await new Promise((resolve) => this.pauseResolvers.push(resolve));
    }
  }

  async #runRoundtable() {
    const base = [this.state.host, ...this.state.participants];
    const maxTurns = this.state.maxRounds * Math.max(1, base.length) + 2;

    for (let round = 1; round <= this.state.maxRounds; round += 1) {
      if (this.state.stopped) break;
      this.state.round = round;
      this.emitState();

      const order = await this.#orderForRound(round);
      for (const agent of order) {
        if (this.state.stopped) break;
        await this.#waitIfPaused();
        if (this.state.stopped) break;
        if (agent !== this.state.host && !this.state.participants.includes(agent)) continue;
        if (!this.getAgents().some((item) => item.name === agent && !item.hidden)) {
          this.state.warnings.push(`Agente ${agent} removido durante a reunião.`);
          this.emitState();
          continue;
        }
        if (this.state.turnCount >= maxTurns) {
          this.state.stopped = true;
          break;
        }

        this.state.currentAgent = agent;
        this.emitState();

        try {
          const result = await this.#sendTurn(
            agent,
            this.#buildTurnPrompt(agent, round, order),
          );
          this.state.turnCount += 1;
          const text = result.text || this.state.lastTextBySession[this.state.sessions[agent]] || '';
          if (
            agent === this.state.host &&
            this.state.stopCriterion === 'host' &&
            /conclu[ií]do/i.test(text)
          ) {
            this.state.stopped = true;
            this.state.hostConcluded = true;
            break;
          }
        } catch (error) {
          this.state.warnings.push(`Turno de ${agent} falhou: ${error.message}`);
          this.emitState();
        } finally {
          this.state.currentAgent = null;
        }
      }
    }

    await this.#finalize();
  }

  async #runDelegation() {
    const participants = this.state.participants
      .map((name) => {
        const agent = this.getAgents().find((item) => item.name === name);
        return `- ${name} (mode: ${agent?.mode || 'desconhecido'})`;
      })
      .join('\n');

    const prompt = [
      `Você é ${this.state.host}, anfitrião da reunião ${this.state.id}.`,
      `Pauta: ${this.state.agenda || '(não informada)'}`,
      'Participantes que você pode delegar:',
      participants,
      '',
      'Use o mecanismo nativo de subagente do OpenCode (ferramenta de subagente ou menção @agente) para dividir o trabalho.',
      'Ao final, responda começando por "CONCLUÍDO" e gere a ata com decisões, pendências, responsáveis e arquivos alterados.',
      'Não eleve permissões de nenhum participante.',
    ].join('\n');

    try {
      const result = await this.#sendTurn(this.state.host, prompt);
      this.state.lastTextBySession[this.state.sessions[this.state.host]] = result.text || '';
    } catch (error) {
      this.state.warnings.push(`Delegação falhou: ${error.message}`);
    }

    await this.#finalize();
  }

  onServerEvent(event) {
    if (!this.state || !['running', 'paused', 'finalizing'].includes(this.state.status)) return;
    const data = event.data || {};
    const sessionID = data.sessionID || event.durable?.aggregateID;
    if (!sessionID) return;

    if (event.type === 'session.created') {
      const parentID = data.parentID;
      if (parentID && this.state.sessions[this.state.host] === parentID) {
        const agent = data.agent || 'subagente';
        this.state.dynamicSessions[sessionID] = { agent, role: 'subagent' };
        this.history.ensureSession({
          id: sessionID,
          agent,
          projectDir: this.state.projectDir,
          title: data.title || `Subagente de ${this.state.id}`,
          meetingId: this.state.id,
          parentId: parentID,
        });
        if (Object.keys(this.state.dynamicSessions).length > this.settings.maxAgents) {
          this.state.warnings.push('Limite de agentes simultâneos ultrapassado na delegação.');
        }
        this.emitState();
      }
      return;
    }

    const sessionInfo = this.state.dynamicSessions[sessionID];
    if (!sessionInfo) return;
    const agent = sessionInfo.agent;
    this.history.ensureSession({
      id: sessionID,
      agent,
      projectDir: this.state.projectDir,
      meetingId: this.state.id,
    });

    if (event.type === 'session.text.delta') {
      const delta = data.delta || '';
      this.streams.set(sessionID, `${this.streams.get(sessionID) || ''}${delta}`);
      this.emit({ type: 'text-delta', sessionID, agent, delta });
      return;
    }

    if (event.type === 'session.text.ended') {
      const text = data.text || this.streams.get(sessionID) || '';
      this.streams.delete(sessionID);
      this.state.lastTextBySession[sessionID] = text;
      this.history.recordText(sessionID, text, { messageId: data.assistantMessageID });
      this.#chatEntry({
        role: agent === this.state.host ? 'host' : 'agent',
        agent,
        text,
      });
      this.emitState();
      return;
    }

    if (event.type === 'session.tool.called') {
      const label = toolLabel(data.input || {});
      const name = fileName(data.input || {}) || label;
      if (['editando', 'bash'].includes(label)) {
        const lockKey = fileName(data.input || {}) || label;
        const holder = this.fileLocks.get(lockKey);
        if (holder && holder !== agent) {
          this.state.warnings.push(
            `Possível conflito: ${agent} e ${holder} estão usando ${lockKey}.`,
          );
          this.emitState();
        } else {
          this.fileLocks.set(lockKey, agent);
        }
      }
      this.history.recordTool(sessionID, {
        phase: 'called',
        toolId: data.id,
        name,
        input: data.input,
      });
      this.#chatEntry({
        role: 'tool',
        agent,
        name,
        status: 'chamada',
        detail: label,
      });
      this.emitState();
      return;
    }

    if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
      const failed = event.type === 'session.tool.failed';
      this.history.recordTool(sessionID, {
        phase: failed ? 'failed' : 'success',
        toolId: data.id,
        name: 'ferramenta',
        input: data.input,
        content: data.content,
        status: failed ? 'erro' : 'ok',
        error: data.error?.message,
      });
      if (failed) {
        this.state.warnings.push(`Ferramenta falhou para ${agent}: ${data.error?.message || ''}`);
      }
      this.#chatEntry({
        role: 'tool',
        agent,
        name: 'ferramenta',
        status: failed ? 'erro' : 'ok',
        detail: failed ? data.error?.message || '' : '',
      });
      this.emitState();
      return;
    }

    if (event.type === 'filesystem.changed') {
      const file = data.file;
      if (file && !this.state.files.includes(file)) this.state.files.push(file);
      this.history.recordFile(sessionID, file, data.event);
      this.emit({ type: 'file', sessionID, agent, file, event: data.event });
      return;
    }

    if (
      ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(
        event.type,
      )
    ) {
      const status =
        event.type === 'session.execution.succeeded'
          ? 'succeeded'
          : event.type === 'session.execution.interrupted'
            ? 'interrupted'
            : 'failed';
      const text = this.state.lastTextBySession[sessionID] || '';
      this.history.recordStatus(sessionID, status, event.type);
      this.#resolveWaiter(sessionID, {
        status,
        text,
        error: data.error?.message || null,
      });
      return;
    }

    if (event.type === 'session.idle') {
      // Alguns fluxos encerram sem execution.succeeded; garante liberação.
      if (this.waiters.has(sessionID)) {
        this.#resolveWaiter(sessionID, {
          status: 'succeeded',
          text: this.state.lastTextBySession[sessionID] || '',
        });
      }
    }
  }

  isManagedSession(sessionID) {
    return Boolean(this.state?.dynamicSessions?.[sessionID]);
  }

  pause() {
    if (!this.state || this.state.status !== 'running') return;
    this.state.paused = true;
    this.emitState();
  }

  resume() {
    if (!this.state) return;
    this.state.paused = false;
    const resolvers = this.pauseResolvers.splice(0);
    for (const resolve of resolvers) resolve();
    this.emitState();
  }

  async skip() {
    if (!this.state || !this.state.currentAgent) return;
    const sessionID = this.state.sessions[this.state.currentAgent];
    if (sessionID) {
      try {
        await this.api.interrupt(sessionID);
      } catch {
        // ignore
      }
      this.#resolveWaiter(sessionID, { status: 'interrupted', text: '' });
    }
  }

  async moderator(text) {
    if (!this.state || !text.trim()) return;
    const message = text.trim();
    this.state.moderatorMessages.push(message);
    this.#chatEntry({ role: 'moderator', agent: 'Moderador', text: message });

    if (this.state.mode === 'delegation') {
      const sessionID = this.state.sessions[this.state.host];
      if (sessionID) {
        try {
          await this.api.sendPrompt(sessionID, `Moderador: ${message}`);
        } catch {
          // ignore
        }
      }
    }
    this.emitState();
  }

  async addParticipant(name) {
    if (!this.state) throw new Error('Nenhuma reunião ativa.');
    if (this.state.participants.includes(name) || name === this.state.host) {
      throw new Error('Agente já participa da reunião.');
    }
    if (this.state.participants.length + 2 > this.settings.maxAgents) {
      throw new Error(`Limite de ${this.settings.maxAgents} agentes atingido.`);
    }
    const agent = this.getAgents().find((item) => item.name === name && !item.hidden);
    if (!agent) throw new Error('Agente não encontrado.');
    if (this.state.mode === 'delegation' && agent.mode === 'primary') {
      throw new Error(
        `${name} é primary e não pode ser delegado. Use a mesa-redonda ou escolha outro agente.`,
      );
    }

    this.state.participants.push(name);
    if (this.state.mode === 'roundtable') {
      await this.#ensureSession(name, 'participant');
    } else {
      const sessionID = this.state.sessions[this.state.host];
      if (sessionID) {
        await this.api
          .sendPrompt(sessionID, `Novo participante adicionado à reunião: ${name}.`)
          .catch(() => {});
      }
    }
    this.#chatEntry({ role: 'system', agent: 'Sistema', text: `${name} entrou na reunião.` });
    this.emitState();
  }

  async removeParticipant(name) {
    if (!this.state) return;
    if (name === this.state.host) {
      throw new Error('O anfitrião não pode ser removido da reunião.');
    }
    this.state.participants = this.state.participants.filter((item) => item !== name);
    if (this.state.currentAgent === name) {
      const sessionID = this.state.sessions[name];
      if (sessionID) {
        await this.api.interrupt(sessionID).catch(() => {});
        this.#resolveWaiter(sessionID, { status: 'interrupted', text: '' });
      }
    }
    this.#chatEntry({ role: 'system', agent: 'Sistema', text: `${name} saiu da reunião.` });
    this.emitState();
  }

  async stop() {
    if (!this.state) return;
    this.state.stopped = true;
    this.state.userStopped = true;
    this.state.paused = false;
    const resolvers = this.pauseResolvers.splice(0);
    for (const resolve of resolvers) resolve();

    for (const sessionID of Object.values(this.state.sessions)) {
      await this.api.interrupt(sessionID).catch(() => {});
      this.#resolveWaiter(sessionID, { status: 'interrupted', text: '' });
    }
    for (const sessionID of Object.keys(this.state.dynamicSessions)) {
      await this.api.interrupt(sessionID).catch(() => {});
    }

    await this.#finalize();
  }

  async #finalize() {
    if (!this.state || this.finalizing || this.state.status === 'done') return;
    this.finalizing = true;
    this.state.status = 'finalizing';
    this.emitState();

    const hostSession = this.state.sessions[this.state.host];
    let ata = '';

    if (hostSession && !this.state.userStopped) {
      try {
        const prompt = [
          'Gere a ata final da reunião em Markdown.',
          `Pauta: ${this.state.agenda || '(não informada)'}`,
          'Inclua as seções: Decisões, Pendências, Responsáveis e Arquivos alterados.',
          'Transcrição:',
          this.#buildTranscript(),
        ].join('\n');
        const result = await this.#sendTurn(this.state.host, prompt);
        ata = result.text || '';
      } catch (error) {
        this.state.warnings.push(`Falha ao gerar ata pelo anfitrião: ${error.message}`);
      }
    }

    if (!ata.trim()) ata = this.#synthesizeAta();

    const date = new Date().toISOString().slice(0, 10);
    let file = path.join(
      this.meetingsDir,
      `${date}-${safeName(this.state.host)}.md`,
    );
    if (fs.existsSync(file)) {
      file = path.join(
        this.meetingsDir,
        `${date}-${safeName(this.state.host)}-${this.state.id}.md`,
      );
    }
    const body = [
      `# Reunião — ${this.state.host}`,
      '',
      `- **ID:** ${this.state.id}`,
      `- **Projeto:** ${this.state.projectDir}`,
      `- **Modo:** ${this.state.mode}`,
      `- **Participantes:** ${[this.state.host, ...this.state.participants].join(', ')}`,
      `- **Início:** ${this.state.createdAt}`,
      `- **Fim:** ${nowIso()}`,
      `- **Pauta:** ${this.state.agenda || '(não informada)'}`,
      '',
      '## Ata',
      '',
      ata.trim(),
      '',
      '## Arquivos alterados',
      '',
      ...(this.state.files.length
        ? this.state.files.map((item) => `- \`${item}\``)
        : ['- Nenhum arquivo registrado.']),
      '',
      '## Transcrição',
      '',
      ...this.state.chat.map((item) => {
        if (item.role === 'tool') {
          return `- **${item.agent} · ${item.name}**: ${item.status || ''} ${item.detail || ''}`;
        }
        return `### ${item.agent} (${item.role})\n\n${item.text}\n`;
      }),
    ].join('\n');

    fs.writeFileSync(file, body);
    this.state.ataPath = file;
    this.state.endedAt = nowIso();
    this.state.status = 'done';
    this.state.currentAgent = null;

    for (const sessionID of Object.keys(this.state.dynamicSessions)) {
      this.history.updateSession(sessionID, {
        meetingId: this.state.id,
        ataPath: file,
        status: 'succeeded',
      });
      this.history.endSession(sessionID, { status: 'succeeded' });
    }

    this.finalizing = false;
    this.emitState();
    this.emit({ type: 'finished', state: this.publicState() });
  }

  #synthesizeAta() {
    const transcript = this.state.chat
      .filter((item) => item.role !== 'tool')
      .map((item) => ({ agent: item.agent, text: item.text || '' }));
    const decisions = transcript
      .filter((item) => /decid|definido|vamos|conclu/i.test(item.text))
      .slice(-6)
      .map((item) => `- ${item.agent}: ${summarize(item.text, 180)}`);
    const pending = transcript
      .filter((item) => /pendente|falta|próximo|proximo|todo/i.test(item.text))
      .slice(-6)
      .map((item) => `- ${item.agent}: ${summarize(item.text, 180)}`);
    const owners = [...new Set(transcript.map((item) => item.agent))];

    return [
      '### Decisões',
      ...(decisions.length ? decisions : ['- Não identificadas automaticamente.']),
      '',
      '### Pendências',
      ...(pending.length ? pending : ['- Não identificadas automaticamente.']),
      '',
      '### Responsáveis',
      ...owners.map((name) => `- ${name}`),
      '',
      '### Arquivos alterados',
      ...(this.state.files.length
        ? this.state.files.map((file) => `- \`${file}\``)
        : ['- Nenhum arquivo registrado.']),
    ].join('\n');
  }

  async #fail(error) {
    if (!this.state || ['done', 'error'].includes(this.state.status)) return;
    this.state.warnings.push(error.message);
    this.state.status = 'error';
    this.state.endedAt = nowIso();
    this.emitState();
  }
}

module.exports = { MeetingManager };
