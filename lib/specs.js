'use strict';

/*
 * Specs no formato do Kiro: `.kiro/specs/<nome>/` com
 *   requirements.md  histórias de usuário + critérios de aceitação (EARS)
 *   design.md        arquitetura, componentes, dados, erros, testes
 *   tasks.md         checklist "- [ ] 1. ..." com subtarefas "- [ ] 1.1 ..."
 *   .config.kiro     JSON do Kiro; o Agent Bar guarda seu estado em "agentBar"
 *
 * Cada fase é gerada por um agente e aprovada pelo usuário antes da próxima.
 * Tarefas são executadas uma por vez (ou todas em sequência); o Agent Bar marca
 * "[-]" ao iniciar, "[x]" quando a execução termina com sucesso e volta para
 * "[ ]" se falhar.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const PHASES = ['requirements', 'design', 'tasks'];
const PHASE_FILES = {
  requirements: 'requirements.md',
  design: 'design.md',
  tasks: 'tasks.md',
};
const PHASE_LABELS = {
  requirements: 'requisitos',
  design: 'design',
  tasks: 'tarefas',
};
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TASK_RE = /^(\s*)[-*+] \[([ xX~-])\](\*)?\s*(?:(\d+(?:\.\d+)*)\.?(?=\s)\s*)?(.*?)\s*$/;
const REQ_RE = /^_*\s*(?:requisitos?|requirements?|reqs?)\s*:\s*(.+?)\s*_*$/i;
const STATUS_MARK = { todo: ' ', in_progress: '-', done: 'x' };

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

function assertName(name) {
  const value = String(name || '');
  if (!NAME_RE.test(value)) {
    throw new Error('Nome de spec inválido: use letras minúsculas, números e hífen (até 64).');
  }
  return value;
}

function indentWidth(text) {
  return text.replace(/\t/g, '  ').length;
}

/* ---------- tasks.md ---------- */

function parseTasks(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const tasks = [];
  let current = null;

  lines.forEach((line, index) => {
    const match = line.match(TASK_RE);
    if (match) {
      const mark = match[2];
      const number = match[4] || null;
      current = {
        id: number || `L${index + 1}`,
        number,
        title: (match[5] || '').trim(),
        line: index,
        indent: indentWidth(match[1]),
        status: /x/i.test(mark) ? 'done' : mark === '-' || mark === '~' ? 'in_progress' : 'todo',
        optional: Boolean(match[3]),
        details: [],
        requirements: [],
        parentId: null,
        children: [],
        depth: 0,
      };
      tasks.push(current);
      return;
    }

    if (!current) return;
    if (line.trim() === '') return;
    const indent = indentWidth(line.match(/^\s*/)[0]);
    if (indent > current.indent) {
      const text = line.trim().replace(/^[-*+]\s+/, '');
      const req = text.match(REQ_RE);
      if (req) {
        current.requirements.push(
          ...req[1]
            .replace(/_+$/, '')
            .split(/[,;]/)
            .map((item) => item.trim())
            .filter(Boolean),
        );
      } else {
        current.details.push(text);
      }
      return;
    }
    current = null;
  });

  const byNumber = new Map(tasks.filter((task) => task.number).map((task) => [task.number, task]));
  tasks.forEach((task, index) => {
    let parent = null;
    if (task.number && task.number.includes('.')) {
      parent = byNumber.get(task.number.split('.').slice(0, -1).join('.')) || null;
    }
    if (!parent && task.indent > 0) {
      for (let i = index - 1; i >= 0; i -= 1) {
        if (tasks[i].indent < task.indent) {
          parent = tasks[i];
          break;
        }
      }
    }
    if (parent && parent !== task) {
      task.parentId = parent.id;
      parent.children.push(task.id);
    }
  });

  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    let depth = 0;
    let cursor = task;
    while (cursor.parentId && depth < 8) {
      depth += 1;
      cursor = byId.get(cursor.parentId);
      if (!cursor) break;
    }
    task.depth = depth;
    task.leaf = task.children.length === 0;
  }
  return tasks;
}

function taskProgress(tasks) {
  const leaves = tasks.filter((task) => task.leaf);
  const required = leaves.filter((task) => !task.optional);
  return {
    total: leaves.length,
    done: leaves.filter((task) => task.status === 'done').length,
    requiredTotal: required.length,
    requiredDone: required.filter((task) => task.status === 'done').length,
  };
}

