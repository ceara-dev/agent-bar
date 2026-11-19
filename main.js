'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { discoverAll, getWatchTargets } = require('./lib/discovery');
const { Runner } = require('./lib/runner');
const { readSettings } = require('./lib/settings');
const { HistoryStore } = require('./lib/history');
const { ServerManager, EventStream } = require('./lib/server');
const { OpenCodeApi } = require('./lib/api');
const { MeetingManager } = require('./lib/meeting');
const { SteeringStore, steeringGeneratePrompt } = require('./lib/steering');
const { SpecStore, SpecRunner, slugify } = require('./lib/specs');
const { HookManager } = require('./lib/hooks');
const { ProjectWatcher } = require('./lib/watcher');
const { EventEmitter } = require('node:events');

const atlasDir = __dirname;
const projectArgIndex = process.argv.indexOf('--project');
const projectDir = path.resolve(
  process.env.OPENCODE_PROJECT_DIR ||
    (projectArgIndex !== -1 ? process.argv[projectArgIndex + 1] : '') ||
    path.resolve(__dirname, '..'),
);

app.setName('Agent Bar');

let mainWindow = null;
let snapshot = null;
let refreshing = null;
let refreshQueued = false;
let refreshTimer = null;
let quitting = false;

let settingsInfo = null;
let history = null;
let server = null;
let api = null;
let stream = null;
let meeting = null;

const runner = new Runner({ cwd: projectDir });
const watchers = new Map();
const executions = new Map();
const activeByAgent = new Map();
const pendingAgents = new Set();
const activeBySession = new Map();
const sessionInfo = new Map();
const trackedSessions = new Set();
const liveByAgent = new Map();
const permissions = new Map();
let restartAttempts = 0;
let serverRestartTimer = null;

// Specs, hooks e steering (formato .kiro/)
const runBus = new EventEmitter();
let steering = null;
let specs = null;
let specRunner = null;
let hooks = null;
let kiroWatcher = null;
let kiroTimer = null;
const kiroWarnings = [];

const serverStatus = {
  available: false,
  starting: false,
  stream: 'offline',
  baseUrl: null,
  version: null,
  reason: null,
};

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function broadcastServerStatus() {
  send('server:status', { ...serverStatus });
}

function emptySnapshot(warning) {
  return {
    projectDir,
    atlasDir,
    globalConfigDir: null,
    legacyGlobalDir: null,
    generatedAt: new Date().toISOString(),
    agents: [],
    commands: [],
    warnings: [warning].filter(Boolean),
    overrides: { file: path.join(atlasDir, 'agents.json'), values: {}, warning: null },
    opencode: {
      bin: process.env.OPENCODE_BIN || 'opencode',
      available: false,
      version: null,
      supportsCommandFlag: false,
      agentListSource: null,
      agentListAvailable: false,
    },
    server: { ...serverStatus },
  };
}

async function refresh(reason = 'auto') {
  if (refreshing) {
    refreshQueued = true;
    return refreshing;
  }

  refreshing = (async () => {
    try {
      snapshot = await discoverAll({ projectDir, atlasDir });
      snapshot.server = { ...serverStatus };
      snapshot.historyCount = history ? history.entries.length : 0;
      runner.setCapabilities({
        supportsCommandFlag: snapshot.opencode.supportsCommandFlag,
      });
      send('agents:updated', snapshot);
      ensureWatchers();
      return snapshot;
    } catch (error) {
      snapshot = emptySnapshot(`Falha na descoberta de agentes: ${error.message}`);
      send('agents:updated', snapshot);
      return snapshot;
    } finally {
      refreshing = null;
      if (refreshQueued) {
        refreshQueued = false;
        setTimeout(() => refresh('queued').catch(() => {}), 0);
      }
      void reason;
    }
  })();

  return refreshing;
}

function shouldReact(target, filename, projectDirValue, globalParent) {
  if (!filename) return true;
  if (target === projectDirValue) {
    return ['opencode.json', 'opencode.jsonc', '.opencode'].includes(filename);
  }
  if (target === globalParent) {
    return filename === 'opencode';
  }
  if (target === atlasDir) {
    return filename === 'agents.json' || filename === 'settings.json';
  }
  return true;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refresh('watch').catch(() => {});
  }, 400);
}

function ensureWatchers() {
  const targets = getWatchTargets(projectDir, atlasDir);
  const globalParent = snapshot?.globalConfigDir
    ? path.dirname(snapshot.globalConfigDir)
    : path.join(os.homedir(), '.config');

  for (const target of targets) {
    if (watchers.has(target)) continue;

    let stat = null;
    try {
      stat = fs.statSync(target);
    } catch {
      continue;
    }

    try {
      const watcher = fs.watch(target, { persistent: true }, (eventType, filename) => {
        if (target === projectDir && filename === '.kiro') {
          scheduleKiroRefresh();
          return;
        }
        if (shouldReact(target, filename, projectDir, globalParent)) {
          scheduleRefresh();
        }
      });
      watcher.on('error', () => {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        watchers.delete(target);
      });
      watchers.set(target, watcher);
    } catch {
      // Diretório pode desaparecer entre stat e watch.
    }
  }

  for (const [target, watcher] of watchers.entries()) {
    if (!fs.existsSync(target)) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
      watchers.delete(target);
    }
  }
}

function publicExecution(execution) {
  if (!execution) return null;
  return {
    executionId: execution.executionId,
    sessionId: execution.sessionId,
    agent: execution.agent,
    command: execution.command,
    prompt: execution.prompt,
    args: execution.args,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt || null,
    status: execution.status,
    server: execution.server,
  };
}

function updateLive(agent, state, detail = '', sessionID = null) {
  const value = { agent, state, detail, sessionId: sessionID, updatedAt: Date.now() };
  liveByAgent.set(agent, value);
  send('live:update', value);
}

