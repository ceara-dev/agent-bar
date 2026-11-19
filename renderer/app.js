'use strict';

const api = window.agentBar;
const FAVORITES_KEY = 'agentBar.favorites';
const GENERAL_AGENT = {
  name: '__general__',
  description: 'Comandos sem agente associado e prompts com o agente padrão.',
  mode: 'primary',
  model: null,
  origin: 'builtin',
  hidden: false,
  warning: null,
  sourcePath: null,
  sourceType: 'builtin',
  color: null,
  icon: '▣',
  order: 999,
};

let itemCounter = 0;

const state = {
  snapshot: null,
  favorites: new Set(),
  live: new Map(),
  status: new Map(),
  executions: new Map(),
  currentSessionByAgent: new Map(),
  activeExecutionByAgent: new Map(),
  timelines: new Map(),
  history: [],
  settings: null,
  server: { available: false, starting: true, stream: 'offline', reason: null },
  templates: [],
  meeting: null,
  meetingDraft: {
    host: null,
    participants: [],
    agenda: '',
    projectDir: '',
    mode: 'roundtable',
    order: 'fixed',
    maxRounds: 3,
    stopCriterion: 'host',
  },
  activeAgentName: null,
  activeTab: 'activity',
  activitySession: null,
  replaySession: null,
  generalReplaySession: null,
  resumeSessionByAgent: new Map(),
  permissions: [],
  searchResults: [],
  searchIndex: 0,
  focusCommand: null,
  historyReady: false,
};

const el = (id) => document.getElementById(id);

function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function nextItemId() {
  itemCounter += 1;
  return `timeline_${itemCounter}`;
}

function loadFavorites() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    state.favorites = new Set(Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : []);
  } catch {
    state.favorites = new Set();
  }
}

function saveFavorites() {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(state.favorites)));
}

function toast(message, type = '') {
  const node = el('toast');
  node.textContent = message;
  node.className = `toast ${type}`.trim();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add('hidden'), 4200);
}

function formatTime(iso) {
  if (!iso) return '--:--';
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '--:--';
  }
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function formatDuration(startedAt, endedAt) {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function originLabel(origin) {
  return origin === 'project' ? 'projeto' : origin === 'global' ? 'global' : 'embutido';
}

function modeLabel(mode) {
  return mode === 'subagent' ? 'subagent' : mode === 'all' ? 'all' : 'primary';
}

function statusLabel(status) {
  return status === 'running'
    ? 'rodando'
    : status === 'done' || status === 'succeeded'
      ? 'concluído'
      : status === 'error' || status === 'failed'
        ? 'erro'
        : status === 'interrupted'
          ? 'interrompido'
          : 'ocioso';
}

function initials(name) {
  const clean = String(name || '?').replace(/^[^A-Za-z0-9À-ÿ]+/, '');
  return (clean.slice(0, 2) || '?').toUpperCase();
}

function agentByName(name) {
  if (name === '__general__') return GENERAL_AGENT;
  return (state.snapshot?.agents || []).find((agent) => agent.name === name) || null;
}

function visibleAgents() {
  return (state.snapshot?.agents || []).filter((agent) => !agent.hidden);
}

function liveFor(name) {
  return state.live.get(name) || null;
}

function statusFor(name) {
  const live = liveFor(name);
  if (live) return live.state;
  return state.status.get(name)?.status || 'idle';
}

function statusDot(status) {
  const node = create('span', `status-dot ${status}`, '');
  node.title = statusLabel(status);
  node.setAttribute('aria-label', statusLabel(status));
  return node;
}

function badge(text, className = '') {
  return create('span', `badge ${className}`.trim(), text);
}

function applyAgentStyle(iconNode, agent) {
  if (agent.color) {
    iconNode.style.color = agent.color;
    iconNode.style.borderColor = agent.color;
    iconNode.style.background = `color-mix(in srgb, ${agent.color} 14%, transparent)`;
  }
}

function sortAgents(list) {
  return [...list].sort((a, b) => {
    const favoriteA = state.favorites.has(a.name) ? 0 : 1;
    const favoriteB = state.favorites.has(b.name) ? 0 : 1;
    if (favoriteA !== favoriteB) return favoriteA - favoriteB;
    const orderA = Number.isFinite(a.order) ? a.order : 999;
    const orderB = Number.isFinite(b.order) ? b.order : 999;
    if (orderA !== orderB) return orderA - orderB;
    return a.name.localeCompare(b.name, 'pt-BR');
  });
}

/* ---------- Chips ---------- */

function createChip(agent) {
  const chip = create('div', 'chip');
  if (state.favorites.has(agent.name)) chip.classList.add('is-favorite');
  const status = statusFor(agent.name);
  if (status === 'running') chip.classList.add('is-running');
  if (status === 'error' || status === 'failed') chip.classList.add('is-error');

  const main = create('button', 'chip-main');
  main.type = 'button';
  main.title = `${agent.name} · ${statusLabel(status)}${agent.description ? ` · ${agent.description}` : ''}`;

  const icon = create('div', 'agent-icon', agent.icon || initials(agent.name));
  applyAgentStyle(icon, agent);

  const copy = create('div', 'chip-copy');
  const nameRow = create('div', 'chip-name');
  nameRow.appendChild(statusDot(status));
  nameRow.appendChild(create('span', '', agent.name));

  const badgeRow = create('div', 'badge-row');
  badgeRow.appendChild(badge(originLabel(agent.origin), agent.origin));
  badgeRow.appendChild(badge(modeLabel(agent.mode), 'mode'));
  if (agent.warning) {
    const warning = badge('!', 'warn');
    warning.title = agent.warning;
    badgeRow.appendChild(warning);
  }

  const live = liveFor(agent.name);
  const subText =
    live && live.state === 'running'
      ? live.detail || 'rodando'
      : agent.model || agent.description || 'sem descrição';
  const sub = create('div', 'chip-sub', subText);

  copy.append(nameRow, badgeRow, sub);
  main.append(icon, copy);
  main.addEventListener('click', () => openAgent(agent.name));

  const star = create('button', 'star-button', state.favorites.has(agent.name) ? '★' : '☆');
  star.type = 'button';
  star.title = state.favorites.has(agent.name) ? 'Remover dos favoritos' : 'Fixar no início';
  if (state.favorites.has(agent.name)) star.classList.add('active');
  star.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFavorite(agent.name);
  });

  chip.append(main, star);
  return chip;
}

function createGeneralChip() {
  const chip = create('div', 'chip is-general');
  const status = statusFor('__general__');
  const main = create('button', 'chip-main');
  main.type = 'button';
  const icon = create('div', 'agent-icon', GENERAL_AGENT.icon);
  const copy = create('div', 'chip-copy');
  const nameRow = create('div', 'chip-name');
  nameRow.appendChild(statusDot(status));
  nameRow.appendChild(create('span', '', 'Geral'));
  const badgeRow = create('div', 'badge-row');
  badgeRow.appendChild(badge('geral', 'mode'));
  copy.append(nameRow, badgeRow, create('div', 'chip-sub', 'comandos sem agente'));
  main.append(icon, copy);
  main.addEventListener('click', () => openAgent('__general__'));
  chip.append(main);
  return chip;
}

function toggleFavorite(name) {
  if (state.favorites.has(name)) state.favorites.delete(name);
  else state.favorites.add(name);
  saveFavorites();
  renderChips();
  if (state.activeAgentName) renderModalHeader();
}