function nextTask(tasks, { includeOptional = false } = {}) {
  return (
    tasks.find(
      (task) => task.leaf && task.status !== 'done' && (includeOptional || !task.optional),
    ) || null
  );
}

function setLineStatus(line, status) {
  return line.replace(/\[([ xX~-])\]/, `[${STATUS_MARK[status]}]`);
}

/** Atualiza o status de uma tarefa e propaga para o pai (todas concluídas → pai concluído). */
function updateTaskStatus(markdown, taskId, status) {
  if (!STATUS_MARK[status]) throw new Error('Status de tarefa inválido.');
  const eol = /\r\n/.test(markdown) ? '\r\n' : '\n';
  const lines = String(markdown).split(/\r?\n/);
  let tasks = parseTasks(markdown);
  const target = tasks.find((task) => task.id === taskId);
  if (!target) throw new Error(`Tarefa "${taskId}" não encontrada em tasks.md.`);

  const apply = (task, value) => {
    lines[task.line] = setLineStatus(lines[task.line], value);
  };

  apply(target, status);
  if (status === 'done' || status === 'todo') {
    // Marcar um pai marca todas as subtarefas.
    const stack = [...target.children];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    while (stack.length > 0) {
      const child = byId.get(stack.pop());
      if (!child) continue;
      apply(child, status);
      stack.push(...child.children);
    }
  }

  tasks = parseTasks(lines.join(eol));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let parent = byId.get(target.parentId);
  while (parent) {
    const children = parent.children.map((id) => byId.get(id)).filter(Boolean);
    // Subtarefas opcionais ("- [ ]*") não impedem o pai de ser concluído.
    const required = children.filter((child) => !child.optional);
    const allDone = (required.length > 0 ? required : children).every((child) => child.status === 'done');
    const anyStarted = children.some((child) => child.status !== 'todo');
    const desired = allDone ? 'done' : anyStarted ? 'in_progress' : 'todo';
    lines[parent.line] = setLineStatus(lines[parent.line], desired);
    tasks = parseTasks(lines.join(eol));
    const refreshed = new Map(tasks.map((task) => [task.id, task]));
    parent = refreshed.get(parent.parentId);
  }
  return lines.join(eol);
}

/* ---------- Prompts ---------- */

function specPath(name, file = '') {
  return `.kiro/specs/${name}${file ? `/${file}` : ''}`;
}

const NO_CODE = 'NÃO implemente código nesta fase e não crie os arquivos das próximas fases.';

function requirementsPrompt({ name, title, idea }) {
  return [
    `Fluxo de desenvolvimento guiado por spec — fase 1 de 3: REQUISITOS da funcionalidade "${title || name}".`,
    '',
    'Ideia do usuário:',
    idea ? idea.trim() : '(sem descrição adicional; deduza a partir do nome e do código)',
    '',
    `Crie o arquivo \`${specPath(name, 'requirements.md')}\` com:`,
    '1. `# Documento de Requisitos` e uma seção `## Introdução` resumindo a funcionalidade e o escopo.',
    '2. `## Requisitos`, com requisitos numerados (`### Requisito 1`, `### Requisito 2`, …). Cada um contém:',
    '   - **História de usuário:** Como <papel>, quero <objetivo>, para que <benefício>.',
    '   - **Critérios de aceitação**, numerados (1, 2, 3…), em notação EARS:',
    '     - `QUANDO <evento> ENTÃO o sistema DEVE <resposta>`',
    '     - `SE <condição> ENTÃO o sistema DEVE <resposta>`',
    '     - `ENQUANTO <estado> o sistema DEVE <comportamento>`',
    '3. Cubra casos de borda, erros, permissões/segurança e requisitos não funcionais relevantes.',
    '',
    'Leia o código existente o suficiente para que os requisitos sejam coerentes com o projeto.',
    NO_CODE,
    'Ao final, responda com um resumo curto e liste as dúvidas em aberto que o usuário deve decidir.',
  ].join('\n');
}

function designPrompt({ name, title }) {
  return [
    `Fluxo guiado por spec — fase 2 de 3: DESIGN da funcionalidade "${title || name}".`,
    '',
    `Leia \`${specPath(name, 'requirements.md')}\` (aprovado pelo usuário) e pesquise no projeto o código relacionado.`,
    `Crie \`${specPath(name, 'design.md')}\` com as seções:`,
    '- `## Visão geral`',
    '- `## Arquitetura` (inclua diagrama Mermaid quando ajudar)',
    '- `## Componentes e interfaces` (arquivos, classes, funções, endpoints, assinaturas)',
    '- `## Modelos de dados`',
    '- `## Tratamento de erros`',
    '- `## Estratégia de testes`',
    '',
    'Indique quais requisitos cada decisão atende (ex.: "Req. 1.2"). Siga os padrões já usados no projeto.',
    NO_CODE,
    'Ao final, resuma as decisões principais e os riscos.',
  ].join('\n');
}