function inferToolDetail(input = {}) {
  if (input.command) return 'rodando bash';
  const file = input.filePath || input.file_path || input.path || input.file;
  if (file) return `editando ${path.basename(String(file))}`;
  if (input.pattern || input.query) return 'buscando';
  return 'usando ferramenta';
}

function normalizeFilePath(value) {
  if (!value) return null;
  const raw = String(value);
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectDir, raw);
}

function collectFileFromTool(input = {}) {
  const value = input.filePath || input.file_path || input.path || input.file;
  return normalizeFilePath(value);
}

function isTrackedSession(sessionID) {
  return trackedSessions.has(sessionID) || history?.byId?.has(sessionID);
}

function ensureTrackedSession(sessionID, { agent, parentID = null, title = null } = {}) {
  if (!sessionID || !history) return null;
  trackedSessions.add(sessionID);
  const existing = history.byId.get(sessionID);
  if (existing) return existing;
  return history.ensureSession({
    id: sessionID,
    agent: agent || sessionInfo.get(sessionID)?.agent || 'subagente',
    projectDir,
    title: title || `Sessão ${sessionID}`,
    parentId: parentID,
  });
}

function finalizeExecution(sessionID, status) {
  const executionId = activeBySession.get(sessionID);
  if (!executionId) return;
  const execution = executions.get(executionId);
  if (!execution) return;

  execution.status = status;
  execution.finishedAt = new Date().toISOString();
  activeBySession.delete(sessionID);
  activeByAgent.delete(execution.agent);

  history.endSession(sessionID, {
    status,
    summary: execution.lastText || '',
  });
  emitRunFinished(execution, status);

  const uiStatus = status === 'succeeded' ? 'done' : 'error';
  send('run:event', {
    type: 'exit',
    executionId,
    sessionId: sessionID,
    agent: execution.agent,
    code: status === 'succeeded' ? 0 : null,
    signal: null,
    status: uiStatus,
    server: true,
    finishedAt: execution.finishedAt,
  });
  send('activity:event', {
    type: 'status',
    sessionID,
    agent: execution.agent,
    status,
    at: execution.finishedAt,
  });
  updateLive(execution.agent, uiStatus, uiStatus === 'done' ? 'concluído' : 'erro', sessionID);
}

function handleServerEvent(event) {
  if (!event || !event.type) return;
  const data = event.data || {};
  const sessionID = data.sessionID || event.durable?.aggregateID || null;

  if (event.type === 'session.created') {
    const info = {
      sessionID: data.sessionID,
      parentID: data.parentID || null,
      agent: data.agent || null,
      title: data.title || null,
      directory: data.location?.directory || null,
    };
    sessionInfo.set(info.sessionID, info);
    const parentTracked = info.parentID && isTrackedSession(info.parentID);
    if (parentTracked || isTrackedSession(info.sessionID)) {
      ensureTrackedSession(info.sessionID, {
        agent: info.agent || 'subagente',
        parentID: info.parentID,
        title: info.title,
      });
    }
    send('activity:event', {
      type: event.type,
      sessionID: info.sessionID,
      agent: info.agent,
      data,
      created: event.created,
    });
  }

  // A reunião observa os eventos antes do filtro de histórico.
  meeting?.onServerEvent(event);

  if (!sessionID) return;

  if (!isTrackedSession(sessionID)) {
    return;
  }

  const execution = activeBySession.get(sessionID)
    ? executions.get(activeBySession.get(sessionID))
    : null;
  const agent =
    execution?.agent ||
    sessionInfo.get(sessionID)?.agent ||
    history.byId.get(sessionID)?.agent ||
    'subagente';
  const managedByMeeting = Boolean(meeting?.state?.dynamicSessions?.[sessionID]);

  ensureTrackedSession(sessionID, { agent });

  if (event.type === 'session.text.delta') {
    const chunk = data.delta || '';
    if (execution) {
      execution.lastText = `${execution.lastText || ''}${chunk}`;
      send('run:event', {
        type: 'log',
        executionId: execution.executionId,
        sessionId: sessionID,
        agent,
        stream: 'stdout',
        chunk,
        server: true,
      });
    }
    send('activity:event', {
      type: 'text.delta',
      sessionID,
      agent,
      delta: chunk,
      messageId: data.assistantMessageID,
      created: event.created,
    });
    updateLive(agent, 'running', 'respondendo', sessionID);
    return;
  }

  if (event.type === 'session.text.ended') {
    const text = data.text || '';
    if (execution) execution.lastText = text;
    if (!managedByMeeting) {
      history.recordText(sessionID, text, { messageId: data.assistantMessageID });
    }
    send('activity:event', {
      type: 'text.ended',
      sessionID,
      agent,
      text,
      messageId: data.assistantMessageID,
      created: event.created,
    });
    return;
  }

  if (event.type === 'session.tool.called') {
    const detail = inferToolDetail(data.input || {});
    if (!managedByMeeting) {
      history.recordTool(sessionID, {
        phase: 'called',
        toolId: data.id,
        name: detail,
        input: data.input,
        status: 'running',
      });
      const file = collectFileFromTool(data.input || {});
      if (file) history.recordFile(sessionID, file);
    }
    send('activity:event', {
      type: 'tool.called',
      sessionID,
      agent,
      toolId: data.id,
      detail,
      input: data.input,
      created: event.created,
    });
    updateLive(agent, 'running', detail, sessionID);
    return;
  }

  if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
    const failed = event.type === 'session.tool.failed';
    if (!managedByMeeting) {
      history.recordTool(sessionID, {
        phase: failed ? 'failed' : 'success',
        toolId: data.id,
        name: 'ferramenta',
        input: data.input,
        content: data.content,
        status: failed ? 'error' : 'ok',
        error: data.error?.message,
      });
    }
    send('activity:event', {
      type: event.type,
      sessionID,
      agent,
      toolId: data.id,
      content: data.content,
      error: data.error?.message || null,
      created: event.created,
    });
    return;
  }

  if (event.type === 'filesystem.changed') {
    const file = normalizeFilePath(data.file);
    if (!managedByMeeting) history.recordFile(sessionID, file, data.event);
    send('activity:event', {
      type: 'file',
      sessionID,
      agent,
      file,
      event: data.event,
      created: event.created,
    });
    updateLive(agent, 'running', `editando ${path.basename(file || '')}`, sessionID);
    return;
  }

  if (event.type === 'session.step.ended') {
    for (const file of data.files || []) history.recordFile(sessionID, normalizeFilePath(file));
    send('activity:event', {
      type: 'step.ended',
      sessionID,
      agent,
      files: data.files || [],
      finish: data.finish,
      tokens: data.tokens,
      cost: data.cost,
      created: event.created,
    });
    return;
  }

  if (event.type === 'permission.asked') {
    permissions.set(data.id, { ...data, agent });
    history.recordPermission(sessionID, data);
    send('permission:asked', { ...data, agent });
    send('activity:event', {
      type: 'permission',
      sessionID,
      agent,
      request: data,
      created: event.created,
    });
    updateLive(agent, 'running', 'aguardando permissão', sessionID);
    return;
  }

  if (event.type === 'permission.replied') {
    permissions.delete(data.requestID);
    send('permission:replied', { ...data, agent });
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
    if (event.type === 'session.execution.failed') {
      history.recordError(sessionID, data.error?.message || 'execução falhou');
    }
    history.recordStatus(sessionID, status);
    finalizeExecution(sessionID, status);
    return;
  }

  if (event.type === 'session.idle') {
    if (activeBySession.has(sessionID)) {
      finalizeExecution(sessionID, 'succeeded');
    }
    updateLive(agent, 'done', 'ocioso', sessionID);
  }
}