function renderChips() {
  const snapshot = state.snapshot;
  if (!snapshot) return;

  el('project-path').textContent = snapshot.projectDir || 'Projeto não identificado';
  el('cli-info').textContent = snapshot.opencode.available
    ? `OpenCode ${snapshot.opencode.version || ''} · ${snapshot.opencode.agentListSource || '—'}`
    : 'OpenCode CLI não encontrado';
  el('refresh-info').textContent = snapshot.generatedAt
    ? `Atualizado ${formatTime(snapshot.generatedAt)}`
    : '';
  renderServerStatus();

  const warnings = snapshot.warnings || [];
  const banner = el('warning-banner');
  if (warnings.length > 0) {
    banner.textContent = `Avisos (${warnings.length}): ${warnings.slice(0, 3).join(' · ')}${
      warnings.length > 3 ? ' · …' : ''
    }`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  const agents = visibleAgents();
  const primary = sortAgents(agents.filter((agent) => agent.mode !== 'subagent'));
  const subagents = sortAgents(agents.filter((agent) => agent.mode === 'subagent'));
  const generalCommands = (snapshot.commands || []).filter((command) => command.group === '__general__');

  const primaryBar = el('primary-bar');
  const subagentBar = el('subagent-bar');
  primaryBar.replaceChildren();
  subagentBar.replaceChildren();

  if (generalCommands.length > 0) primaryBar.appendChild(createGeneralChip());
  for (const agent of primary) primaryBar.appendChild(createChip(agent));
  for (const agent of subagents) subagentBar.appendChild(createChip(agent));

  el('primary-count').textContent = String(primary.length + (generalCommands.length ? 1 : 0));
  el('subagent-count').textContent = String(subagents.length);
  el('empty-state').classList.toggle('hidden', agents.length > 0 || generalCommands.length > 0);
}

function renderServerStatus() {
  const node = el('server-info');
  if (!state.server) return;
  if (state.server.starting) {
    node.textContent = 'Servidor: iniciando…';
    return;
  }
  if (state.server.available) {
    node.textContent =
      state.server.stream === 'connected'
        ? `Servidor: online (${state.server.baseUrl || 'local'})`
        : 'Servidor: reconectando…';
    return;
  }
  node.textContent = `Servidor indisponível${state.server.reason ? ` — ${state.server.reason}` : ''}`;
}

/* ---------- Modal ---------- */

function openAgent(name) {
  const agent = agentByName(name);
  if (!agent) return;
  state.activeAgentName = name;
  state.activeTab = 'activity';
  el('agent-modal').classList.remove('hidden');
  el('prompt-input').value = '';

  if (state.meetingDraft.host !== name) {
    state.meetingDraft = {
      host: name,
      participants: [],
      agenda: '',
      projectDir: state.snapshot?.projectDir || '',
      mode: 'roundtable',
      order: 'fixed',
      maxRounds: state.settings?.meeting?.maxRounds || 3,
      stopCriterion: 'host',
    };
  }

  state.activitySession =
    state.currentSessionByAgent.get(name) ||
    latestHistoryEntry(name)?.id ||
    null;
  state.replaySession = null;

  renderModal();
  loadActivityForAgent(name);
}

function closeModal() {
  state.activeAgentName = null;
  state.activitySession = null;
  state.replaySession = null;
  el('agent-modal').classList.add('hidden');
}

function latestHistoryEntry(agent) {
  return state.history
    .filter((entry) => entry.agent === agent)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
}

function renderModal() {
  const agent = agentByName(state.activeAgentName);
  if (!agent) return;

  renderModalHeader();
  renderTabs();
  renderCommands(agent);
  renderActivityStatus();
  renderHistory(agent);
  renderMeeting(agent);
}

function renderModalHeader() {
  const agent = agentByName(state.activeAgentName);
  if (!agent) return;

  const icon = el('modal-icon');
  icon.textContent = agent.icon || initials(agent.name);
  applyAgentStyle(icon, agent);

  el('modal-title').textContent = agent.name === '__general__' ? 'Geral' : agent.name;
  el('modal-description').textContent = agent.description || 'Sem descrição.';

  const metaParts = [`status: ${statusLabel(statusFor(agent.name))}`];
  if (agent.model) metaParts.push(`model: ${agent.model}`);
  if (agent.sourcePath) metaParts.push(agent.sourcePath);
  el('modal-meta').textContent = metaParts.join('  ·  ');

  const badges = el('modal-badges');
  badges.replaceChildren();
  badges.appendChild(badge(originLabel(agent.origin), agent.origin));
  badges.appendChild(badge(modeLabel(agent.mode), 'mode'));
  if (agent.warning) {
    const warning = badge('frontmatter inválido', 'warn');
    warning.title = agent.warning;
    badges.appendChild(warning);
  }
  const star = create(
    'button',
    `star-button ${state.favorites.has(agent.name) ? 'active' : ''}`.trim(),
    state.favorites.has(agent.name) ? '★' : '☆',
  );
  star.type = 'button';
  star.title = state.favorites.has(agent.name) ? 'Remover dos favoritos' : 'Fixar no início';
  star.addEventListener('click', () => toggleFavorite(agent.name));
  badges.appendChild(star);
}

function renderTabs() {
  const isGeneral = state.activeAgentName === '__general__';
  if (isGeneral && state.activeTab === 'meeting') state.activeTab = 'activity';
  document.querySelectorAll('.tab').forEach((tab) => {
    if (tab.dataset.tab === 'meeting') tab.classList.toggle('hidden', isGeneral);
    tab.classList.toggle('active', tab.dataset.tab === state.activeTab);
  });
  el('panel-activity').classList.toggle('hidden', state.activeTab !== 'activity');
  el('panel-history').classList.toggle('hidden', state.activeTab !== 'history');
  el('panel-meeting').classList.toggle('hidden', state.activeTab !== 'meeting');
}

function switchTab(tab) {
  state.activeTab = tab;
  renderTabs();
  if (tab === 'activity') loadActivityForAgent(state.activeAgentName);
  if (tab === 'history') renderHistory(agentByName(state.activeAgentName));
  if (tab === 'meeting') renderMeeting(agentByName(state.activeAgentName));
}

/* ---------- Activity ---------- */

function renderActivityStatus() {
  const agent = agentByName(state.activeAgentName);
  if (!agent) return;
  const live = liveFor(agent.name);
  const status = live?.state || statusFor(agent.name);
  const executionId = state.activeExecutionByAgent.get(agent.name);
  el('activity-status').textContent = statusLabel(status);
  el('activity-status').style.color =
    status === 'error' || status === 'failed'
      ? 'var(--red)'
      : status === 'running'
        ? 'var(--accent-text)'
        : status === 'done' || status === 'succeeded'
          ? 'var(--green)'
          : 'var(--muted-strong)';
  el('activity-session').textContent = state.activitySession ? `· ${state.activitySession}` : '';
  el('activity-stop').classList.toggle('hidden', !executionId);

  const entry = state.history.find((item) => item.id === state.activitySession);
  el('activity-duration').textContent = entry
    ? `duração ${formatDuration(entry.startedAt, entry.endedAt)}`
    : '';

  const resumeSession = state.resumeSessionByAgent.get(agent.name);
  const resume = el('resume-banner');
  if (resumeSession) {
    resume.textContent = `Retomando a sessão ${resumeSession}. O próximo prompt continuará nela.`;
    resume.classList.remove('hidden');
    el('activity-new-session').classList.remove('hidden');
  } else {
    resume.classList.add('hidden');
    el('activity-new-session').classList.add('hidden');
  }

  el('prompt-hint').textContent =
    agent.name === '__general__'
      ? 'Sem --agent: usa o agente padrão.'
      : `Executa com --agent ${agent.name}.`;
}

async function loadActivityForAgent(agentName) {
  const agent = agentByName(agentName);
  if (!agent) return;

  const sessionID =
    state.currentSessionByAgent.get(agentName) ||
    state.activitySession ||
    latestHistoryEntry(agentName)?.id ||
    null;
  state.activitySession = sessionID;

  const container = el('activity-timeline');
  container.replaceChildren();

  if (!sessionID) {
    el('activity-empty').classList.remove('hidden');
    renderActivityStatus();
    return;
  }

  if (!state.timelines.has(sessionID)) {
    try {
      const data = await api.history.read(sessionID);
      state.timelines.set(sessionID, historyEventsToItems(data.events || []));
    } catch {
      state.timelines.set(sessionID, []);
    }
  }

  renderTimeline(container, state.timelines.get(sessionID) || [], { live: sessionID === state.currentSessionByAgent.get(agentName) });
  el('activity-empty').classList.toggle('hidden', (state.timelines.get(sessionID) || []).length > 0);
  renderActivityStatus();
}

function historyEventsToItems(events) {
  const items = [];
  const toolMap = new Map();

  for (const event of events) {
    if (event.type === 'prompt') {
      items.push({ id: nextItemId(), kind: 'prompt', ts: event.ts, text: event.text || '' });
    } else if (event.type === 'text') {
      items.push({ id: nextItemId(), kind: 'text', ts: event.ts, text: event.text || '', live: false });
    } else if (event.type === 'tool') {
      if (event.phase === 'called') {
        const item = {
          id: nextItemId(),
          kind: 'tool',
          ts: event.ts,
          toolId: event.toolId,
          name: event.name || 'ferramenta',
          input: event.input,
          content: null,
          status: 'running',
          error: null,
        };
        items.push(item);
        if (event.toolId) toolMap.set(event.toolId, item);
      } else if (event.toolId && toolMap.has(event.toolId)) {
        const item = toolMap.get(event.toolId);
        item.status = event.status || (event.phase === 'failed' ? 'error' : 'ok');
        item.content = event.content || item.content;
        item.error = event.error || item.error;
      } else {
        items.push({
          id: nextItemId(),
          kind: 'tool',
          ts: event.ts,
          toolId: event.toolId,
          name: event.name || 'ferramenta',
          input: event.input,
          content: event.content,
          status: event.status || 'ok',
          error: event.error,
        });
      }
    } else if (event.type === 'file') {
      items.push({ id: nextItemId(), kind: 'file', ts: event.ts, file: event.file, event: event.event });
    } else if (event.type === 'permission') {
      items.push({ id: nextItemId(), kind: 'permission', ts: event.ts, request: event.request });
    } else if (event.type === 'error') {
      items.push({ id: nextItemId(), kind: 'error', ts: event.ts, text: event.error || '' });
    } else if (event.type === 'status') {
      items.push({ id: nextItemId(), kind: 'status', ts: event.ts, status: event.status });
    }
  }

  return items;
}

function renderTimeline(container, items, { live = false } = {}) {
  container.replaceChildren();
  for (const item of items) container.appendChild(renderTimelineItem(item, { live }));
}

function renderTimelineItem(item, { live = false } = {}) {
  if (item.kind === 'file') {
    const row = create('div', 'timeline-item file');
    row.dataset.itemId = item.id;
    const head = create('div', 'timeline-head');
    head.appendChild(create('span', 'timeline-title', 'Arquivo'));
    head.appendChild(create('span', '', formatTime(item.ts)));
    const body = create('div', 'timeline-body');
    const chip = create('button', 'file-chip', item.file);
    chip.type = 'button';
    chip.title = 'Abrir no sistema';
    chip.addEventListener('click', () => openFile(item.file));
    body.appendChild(chip);
    row.append(head, body);
    return row;
  }

  if (item.kind === 'tool') {
    const details = create('details', 'tool-card timeline-item tool');
    details.dataset.itemId = item.id;
    const head = create('summary');
    head.textContent = `${item.name || 'ferramenta'} · ${item.status || ''}`;
    details.appendChild(head);
    const body = create('div', 'timeline-body');
    if (item.input) {
      const pre = create('pre', '', item.input);
      body.appendChild(pre);
    }
    if (item.content) body.appendChild(create('pre', '', item.content));
    if (item.error) {
      const error = create('div', 'timeline-body');
      error.style.color = 'var(--red)';
      error.textContent = item.error;
      body.appendChild(error);
    }
    details.appendChild(body);
    return details;
  }

  const row = create('div', `timeline-item ${item.kind}`);
  row.dataset.itemId = item.id;
  const head = create('div', 'timeline-head');
  const title =
    item.kind === 'prompt'
      ? 'Prompt'
      : item.kind === 'text'
        ? 'Resposta'
        : item.kind === 'permission'
          ? 'Permissão'
          : item.kind === 'error'
            ? 'Erro'
            : 'Status';
  head.appendChild(create('span', 'timeline-title', title));
  if (item.agent) head.appendChild(create('span', 'badge mode', item.agent));
  head.appendChild(create('span', '', formatTime(item.ts)));
  const body = create('div', 'timeline-body');

  if (item.kind === 'permission') {
    const request = item.request || {};
    body.textContent = `${request.action || ''} ${(request.resources || []).join(', ')}`.trim();
    if (live && request.id && request.sessionID) {
      const actions = create('div', 'inline');
      for (const [label, decision] of [
        ['Permitir uma vez', 'once'],
        ['Sempre', 'always'],
        ['Rejeitar', 'reject'],
      ]) {
        const button = create('button', 'button ghost small', label);
        button.type = 'button';
        button.addEventListener('click', () => replyPermission(request, decision));
        actions.appendChild(button);
      }
      body.appendChild(actions);
    }
  } else if (item.kind === 'status') {
    body.textContent = `status: ${statusLabel(item.status)}`;
  } else {
    body.textContent = item.text || '';
  }

  row.append(head, body);
  return row;
}

function appendTextDelta(sessionID, agent, delta, messageId) {
  let timeline = state.timelines.get(sessionID);
  if (!timeline) {
    timeline = [];
    state.timelines.set(sessionID, timeline);
  }

  let item = [...timeline].reverse().find(
    (entry) => entry.kind === 'text' && entry.live && entry.messageId === messageId,
  );
  if (!item) {
    item = {
      id: nextItemId(),
      kind: 'text',
      ts: new Date().toISOString(),
      text: '',
      live: true,
      messageId,
    };
    timeline.push(item);
  }
  item.text += delta;

  if (state.activeAgentName === agent && state.activitySession === sessionID) {
    const node = el('activity-timeline').querySelector(`[data-item-id="${item.id}"] .timeline-body`);
    if (node) {
      node.textContent = item.text;
      el('activity-timeline').scrollTop = el('activity-timeline').scrollHeight;
      el('activity-empty').classList.add('hidden');
    } else {
      renderTimeline(el('activity-timeline'), timeline, { live: true });
    }
  }
}

function finishText(sessionID, agent, text, messageId) {
  let timeline = state.timelines.get(sessionID);
  if (!timeline) {
    timeline = [];
    state.timelines.set(sessionID, timeline);
  }
  let item = [...timeline].reverse().find(
    (entry) => entry.kind === 'text' && entry.messageId === messageId,
  );
  if (!item) {
    item = {
      id: nextItemId(),
      kind: 'text',
      ts: new Date().toISOString(),
      text: '',
      live: false,
      messageId,
    };
    timeline.push(item);
  }
  item.text = text || item.text;
  item.live = false;

  if (state.activeAgentName === agent && state.activitySession === sessionID) {
    const node = el('activity-timeline').querySelector(`[data-item-id="${item.id}"] .timeline-body`);
    if (node) node.textContent = item.text;
    else renderTimeline(el('activity-timeline'), timeline, { live: true });
  }
}

function addTimelineItem(sessionID, item) {
  let timeline = state.timelines.get(sessionID);
  if (!timeline) {
    timeline = [];
    state.timelines.set(sessionID, timeline);
  }
  timeline.push(item);
  if (
    state.activeAgentName &&
    state.activitySession === sessionID &&
    state.activeTab === 'activity'
  ) {
    el('activity-timeline').appendChild(renderTimelineItem(item, { live: true }));
    el('activity-empty').classList.add('hidden');
    el('activity-timeline').scrollTop = el('activity-timeline').scrollHeight;
  }
}

function handleActivityEvent(event) {
  if (!event || !event.sessionID) return;
  const sessionID = event.sessionID;
  const agent = event.agent || 'agente';
  if (event.type === 'start') {
    state.currentSessionByAgent.set(agent, sessionID);
    if (state.activeAgentName === agent) state.activitySession = sessionID;
    if (!state.timelines.has(sessionID)) state.timelines.set(sessionID, []);
    const text = event.command
      ? `/${event.command}${event.args ? ` ${event.args}` : ''}`
      : event.prompt || '';
    addTimelineItem(sessionID, {
      id: nextItemId(),
      kind: 'prompt',
      ts: event.startedAt || new Date().toISOString(),
      text,
    });
    if (state.activeAgentName === agent) {
      state.activitySession = sessionID;
      renderTimeline(el('activity-timeline'), state.timelines.get(sessionID) || [], {
        live: true,
      });
      el('activity-empty').classList.add('hidden');
      renderActivityStatus();
    }
    return;
  }

  if (event.type === 'text.delta') {
    appendTextDelta(sessionID, agent, event.delta || '', event.messageId || 'default');
    return;
  }

  if (event.type === 'text.ended') {
    finishText(sessionID, agent, event.text || '', event.messageId || 'default');
    return;
  }

  if (event.type === 'tool.called') {
    addTimelineItem(sessionID, {
      id: nextItemId(),
      kind: 'tool',
      ts: event.created ? new Date(event.created).toISOString() : new Date().toISOString(),
      toolId: event.toolId,
      name: event.detail || 'ferramenta',
      input: event.input ? JSON.stringify(event.input, null, 2) : null,
      content: null,
      status: 'running',
    });
    return;
  }

  if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
    const timeline = state.timelines.get(sessionID) || [];
    const item = [...timeline].reverse().find(
      (entry) => entry.kind === 'tool' && entry.toolId === event.toolId,
    );
    if (item) {
      item.status = event.type === 'session.tool.failed' ? 'error' : 'ok';
      item.content = event.content ? JSON.stringify(event.content, null, 2) : item.content;
      item.error = event.error || null;
      if (state.activeAgentName === agent && state.activitySession === sessionID) {
        renderTimeline(el('activity-timeline'), timeline, { live: true });
      }
    }
    return;
  }

  if (event.type === 'file' || event.type === 'filesystem.changed') {
    addTimelineItem(sessionID, {
      id: nextItemId(),
      kind: 'file',
      ts: new Date().toISOString(),
      file: event.file,
      event: event.event,
    });
    return;
  }

  if (event.type === 'step.ended') {
    for (const file of event.files || []) {
      addTimelineItem(sessionID, {
        id: nextItemId(),
        kind: 'file',
        ts: new Date().toISOString(),
        file,
        event: 'change',
      });
    }
    return;
  }

  if (event.type === 'permission') {
    addTimelineItem(sessionID, {
      id: nextItemId(),
      kind: 'permission',
      ts: new Date().toISOString(),
      request: event.request,
    });
    return;
  }

  if (event.type === 'status') {
    addTimelineItem(sessionID, {
      id: nextItemId(),
      kind: 'status',
      ts: new Date().toISOString(),
      status: event.status,
    });
    return;
  }
}