function tasksPrompt({ name, title }) {
  return [
    `Fluxo guiado por spec — fase 3 de 3: TAREFAS da funcionalidade "${title || name}".`,
    '',
    `Com base em \`${specPath(name, 'requirements.md')}\` e \`${specPath(name, 'design.md')}\`, crie \`${specPath(name, 'tasks.md')}\`:`,
    '',
    '```markdown',
    '# Plano de Implementação',
    '',
    '- [ ] 1. Título da tarefa',
    '  - o que fazer, em uma ou mais linhas',
    '  - _Requisitos: 1.1, 2.3_',
    '',
    '- [ ] 2. Tarefa com subtarefas',
    '- [ ] 2.1 Subtarefa',
    '  - detalhes',
    '  - _Requisitos: 3.1_',
    '- [ ]* 2.2 Subtarefa opcional (ex.: testes extras)',
    '```',
    '',
    'Regras:',
    '- Tarefas pequenas e incrementais; cada uma deve deixar o código compilando e testável e construir sobre as anteriores.',
    '- Apenas atividades de código: escrever, alterar e testar código. Nada de deploy, coleta de feedback, métricas ou tarefas manuais.',
    '- Toda tarefa referencia os requisitos que atende.',
    '- Marque com `- [ ]*` as opcionais.',
    NO_CODE,
  ].join('\n');
}

function refinePrompt({ name, phase, feedback }) {
  const file = PHASE_FILES[phase];
  return [
    `Revise \`${specPath(name, file)}\` da spec "${name}" conforme o pedido abaixo, mantendo o formato do documento.`,
    phase !== 'requirements'
      ? `Mantenha a coerência com as fases anteriores (${PHASES.slice(0, PHASES.indexOf(phase))
          .map((item) => `\`${PHASE_FILES[item]}\``)
          .join(', ')}).`
      : '',
    '',
    'Pedido do usuário:',
    feedback.trim(),
    '',
    `Altere apenas \`${specPath(name, file)}\`. ${NO_CODE}`,
    'Ao final, liste em poucas linhas o que mudou.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function taskPrompt({ name, title, task, parent }) {
  const lines = [
    `Implemente a tarefa ${task.number || task.title} da spec "${title || name}".`,
    '',
    `Antes de começar, leia \`${specPath(name, 'requirements.md')}\`, \`${specPath(name, 'design.md')}\` e \`${specPath(name, 'tasks.md')}\`.`,
    '',
    `Tarefa: ${task.number ? `${task.number}. ` : ''}${task.title}`,
  ];
  if (parent) lines.push(`Parte de: ${parent.number ? `${parent.number}. ` : ''}${parent.title}`);
  if (task.details.length > 0) {
    lines.push('Detalhes:', ...task.details.map((detail) => `- ${detail}`));
  }
  if (task.requirements.length > 0) {
    lines.push(`Requisitos atendidos: ${task.requirements.join(', ')}`);
  }
  lines.push(
    '',
    'Regras:',
    '- Implemente SOMENTE esta tarefa; não adiante as próximas.',
    '- Siga o design e os padrões do projeto. Verifique o resultado contra os critérios de aceitação dos requisitos citados.',
    '- Rode os testes, lint ou build relevantes, se existirem, e corrija o que quebrar.',
    '- Não edite tasks.md: o Agent Bar marca a tarefa como concluída quando você terminar.',
    '- Termine com um resumo do que mudou e dos arquivos alterados.',
  );
  return lines.join('\n');
}

/* ---------- Store ---------- */

class SpecStore {
  constructor({ projectDir }) {
    this.projectDir = projectDir;
  }

  get root() {
    return path.join(this.projectDir, '.kiro', 'specs');
  }

  dir(name) {
    return path.join(this.root, assertName(name));
  }

  configFile(name) {
    return path.join(this.dir(name), '.config.kiro');
  }