function wireStream() {
  if (stream) stream.stop();
  if (!server?.available) return;

  stream = new EventStream({
    baseUrl: server.baseUrl,
    authorization: server.authorization,
  });
  stream.on('connected', () => {
    serverStatus.stream = 'connected';
    broadcastServerStatus();
    send('activity:event', { type: 'server.connected', at: new Date().toISOString() });
  });
  stream.on('disconnected', ({ reason }) => {
    serverStatus.stream = 'reconnecting';
    serverStatus.reason = reason;
    broadcastServerStatus();
  });
  stream.on('parse-error', (error) => {
    console.error('[agent-bar] SSE parse error:', error.error);
  });
  stream.on('event', handleServerEvent);
  stream.start();
}

async function startServer() {
  if (!server || serverStatus.starting) return;
  if (server.available) {
    api.configure({ baseUrl: server.baseUrl, authorization: server.authorization });
    serverStatus.available = true;
    serverStatus.starting = false;
    serverStatus.baseUrl = server.baseUrl;
    wireStream();
    broadcastServerStatus();
    return;
  }

  serverStatus.starting = true;
  serverStatus.reason = null;
  broadcastServerStatus();

  try {
    const info = await server.start();
    api.configure({ baseUrl: info.baseUrl, authorization: info.authorization });
    serverStatus.available = true;
    serverStatus.starting = false;
    serverStatus.baseUrl = info.baseUrl;
    serverStatus.reason = null;
    restartAttempts = 0;
    wireStream();
    broadcastServerStatus();
    refresh('server').catch(() => {});
  } catch (error) {
    serverStatus.available = false;
    serverStatus.starting = false;
    serverStatus.reason = error.message;
    broadcastServerStatus();
    scheduleServerRestart();
  }
}

function scheduleServerRestart() {
  if (quitting || !server) return;
  const maxAttempts = settingsInfo?.values.server.restartAttempts ?? 3;
  if (restartAttempts >= maxAttempts) return;
  restartAttempts += 1;
  clearTimeout(serverRestartTimer);
  serverRestartTimer = setTimeout(() => {
    startServer().catch(() => {});
  }, 1500 * restartAttempts);
  serverRestartTimer.unref?.();
}

function wireServerLifecycle() {
  server.on('status', (status) => {
    serverStatus.available = status.available;
    if (!status.available) {
      serverStatus.stream = 'offline';
    }
    broadcastServerStatus();
  });

  server.on('exit', () => {
    serverStatus.available = false;
    serverStatus.stream = 'offline';
    serverStatus.reason = 'Servidor encerrou.';
    if (stream) stream.stop();
    stream = null;
    api.configure({ baseUrl: null, authorization: null });
    for (const execution of executions.values()) {
      if (execution.status === 'running' && execution.sessionId) {
        finalizeExecution(execution.sessionId, 'failed');
      }
    }
    broadcastServerStatus();
    scheduleServerRestart();
  });
}