function replyPermission(request, decision) {
  api.permissions
    .reply({
      sessionID: request.sessionID,
      requestID: request.id,
      decision,
    })
    .then(() => {
      state.permissions = state.permissions.filter((item) => item.id !== request.id);
      renderPermissionBar();
    })
    .catch((error) => toast(error.message || String(error), 'error'));
}

/* ---------- Commands / prompt ---------- */

function renderCommands(agent) {
  const list = el('command-list');
  list.replaceChildren();
  const commands = (state.snapshot?.commands || []).filter((command) => command.group === agent.name);
  el('command-count').textContent = String(commands.length);

  if (commands.length === 0) {
    list.appendChild(create('div', 'command-empty', 'Nenhum comando associado a este agente.'));
    return;
  }

  for (const command of commands) {
    const row = create('div', 'command-row');
    row.dataset.commandName = command.name;

    const copy = create('div', 'command-copy');
    const name = create('div', 'command-name');
    name.appendChild(create('span', 'slash', '/'));
    name.appendChild(create('span', '', command.name));
    if (command.warning) {
      const warning = badge('!', 'warn');
      warning.title = command.warning;
      name.appendChild(warning);
    }
    copy.appendChild(name);
    copy.appendChild(create('div', 'command-desc', command.description || 'Sem descrição.'));
    copy.title = `Executar /${command.name}`;
    copy.style.cursor = 'pointer';

    const args = create('input', 'command-args');
    args.type = 'text';
    args.placeholder = command.argumentHint || 'argumentos (opcional)';
    args.setAttribute('aria-label', `Argumentos para /${command.name}`);

    const run = create('button', 'button primary small', 'Executar');
    run.type = 'button';
    run.addEventListener('click', () => {
      run.disabled = true;
      runCommand(command, args.value)
        .catch((error) => toast(error.message || String(error), 'error'))
        .finally(() => {
          run.disabled = false;
        });
    });
    args.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        run.click();
      }
    });
    copy.addEventListener('click', () => {
      if (!run.disabled) run.click();
    });

    row.append(copy, args, run);
    list.appendChild(row);

    if (state.focusCommand === command.name) {
      state.focusCommand = null;
      setTimeout(() => {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.style.borderColor = 'var(--accent)';
        setTimeout(() => {
          row.style.borderColor = '';
        }, 1400);
      }, 40);
    }
  }
}

