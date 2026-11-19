'use strict';

const fs = require('node:fs');
const path = require('node:path');

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function truncate(value, max = 4000) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n… (truncado)` : text;
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function formatDuration(startedAt, endedAt) {
  if (!startedAt) return '—';
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

class HistoryStore {
  constructor({ dir, retentionDays = 90, maxSessionBytes = 5 * 1024 * 1024 }) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    this.retentionDays = retentionDays;
    this.maxSessionBytes = maxSessionBytes;
    this.entries = [];
    this.byId = new Map();
    this.saveTimer = null;
    this.initialized = false;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    let raw = null;
    try {
      raw = fs.readFileSync(this.indexFile, 'utf8');
    } catch {
      raw = null;
    }

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : parsed.sessions;
        this.entries = Array.isArray(list) ? list : [];
      } catch {
        this.entries = [];
      }
    }

    this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    this.prune();
    this.initialized = true;
    this.saveIndexNow();
  }

  fileFor(sessionID) {
    return path.join(this.dir, `${String(sessionID).replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`);
  }

  ensureSession({
    id,
    agent,
    projectDir,
    title = '',
    prompt = '',
    command = null,
    meetingId = null,
    parentId = null,
    startedAt = null,
  }) {
    if (!id) return null;
    const existing = this.byId.get(id);
    if (existing) {
      if (agent && (!existing.agent || existing.agent === 'subagente')) {
        existing.agent = agent;
      }
      if (projectDir && !existing.projectDir) existing.projectDir = projectDir;
      if (meetingId && !existing.meetingId) existing.meetingId = meetingId;
      if (parentId && !existing.parentId) existing.parentId = parentId;
      return existing;
    }

    const entry = {
      id,
      agent: agent || 'desconhecido',
      projectDir: projectDir || '',
      title: title || `${agent || 'Agente'} · ${new Date().toISOString()}`,
      startedAt: startedAt || new Date().toISOString(),
      endedAt: null,
      status: 'running',
      actions: 0,
      files: [],
      summary: '',
      prompt: truncate(prompt, 2000),
      command: command || null,
      meetingId: meetingId || null,
      parentId: parentId || null,
      size: 0,
      truncated: false,
    };

    this.entries.unshift(entry);
    this.byId.set(id, entry);
    this.appendLine(id, {
      ts: new Date().toISOString(),
      type: 'session.start',
      agent: entry.agent,
      projectDir: entry.projectDir,
      title: entry.title,
      prompt: entry.prompt,
      command: entry.command,
      meetingId: entry.meetingId,
      parentId: entry.parentId,
    });
    this.scheduleIndexSave();
    return entry;
  }

  appendLine(sessionID, payload) {
    const entry = this.byId.get(sessionID);
    if (!entry || entry.truncated) return false;

    const line = `${safeJson(payload)}\n`;
    const bytes = Buffer.byteLength(line);
    if (entry.size + bytes > this.maxSessionBytes) {
      entry.truncated = true;
      const marker = `${safeJson({
        ts: new Date().toISOString(),
        type: 'truncated',
        message: 'Limite de tamanho da sessão atingido.',
        maxSessionBytes: this.maxSessionBytes,
      })}\n`;
      try {
        fs.appendFileSync(this.fileFor(sessionID), marker);
      } catch {
        // ignore
      }
      this.scheduleIndexSave();
      return false;
    }

    try {
      fs.appendFileSync(this.fileFor(sessionID), line);
      entry.size += bytes;
      return true;
    } catch {
      return false;
    }
  }

  recordPrompt(sessionID, text) {
    const entry = this.byId.get(sessionID);
    if (!entry) return;
    entry.prompt = truncate(text, 2000);
    this.appendLine(sessionID, {
      ts: new Date().toISOString(),
      type: 'prompt',
      text: truncate(text, 8000),
    });
    this.scheduleIndexSave();
  }

  recordText(sessionID, text, meta = {}) {
    const entry = this.byId.get(sessionID);
    if (!entry || !text) return;
    entry.summary = truncate(text.replace(/\s+/g, ' ').trim(), 280);
    this.appendLine(sessionID, {
      ts: new Date().toISOString(),
      type: 'text',
      text: truncate(text, 12_000),
      messageId: meta.messageId || null,
    });
    this.scheduleIndexSave();
  }

  recordTool(sessionID, { phase, toolId, name, input, content, status, error }) {
    const entry = this.byId.get(sessionID);
    if (!entry) return;
    if (phase === 'called') entry.actions += 1;
    this.appendLine(sessionID, {
      ts: new Date().toISOString(),
      type: 'tool',
      phase,
      toolId,
      name: name || 'ferramenta',
      input: input ? truncate(safeJson(input), 4000) : null,
      content: content ? truncate(safeJson(content), 4000) : null,
      status: status || null,
      error: error ? truncate(error, 2000) : null,
    });
    this.scheduleIndexSave();
  }

  recordFile(sessionID, file, event = 'change') {
    const entry = this.byId.get(sessionID);
    if (!entry || !file) return;
    if (!entry.files.includes(file)) entry.files.push(file);
    this.appendLine(sessionID, {
      ts: new Date().toISOString(),
      type: 'file',
      file,
      event,
    });
    this.scheduleIndexSave();
  }

  recordPermission(sessionID, request) {
    const entry = this.byId.get(sessionID);
    if (!entry) return;
    this.appendLine(sessionID, {
      ts: new Date().toISOString(),
      type: 'permission',
      request,
    });
    this.scheduleIndexSave();
  }

  recordError(sessionID, error) {
    const entry = this.byId.get(sessionID);
    if (!entry) return;
    this.appendLine(sessionID, {
      ts: new Date().toISOString(),
      type: 'error',
      error: truncate(error, 2000),
    });
    this.scheduleIndexSave();
  }

  recordStatus(sessionID, status, detail = '') {
    const entry = this.byId.get(sessionID);
    if (!entry) return;
    entry.status = status;
    if (status === 'running') entry.endedAt = null;
    this.appendLine(sessionID, {
      ts: new Date().toISOString(),
      type: 'status',
      status,
      detail,
    });
    this.scheduleIndexSave();
  }

  endSession(sessionID, { status = 'succeeded', summary = null } = {}) {
    const entry = this.byId.get(sessionID);
    if (!entry) return;
    entry.endedAt = entry.endedAt || new Date().toISOString();
    entry.status = status;
    if (summary) entry.summary = truncate(summary.replace(/\s+/g, ' ').trim(), 280);
    this.appendLine(sessionID, {
      ts: entry.endedAt,
      type: 'session.end',
      status,
    });
    this.scheduleIndexSave();
  }

  updateSession(sessionID, patch) {
    const entry = this.byId.get(sessionID);
    if (!entry) return;
    Object.assign(entry, patch);
    this.scheduleIndexSave();
  }

  scheduleIndexSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveIndexNow(), 500);
    this.saveTimer.unref?.();
  }

  saveIndexNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = `${this.indexFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, sessions: this.entries }, null, 2));
    fs.renameSync(temp, this.indexFile);
  }

  flush() {
    if (this.saveTimer) this.saveIndexNow();
  }

  list() {
    return this.entries
      .map((entry) => ({ ...entry }))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  read(sessionID) {
    const entry = this.byId.get(sessionID);
    const file = this.fileFor(sessionID);
    const events = [];
    let warning = null;

    try {
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          warning = 'Uma ou mais linhas do histórico estão corrompidas.';
        }
      }
    } catch {
      warning = 'Arquivo de histórico não encontrado.';
    }

    return {
      entry: entry ? { ...entry } : null,
      events,
      warning,
      file,
    };
  }

  exportMarkdown(sessionID) {
    const { entry, events } = this.read(sessionID);
    if (!entry) throw new Error('Sessão não encontrada no histórico.');

    const lines = [];
    lines.push(`# Agent Bar — ${entry.agent}`);
    lines.push('');
    lines.push(`- **Sessão:** ${entry.id}`);
    lines.push(`- **Projeto:** ${entry.projectDir}`);
    lines.push(`- **Início:** ${entry.startedAt}`);
    lines.push(`- **Fim:** ${entry.endedAt || 'em andamento'}`);
    lines.push(`- **Status:** ${entry.status}`);
    lines.push(`- **Duração:** ${formatDuration(entry.startedAt, entry.endedAt)}`);
    lines.push(`- **Ações:** ${entry.actions}`);
    lines.push(`- **Arquivos tocados:** ${entry.files.length}`);
    if (entry.meetingId) lines.push(`- **Reunião:** ${entry.meetingId}`);
    if (entry.truncated) lines.push('- **Aviso:** histórico truncado por limite de tamanho.');
    lines.push('');
    lines.push('## Linha do tempo');
    lines.push('');

    for (const event of events) {
      const time = event.ts ? new Date(event.ts).toLocaleString('pt-BR') : '';
      if (event.type === 'prompt') {
        lines.push(`### ${time} — Prompt`);
        lines.push('');
        lines.push(event.text || '');
        lines.push('');
      } else if (event.type === 'text') {
        lines.push(`### ${time} — Resposta`);
        lines.push('');
        lines.push(event.text || '');
        lines.push('');
      } else if (event.type === 'tool') {
        lines.push(`### ${time} — Ferramenta: ${event.name} (${event.phase})`);
        lines.push('');
        if (event.input) {
          lines.push('```json');
          lines.push(event.input);
          lines.push('```');
          lines.push('');
        }
        if (event.error) {
          lines.push(`**Erro:** ${event.error}`);
          lines.push('');
        }
      } else if (event.type === 'file') {
        lines.push(`- ${event.event}: \`${event.file}\``);
      } else if (event.type === 'error') {
        lines.push(`- **Erro:** ${event.error}`);
      } else if (event.type === 'permission') {
        lines.push(
          `- **Permissão:** ${event.request?.action || ''} ${(
            event.request?.resources || []
          ).join(', ')}`,
        );
      }
    }

    if (entry.files.length > 0) {
      lines.push('');
      lines.push('## Arquivos tocados');
      for (const file of entry.files) lines.push(`- \`${file}\``);
    }

    return lines.join('\n');
  }

  delete(sessionID) {
    this.entries = this.entries.filter((entry) => entry.id !== sessionID);
    this.byId.delete(sessionID);
    try {
      fs.unlinkSync(this.fileFor(sessionID));
    } catch {
      // ignore
    }
    this.saveIndexNow();
  }

  prune() {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const keep = [];
    for (const entry of this.entries) {
      const timestamp = new Date(entry.endedAt || entry.startedAt).getTime();
      if (Number.isFinite(timestamp) && timestamp < cutoff) {
        try {
          fs.unlinkSync(this.fileFor(entry.id));
        } catch {
          // ignore
        }
      } else {
        keep.push(entry);
      }
    }
    this.entries = keep;
    this.byId = new Map(keep.map((entry) => [entry.id, entry]));
  }
}

module.exports = { HistoryStore, formatDuration };