function waitForStream(timeoutMs = 4000) {
  if (serverStatus.stream === 'connected') return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (serverStatus.stream === 'connected') {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

function assertString(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw new Error(`Campo "${field}" inválido.`);
  }
  if (value.length > maxLength) {
    throw new Error(`Campo "${field}" excede o limite de ${maxLength} caracteres.`);
  }
  return value;
}

function validateRunPayload(payload, snapshotValue) {
  const allowed = new Set(
    (snapshotValue.agents || []).filter((agent) => !agent.hidden).map((agent) => agent.name),
  );
  allowed.add('__general__');

  const agent = assertString(payload.agent || '__general__', 'agent', 120);
  if (!allowed.has(agent)) {
    throw new Error(`Agente "${agent}" não encontrado ou oculto.`);
  }

  let command = null;
  let template = '';
  if (payload.command) {
    command = assertString(payload.command, 'command', 120);
    const found = (snapshotValue.commands || []).find((item) => item.name === command);
    if (!found) throw new Error(`Comando "${command}" não encontrado.`);
    if (
      found.group !== '__general__' &&
      found.agent &&
      found.agent !== '__general__' &&
      found.agent !== agent
    ) {
      throw new Error(`O comando "${command}" pertence ao agente "${found.agent}".`);
    }
    template = found.template || '';
  }

  const prompt = assertString(payload.prompt || '', 'prompt', 50_000);
  const args = assertString(payload.args || '', 'args', 10_000);
  if (!command && prompt.trim().length === 0) {
    throw new Error('Informe um prompt ou escolha um comando.');
  }

  return { agent, command, prompt, args, template };
}

function createExecution({
  executionId = crypto.randomUUID(),
  agent,
  sessionId,
  command,
  args,
  prompt,
  server: isServer,
  origin = null,
}) {
  const execution = {
    executionId,
    sessionId,
    agent,
    command,
    args,
    prompt,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    server: isServer,
    lastText: '',
    origin,
  };
  executions.set(executionId, execution);
  activeByAgent.set(agent, executionId);
  if (sessionId) activeBySession.set(sessionId, executionId);
  return execution;
}

function emitRunFinished(execution, status) {
  const payload = {
    executionId: execution.executionId,
    sessionId: execution.sessionId,
    agent: execution.agent,
    status,
    origin: execution.origin || null,
    summary: execution.lastText || '',
  };
  // Depois que o chamador terminou de liberar o agente e avisar a interface.
  setImmediate(() => runBus.emit('finished', payload));
}

/**
 * Monta o texto realmente enviado ao agente: hooks promptSubmit (só para
 * prompts do usuário) e steering (todas as origens).
 */
async function composePrompt(parsed, internal) {
  let text = parsed.prompt;
  const applied = { steering: [], hooks: [] };
  const origin = internal.origin?.kind || 'user';

  if (origin === 'user' && hooks) {
    const result = await hooks.applyPromptSubmit({ agent: parsed.agent, prompt: text });
    text = result.prompt;
    applied.hooks = result.applied;
  }

  if (steering && settingsInfo.values.steering.enabled) {
    try {
      const resolved = steering.resolve({ prompt: parsed.prompt, files: internal.files || [] });
      if (resolved.text) {
        text = `${resolved.text}\n\n${text}`;
        applied.steering = resolved.included.map((doc) => doc.name);
      }
    } catch (error) {
      console.error('[agent-bar] steering:', error.message);
    }
  }
  return { text, applied };
}

function displayPrompt(parsed, internal, applied) {
  if (parsed.command) return `/${parsed.command} ${parsed.args}`.trim();
  const lines = [];
  if (internal.label) lines.push(`[${internal.label}]`);
  lines.push(parsed.prompt);
  const notes = [];
  if (applied.steering.length > 0) notes.push(`steering: ${applied.steering.join(', ')}`);
  if (applied.hooks.length > 0) notes.push(`hooks: ${applied.hooks.join(', ')}`);
  if (notes.length > 0) lines.push('', `(${notes.join(' · ')})`);
  return lines.join('\n');
}

async function startRun(payload, internal = {}) {
  if (!snapshot) await refresh('before-run');
  const parsed = validateRunPayload(payload, snapshot);
  if (activeByAgent.has(parsed.agent) || pendingAgents.has(parsed.agent)) {
    throw new Error(`O agente "${parsed.agent}" já está em execução neste projeto.`);
  }

  const meetingActive = meeting?.state &&
    ['running', 'paused', 'finalizing'].includes(meeting.state.status);
  if (
    meetingActive &&
    [meeting.state.host, ...(meeting.state.participants || [])].includes(parsed.agent)
  ) {
    throw new Error(`O agente "${parsed.agent}" está em uma reunião ativa.`);
  }

  pendingAgents.add(parsed.agent);
  try {
    return await startRunUnlocked(payload, parsed, internal);
  } finally {
    pendingAgents.delete(parsed.agent);
  }
}

async function startRunUnlocked(payload, parsed, internal = {}) {
  const composed = parsed.command
    ? { text: parsed.prompt, applied: { steering: [], hooks: [] } }
    : await composePrompt(parsed, internal);
  const promptToSend = composed.text;
  const shownPrompt = displayPrompt(parsed, internal, composed.applied);
  const origin = internal.origin || { kind: 'user' };
  const titlePrefix = internal.label || parsed.agent;

  if (serverStatus.available && api?.configured) {
    const streamReady = await waitForStream(4000);
    if (!streamReady) {
      throw new Error('Stream de eventos do OpenCode não conectou.');
    }
    let sessionCreated = false;
    try {
      let sessionId = payload.resumeSessionId || null;
      if (sessionId) {
        sessionCreated = true;
        const loaded = await api.getSession(sessionId);
        const existingAgent = loaded?.data?.agent || parsed.agent;
        if (existingAgent !== parsed.agent && parsed.agent !== '__general__') {
          throw new Error('A sessão pertence a outro agente.');
        }
        ensureTrackedSession(sessionId, { agent: parsed.agent });
      } else {
        const created = await api.createSession({
          directory: projectDir,
          agent: parsed.agent === '__general__' ? null : parsed.agent,
          title: `${titlePrefix}${parsed.command ? ` /${parsed.command}` : ''} · ${new Date().toLocaleString('pt-BR')}`,
        });
        sessionId = created?.data?.id;
        if (!sessionId) throw new Error('O servidor não retornou o ID da sessão.');
        sessionCreated = true;
        sessionInfo.set(sessionId, {
          sessionID: sessionId,
          agent: parsed.agent,
          parentID: null,
          title: created.data.title,
        });
        ensureTrackedSession(sessionId, { agent: parsed.agent, title: created.data.title });
      }

      const execution = createExecution({
        agent: parsed.agent,
        sessionId,
        command: parsed.command,
        args: parsed.args,
        prompt: parsed.prompt,
        server: true,
        origin,
      });
      history.recordPrompt(sessionId, shownPrompt);
      history.recordStatus(sessionId, 'running');
      updateLive(parsed.agent, 'running', 'iniciando', sessionId);
      send('run:event', {
        type: 'start',
        executionId: execution.executionId,
        sessionId,
        agent: parsed.agent,
        command: parsed.command,
        args: parsed.args,
        prompt: parsed.prompt,
        startedAt: execution.startedAt,
        server: true,
        origin,
        steering: composed.applied.steering,
      });
      send('activity:event', {
        type: 'start',
        executionId: execution.executionId,
        sessionID: sessionId,
        agent: parsed.agent,
        command: parsed.command,
        args: parsed.args,
        prompt: parsed.prompt,
        startedAt: execution.startedAt,
      });

      try {
        if (parsed.command) {
          await api.runCommand(sessionId, parsed.command, parsed.args || '');
        } else {
          await api.sendPrompt(sessionId, promptToSend);
        }
      } catch (error) {
        finalizeExecution(sessionId, 'failed');
        throw error;
      }

      return {
        executionId: execution.executionId,
        sessionId,
        agent: parsed.agent,
        command: parsed.command,
        args: execution.args,
        server: true,
      };
    } catch (error) {
      if (sessionCreated || error.message.includes('outro agente')) throw error;
      // Só cai para o spawn quando a sessão nem chegou a ser criada.
      console.error('[agent-bar] servidor falhou ao iniciar execução:', error.message);
    }
  }

  // Fallback: opencode run via spawn.
  const result = runner.run({
    agent: parsed.agent,
    command: parsed.command,
    args: parsed.args,
    prompt: promptToSend,
    template: parsed.template,
  });
  const localSessionId = `local_${result.executionId}`;
  const execution = createExecution({
    executionId: result.executionId,
    agent: parsed.agent,
    sessionId: localSessionId,
    command: parsed.command,
    args: parsed.args,
    prompt: parsed.prompt,
    server: false,
    origin,
  });
  execution.fallbackExecutionId = result.executionId;
  sessionInfo.set(localSessionId, {
    sessionID: localSessionId,
    agent: parsed.agent,
    parentID: null,
    title: `Local · ${parsed.agent}`,
  });
  ensureTrackedSession(localSessionId, { agent: parsed.agent });
  history.recordPrompt(localSessionId, shownPrompt);
  history.recordStatus(localSessionId, 'running');
  updateLive(parsed.agent, 'running', 'iniciando', localSessionId);
  send('run:event', {
    type: 'start',
    executionId: result.executionId,
    sessionId: localSessionId,
    agent: parsed.agent,
    command: parsed.command,
    args: parsed.args,
    prompt: parsed.prompt,
    startedAt: execution.startedAt,
    server: false,
    origin,
    steering: composed.applied.steering,
  });
  send('activity:event', {
    type: 'start',
    executionId: result.executionId,
    sessionID: localSessionId,
    agent: parsed.agent,
    command: parsed.command,
    args: parsed.args,
    prompt: parsed.prompt,
    startedAt: execution.startedAt,
  });
  return { ...result, sessionId: localSessionId, server: false };
}

async function cancelRun(executionId) {
  const execution = executions.get(executionId);
  if (!execution) return { ok: false, message: 'Execução não encontrada.' };
  if (execution.status !== 'running') {
    return { ok: false, message: 'Execução já finalizada.' };
  }

  if (execution.server && execution.sessionId) {
    await api.interrupt(execution.sessionId);
    return { ok: true };
  }

  return runner.cancel(executionId);
}

function assertSafePath(target) {
  const raw = String(target || '');
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectDir, raw);
  const roots = [projectDir, path.join(atlasDir, 'data')];
  if (steering) roots.push(steering.globalDir);
  const allowed = roots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
  if (!allowed) throw new Error('Caminho fora do projeto/histórico não pode ser aberto.');
  return resolved;
}