  readConfig(name) {
    try {
      const value = JSON.parse(fs.readFileSync(this.configFile(name), 'utf8'));
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  writeConfig(name, config) {
    fs.mkdirSync(this.dir(name), { recursive: true });
    fs.writeFileSync(this.configFile(name), `${JSON.stringify(config, null, 2)}\n`);
  }

  updateAgentBarConfig(name, mutate) {
    const config = this.readConfig(name);
    const own = config.agentBar && typeof config.agentBar === 'object' ? config.agentBar : {};
    mutate(own);
    config.agentBar = own;
    this.writeConfig(name, config);
    return own;
  }

  docInfo(name, phase) {
    const file = path.join(this.dir(name), PHASE_FILES[phase]);
    try {
      const stat = fs.statSync(file);
      return {
        exists: stat.isFile(),
        file: path.relative(this.projectDir, file),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    } catch {
      return { exists: false, file: path.relative(this.projectDir, file), mtimeMs: 0, size: 0 };
    }
  }

  readDoc(name, phase) {
    try {
      return fs.readFileSync(path.join(this.dir(name), PHASE_FILES[phase]), 'utf8');
    } catch {
      return '';
    }
  }

  summary(name) {
    const config = this.readConfig(name);
    const own = config.agentBar || {};
    const docs = {};
    const approvals = {};
    for (const phase of PHASES) {
      docs[phase] = this.docInfo(name, phase);
      const approval = own.approved?.[phase] || null;
      approvals[phase] = {
        approved: Boolean(approval) && docs[phase].exists,
        at: approval?.at || null,
        stale: Boolean(approval) && docs[phase].exists && docs[phase].mtimeMs > (approval.mtimeMs || 0) + 1500,
      };
    }

    let tasks = [];
    if (docs.tasks.exists) tasks = parseTasks(this.readDoc(name, 'tasks'));
    const progress = taskProgress(tasks);
    const next = nextTask(tasks);

    let phase = 'requirements';
    if (approvals.requirements.approved) phase = 'design';
    if (phase === 'design' && approvals.design.approved) phase = 'tasks';
    if (phase === 'tasks' && approvals.tasks.approved) {
      phase = progress.requiredTotal > 0 && progress.requiredDone === progress.requiredTotal
        ? 'done'
        : 'implementation';
    }

    const updatedAt = Math.max(0, ...PHASES.map((item) => docs[item].mtimeMs), own.createdAtMs || 0);
    return {
      name,
      title: own.title || name,
      idea: own.idea || '',
      agent: own.agent || null,
      specType: config.specType || 'feature',
      createdAt: own.createdAt || null,
      docs,
      approvals,
      phase,
      progress,
      next: next ? { id: next.id, number: next.number, title: next.title } : null,
      updatedAt,
    };
  }

  list() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && NAME_RE.test(entry.name))
      .map((entry) => this.summary(entry.name))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  read(name) {
    const summary = this.summary(name);
    const content = {};
    for (const phase of PHASES) content[phase] = this.readDoc(name, phase);
    return { ...summary, content, tasks: parseTasks(content.tasks) };
  }

  create({ title, name, idea = '', agent = null }) {
    const cleanTitle = String(title || '').trim();
    const slug = assertName(name || slugify(cleanTitle));
    if (fs.existsSync(this.dir(slug))) throw new Error(`Já existe uma spec "${slug}".`);
    const now = new Date();
    this.writeConfig(slug, {
      specId: crypto.randomUUID(),
      workflowType: 'requirements-first',
      specType: 'feature',
      agentBar: {
        title: cleanTitle || slug,
        idea: String(idea || '').slice(0, 20_000),
        agent,
        createdAt: now.toISOString(),
        createdAtMs: now.getTime(),
        approved: {},
      },
    });
    return this.read(slug);
  }

  setAgent(name, agent) {
    this.updateAgentBarConfig(name, (own) => {
      own.agent = agent || null;
    });
    return this.summary(name);
  }

  approve(name, phase, approved = true) {
    if (!PHASES.includes(phase)) throw new Error('Fase inválida.');
    const index = PHASES.indexOf(phase);
    const summary = this.summary(name);
    if (approved) {
      if (!summary.docs[phase].exists) throw new Error(`Gere ${PHASE_LABELS[phase]} antes de aprovar.`);
      if (index > 0 && !summary.approvals[PHASES[index - 1]].approved) {
        throw new Error(`Aprove ${PHASE_LABELS[PHASES[index - 1]]} antes.`);
      }
    }
    this.updateAgentBarConfig(name, (own) => {
      own.approved = own.approved || {};
      if (approved) {
        own.approved[phase] = { at: new Date().toISOString(), mtimeMs: summary.docs[phase].mtimeMs };
      } else {
        // Desaprovar uma fase reabre as seguintes.
        for (const item of PHASES.slice(index)) delete own.approved[item];
      }
    });
    return this.summary(name);
  }

  setTaskStatus(name, taskId, status) {
    const file = path.join(this.dir(name), PHASE_FILES.tasks);
    const markdown = this.readDoc(name, 'tasks');
    if (!markdown) throw new Error('tasks.md não existe.');
    const updated = updateTaskStatus(markdown, taskId, status);
    if (updated !== markdown) {
      fs.writeFileSync(file, updated);
      // Mudança de checkbox não invalida a aprovação das tarefas.
      this.updateAgentBarConfig(name, (own) => {
        if (own.approved?.tasks) own.approved.tasks.mtimeMs = fs.statSync(file).mtimeMs;
      });
    }
    return this.read(name);
  }

  remove(name) {
    fs.rmSync(this.dir(name), { recursive: true, force: true });
    return { ok: true };
  }
}

/* ---------- Orquestração ---------- */

class SpecRunner extends EventEmitter {
  constructor({ store, startRun, cancelRun }) {
    super();
    this.store = store;
    this.startRun = startRun;
    this.cancelRun = cancelRun;
    this.active = new Map(); // nome da spec → execução em andamento
    this.waitingNext = new Map(); // "executar todas" esperando o agente ficar livre
  }

  state() {
    const value = Object.fromEntries(this.active.entries());
    for (const [spec, waiting] of this.waitingNext.entries()) {
      if (!value[spec]) {
        value[spec] = { spec, kind: 'waiting', agent: waiting.agent, runAll: true, startedAt: waiting.startedAt };
      }
    }
    return value;
  }

  ensureIdle(name) {
    if (this.active.has(name)) throw new Error('Esta spec já tem uma execução em andamento.');
  }

  scheduleNext(spec, agent) {
    setTimeout(() => {
      this.startNext(spec, agent).catch(() => {});
    }, 300);
  }

  async startNext(spec, agent) {
    let detail;
    try {
      detail = this.store.read(spec);
    } catch {
      this.waitingNext.delete(spec);
      return;
    }
    const next = nextTask(detail.tasks);
    if (!next) {
      this.waitingNext.delete(spec);
      this.emit('update');
      return;
    }
    try {
      await this.runTask(spec, next.id, { agent, runAll: true });
      this.waitingNext.delete(spec);
    } catch (error) {
      if (/já está em execução|reunião ativa/.test(error.message)) {
        const previous = this.waitingNext.get(spec);
        this.waitingNext.set(spec, {
          agent,
          since: previous?.since || Date.now(),
          startedAt: previous?.startedAt || new Date().toISOString(),
        });
      } else {
        this.waitingNext.delete(spec);
        this.emit('error', { spec, message: error.message });
      }
      this.emit('update');
    }
  }

  agentFor(name, override) {
    return override || this.store.summary(name).agent || '__general__';
  }

  async runPhase(name, phase, { feedback = '', agent = null } = {}) {
    if (!PHASES.includes(phase)) throw new Error('Fase inválida.');
    this.ensureIdle(name);
    const summary = this.store.summary(name);
    const index = PHASES.indexOf(phase);
    if (index > 0 && !summary.approvals[PHASES[index - 1]].approved) {
      throw new Error(`Aprove ${PHASE_LABELS[PHASES[index - 1]]} antes de gerar ${PHASE_LABELS[phase]}.`);
    }

    let prompt;
    const text = String(feedback || '').trim();
    if (text) {
      if (!summary.docs[phase].exists) throw new Error(`Gere ${PHASE_LABELS[phase]} antes de refinar.`);
      prompt = refinePrompt({ name, phase, feedback: text });
    } else if (phase === 'requirements') {
      prompt = requirementsPrompt({ name, title: summary.title, idea: summary.idea });
    } else if (phase === 'design') {
      prompt = designPrompt({ name, title: summary.title });
    } else {
      prompt = tasksPrompt({ name, title: summary.title });
    }

    return this.launch(name, {
      kind: text ? 'refine' : 'phase',
      phase,
      agent: this.agentFor(name, agent),
      prompt,
      label: `spec ${name} · ${text ? 'refinar' : 'gerar'} ${PHASE_LABELS[phase]}`,
    });
  }

  async runTask(name, taskId, { agent = null, runAll = false } = {}) {
    this.ensureIdle(name);
    const detail = this.store.read(name);
    if (!detail.approvals.tasks.approved) {
      throw new Error('Aprove as tarefas antes de começar a implementação.');
    }
    const task = detail.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Tarefa "${taskId}" não encontrada.`);
    if (!task.leaf) {
      const child = detail.tasks.find(
        (item) => item.parentId === task.id && item.status !== 'done',
      );
      if (!child) throw new Error('Todas as subtarefas já estão concluídas.');
      return this.runTask(name, child.id, { agent, runAll });
    }
    const parent = detail.tasks.find((item) => item.id === task.parentId) || null;
    const prompt = taskPrompt({ name, title: detail.title, task, parent });

    this.store.setTaskStatus(name, task.id, 'in_progress');
    try {
      return await this.launch(name, {
        kind: 'task',
        taskId: task.id,
        taskLabel: `${task.number ? `${task.number} ` : ''}${task.title}`,
        agent: this.agentFor(name, agent),
        prompt,
        runAll,
        label: `spec ${name} · tarefa ${task.number || task.title}`,
      });
    } catch (error) {
      this.store.setTaskStatus(name, task.id, 'todo');
      throw error;
    }
  }

  async runAll(name, { agent = null } = {}) {
    const detail = this.store.read(name);
    const next = nextTask(detail.tasks);
    if (!next) throw new Error('Não há tarefas obrigatórias pendentes.');
    return this.runTask(name, next.id, { agent, runAll: true });
  }

  async launch(name, run) {
    const files = PHASES.map((phase) => specPath(name, PHASE_FILES[phase]));
    const result = await this.startRun({
      agent: run.agent,
      prompt: run.prompt,
      files,
      label: run.label,
      origin: { kind: 'spec', spec: name, task: run.taskId || null, phase: run.phase || null },
    });
    const entry = {
      spec: name,
      kind: run.kind,
      phase: run.phase || null,
      taskId: run.taskId || null,
      taskLabel: run.taskLabel || null,
      agent: run.agent,
      runAll: Boolean(run.runAll),
      executionId: result.executionId,
      sessionId: result.sessionId || null,
      startedAt: new Date().toISOString(),
    };
    this.active.set(name, entry);
    this.emit('update');
    return entry;
  }

  async stop(name) {
    if (this.waitingNext.delete(name) && !this.active.has(name)) {
      this.emit('update');
      return { ok: true };
    }
    const entry = this.active.get(name);
    if (!entry) return { ok: false, message: 'Nada em execução nesta spec.' };
    entry.runAll = false;
    this.emit('update');
    return this.cancelRun(entry.executionId);
  }

  /** Chamado quando qualquer execução termina. */
  handleFinished({ executionId, status }) {
    // Sequências que esperavam um agente ocupado tentam de novo.
    for (const [spec, waiting] of Array.from(this.waitingNext.entries())) {
      if (Date.now() - waiting.since > 10 * 60 * 1000) {
        this.waitingNext.delete(spec);
        this.emit('error', { spec, message: 'Sequência cancelada: o agente ficou ocupado por mais de 10 minutos.' });
        this.emit('update');
      } else if (!this.active.has(spec)) {
        this.scheduleNext(spec, waiting.agent);
      }
    }

    const found = Array.from(this.active.values()).find((entry) => entry.executionId === executionId);
    if (!found) return;
    this.active.delete(found.spec);

    if (found.kind === 'task') {
      try {
        this.store.setTaskStatus(found.spec, found.taskId, status === 'succeeded' ? 'done' : 'todo');
      } catch (error) {
        this.emit('error', { spec: found.spec, message: error.message });
      }
    }
    this.emit('finished', { ...found, status });
    this.emit('update');

    if (found.kind === 'task' && found.runAll && status === 'succeeded') {
      // Deixa o processo principal liberar o agente antes de reutilizá-lo.
      this.scheduleNext(found.spec, found.agent);
    }
  }
}

module.exports = {
  SpecStore,
  SpecRunner,
  PHASES,
  PHASE_FILES,
  slugify,
  parseTasks,
  updateTaskStatus,
  taskProgress,
  nextTask,
  prompts: { requirementsPrompt, designPrompt, tasksPrompt, refinePrompt, taskPrompt },
};