async function runCommand(command, args) {
  const agent = command.group === '__general__' ? '__general__' : command.agent || '__general__';
  const resumeSessionId = state.resumeSessionByAgent.get(agent);
  const result = await api.run({
    agent,
    command: command.name,
    args,
    ...(resumeSessionId ? { resumeSessionId } : {}),
  });
  state.activeExecutionByAgent.set(agent, result.executionId);
  if (result.sessionId) {
    state.currentSessionByAgent.set(agent, result.sessionId);
    state.activitySession = result.sessionId;
  }
  renderActivityStatus();
  toast(`Execução iniciada: ${agent} /${command.name}`);
}

async function runPrompt() {
  const agent = state.activeAgentName;
  if (!agent) return;
  const prompt = el('prompt-input').value.trim();
  if (!prompt) {
    toast('Digite um prompt antes de enviar.', 'error');
    return;
  }

  const button = el('run-prompt-button');
  button.disabled = true;
  try {
    const resumeSessionId = state.resumeSessionByAgent.get(agent);
    const result = await api.run({
      agent,
      prompt,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    state.activeExecutionByAgent.set(agent, result.executionId);
    if (result.sessionId) {
      state.currentSessionByAgent.set(agent, result.sessionId);
      state.activitySession = result.sessionId;
    }
    el('prompt-input').value = '';
    renderActivityStatus();
  } catch (error) {
    toast(error.message || String(error), 'error');
  } finally {
    button.disabled = false;
  }
}

/* ---------- Run/live events ---------- */

function handleRunEvent(event) {
  if (!event || !event.executionId) return;
  if (event.type === 'start') {
    state.executions.set(event.executionId, event);
    state.activeExecutionByAgent.set(event.agent, event.executionId);
    if (event.sessionId) {
      state.currentSessionByAgent.set(event.agent, event.sessionId);
      if (state.activeAgentName === event.agent) state.activitySession = event.sessionId;
    }
    setStatus(event.agent, 'running', event.executionId, 'iniciando');
    renderChips();
    loadHistory().catch(() => {});
    if (state.activeAgentName === event.agent) renderActivityStatus();
    return;
  }

  if (event.type === 'exit') {
    state.activeExecutionByAgent.delete(event.agent);
    setStatus(event.agent, event.status === 'done' ? 'done' : 'error', null, statusLabel(event.status));
    state.historyReady = false;
    loadHistory().catch(() => {});
    renderChips();
    if (state.activeAgentName === event.agent) {
      renderActivityStatus();
      renderHistory(agentByName(event.agent));
    }
  }
}

let chipsTimer = null;

function scheduleChips() {
  clearTimeout(chipsTimer);
  chipsTimer = setTimeout(() => renderChips(), 120);
}

function handleLiveUpdate(update) {
  if (!update || !update.agent) return;
  state.live.set(update.agent, update);
  scheduleChips();
  if (state.activeAgentName === update.agent) renderActivityStatus();
}

function setStatus(agent, status, executionId = null, detail = '') {
  state.status.set(agent, { status, executionId, detail });
  state.live.set(agent, { agent, state: status, detail, updatedAt: Date.now() });
}

/* ---------- History ---------- */

async function loadHistory() {
  try {
    state.history = await api.history.list();
    state.historyReady = true;
    if (state.activeAgentName) renderHistory(agentByName(state.activeAgentName));
    if (!el('general-history-modal').classList.contains('hidden')) renderGeneralHistory();
  } catch (error) {
    toast(`Falha ao carregar histórico: ${error.message}`, 'error');
  }
}

function renderHistory(agent) {
  if (!agent) return;
  const list = el('history-list');
  list.replaceChildren();
  const entries = state.history
    .filter((entry) => entry.agent === agent.name)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

  if (entries.length === 0) {
    list.appendChild(create('div', 'command-empty', 'Nenhuma sessão registrada para este agente.'));
    return;
  }

  for (const entry of entries) list.appendChild(historyCard(entry, { general: false }));
}

function historyCard(entry, { general = false } = {}) {
  const card = create('div', 'history-card');
  const copy = create('div');
  const title = create('div', 'history-title');
  title.textContent = `${entry.agent} · ${formatDate(entry.startedAt)}`;
  const meta = create('div', 'history-meta');
  meta.textContent = `${pathBasename(entry.projectDir)} · ${formatDuration(entry.startedAt, entry.endedAt)} · ${entry.actions || 0} ações · ${entry.files?.length || 0} arquivos`;
  const summary = create('div', 'history-summary', entry.summary || entry.prompt || 'Sem resumo.');
  copy.append(title, meta, summary);

  const actions = create('div', 'history-actions');
  const status = create('span', `status-pill ${entry.status}`, statusLabel(entry.status));
  actions.appendChild(status);

  const open = create('button', 'button ghost small', 'Abrir');
  open.type = 'button';
  open.addEventListener('click', () => openReplay(entry, general));
  actions.appendChild(open);

  if (entry.id && !entry.id.startsWith('local_')) {
    const resume = create('button', 'button ghost small', 'Retomar');
    resume.type = 'button';
    resume.addEventListener('click', () => resumeHistory(entry));
    actions.appendChild(resume);
  }

  const exportButton = create('button', 'button ghost small', 'Exportar MD');
  exportButton.type = 'button';
  exportButton.addEventListener('click', () =>
    api.history
      .export(entry.id)
      .then((result) => {
        if (result && result.path) toast(`Exportado para ${result.path}`);
      })
      .catch((error) => toast(error.message, 'error')),
  );
  actions.appendChild(exportButton);

  const copyButton = create('button', 'button ghost small', 'Copiar');
  copyButton.type = 'button';
  copyButton.addEventListener('click', () =>
    api.history
      .copy(entry.id)
      .then(() => toast('Histórico copiado.'))
      .catch((error) => toast(error.message, 'error')),
  );
  actions.appendChild(copyButton);

  const deleteButton = create('button', 'button danger small', 'Apagar');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', async () => {
    if (!window.confirm(`Apagar o histórico da sessão ${entry.id}?`)) return;
    try {
      await api.history.remove(entry.id);
      await loadHistory();
      if (general) renderGeneralHistory();
      toast('Histórico apagado.');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  actions.appendChild(deleteButton);

  card.append(copy, actions);
  return card;
}

function pathBasename(value) {
  if (!value) return '—';
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

async function openReplay(entry, general = false) {
  try {
    const data = await api.history.read(entry.id);
    if (data.warning) toast(data.warning, 'error');
    const items = historyEventsToItems(data.events || []);

    if (general) {
      state.generalReplaySession = entry.id;
      el('gh-replay').classList.remove('hidden');
      el('gh-replay-title').textContent = `${entry.agent} · ${formatDate(entry.startedAt)}`;
      renderTimeline(el('gh-timeline'), items);
      return;
    }

    state.replaySession = entry.id;
    el('history-replay').classList.remove('hidden');
    el('replay-title').textContent = `${entry.agent} · ${formatDate(entry.startedAt)}`;
    renderTimeline(el('replay-timeline'), items);
    el('replay-resume').onclick = () => resumeHistory(entry);
    el('replay-export').onclick = () =>
      api.history.export(entry.id).then((result) => {
        if (result && result.path) toast(`Exportado para ${result.path}`);
      });
    el('replay-copy').onclick = () =>
      api.history.copy(entry.id).then(() => toast('Histórico copiado.'));
    el('replay-delete').onclick = async () => {
      if (!window.confirm(`Apagar o histórico da sessão ${entry.id}?`)) return;
      await api.history.remove(entry.id);
      await loadHistory();
      el('history-replay').classList.add('hidden');
    };
  } catch (error) {
    toast(`Falha ao ler histórico: ${error.message}`, 'error');
  }
}

function resumeHistory(entry) {
  if (!entry || String(entry.id).startsWith('local_')) {
    toast('Sessão local (fallback) não pode ser retomada pelo servidor.', 'error');
    return;
  }
  state.resumeSessionByAgent.set(entry.agent, entry.id);
  state.currentSessionByAgent.set(entry.agent, entry.id);
  state.activitySession = entry.id;
  state.activeTab = 'activity';
  if (state.activeAgentName !== entry.agent) openAgent(entry.agent);
  else {
    renderTabs();
    loadActivityForAgent(entry.agent);
  }
  renderActivityStatus();
  toast(`Sessão ${entry.id} será retomada no próximo prompt.`);
}

/* ---------- Histórico geral ---------- */

function openGeneralHistory() {
  el('general-history-modal').classList.remove('hidden');
  populateGeneralFilters();
  renderGeneralHistory();
}

function populateGeneralFilters() {
  const agents = [...new Set(state.history.map((entry) => entry.agent))].sort();
  const projects = [...new Set(state.history.map((entry) => entry.projectDir))].sort();
  fillSelect(el('gh-agent'), 'Todos', agents, (item) => item);
  fillSelect(el('gh-project'), 'Todos', projects, (item) => pathBasename(item));
}

function fillSelect(select, placeholder, values, label) {
  const current = select.value;
  select.replaceChildren();
  const all = create('option', '', placeholder);
  all.value = '';
  select.appendChild(all);
  for (const value of values) {
    const option = create('option', '', label(value));
    option.value = value;
    select.appendChild(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function filteredHistory() {
  const agent = el('gh-agent').value;
  const project = el('gh-project').value;
  const status = el('gh-status').value;
  const period = el('gh-period').value;
  const search = el('gh-search').value.trim().toLowerCase();
  const cutoff =
    period === 'all' ? 0 : Date.now() - Number(period) * 24 * 60 * 60 * 1000;

  return state.history.filter((entry) => {
    if (agent && entry.agent !== agent) return false;
    if (project && entry.projectDir !== project) return false;
    if (status && entry.status !== status) return false;
    const timestamp = new Date(entry.startedAt).getTime();
    if (cutoff && (!Number.isFinite(timestamp) || timestamp < cutoff)) return false;
    if (search) {
      const haystack = [
        entry.agent,
        entry.projectDir,
        entry.summary,
        entry.prompt,
        ...(entry.files || []),
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function renderGeneralHistory() {
  const list = el('gh-list');
  list.replaceChildren();
  const entries = filteredHistory();

  if (entries.length === 0) {
    list.appendChild(create('div', 'command-empty', 'Nenhuma sessão encontrada com esses filtros.'));
    return;
  }

  for (const entry of entries) list.appendChild(historyCard(entry, { general: true }));
}

async function showGeneralTimeline() {
  const entries = filteredHistory().slice(0, 60);
  const items = [];

  for (const entry of entries) {
    try {
      const data = await api.history.read(entry.id);
      const entryItems = historyEventsToItems(data.events || []);
      for (const item of entryItems) {
        item.agent = entry.agent;
        item.sessionId = entry.id;
        items.push(item);
      }
    } catch {
      // ignora sessões ilegíveis no consolidado
    }
  }

  items.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  el('gh-replay').classList.remove('hidden');
  el('gh-replay-title').textContent = `Linha do tempo unificada · ${items.length} eventos`;
  renderTimeline(el('gh-timeline'), items);
}

/* ---------- Meeting ---------- */

function renderMeeting(agent) {
  if (!agent) return;
  const draft = state.meetingDraft;
  const live = state.meeting;

  el('meeting-setup').classList.toggle('hidden', Boolean(live));
  el('meeting-live').classList.toggle('hidden', !live);

  if (!live) {
    el('meeting-host').textContent = `Anfitrião: ${agent.name}`;
    el('meeting-agenda').value = draft.agenda || '';
    el('meeting-mode').value = draft.mode;
    el('meeting-order').value = draft.order;
    el('meeting-rounds').value = draft.maxRounds;
    el('meeting-stop').value = draft.stopCriterion;
    populateMeetingProjects();
    renderMeetingParticipants();
    renderParticipantOptions();
    renderMeetingWarning();
    loadTemplates();
  }

  if (live) renderMeetingLive(live);
}

function populateMeetingProjects() {
  const select = el('meeting-project');
  const current = state.meetingDraft.projectDir || state.snapshot?.projectDir || '';
  const projects = [...new Set([state.snapshot?.projectDir, ...state.history.map((entry) => entry.projectDir)])]
    .filter(Boolean)
    .sort();
  select.replaceChildren();
  for (const project of projects) {
    const option = create('option', '', project);
    option.value = project;
    select.appendChild(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
  else if (projects.length > 0) select.value = projects[0];
}

function renderMeetingParticipants() {
  const container = el('meeting-participants');
  container.replaceChildren();
  const draft = state.meetingDraft;

  for (const name of draft.participants) {
    const chip = create('div', 'chip');
    const copy = create('div', 'chip-copy');
    const nameRow = create('div', 'chip-name');
    nameRow.appendChild(create('span', '', name));
    copy.appendChild(nameRow);
    const remove = create('button', 'chip-remove', '×');
    remove.type = 'button';
    remove.title = 'Remover participante';
    remove.addEventListener('click', () => {
      draft.participants = draft.participants.filter((item) => item !== name);
      renderMeetingParticipants();
      renderParticipantOptions();
      renderMeetingWarning();
    });
    chip.append(copy, remove);
    container.appendChild(chip);
  }

  if (draft.participants.length === 0) {
    container.appendChild(create('span', 'muted', 'Nenhum participante adicionado.'));
  }
}

function renderParticipantOptions() {
  const container = el('meeting-participant-options');
  const search = el('meeting-participant-search').value.trim().toLowerCase();
  const draft = state.meetingDraft;
  container.replaceChildren();

  const candidates = visibleAgents().filter(
    (agent) =>
      agent.name !== draft.host &&
      !draft.participants.includes(agent.name) &&
      (!search || agent.name.toLowerCase().includes(search) || (agent.description || '').toLowerCase().includes(search)),
  );

  for (const agent of candidates) {
    const button = create('button', 'participant-option', `${agent.name} · ${modeLabel(agent.mode)}`);
    button.type = 'button';
    button.addEventListener('click', () => {
      if (draft.participants.length + 2 > (state.settings?.meeting?.maxAgents || 4)) {
        toast('Limite de agentes da reunião atingido.', 'error');
        return;
      }
      draft.participants.push(agent.name);
      renderMeetingParticipants();
      renderParticipantOptions();
      renderMeetingWarning();
    });
    container.appendChild(button);
  }

  if (candidates.length === 0) {
    container.appendChild(create('span', 'muted', 'Nenhum agente disponível.'));
  }
}

function renderMeetingWarning() {
  const draft = state.meetingDraft;
  const warning = el('meeting-warning');
  warning.classList.add('hidden');

  if (draft.mode === 'delegation') {
    const primary = draft.participants.filter(
      (name) => agentByName(name)?.mode === 'primary',
    );
    if (primary.length > 0) {
      warning.textContent = `Participantes primary não podem ser delegados: ${primary.join(', ')}. Use a mesa-redonda.`;
      warning.classList.remove('hidden');
      return;
    }
  }

  if (draft.participants.length + 2 > (state.settings?.meeting?.maxAgents || 4)) {
    warning.textContent = 'Limite de agentes simultâneos atingido.';
    warning.classList.remove('hidden');
  }
}

async function startMeeting() {
  const draft = state.meetingDraft;
  const payload = {
    host: draft.host,
    participants: draft.participants,
    agenda: el('meeting-agenda').value.trim(),
    projectDir: el('meeting-project').value,
    mode: el('meeting-mode').value,
    order: el('meeting-order').value,
    maxRounds: Number(el('meeting-rounds').value) || 3,
    stopCriterion: el('meeting-stop').value,
  };

  const button = el('meeting-start');
  button.disabled = true;
  try {
    const result = await api.meeting.start(payload);
    state.meeting = result;
    renderMeeting(agentByName(draft.host));
    toast('Reunião iniciada.');
  } catch (error) {
    const message = error.message || String(error);
    toast(message, 'error');
    if (/primary|mesa-redonda|deleg/i.test(message)) {
      el('meeting-mode').value = 'roundtable';
      state.meetingDraft.mode = 'roundtable';
      renderMeetingWarning();
    }
  } finally {
    button.disabled = false;
  }
}

function renderMeetingLive(meeting) {
  el('meeting-status').textContent = `${meeting.status} · rodada ${meeting.round || 0}/${meeting.maxRounds} · ${meeting.mode}`;
  el('meeting-status').style.color =
    meeting.status === 'error'
      ? 'var(--red)'
      : meeting.status === 'done'
        ? 'var(--green)'
        : 'var(--accent-text)';
  el('meeting-current').textContent = meeting.currentAgent
    ? `Falando agora: ${meeting.currentAgent}`
    : meeting.status === 'done'
      ? 'Reunião concluída.'
      : 'Aguardando turno…';

  const meetingWarnings = el('meeting-warnings');
  const warnings = meeting.warnings || [];
  if (warnings.length > 0) {
    meetingWarnings.textContent = warnings.slice(-4).join(' · ');
    meetingWarnings.classList.remove('hidden');
  } else {
    meetingWarnings.classList.add('hidden');
  }
  el('meeting-pause').classList.toggle('hidden', meeting.paused || meeting.status !== 'running');
  el('meeting-resume').classList.toggle('hidden', !meeting.paused);
  el('meeting-skip').disabled = !meeting.currentAgent;
  el('meeting-new').classList.toggle(
    'hidden',
    !['done', 'error'].includes(meeting.status),
  );

  const participants = el('meeting-participants-live');
  participants.replaceChildren();
  for (const name of [meeting.host, ...meeting.participants]) {
    const chip = create('div', 'chip');
    const copy = create('div', 'chip-copy');
    const nameRow = create('div', 'chip-name');
    nameRow.appendChild(create('span', '', name));
    copy.appendChild(nameRow);
    const remove = create('button', 'chip-remove', '×');
    remove.type = 'button';
    remove.title = 'Remover';
    remove.disabled = name === meeting.host || meeting.status === 'done';
    remove.addEventListener('click', () => {
      api.meeting
        .remove(name)
        .then((next) => {
          state.meeting = next;
          renderMeetingLive(next);
        })
        .catch((error) => toast(error.message, 'error'));
    });
    chip.append(copy, remove);
    participants.appendChild(chip);
  }

  const addSelect = el('meeting-live-add');
  addSelect.replaceChildren();
  const available = visibleAgents().filter(
    (agent) => agent.name !== meeting.host && !meeting.participants.includes(agent.name),
  );
  for (const agent of available) {
    const option = create('option', '', agent.name);
    option.value = agent.name;
    addSelect.appendChild(option);
  }
  el('meeting-live-add-button').disabled = available.length === 0;

  const chat = el('meeting-chat');
  chat.replaceChildren();
  for (const item of meeting.chat || []) chat.appendChild(chatMessage(item));

  const files = el('meeting-files');
  files.replaceChildren();
  for (const file of meeting.files || []) {
    const chip = create('button', 'file-chip', file);
    chip.type = 'button';
    chip.addEventListener('click', () => openFile(file));
    files.appendChild(chip);
  }

  const ata = el('meeting-ata');
  ata.replaceChildren();
  if (meeting.ataPath) {
    const button = create('button', 'button ghost small', 'Abrir ata');
    button.type = 'button';
    button.addEventListener('click', () => openFile(meeting.ataPath));
    ata.append(button, create('span', 'muted', ` ${meeting.ataPath}`));
  }

  chat.scrollTop = chat.scrollHeight;
}

function chatMessage(item) {
  const node = create('div', `chat-message ${item.role === 'moderator' ? 'moderator' : item.role === 'system' ? 'system' : ''}`.trim());
  const head = create('div', 'chat-head');
  const avatar = create('div', 'chat-avatar', initials(item.agent));
  const agent = create('span', 'chat-agent', item.agent || 'Sistema');
  const agentInfo = agentByName(item.agent);
  if (agentInfo?.color) avatar.style.background = agentInfo.color;
  head.append(avatar, agent, create('span', '', formatTime(item.ts)));
  const text = create(
    'div',
    item.role === 'tool' ? 'chat-tool' : 'chat-text',
    item.role === 'tool'
      ? `${item.name || 'ferramenta'} · ${item.status || ''} ${item.detail || ''}`.trim()
      : item.text || '',
  );
  node.append(head, text);
  return node;
}

async function loadTemplates() {
  try {
    state.templates = await api.meeting.templates();
    const select = el('meeting-template-select');
    select.replaceChildren();
    const empty = create('option', '', '—');
    empty.value = '';
    select.appendChild(empty);
    for (const template of state.templates) {
      const option = create('option', '', template.name);
      option.value = template.id;
      select.appendChild(option);
    }
  } catch {
    // silencioso
  }
}

function loadTemplate(id) {
  const template = state.templates.find((item) => item.id === id);
  if (!template) return;
  state.meetingDraft = {
    host: template.host || state.meetingDraft.host,
    participants: [...(template.participants || [])],
    agenda: template.agenda || '',
    projectDir: template.projectDir || state.meetingDraft.projectDir,
    mode: template.mode || 'roundtable',
    order: template.order || 'fixed',
    maxRounds: template.maxRounds || 3,
    stopCriterion: template.stopCriterion || 'host',
  };
  renderMeeting(agentByName(state.meetingDraft.host));
}

/* ---------- General UI ---------- */

function renderPermissionBar() {
  const bar = el('permission-bar');
  const request = state.permissions[0];
  if (!request) {
    bar.classList.add('hidden');
    return;
  }
  bar.replaceChildren();
  const text = create(
    'span',
    '',
    `${request.agent || 'Agente'} pede permissão: ${request.action || ''} ${(request.resources || []).join(', ')}`,
  );
  const actions = create('div', 'inline');
  for (const [label, decision] of [
    ['Permitir uma vez', 'once'],
    ['Sempre', 'always'],
    ['Rejeitar', 'reject'],
  ]) {
    const button = create('button', 'button ghost small', label);
    button.type = 'button';
    button.addEventListener('click', () => replyPermission(request, decision));
    actions.appendChild(button);
  }
  bar.append(text, actions);
  bar.classList.remove('hidden');
}

function openFile(file) {
  api.files
    .open(file)
    .catch((error) => toast(error.message || String(error), 'error'));
}

/* ---------- Search ---------- */

function openSearch() {
  el('search-overlay').classList.remove('hidden');
  const input = el('search-input');
  input.value = '';
  renderSearch('');
  setTimeout(() => input.focus(), 20);
}

function closeSearch() {
  el('search-overlay').classList.add('hidden');
}

function searchData(term) {
  const query = term.trim().toLowerCase();
  const agents = visibleAgents().filter((agent) => {
    if (!query) return true;
    return (
      agent.name.toLowerCase().includes(query) ||
      (agent.description || '').toLowerCase().includes(query) ||
      (agent.model || '').toLowerCase().includes(query)
    );
  });

  const commands = (state.snapshot?.commands || []).filter((command) => {
    if (!query) return true;
    return (
      command.name.toLowerCase().includes(query) ||
      (command.description || '').toLowerCase().includes(query) ||
      (command.agent || 'geral').toLowerCase().includes(query)
    );
  });

  const results = [];
  for (const agent of agents) results.push({ type: 'agent', agent });
  for (const command of commands) results.push({ type: 'command', command });
  return { agents, commands, results };
}

function renderSearch(term) {
  const { agents, commands, results } = searchData(term);
  state.searchResults = results;
  state.searchIndex = 0;

  const container = el('search-results');
  container.replaceChildren();

  if (agents.length > 0) {
    container.appendChild(create('div', 'search-group-title', 'Agentes'));
    for (const agent of agents) {
      container.appendChild(
        searchItem({
          icon: agent.icon || initials(agent.name),
          color: agent.color,
          name: agent.name,
          sub: `${originLabel(agent.origin)} · ${modeLabel(agent.mode)} · ${agent.description || 'sem descrição'}`,
          onSelect: () => {
            closeSearch();
            openAgent(agent.name);
          },
        }),
      );
    }
  }

  if (commands.length > 0) {
    container.appendChild(create('div', 'search-group-title', 'Comandos'));
    for (const command of commands) {
      const agentName = command.group === '__general__' ? 'Geral' : command.agent || 'Geral';
      container.appendChild(
        searchItem({
          icon: '/',
          name: `/${command.name}`,
          sub: `${agentName} · ${command.description || 'sem descrição'}`,
          onSelect: () => {
            closeSearch();
            openAgent(command.group);
            state.focusCommand = command.name;
            renderModal();
          },
        }),
      );
    }
  }

  if (results.length === 0) {
    container.appendChild(create('div', 'command-empty', 'Nada encontrado.'));
  }
}

function searchItem({ icon, color, name, sub, onSelect }) {
  const button = create('button', 'search-item');
  button.type = 'button';
  const iconNode = create('div', 'agent-icon', icon);
  if (color) {
    iconNode.style.color = color;
    iconNode.style.borderColor = color;
  }
  const copy = create('div', 'search-item-copy');
  copy.append(create('div', 'search-item-name', name), create('div', 'search-item-sub', sub));
  button.append(iconNode, copy);
  button.addEventListener('click', onSelect);
  return button;
}

function handleSearchKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSearch();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
  event.preventDefault();

  const items = Array.from(el('search-results').querySelectorAll('.search-item'));
  if (items.length === 0) return;

  if (event.key === 'ArrowDown') state.searchIndex = (state.searchIndex + 1) % items.length;
  else if (event.key === 'ArrowUp') state.searchIndex = (state.searchIndex - 1 + items.length) % items.length;
  else {
    items[state.searchIndex].click();
    return;
  }

  items.forEach((item, index) => item.classList.toggle('active', index === state.searchIndex));
  items[state.searchIndex].scrollIntoView({ block: 'nearest' });
}

/* ---------- Init / events ---------- */

async function refresh() {
  const button = el('reload-button');
  button.disabled = true;
  button.textContent = 'Recarregando…';
  try {
    state.snapshot = await api.refresh();
    renderChips();
    if (state.activeAgentName) renderModalHeader();
  } catch (error) {
    toast(`Falha ao recarregar: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Recarregar';
  }
}

function bindUi() {
  el('reload-button').addEventListener('click', refresh);
  el('search-button').addEventListener('click', openSearch);
  el('history-button').addEventListener('click', openGeneralHistory);
  el('run-prompt-button').addEventListener('click', runPrompt);
  el('activity-stop').addEventListener('click', async () => {
    const agent = state.activeAgentName;
    const executionId = state.activeExecutionByAgent.get(agent);
    if (!executionId) return;
    try {
      const result = await api.cancel(executionId);
      if (!result.ok) toast(result.message || 'Não foi possível parar.', 'error');
    } catch (error) {
      toast(error.message || String(error), 'error');
    }
  });
  el('activity-new-session').addEventListener('click', () => {
    if (!state.activeAgentName) return;
    state.resumeSessionByAgent.delete(state.activeAgentName);
    renderActivityStatus();
  });
  el('history-refresh').addEventListener('click', () => loadHistory().catch(() => {}));

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  document.querySelectorAll('[data-close-modal]').forEach((node) => {
    node.addEventListener('click', closeModal);
  });
  document.querySelectorAll('[data-close-search]').forEach((node) => {
    node.addEventListener('click', closeSearch);
  });
  document.querySelectorAll('[data-close-general-history]').forEach((node) => {
    node.addEventListener('click', () => el('general-history-modal').classList.add('hidden'));
  });

  el('meeting-participant-search').addEventListener('input', renderParticipantOptions);
  el('meeting-agenda').addEventListener('input', (event) => {
    state.meetingDraft.agenda = event.target.value;
  });
  el('meeting-project').addEventListener('change', (event) => {
    state.meetingDraft.projectDir = event.target.value;
  });
  el('meeting-order').addEventListener('change', (event) => {
    state.meetingDraft.order = event.target.value;
  });
  el('meeting-rounds').addEventListener('change', (event) => {
    state.meetingDraft.maxRounds = Number(event.target.value) || 3;
  });
  el('meeting-stop').addEventListener('change', (event) => {
    state.meetingDraft.stopCriterion = event.target.value;
  });
  el('meeting-mode').addEventListener('change', (event) => {
    state.meetingDraft.mode = event.target.value;
    renderMeetingWarning();
  });
  el('meeting-new').addEventListener('click', () => {
    state.meeting = null;
    renderMeeting(agentByName(state.activeAgentName));
  });
  el('meeting-start').addEventListener('click', startMeeting);
  el('meeting-pause').addEventListener('click', () =>
    api.meeting.pause().then((stateValue) => {
      state.meeting = stateValue;
      renderMeetingLive(stateValue);
    }),
  );
  el('meeting-resume').addEventListener('click', () =>
    api.meeting.resume().then((stateValue) => {
      state.meeting = stateValue;
      renderMeetingLive(stateValue);
    }),
  );
  el('meeting-skip').addEventListener('click', () =>
    api.meeting.skip().then((stateValue) => {
      state.meeting = stateValue;
      renderMeetingLive(stateValue);
    }),
  );
  el('meeting-stop-button').addEventListener('click', () =>
    api.meeting.stop().then((stateValue) => {
      state.meeting = stateValue;
      renderMeetingLive(stateValue);
      loadHistory().catch(() => {});
    }),
  );
  el('meeting-moderator-send').addEventListener('click', () => {
    const input = el('meeting-moderator');
    const text = input.value.trim();
    if (!text) return;
    api.meeting
      .moderator(text)
      .then((stateValue) => {
        state.meeting = stateValue;
        input.value = '';
        renderMeetingLive(stateValue);
      })
      .catch((error) => toast(error.message, 'error'));
  });
  el('meeting-live-add-button').addEventListener('click', () => {
    const name = el('meeting-live-add').value;
    if (!name) return;
    api.meeting
      .add(name)
      .then((stateValue) => {
        state.meeting = stateValue;
        renderMeetingLive(stateValue);
      })
      .catch((error) => toast(error.message, 'error'));
  });
  el('meeting-template-save').addEventListener('click', () => {
    const name = el('meeting-template-name').value.trim();
    if (!name) {
      toast('Dê um nome ao modelo.', 'error');
      return;
    }
    api.meeting
      .saveTemplate({
        name,
        host: state.meetingDraft.host,
        participants: state.meetingDraft.participants,
        agenda: el('meeting-agenda').value,
        mode: el('meeting-mode').value,
        order: el('meeting-order').value,
        maxRounds: Number(el('meeting-rounds').value) || 3,
        stopCriterion: el('meeting-stop').value,
        projectDir: el('meeting-project').value,
      })
      .then(() => loadTemplates())
      .then(() => toast('Modelo salvo.'))
      .catch((error) => toast(error.message, 'error'));
  });
  el('meeting-template-load').addEventListener('click', () => {
    const id = el('meeting-template-select').value;
    if (id) loadTemplate(id);
  });
  el('meeting-template-delete').addEventListener('click', () => {
    const id = el('meeting-template-select').value;
    if (!id) return;
    api.meeting
      .deleteTemplate(id)
      .then(() => loadTemplates())
      .catch((error) => toast(error.message, 'error'));
  });

  el('gh-agent').addEventListener('change', renderGeneralHistory);
  el('gh-project').addEventListener('change', renderGeneralHistory);
  el('gh-status').addEventListener('change', renderGeneralHistory);
  el('gh-period').addEventListener('change', renderGeneralHistory);
  el('gh-search').addEventListener('input', renderGeneralHistory);
  el('gh-timeline-button').addEventListener('click', () => {
    showGeneralTimeline().catch((error) => toast(error.message, 'error'));
  });

  el('prompt-input').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      runPrompt();
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (el('search-overlay').classList.contains('hidden')) openSearch();
      else closeSearch();
      return;
    }
    if (event.key === 'Escape') {
      if (!el('search-overlay').classList.contains('hidden')) closeSearch();
      else if (!el('agent-modal').classList.contains('hidden')) closeModal();
      else el('general-history-modal').classList.add('hidden');
    }
  });

  el('search-input').addEventListener('input', (event) => renderSearch(event.target.value));
  el('search-input').addEventListener('keydown', handleSearchKey);
}

function wireApiEvents() {
  api.onAgentsUpdated((snapshot) => {
    state.snapshot = snapshot;
    if (snapshot.server) state.server = snapshot.server;
    renderChips();
    if (state.activeAgentName) renderModalHeader();
  });

  api.onRunEvent(handleRunEvent);
  api.onActivityEvent(handleActivityEvent);
  api.onLiveUpdate(handleLiveUpdate);

  api.onServerStatus((status) => {
    state.server = status;
    renderServerStatus();
  });

  api.onHistoryUpdated((list) => {
    state.history = list;
    if (state.activeAgentName) renderHistory(agentByName(state.activeAgentName));
    if (!el('general-history-modal').classList.contains('hidden')) renderGeneralHistory();
  });

  api.onPermissionAsked((request) => {
    state.permissions.push(request);
    renderPermissionBar();
  });
  api.onPermissionReplied((reply) => {
    state.permissions = state.permissions.filter((item) => item.id !== reply.requestID);
    renderPermissionBar();
  });

  api.onMeetingEvent((event) => {
    if (!event) return;
    if (event.type === 'state' && event.state) {
      state.meeting = event.state;
      if (state.activeAgentName) renderMeeting(agentByName(state.activeAgentName));
      return;
    }
    if (event.type === 'text-delta') {
      const chat = el('meeting-chat');
      let node = chat.querySelector(`[data-streaming-agent="${event.agent}"] .chat-text`);
      if (!node) {
        const wrapper = create('div', 'chat-message');
        wrapper.dataset.streamingAgent = event.agent;
        const head = create('div', 'chat-head');
        head.append(
          create('div', 'chat-avatar', initials(event.agent)),
          create('span', 'chat-agent', event.agent),
          create('span', '', 'ao vivo'),
        );
        const text = create('div', 'chat-text', '');
        wrapper.append(head, text);
        chat.appendChild(wrapper);
        node = text;
      }
      node.textContent += event.delta || '';
      chat.scrollTop = chat.scrollHeight;
      return;
    }
    if (event.type === 'file' && state.meeting) {
      if (!state.meeting.files.includes(event.file)) state.meeting.files.push(event.file);
      renderMeetingLive(state.meeting);
      return;
    }
    if (event.type === 'finished') {
      state.meeting = event.state;
      loadHistory().catch(() => {});
      toast('Reunião concluída.');
      if (state.activeAgentName) renderMeeting(agentByName(state.activeAgentName));
    }
  });
}

async function init() {
  loadFavorites();
  bindUi();

  if (!api) {
    el('warning-banner').textContent =
      'A ponte segura do Electron (preload) não foi carregada. Abra via "npm start".';
    el('warning-banner').classList.remove('hidden');
    return;
  }

  wireApiEvents();

  try {
    const [snapshot, history, settings, templates] = await Promise.all([
      api.discover(),
      api.history.list().catch(() => []),
      api.settings.get().catch(() => null),
      api.meeting.templates().catch(() => []),
    ]);
    state.snapshot = snapshot;
    state.history = history || [];
    state.settings = settings?.values || null;
    state.templates = templates || [];
    if (snapshot.server) state.server = snapshot.server;
    if (state.settings?.meeting?.maxRounds) {
      state.meetingDraft.maxRounds = state.settings.meeting.maxRounds;
    }
    renderChips();
    await loadTemplates();
  } catch (error) {
    toast(`Falha na descoberta: ${error.message}`, 'error');
    el('warning-banner').textContent = `Falha na descoberta: ${error.message}`;
    el('warning-banner').classList.remove('hidden');
  }
}

init();