/* ---------- Specs, hooks e steering ---------- */

function knownAgentNames() {
  const names = new Set(
    (snapshot?.agents || []).filter((agent) => !agent.hidden).map((agent) => agent.name),
  );
  names.add('__general__');
  return names;
}

function assertAgent(name) {
  const agent = name ? String(name) : '__general__';
  if (!knownAgentNames().has(agent)) throw new Error(`Agente "${agent}" não encontrado.`);
  return agent;
}

function pushKiroWarning(message) {
  kiroWarnings.unshift({ message, at: new Date().toISOString() });
  if (kiroWarnings.length > 20) kiroWarnings.length = 20;
  scheduleKiroBroadcast();
}

function kiroState() {
  const safe = (fn, fallback) => {
    try {
      return fn();
    } catch (error) {
      pushKiroWarning(error.message);
      return fallback;
    }
  };
  return {
    projectDir,
    paths: {
      steering: path.join(projectDir, '.kiro', 'steering'),
      globalSteering: steering.globalDir,
      specs: path.join(projectDir, '.kiro', 'specs'),
      hooks: path.join(projectDir, '.kiro', 'hooks'),
    },
    settings: {
      steeringEnabled: settingsInfo.values.steering.enabled,
      hooksEnabled: settingsInfo.values.hooks.enabled,
    },
    steering: safe(() => steering.list(), []),
    specs: safe(() => specs.list(), []),
    specRuns: specRunner.state(),
    hooks: safe(() => hooks.list(), []),
    hookRuns: hooks.listRuns(),
    hookStatus: hooks.status(),
    warnings: kiroWarnings.slice(),
  };
}

let kiroBroadcastTimer = null;
function scheduleKiroBroadcast() {
  clearTimeout(kiroBroadcastTimer);
  kiroBroadcastTimer = setTimeout(() => {
    if (steering && specs && hooks) send('kiro:updated', kiroState());
  }, 150);
}

function scheduleKiroRefresh() {
  clearTimeout(kiroTimer);
  kiroTimer = setTimeout(() => {
    ensureKiroWatcher();
    try {
      hooks.load();
    } catch (error) {
      pushKiroWarning(`Hooks: ${error.message}`);
    }
    scheduleKiroBroadcast();
  }, 300);
}

function ensureKiroWatcher() {
  const kiroDir = path.join(projectDir, '.kiro');
  if (!fs.existsSync(kiroDir)) {
    if (kiroWatcher) {
      kiroWatcher.stop();
      kiroWatcher = null;
    }
    return;
  }
  if (!kiroWatcher) {
    kiroWatcher = new ProjectWatcher({ root: kiroDir, ignoredNames: new Set(), debounceMs: 150 });
    kiroWatcher.on('change', scheduleKiroRefresh);
  }
  kiroWatcher.setBases(['']);
}

let globalSteeringWatcher = null;
function ensureGlobalSteeringWatcher() {
  if (globalSteeringWatcher || !fs.existsSync(steering.globalDir)) return;
  try {
    globalSteeringWatcher = fs.watch(steering.globalDir, { persistent: false }, scheduleKiroBroadcast);
    globalSteeringWatcher.on('error', () => {
      globalSteeringWatcher = null;
    });
  } catch {
    globalSteeringWatcher = null;
  }
}

function initKiro() {
  steering = new SteeringStore({ projectDir, maxChars: settingsInfo.values.steering.maxChars });
  specs = new SpecStore({ projectDir });

  const startInternalRun = ({ agent, prompt, files, label, origin }) =>
    startRun({ agent, prompt }, { origin, files, label });

  specRunner = new SpecRunner({ store: specs, startRun: startInternalRun, cancelRun });
  specRunner.on('update', scheduleKiroBroadcast);
  specRunner.on('error', ({ spec, message }) => pushKiroWarning(`Spec ${spec}: ${message}`));
  specRunner.on('finished', (entry) => {
    send('kiro:notice', {
      type: entry.status === 'succeeded' ? 'success' : 'error',
      message:
        entry.kind === 'task'
          ? `Spec ${entry.spec}: tarefa ${entry.taskLabel} ${entry.status === 'succeeded' ? 'concluída' : 'não concluída'}.`
          : `Spec ${entry.spec}: ${entry.phase} ${entry.status === 'succeeded' ? 'pronto para revisão' : 'falhou'}.`,
    });
  });

  const hookWatcher = new ProjectWatcher({
    root: projectDir,
    ignoredPaths: [path.join(atlasDir, 'data'), path.join(projectDir, '.kiro', 'hooks')],
    maxDirs: settingsInfo.values.hooks.maxWatchedDirs,
    debounceMs: 250,
  });
  hooks = new HookManager({
    projectDir,
    dataDir: path.join(atlasDir, 'data'),
    startAgentRun: startInternalRun,
    watcher: settingsInfo.values.hooks.enabled ? hookWatcher : null,
    settings: settingsInfo.values.hooks,
  });
  hooks.on('update', scheduleKiroBroadcast);
  hooks.on('warning', (message) => pushKiroWarning(message));
  hooks.on('run', (run) => {
    if (['failed', 'blocked'].includes(run.status)) {
      send('kiro:notice', { type: 'error', message: `Hook "${run.name}": ${run.message}` });
    }
  });

  runBus.on('finished', (payload) => {
    specRunner.handleFinished(payload);
    hooks.handleExecutionFinished(payload);
  });

  try {
    hooks.load();
  } catch (error) {
    pushKiroWarning(`Hooks: ${error.message}`);
  }
  ensureKiroWatcher();
  ensureGlobalSteeringWatcher();
}

function specName(value) {
  return assertString(value, 'name', 64);
}

function registerKiroIpc() {
  ipcMain.handle('kiro:state', async () => {
    ensureGlobalSteeringWatcher();
    return kiroState();
  });

  // Steering
  ipcMain.handle('steering:get', async (_event, id) => steering.get(assertString(id, 'id', 200)));
  ipcMain.handle('steering:save', async (_event, payload = {}) => {
    const doc = steering.save(payload);
    ensureKiroWatcher();
    ensureGlobalSteeringWatcher();
    scheduleKiroBroadcast();
    return doc;
  });
  ipcMain.handle('steering:delete', async (_event, id) => {
    const result = steering.remove(assertString(id, 'id', 200));
    scheduleKiroBroadcast();
    return result;
  });
  ipcMain.handle('steering:preview', async (_event, payload = {}) => {
    const prompt = assertString(payload.prompt || '', 'prompt', 50_000);
    const files = Array.isArray(payload.files) ? payload.files.map(String).slice(0, 200) : [];
    return steering.resolve({ prompt, files });
  });
  ipcMain.handle('steering:generate', async (_event, payload = {}) =>
    startRun(
      { agent: assertAgent(payload.agent), prompt: steeringGeneratePrompt() },
      { origin: { kind: 'steering' }, label: 'gerar steering do projeto' },
    ),
  );

  // Specs
  ipcMain.handle('specs:read', async (_event, name) => specs.read(specName(name)));
  ipcMain.handle('specs:create', async (_event, payload = {}) => {
    const title = assertString(payload.title || '', 'title', 200).trim();
    const idea = assertString(payload.idea || '', 'idea', 20_000);
    const name = payload.name ? specName(payload.name) : slugify(title);
    if (!title && !name) throw new Error('Dê um nome à funcionalidade.');
    const agent = assertAgent(payload.agent);
    const created = specs.create({ title: title || name, name, idea, agent });
    ensureKiroWatcher();
    let run = null;
    let runError = null;
    try {
      run = await specRunner.runPhase(created.name, 'requirements', { agent });
    } catch (error) {
      runError = error.message;
    }
    scheduleKiroBroadcast();
    return { spec: specs.read(created.name), run, runError };
  });
  ipcMain.handle('specs:set-agent', async (_event, payload = {}) => {
    const summary = specs.setAgent(specName(payload.name), assertAgent(payload.agent));
    scheduleKiroBroadcast();
    return summary;
  });
  ipcMain.handle('specs:approve', async (_event, payload = {}) => {
    const summary = specs.approve(
      specName(payload.name),
      assertString(payload.phase, 'phase', 40),
      payload.approved !== false,
    );
    scheduleKiroBroadcast();
    return summary;
  });
  ipcMain.handle('specs:generate', async (_event, payload = {}) =>
    specRunner.runPhase(specName(payload.name), assertString(payload.phase, 'phase', 40), {
      feedback: assertString(payload.feedback || '', 'feedback', 20_000),
      agent: payload.agent ? assertAgent(payload.agent) : null,
    }),
  );
  ipcMain.handle('specs:task-status', async (_event, payload = {}) => {
    const status = ['todo', 'in_progress', 'done'].includes(payload.status) ? payload.status : null;
    if (!status) throw new Error('Status inválido.');
    const detail = specs.setTaskStatus(
      specName(payload.name),
      assertString(payload.taskId, 'taskId', 40),
      status,
    );
    scheduleKiroBroadcast();
    return detail;
  });
  ipcMain.handle('specs:run-task', async (_event, payload = {}) =>
    specRunner.runTask(specName(payload.name), assertString(payload.taskId, 'taskId', 40), {
      agent: payload.agent ? assertAgent(payload.agent) : null,
    }),
  );
  ipcMain.handle('specs:run-all', async (_event, payload = {}) =>
    specRunner.runAll(specName(payload.name), {
      agent: payload.agent ? assertAgent(payload.agent) : null,
    }),
  );
  ipcMain.handle('specs:stop', async (_event, name) => specRunner.stop(specName(name)));
  ipcMain.handle('specs:delete', async (_event, name) => {
    const value = specName(name);
    if (specRunner.state()[value]) throw new Error('Pare a execução antes de apagar a spec.');
    const result = specs.remove(value);
    scheduleKiroBroadcast();
    return result;
  });

  // Hooks
  ipcMain.handle('hooks:save', async (_event, payload = {}) => {
    const hook = hooks.save(payload.hook || {}, {
      previousId: payload.previousId ? assertString(payload.previousId, 'previousId', 120) : null,
      knownAgents: knownAgentNames(),
    });
    ensureKiroWatcher();
    return hook;
  });
  ipcMain.handle('hooks:delete', async (_event, id) => hooks.remove(assertString(id, 'id', 120)));
  ipcMain.handle('hooks:toggle', async (_event, payload = {}) =>
    hooks.setEnabled(assertString(payload.id, 'id', 120), payload.enabled !== false),
  );
  ipcMain.handle('hooks:authorize', async (_event, id) => hooks.authorize(assertString(id, 'id', 120)));
  ipcMain.handle('hooks:run', async (_event, id) => {
    const run = await hooks.runManual(assertString(id, 'id', 120));
    return run ? { ...run } : null;
  });
}

function registerIpc() {
  registerKiroIpc();
  ipcMain.handle('agents:discover', async () => snapshot || refresh('ipc'));
  ipcMain.handle('agents:refresh', async () => refresh('manual'));

  ipcMain.handle('agent:run', async (_event, payload = {}) =>
    startRun(payload, { origin: { kind: 'user' } }),
  );
  ipcMain.handle('run:cancel', async (_event, executionId) => {
    if (typeof executionId !== 'string') throw new Error('executionId inválido.');
    return cancelRun(executionId);
  });

  ipcMain.handle('history:list', async () => history.list());
  ipcMain.handle('history:read', async (_event, sessionID) => {
    if (typeof sessionID !== 'string') throw new Error('sessionID inválido.');
    return history.read(sessionID);
  });
  ipcMain.handle('history:copy', async (_event, sessionID) => {
    const markdown = history.exportMarkdown(sessionID);
    clipboard.writeText(markdown);
    return { ok: true };
  });
  ipcMain.handle('history:export', async (_event, sessionID) => {
    const entry = history.byId.get(sessionID);
    if (!entry) throw new Error('Sessão não encontrada.');
    const dir = path.join(atlasDir, 'data', 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const defaultPath = path.join(dir, `${entry.agent}-${sessionID}.md`);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar histórico como Markdown',
      defaultPath,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, history.exportMarkdown(sessionID));
    return { path: result.filePath };
  });
  ipcMain.handle('history:delete', async (_event, sessionID) => {
    if (typeof sessionID !== 'string') throw new Error('sessionID inválido.');
    history.delete(sessionID);
    send('history:updated', history.list());
    return { ok: true };
  });

  ipcMain.handle('file:open', async (_event, target) => {
    const safe = assertSafePath(target);
    const error = await shell.openPath(safe);
    if (error) throw new Error(error);
    return { ok: true };
  });

  ipcMain.handle('permission:reply', async (_event, payload = {}) => {
    const sessionID = assertString(payload.sessionID, 'sessionID', 200);
    const requestID = assertString(payload.requestID, 'requestID', 200);
    const decision = ['once', 'always', 'reject'].includes(payload.decision)
      ? payload.decision
      : null;
    if (!decision) throw new Error('Decisão de permissão inválida.');
    await api.replyPermission(sessionID, requestID, decision, payload.message || null);
    permissions.delete(requestID);
    return { ok: true };
  });

  ipcMain.handle('meeting:start', async (_event, payload = {}) => {
    if (!snapshot) await refresh('meeting');
    if (!serverStatus.available || !api?.configured) {
      throw new Error('Servidor OpenCode indisponível para iniciar a reunião.');
    }
    const streamReady = await waitForStream(4000);
    if (!streamReady) {
      throw new Error('Stream de eventos do OpenCode não conectou; tente novamente.');
    }
    const names = [payload.host, ...(payload.participants || [])];
    const busy = names.find(
      (name) => activeByAgent.has(name) || pendingAgents.has(name),
    );
    if (busy) throw new Error(`O agente "${busy}" já está em execução.`);
    const state = await meeting.start(payload);
    return state;
  });
  ipcMain.handle('meeting:state', async () => meeting.publicState());
  ipcMain.handle('meeting:pause', async () => {
    meeting.pause();
    return meeting.publicState();
  });
  ipcMain.handle('meeting:resume', async () => {
    meeting.resume();
    return meeting.publicState();
  });
  ipcMain.handle('meeting:skip', async () => {
    await meeting.skip();
    return meeting.publicState();
  });
  ipcMain.handle('meeting:moderator', async (_event, text) => {
    await meeting.moderator(String(text || ''));
    return meeting.publicState();
  });
  ipcMain.handle('meeting:add', async (_event, name) => {
    const participant = String(name || '');
    if (activeByAgent.has(participant) || pendingAgents.has(participant)) {
      throw new Error(`O agente "${participant}" já está em execução.`);
    }
    await meeting.addParticipant(participant);
    return meeting.publicState();
  });
  ipcMain.handle('meeting:remove', async (_event, name) => {
    await meeting.removeParticipant(String(name || ''));
    return meeting.publicState();
  });
  ipcMain.handle('meeting:stop', async () => {
    await meeting.stop();
    return meeting.publicState();
  });
  ipcMain.handle('meeting:templates', async () => meeting.listTemplates());
  ipcMain.handle('meeting:save-template', async (_event, payload) =>
    meeting.saveTemplate(payload || {}),
  );
  ipcMain.handle('meeting:delete-template', async (_event, id) =>
    meeting.deleteTemplate(String(id || '')),
  );

  ipcMain.handle('settings:get', async () => ({
    values: settingsInfo.values,
    file: settingsInfo.file,
    warning: settingsInfo.warning,
  }));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'Agent Bar',
    backgroundColor: '#020203',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  settingsInfo = readSettings(atlasDir);

  history = new HistoryStore({
    dir: path.join(atlasDir, 'data', 'history'),
    retentionDays: settingsInfo.values.history.retentionDays,
    maxSessionBytes: settingsInfo.values.history.maxSessionBytes,
  });
  history.init();

  api = new OpenCodeApi();
  server = new ServerManager({
    cwd: projectDir,
    startupTimeoutMs: settingsInfo.values.server.startupTimeoutMs,
  });
  wireServerLifecycle();

  meeting = new MeetingManager({
    api,
    history,
    getAgents: () => snapshot?.agents || [],
    getProjectDir: () => projectDir,
    emit: (event) => send('meeting:event', event),
    dataDir: path.join(atlasDir, 'data'),
    settings: settingsInfo.values.meeting,
  });
  meeting.init();
  initKiro();

  registerIpc();
  runner.on('event', (event) => {
    const execution = executions.get(event.executionId);
    if (!execution) return;

    if (event.type === 'start') {
      execution.status = 'running';
    }

    if (event.type === 'log') {
      execution.lastText = `${execution.lastText || ''}${event.chunk || ''}`;
      send('activity:event', {
        type: 'text.delta',
        sessionID: execution.sessionId,
        agent: execution.agent,
        delta: event.chunk || '',
        created: new Date().toISOString(),
      });
    }

    if (event.type === 'exit') {
      const status = event.status === 'done' ? 'succeeded' : 'failed';
      if (execution.sessionId) {
        if (execution.lastText) {
          history.recordText(execution.sessionId, execution.lastText);
        }
        history.endSession(execution.sessionId, {
          status,
          summary: execution.lastText || '',
        });
        send('activity:event', {
          type: 'status',
          sessionID: execution.sessionId,
          agent: execution.agent,
          status,
        });
      }
      activeByAgent.delete(execution.agent);
      if (execution.sessionId) activeBySession.delete(execution.sessionId);
      execution.status = status;
      execution.finishedAt = new Date().toISOString();
      updateLive(execution.agent, event.status === 'done' ? 'done' : 'error', event.status);
      emitRunFinished(execution, status);
    }

    send('run:event', event);
  });

  createWindow();
  refresh('startup').catch(() => {});
  startServer().catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function shutdownSidecars() {
  quitting = true;
  clearTimeout(refreshTimer);
  clearTimeout(serverRestartTimer);
  clearTimeout(kiroTimer);
  if (hooks) hooks.stop();
  if (kiroWatcher) kiroWatcher.stop();
  if (globalSteeringWatcher) globalSteeringWatcher.close();
  if (stream) stream.stop();
  if (server) server.stop();
  if (history) history.flush();
}

process.on('SIGINT', () => {
  shutdownSidecars();
  app.quit();
});

process.on('SIGTERM', () => {
  shutdownSidecars();
  app.quit();
});

app.on('before-quit', () => {
  shutdownSidecars();
  for (const watcher of watchers.values()) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
  }
  watchers.clear();
  for (const execution of executions.values()) {
    if (execution.status === 'running' && !execution.server) {
      runner.cancel(execution.executionId);
    }
  }
});
