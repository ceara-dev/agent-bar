'use strict';

/*
 * Telas de Specs, Hooks e Steering (formato .kiro/).
 * Carregado depois de app.js; reutiliza `api`, `state`, `toast`, `formatDate`,
 * `formatTime`, `formatDuration` e `openAgent` declarados lá.
 */

(() => {
  const bridge = window.agentBar;
  if (!bridge || !bridge.kiro) return;

  const VIEW_KEY = 'agentBar.view';
  const PHASES = ['requirements', 'design', 'tasks'];
  const PHASE = {
    requirements: { label: 'Requisitos', noun: 'os requisitos', approved: 'Requisitos aprovados', file: 'requirements.md', next: 'design' },
    design: { label: 'Design', noun: 'o design', approved: 'Design aprovado', file: 'design.md', next: 'tasks' },
    tasks: { label: 'Tarefas', noun: 'as tarefas', approved: 'Tarefas aprovadas', file: 'tasks.md', next: null },
  };
  const PHASE_INFO = {
    requirements:
      'Histórias de usuário com critérios de aceitação em notação EARS (QUANDO… ENTÃO o sistema DEVE…). Define o que será construído.',
    design:
      'Arquitetura, componentes, modelos de dados, tratamento de erros e estratégia de testes, baseados nos requisitos aprovados e no código atual.',
    tasks:
      'Plano de implementação em checklist: tarefas pequenas e incrementais, cada uma ligada aos requisitos que atende.',
  };
  const SPEC_PHASE_LABEL = {
    requirements: 'Requisitos',
    design: 'Design',
    tasks: 'Tarefas',
    implementation: 'Implementação',
    done: 'Concluída',
  };
  const TRIGGERS = [
    { type: 'fileEdited', icon: '✎', label: 'Arquivo salvo', hint: 'Quando um arquivo que casa com o padrão é editado.', files: true },
    { type: 'fileCreated', icon: '+', label: 'Arquivo criado', hint: 'Quando surge um arquivo novo que casa com o padrão.', files: true },
    { type: 'fileDeleted', icon: '−', label: 'Arquivo apagado', hint: 'Quando um arquivo que casa com o padrão some.', files: true },
    { type: 'promptSubmit', icon: '↵', label: 'Envio de prompt', hint: 'Antes de cada prompt enviado pelo Agent Bar.', files: false },
    { type: 'agentStop', icon: '■', label: 'Agente terminou', hint: 'Depois que um agente conclui uma execução.', files: false },
    { type: 'userTriggered', icon: '▶', label: 'Manual', hint: 'Só quando você clicar em Executar.', files: false },
  ];
  const TRIGGER_BY_TYPE = Object.fromEntries(TRIGGERS.map((item) => [item.type, item]));
  const INCLUSION = {
    always: { label: 'Sempre', hint: 'Entra em todo prompt enviado pelo Agent Bar.' },
    fileMatch: {
      label: 'Por arquivo',
      hint: 'Entra quando um arquivo citado no prompt, da spec ou do hook casa com o padrão. Fora isso, o agente recebe só um aviso para ler o documento se precisar.',
    },
    manual: { label: 'Manual', hint: 'Entra quando o prompt cita #nome-do-documento.' },
  };
  const RUN_STATUS = {
    running: 'rodando',
    waiting: 'aguardando',
    succeeded: 'concluído',
    failed: 'erro',
    blocked: 'bloqueado',
    cancelled: 'cancelado',
  };

  const ks = {
    view: 'agents',
    data: null,
    lastWarningAt: null,
    spec: {
      selected: null,
      detail: null,
      doc: 'requirements',
      creating: false,
      draft: { title: '', idea: '', agent: '' },
      feedback: {},
      loading: false,
    },
    hook: { selected: null, draft: null },
    steering: { selected: null, draft: null, previewText: '', previewResult: null, generateAgent: '' },
  };

  /* ---------- DOM ---------- */

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'value') node.value = value;
      else if (key === 'checked' || key === 'disabled' || key === 'selected') node[key] = Boolean(value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function rerender(container, build) {
    const active = document.activeElement;
    const focusId = active && active.id && container.contains(active) ? active.id : null;
    const start = focusId && 'selectionStart' in active ? active.selectionStart : null;
    const end = focusId && 'selectionEnd' in active ? active.selectionEnd : null;
    const scroller = container.closest('.content');
    const scrollTop = scroller ? scroller.scrollTop : 0;
    container.replaceChildren(...[build()].flat().filter(Boolean));
    if (scroller) scroller.scrollTop = scrollTop;
    if (focusId) {
      const node = byId(focusId);
      if (node) {
        node.focus({ preventScroll: true });
        if (start !== null) {
          try {
            node.setSelectionRange(start, end);
          } catch {
            // nem todo input aceita seleção
          }
        }
      }
    }
  }

  async function act(promise, success) {
    try {
      const result = await promise;
      if (success) toast(typeof success === 'function' ? success(result) : success);
      return result;
    } catch (error) {
      toast(cleanError(error), 'error');
      return null;
    }
  }

  function cleanError(error) {
    return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

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

  function agentLabel(name) {
    return !name || name === '__general__' ? 'Geral' : name;
  }

  /** Para usar no meio de frases: "o agente padrão" ou o nome do agente. */
  function who(name) {
    return !name || name === '__general__' ? 'o agente padrão' : name;
  }

  function Who(name) {
    const text = who(name);
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function agentChoices() {
    const agents = (state.snapshot?.agents || []).filter(
      (agent) => !agent.hidden && agent.mode !== 'subagent',
    );
    return [
      { value: '__general__', label: 'Geral (agente padrão)' },
      ...agents.map((agent) => ({ value: agent.name, label: agent.name })),
    ];
  }

  function agentSelect(id, value, onChange, { extra = [] } = {}) {
    const select = h('select', { id, class: 'select' });
    const choices = [...extra, ...agentChoices()];
    const current = value ?? '__general__';
    if (!choices.some((choice) => choice.value === current)) {
      choices.push({ value: current, label: `${current} (indisponível)` });
    }
    for (const choice of choices) {
      select.append(h('option', { value: choice.value, text: choice.label }));
    }
    select.value = current;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function field(label, control, hint) {
    return h(
      'label',
      { class: 'kfield' },
      h('span', { class: 'kfield-label', text: label }),
      control,
      hint ? h('span', { class: 'kfield-hint' }, hint) : null,
    );
  }

  function pill(status) {
    return h('span', { class: `status-pill ${status}`, text: RUN_STATUS[status] || status });
  }

  function emptyBlock(icon, title, text, ...actions) {
    return h(
      'div',
      { class: 'kempty' },
      h('div', { class: 'kempty-icon', 'aria-hidden': 'true', text: icon }),
      h('h3', { text: title }),
      text ? h('p', { class: 'muted' }, text) : null,
      actions.length > 0 ? h('div', { class: 'kempty-actions' }, actions) : null,
    );
  }

  function openFile(file) {
    act(api.files.open(file));
  }

  /* ---------- Markdown (sem innerHTML) ---------- */

  const EARS_RE = /\b(QUANDO|ENTÃO|DEVE|ENQUANTO|SE|ONDE|WHEN|THEN|SHALL|WHILE|IF|WHERE)\b/g;
  const INLINE_RE =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(?<![\w])(__[^_\n]+__)(?![\w])|(?<![\w*])(\*[^*\s][^*\n]*\*)(?![\w*])|(?<![\w])(_[^_\s][^_\n]*_)(?![\w])|(\[[^\]\n]+\]\([^)\n]+\))/g;

  function plain(text, opts) {
    if (!opts.ears) return document.createTextNode(text);
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(EARS_RE)) {
      if (match.index > last) frag.append(text.slice(last, match.index));
      frag.append(h('span', { class: 'ears', text: match[0] }));
      last = match.index + match[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  function inline(text, opts = {}) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const match of String(text).matchAll(INLINE_RE)) {
      if (match.index > last) frag.append(plain(text.slice(last, match.index), opts));
      const token = match[0];
      if (match[1]) frag.append(h('code', { text: token.slice(1, -1) }));
      else if (match[2] || match[3]) frag.append(h('strong', {}, inline(token.slice(2, -2), opts)));
      else if (match[4] || match[5]) frag.append(h('em', {}, inline(token.slice(1, -1), opts)));
      else if (match[6]) frag.append(h('span', { class: 'md-link', text: token.slice(1, token.indexOf(']')) }));
      last = match.index + token.length;
    }
    if (last < text.length) frag.append(plain(text.slice(last), opts));
    return frag;
  }

  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  function renderList(lines, start, parent, opts) {
    const items = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      const match = line.match(LIST_RE);
      if (match) {
        items.push({ indent: match[1].replace(/\t/g, '  ').length, ordered: /\d/.test(match[2]), text: match[3] });
        i += 1;
        continue;
      }
      if (line.trim() && /^\s+/.test(line) && items.length > 0) {
        items[items.length - 1].text += ` ${line.trim()}`;
        i += 1;
        continue;
      }
      if (!line.trim() && i + 1 < lines.length && LIST_RE.test(lines[i + 1])) {
        i += 1;
        continue;
      }
      break;
    }

    const stack = [];
    for (const item of items) {
      while (stack.length > 0 && item.indent < stack[stack.length - 1].indent) stack.pop();
      let top = stack[stack.length - 1];
      if (!top || item.indent > top.indent) {
        const list = h(item.ordered ? 'ol' : 'ul');
        if (top && top.lastLi) top.lastLi.append(list);
        else parent.append(list);
        top = { indent: item.indent, list, lastLi: null };
        stack.push(top);
      }
      const li = h('li');
      const check = item.text.match(/^\[([ xX~-])\]\*?\s*(.*)$/);
      if (check) {
        const mark = check[1].toLowerCase();
        li.classList.add('md-task');
        li.append(
          h('span', {
            class: `md-check ${mark === 'x' ? 'done' : mark === '-' || mark === '~' ? 'progress' : ''}`,
            'aria-hidden': 'true',
          }),
          inline(check[2], opts),
        );
      } else {
        li.append(inline(item.text, opts));
      }
      top.list.append(li);
      top.lastLi = li;
    }
    return i;
  }

  function renderMarkdown(source, opts = {}) {
    const root = h('div', { class: 'md' });
    const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [];
    const flush = () => {
      if (paragraph.length > 0) {
        root.append(h('p', {}, inline(paragraph.join(' '), opts)));
        paragraph = [];
      }
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
      if (fence) {
        flush();
        const body = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1;
        root.append(
          h(
            'div',
            { class: 'md-code' },
            fence[2] ? h('span', { class: 'md-code-lang', text: fence[2] }) : null,
            h('pre', {}, h('code', { text: body.join('\n') })),
          ),
        );
        continue;
      }
      if (!line.trim()) {
        flush();
        i += 1;
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (heading) {
        flush();
        const level = Math.min(6, heading[1].length + 1);
        root.append(h(`h${level}`, {}, inline(heading[2], opts)));
        i += 1;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        root.append(h('hr'));
        i += 1;
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          body.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        root.append(h('blockquote', {}, renderMarkdown(body.join('\n'), opts)));
        continue;
      }
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          rows.push(lines[i]);
          i += 1;
        }
        const cells = (row) =>
          row
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((cell) => cell.trim());
        root.append(
          h(
            'div',
            { class: 'md-table-wrap' },
            h(
              'table',
              { class: 'md-table' },
              h('thead', {}, h('tr', {}, cells(rows[0]).map((cell) => h('th', {}, inline(cell, opts))))),
              h(
                'tbody',
                {},
                rows.slice(2).map((row) => h('tr', {}, cells(row).map((cell) => h('td', {}, inline(cell, opts))))),
              ),
            ),
          ),
        );
        continue;
      }
      if (LIST_RE.test(line)) {
        flush();
        i = renderList(lines, i, root, opts);
        continue;
      }
      paragraph.push(line.trim());
      i += 1;
    }
    flush();
    return root;
  }

  /* ---------- Navegação ---------- */

  function setView(view) {
    if (!['agents', 'specs', 'hooks', 'steering'].includes(view)) view = 'agents';
    ks.view = view;
    document.querySelectorAll('.view-tab').forEach((tab) => {
      const on = tab.dataset.view === view;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('main.view').forEach((main) => {
      main.classList.toggle('hidden', main.id !== `view-${view}`);
    });
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // armazenamento indisponível
    }
    renderCurrent();
  }

  function renderCurrent() {
    if (!ks.data) return;
    if (ks.view === 'specs') renderSpecs();
    if (ks.view === 'hooks') renderHooks();
    if (ks.view === 'steering') renderSteering();
  }

  function renderNav() {
    const data = ks.data;
    if (!data) return;
    const setCount = (id, value) => {
      const node = byId(id);
      if (node) node.textContent = value ? String(value) : '';
    };
    setCount('nav-count-specs', data.specs.length);
    setCount('nav-count-hooks', data.hooks.filter((hook) => hook.enabled).length);
    setCount('nav-count-steering', data.steering.filter((doc) => !doc.shadowed).length);

    const specRuns = Object.keys(data.specRuns || {}).length;
    const hookRuns = data.hookRuns.filter((run) => run.status === 'running' || run.status === 'waiting').length;
    const parts = [];
    if (specRuns) parts.push(`${specRuns} spec${specRuns > 1 ? 's' : ''}`);
    if (hookRuns) parts.push(`${hookRuns} hook${hookRuns > 1 ? 's' : ''}`);
    const activity = byId('kiro-activity');
    activity.replaceChildren();
    if (parts.length > 0) {
      activity.append(h('span', { class: 'status-dot running' }), ` ${parts.join(' · ')} em execução`);
    } else if (data.hookStatus?.pausedUntil) {
      activity.append(h('span', { class: 'status-dot interrupted' }), ' hooks pausados (limite por minuto)');
    }
  }

  /* ---------- Specs ---------- */

  function specRun(name) {
    return ks.data?.specRuns?.[name] || null;
  }

  function renderSpecs() {
    rerender(byId('spec-list'), renderSpecList);
    rerender(byId('spec-detail'), renderSpecDetailPane);
  }

  function progressBar(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return h(
      'div',
      { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) },
      h('span', { class: 'progress-fill', style: `width:${pct}%` }),
    );
  }

  function renderSpecList() {
    const list = ks.data.specs;
    if (list.length === 0) {
      return h(
        'div',
        { class: 'list-empty' },
        h('p', { text: 'Nenhuma spec ainda.' }),
        h('p', { class: 'muted', text: 'Specs ficam em .kiro/specs/<nome>/ e podem ir para o Git.' }),
      );
    }
    return list.map((spec) => {
      const running = specRun(spec.name);
      const active = !ks.spec.creating && ks.spec.selected === spec.name;
      return h(
        'button',
        {
          type: 'button',
          class: `list-card${active ? ' active' : ''}`,
          'aria-current': active ? 'true' : null,
          onclick: () => selectSpec(spec.name),
        },
        h(
          'div',
          { class: 'list-card-top' },
          running ? h('span', { class: 'status-dot running', title: 'em execução' }) : null,
          h('span', { class: 'list-card-title', text: spec.title }),
          h('span', { class: `phase-chip phase-${spec.phase}`, text: SPEC_PHASE_LABEL[spec.phase] }),
        ),
        h('div', { class: 'list-card-sub mono', text: spec.name }),
        spec.progress.total > 0
          ? h(
              'div',
              { class: 'list-card-progress' },
              progressBar(spec.progress.done, spec.progress.total),
              h('span', { class: 'mono muted', text: `${spec.progress.done}/${spec.progress.total}` }),
            )
          : null,
      );
    });
  }

  async function selectSpec(name, { doc } = {}) {
    ks.spec.creating = false;
    if (ks.spec.selected !== name) {
      ks.spec.selected = name;
      ks.spec.detail = null;
      const summary = ks.data.specs.find((spec) => spec.name === name);
      ks.spec.doc = doc || defaultDocFor(summary);
    } else if (doc) {
      ks.spec.doc = doc;
    }
    renderSpecs();
    await loadSpecDetail();
  }

  function defaultDocFor(summary) {
    if (!summary) return 'requirements';
    if (summary.phase === 'implementation' || summary.phase === 'done') return 'tasks';
    return PHASES.includes(summary.phase) ? summary.phase : 'requirements';
  }

  let specLoadSeq = 0;
  async function loadSpecDetail() {
    const name = ks.spec.selected;
    if (!name) return;
    const seq = ++specLoadSeq;
    try {
      const detail = await bridge.specs.read(name);
      if (seq !== specLoadSeq || ks.spec.selected !== name) return;
      ks.spec.detail = detail;
    } catch (error) {
      if (seq !== specLoadSeq) return;
      ks.spec.selected = null;
      ks.spec.detail = null;
      toast(cleanError(error), 'error');
    }
    if (ks.view === 'specs') renderSpecs();
  }

  function renderSpecDetailPane() {
    if (ks.spec.creating) return renderSpecForm();
    if (ks.spec.selected && ks.spec.detail) return renderSpecDetail(ks.spec.detail);
    if (ks.spec.selected) return h('div', { class: 'kloading muted', text: 'Carregando spec…' });
    return renderSpecIntro();
  }

  function renderSpecIntro() {
    const steps = [
      ['1', 'Requisitos', 'O agente transforma sua ideia em histórias de usuário e critérios de aceitação verificáveis.'],
      ['2', 'Design', 'Com os requisitos aprovados, ele pesquisa o código e propõe arquitetura, dados e testes.'],
      ['3', 'Tarefas', 'O design vira um checklist de tarefas pequenas, cada uma ligada a requisitos.'],
      ['▶', 'Implementação', 'Execute uma tarefa por vez ou todas em sequência; o progresso fica no tasks.md.'],
    ];
    return h(
      'div',
      { class: 'kintro' },
      h(
        'ol',
        { class: 'flow' },
        steps.map(([n, title, text]) =>
          h('li', { class: 'flow-step' }, h('span', { class: 'flow-n', text: n }), h('div', {}, h('strong', { text: title }), h('p', { class: 'muted', text }))),
        ),
      ),
      h(
        'div',
        { class: 'kempty-actions' },
        h('button', { type: 'button', class: 'button primary', onclick: startNewSpec }, 'Criar a primeira spec'),
      ),
    );
  }

  function startNewSpec() {
    ks.spec.creating = true;
    ks.spec.selected = null;
    ks.spec.detail = null;
    if (!ks.spec.draft.agent) {
      const choices = agentChoices();
      ks.spec.draft.agent = (choices.find((choice) => choice.value === 'build') || choices[0]).value;
    }
    setView('specs');
    setTimeout(() => byId('spec-new-title')?.focus(), 30);
  }

  function renderSpecForm() {
    const draft = ks.spec.draft;
    const slug = slugify(draft.title);
    const title = h('input', {
      id: 'spec-new-title',
      class: 'input',
      type: 'text',
      maxlength: '200',
      placeholder: 'Ex.: Notificações push de novas publicações',
      value: draft.title,
    });
    const slugNode = h('span', { class: 'mono', text: `.kiro/specs/${slug || '<nome>'}/` });
    title.addEventListener('input', () => {
      draft.title = title.value;
      slugNode.textContent = `.kiro/specs/${slugify(title.value) || '<nome>'}/`;
    });
    const idea = h('textarea', {
      id: 'spec-new-idea',
      class: 'input textarea',
      rows: '7',
      placeholder:
        'Descreva como faria num chat: o problema, quem usa, o comportamento esperado, restrições e o que fica de fora.',
      value: draft.idea,
    });
    idea.addEventListener('input', () => {
      draft.idea = idea.value;
    });
    const submit = h('button', { type: 'button', class: 'button primary' }, 'Criar e gerar requisitos');
    submit.addEventListener('click', async () => {
      if (!draft.title.trim()) {
        toast('Dê um nome à funcionalidade.', 'error');
        title.focus();
        return;
      }
      submit.disabled = true;
      const result = await act(
        bridge.specs.create({ title: draft.title.trim(), name: slug, idea: draft.idea, agent: draft.agent }),
      );
      submit.disabled = false;
      if (!result) return;
      if (result.runError) toast(`Spec criada, mas o agente não iniciou: ${result.runError}`, 'error');
      else toast(`Spec criada. ${Who(draft.agent)} está escrevendo os requisitos…`);
      ks.spec.draft = { title: '', idea: '', agent: draft.agent };
      ks.spec.creating = false;
      ks.spec.selected = result.spec.name;
      ks.spec.detail = result.spec;
      ks.spec.doc = 'requirements';
      renderSpecs();
    });

    return h(
      'div',
      { class: 'kcard' },
      h('div', { class: 'kcard-head' }, h('h3', { text: 'Nova spec' }), slugNode),
      field('Nome da funcionalidade', title),
      field('Ideia', idea, 'Quanto mais contexto, melhores os requisitos. Você revisa tudo antes de seguir.'),
      field(
        'Agente',
        agentSelect('spec-new-agent', draft.agent, (value) => {
          draft.agent = value;
        }),
        'Escreve as fases e implementa as tarefas. Dá para trocar depois.',
      ),
      h(
        'div',
        { class: 'kactions' },
        h(
          'button',
          {
            type: 'button',
            class: 'button ghost',
            onclick: () => {
              ks.spec.creating = false;
              renderSpecs();
            },
          },
          'Cancelar',
        ),
        submit,
      ),
    );
  }

  function stepState(detail, step) {
    if (step === 'implementation') {
      if (detail.phase === 'done') return 'done';
      return detail.phase === 'implementation' ? 'current' : 'pending';
    }
    const approval = detail.approvals[step];
    if (approval.approved) return approval.stale ? 'stale' : 'done';
    return detail.phase === step ? 'current' : 'pending';
  }

  function renderStepper(detail) {
    const steps = [...PHASES, 'implementation'];
    return h(
      'ol',
      { class: 'stepper' },
      steps.map((step, index) => {
        const status = stepState(detail, step);
        const target = step === 'implementation' ? 'tasks' : step;
        const label = step === 'implementation' ? 'Implementação' : PHASE[step].label;
        const sub =
          step === 'implementation'
            ? detail.progress.total > 0
              ? `${detail.progress.done}/${detail.progress.total} tarefas`
              : '—'
            : status === 'done'
              ? 'aprovado'
              : status === 'stale'
                ? 'alterado após aprovar'
                : detail.docs[step].exists
                  ? 'em revisão'
                  : 'pendente';
        return h(
          'li',
          { class: `step ${status}${ks.spec.doc === target && step !== 'implementation' ? ' viewing' : ''}` },
          h(
            'button',
            { type: 'button', class: 'step-button', onclick: () => selectSpec(detail.name, { doc: target }) },
            h('span', { class: 'step-n', text: status === 'done' ? '✓' : String(index + 1) }),
            h('span', { class: 'step-copy' }, h('strong', { text: label }), h('span', { class: 'step-sub', text: sub })),
          ),
        );
      }),
    );
  }

  function renderRunBanner(detail, run) {
    if (run.kind === 'waiting') {
      return h(
        'div',
        { class: 'run-banner' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        h(
          'div',
          { class: 'run-banner-copy' },
          h('strong', { text: `Sequência aguardando ${who(run.agent)} ficar livre` }),
          h('span', { class: 'muted', text: 'A próxima tarefa começa assim que a execução atual desse agente terminar.' }),
        ),
        h(
          'button',
          { type: 'button', class: 'button danger small', onclick: () => act(bridge.specs.stop(detail.name), 'Sequência cancelada.') },
          'Cancelar sequência',
        ),
      );
    }
    const what =
      run.kind === 'task'
        ? `implementando a tarefa ${run.taskLabel}`
        : run.kind === 'refine'
          ? `ajustando ${PHASE[run.phase].noun}`
          : `escrevendo ${PHASE[run.phase].noun}`;
    return h(
      'div',
      { class: 'run-banner' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'run-banner-copy' },
        h('strong', { text: `${Who(run.agent)} está ${what}` }),
        h(
          'span',
          { class: 'muted' },
          run.runAll ? 'Executando todas as tarefas pendentes em sequência. ' : '',
          `Desde ${formatTime(run.startedAt)}.`,
        ),
      ),
      h('button', { type: 'button', class: 'button ghost small', onclick: () => openAgent(run.agent) }, 'Ver atividade'),
      h(
        'button',
        { type: 'button', class: 'button danger small', onclick: () => act(bridge.specs.stop(detail.name), 'Parando…') },
        run.runAll ? 'Parar sequência' : 'Parar',
      ),
    );
  }

  function renderSpecDetail(detail) {
    const run = specRun(detail.name);
    const doc = ks.spec.doc;
    return h(
      'div',
      { class: 'spec-detail' },
      h(
        'div',
        { class: 'detail-head' },
        h(
          'div',
          { class: 'detail-title' },
          h('h3', { text: detail.title }),
          h('span', { class: 'mono muted', text: `.kiro/specs/${detail.name}/` }),
        ),
        h(
          'div',
          { class: 'detail-head-actions' },
          h(
            'label',
            { class: 'inline-label' },
            h('span', { class: 'muted', text: 'Agente' }),
            agentSelect('spec-agent', detail.agent || '__general__', (value) =>
              act(bridge.specs.setAgent({ name: detail.name, agent: value }), `Agente da spec: ${agentLabel(value)}`),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-button',
              title: 'Apagar spec',
              'aria-label': 'Apagar spec',
              onclick: async () => {
                if (!window.confirm(`Apagar a spec "${detail.title}" e a pasta .kiro/specs/${detail.name}/?`)) return;
                const ok = await act(bridge.specs.remove(detail.name), 'Spec apagada.');
                if (ok) {
                  ks.spec.selected = null;
                  ks.spec.detail = null;
                }
              },
            },
            '🗑',
          ),
        ),
      ),
      renderStepper(detail),
      run ? renderRunBanner(detail, run) : null,
      h(
        'div',
        { class: 'doc-tabs', role: 'tablist' },
        PHASES.map((phase) =>
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              class: `doc-tab${doc === phase ? ' active' : ''}`,
              'aria-selected': String(doc === phase),
              onclick: () => selectSpec(detail.name, { doc: phase }),
            },
            PHASE[phase].label,
            detail.approvals[phase].approved ? h('span', { class: 'doc-tab-ok', text: '✓' }) : null,
            h('span', { class: 'doc-tab-file mono', text: PHASE[phase].file }),
          ),
        ),
      ),
      renderDocPanel(detail, doc, run),
    );
  }

  function renderDocPanel(detail, phase, run) {
    const info = detail.docs[phase];
    const approval = detail.approvals[phase];
    const index = PHASES.indexOf(phase);
    const previous = index > 0 ? PHASES[index - 1] : null;
    const unlocked = !previous || detail.approvals[previous].approved;
    const busy = Boolean(run);

    if (!info.exists) {
      const generate = h(
        'button',
        {
          type: 'button',
          class: 'button primary',
          disabled: busy || !unlocked,
          onclick: () =>
            act(
              bridge.specs.generate({ name: detail.name, phase }),
              `${Who(detail.agent)} está escrevendo ${PHASE[phase].noun}…`,
            ),
        },
        `Gerar ${PHASE[phase].label.toLowerCase()}`,
      );
      return h(
        'div',
        { class: 'doc-panel' },
        emptyBlock(
          index === 0 ? '◇' : index === 1 ? '◈' : '☰',
          `${PHASE[phase].label} ainda não existe`,
          PHASE_INFO[phase],
          unlocked
            ? generate
            : h('span', { class: 'muted', text: `Aprove ${PHASE[previous].noun} para liberar esta fase.` }),
        ),
      );
    }

    const content = detail.content[phase];
    const statusNode = approval.approved
      ? approval.stale
        ? h('span', { class: 'doc-status stale', text: 'Alterado depois de aprovado — revise e aprove de novo' })
        : h('span', { class: 'doc-status ok', text: `Aprovado ${approval.at ? formatDate(approval.at) : ''}` })
      : h('span', { class: 'doc-status review', text: 'Aguardando sua revisão' });

    const toolbar = h(
      'div',
      { class: 'doc-toolbar' },
      statusNode,
      h(
        'div',
        { class: 'doc-toolbar-actions' },
        h('button', { type: 'button', class: 'button ghost small', onclick: () => openFile(info.file) }, 'Abrir arquivo'),
        h(
          'button',
          {
            type: 'button',
            class: 'button ghost small',
            disabled: busy || !unlocked,
            onclick: () => {
              if (!window.confirm(`Gerar ${PHASE[phase].noun} de novo? O agente vai reescrever ${PHASE[phase].file}.`)) return;
              act(bridge.specs.generate({ name: detail.name, phase }), 'Regenerando…');
            },
          },
          'Regenerar',
        ),
      ),
    );

    const body =
      phase === 'tasks'
        ? renderTasks(detail, run)
        : h('div', { class: 'doc-content' }, renderMarkdown(content, { ears: phase === 'requirements' }));

    const feedbackId = `spec-feedback-${phase}`;
    const feedback = h('textarea', {
      id: feedbackId,
      class: 'input textarea',
      rows: '2',
      placeholder:
        phase === 'requirements'
          ? 'Peça ajustes, ex.: "adicione um requisito de acessibilidade" ou "remova o login social"'
          : phase === 'design'
            ? 'Peça ajustes, ex.: "use o repositório existente em vez de um serviço novo"'
            : 'Peça ajustes, ex.: "quebre a tarefa 3 em partes menores"',
      value: ks.spec.feedback[`${detail.name}:${phase}`] || '',
    });
    feedback.addEventListener('input', () => {
      ks.spec.feedback[`${detail.name}:${phase}`] = feedback.value;
    });
    const refine = h(
      'button',
      {
        type: 'button',
        class: 'button small',
        disabled: busy,
        onclick: async () => {
          const text = feedback.value.trim();
          if (!text) {
            feedback.focus();
            return;
          }
          const ok = await act(
            bridge.specs.generate({ name: detail.name, phase, feedback: text }),
            `${Who(detail.agent)} está ajustando ${PHASE[phase].noun}…`,
          );
          if (ok) {
            ks.spec.feedback[`${detail.name}:${phase}`] = '';
            renderSpecs();
          }
        },
      },
      'Refinar com o agente',
    );
    feedback.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        refine.click();
      }
    });

    const next = PHASE[phase].next;
    const approvalBar = h(
      'div',
      { class: 'approve-bar' },
      approval.approved && !approval.stale
        ? [
            h('span', { class: 'approve-done', text: `✓ ${PHASE[phase].approved}` }),
            h(
              'button',
              {
                type: 'button',
                class: 'button ghost small',
                disabled: busy,
                onclick: () => {
                  const message = next
                    ? `Reabrir ${PHASE[phase].noun}? As fases seguintes também voltam para revisão.`
                    : `Reabrir ${PHASE[phase].noun}? A execução de tarefas fica bloqueada até aprovar de novo.`;
                  if (!window.confirm(message)) return;
                  act(bridge.specs.approve({ name: detail.name, phase, approved: false }));
                },
              },
              'Reabrir',
            ),
            next
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'button small',
                    onclick: () => selectSpec(detail.name, { doc: next }),
                  },
                  `Ir para ${PHASE[next].label.toLowerCase()} →`,
                )
              : null,
          ]
        : [
            h(
              'span',
              { class: 'muted' },
              next
                ? `Revise o documento. Ao aprovar, ${who(detail.agent)} gera ${PHASE[next].noun}.`
                : 'Revise o plano. Ao aprovar, as tarefas ficam liberadas para execução.',
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'button primary',
                disabled: busy,
                onclick: () => approvePhase(detail, phase),
              },
              next ? `Aprovar e gerar ${PHASE[next].label.toLowerCase()}` : 'Aprovar tarefas',
            ),
          ],
    );

    return h(
      'div',
      { class: 'doc-panel' },
      toolbar,
      body,
      h('div', { class: 'refine-box' }, feedback, h('div', { class: 'refine-actions' }, h('span', { class: 'muted mono', text: 'Ctrl+Enter' }), refine)),
      approvalBar,
    );
  }

  async function approvePhase(detail, phase) {
    const summary = await act(bridge.specs.approve({ name: detail.name, phase, approved: true }));
    if (!summary) return;
    const next = PHASE[phase].next;
    if (!next) {
      toast('Tarefas aprovadas. Já pode executar a implementação.');
      return;
    }
    ks.spec.doc = next;
    const docExists = summary.docs[next].exists;
    if (docExists) {
      toast(`${PHASE[phase].approved}.`);
      renderSpecs();
      return;
    }
    await act(
      bridge.specs.generate({ name: detail.name, phase: next }),
      `${PHASE[phase].approved}. ${Who(detail.agent)} está escrevendo ${PHASE[next].noun}…`,
    );
  }

  function renderTasks(detail, run) {
    const tasks = detail.tasks;
    const approved = detail.approvals.tasks.approved;
    const progress = detail.progress;
    if (tasks.length === 0) {
      return h(
        'div',
        { class: 'doc-content' },
        h('p', { class: 'muted', text: 'Nenhuma tarefa no formato "- [ ] 1. Título" foi encontrada. Conteúdo do arquivo:' }),
        renderMarkdown(detail.content.tasks),
      );
    }

    const runningTask = run && run.kind === 'task' ? run.taskId : null;
    const header = h(
      'div',
      { class: 'tasks-head' },
      h(
        'div',
        { class: 'tasks-progress' },
        progressBar(progress.requiredDone, progress.requiredTotal),
        h(
          'span',
          { class: 'muted' },
          `${progress.requiredDone} de ${progress.requiredTotal} obrigatórias`,
          progress.total > progress.requiredTotal
            ? ` · ${progress.total - progress.requiredTotal} ${progress.total - progress.requiredTotal === 1 ? 'opcional' : 'opcionais'}`
            : '',
        ),
      ),
      h(
        'div',
        { class: 'tasks-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'button small',
            disabled: !approved || Boolean(run) || !detail.next,
            onclick: () =>
              act(bridge.specs.runTask({ name: detail.name, taskId: detail.next.id }), `Executando a tarefa ${detail.next.number || ''}…`),
          },
          'Executar próxima',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'button primary small',
            disabled: !approved || Boolean(run) || !detail.next,
            onclick: () => {
              if (!window.confirm('Executar todas as tarefas obrigatórias pendentes, uma após a outra? A sequência para no primeiro erro.')) return;
              act(bridge.specs.runAll({ name: detail.name }), 'Executando todas as tarefas pendentes…');
            },
          },
          'Executar todas',
        ),
      ),
    );

    const rows = tasks.map((task) => {
      const isRunning = runningTask === task.id;
      const checkbox = h(
        'button',
        {
          type: 'button',
          class: `task-check ${task.status}`,
          role: 'checkbox',
          'aria-checked': task.status === 'done' ? 'true' : task.status === 'in_progress' ? 'mixed' : 'false',
          'aria-label': `Marcar ${task.number || ''} ${task.title}`,
          disabled: isRunning,
          onclick: () =>
            act(
              bridge.specs.setTaskStatus({
                name: detail.name,
                taskId: task.id,
                status: task.status === 'done' ? 'todo' : 'done',
              }),
            ),
        },
        task.status === 'done' ? '✓' : task.status === 'in_progress' ? '•' : '',
      );
      const canRun = approved && !run && task.status !== 'done';
      return h(
        'li',
        { class: `task-row depth-${Math.min(task.depth, 3)} ${task.status}${isRunning ? ' running' : ''}` },
        checkbox,
        h(
          'div',
          { class: 'task-main' },
          h(
            'div',
            { class: 'task-title' },
            task.number ? h('span', { class: 'task-number mono', text: task.number }) : null,
            h('span', {}, inline(task.title)),
            task.optional ? h('span', { class: 'badge mode', text: 'opcional' }) : null,
          ),
          task.details.length > 0
            ? h('ul', { class: 'task-details' }, task.details.map((detailLine) => h('li', {}, inline(detailLine))))
            : null,
          task.requirements.length > 0
            ? h(
                'div',
                { class: 'task-reqs' },
                h('span', { class: 'muted', text: 'Requisitos' }),
                task.requirements.map((req) => h('span', { class: 'req-chip mono', text: req })),
              )
            : null,
        ),
        h(
          'div',
          { class: 'task-side' },
          isRunning
            ? h('span', { class: 'task-running' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'executando')
            : canRun
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'button ghost small task-run',
                    onclick: () =>
                      act(
                        bridge.specs.runTask({ name: detail.name, taskId: task.id }),
                        `Executando ${task.number ? `a tarefa ${task.number}` : 'a tarefa'}…`,
                      ),
                  },
                  '▶ Executar',
                )
              : null,
        ),
      );
    });

    return h(
      'div',
      { class: 'tasks' },
      header,
      approved ? null : h('div', { class: 'knotice' }, 'Revise o plano e aprove as tarefas para liberar a execução.'),
      h('ol', { class: 'task-list' }, rows),
    );
  }

  /* ---------- Hooks ---------- */

  function renderHooks() {
    rerender(byId('hook-list'), renderHookList);
    rerender(byId('hook-detail'), renderHookDetailPane);
  }

  function hookById(id) {
    return ks.data.hooks.find((hook) => hook.id === id) || null;
  }

  function triggerSummary(hook) {
    const trigger = TRIGGER_BY_TYPE[hook.when.type];
    return h(
      'span',
      { class: 'trigger-chip' },
      h('span', { class: 'trigger-icon', 'aria-hidden': 'true', text: trigger?.icon || '?' }),
      trigger?.label || hook.when.type,
      hook.when.patterns.length > 0 ? h('span', { class: 'mono', text: ` ${hook.when.patterns.join(', ')}` }) : null,
    );
  }

  function actionSummary(hook) {
    if (hook.then.type === 'runCommand') {
      return h('span', { class: 'action-chip' }, h('span', { class: 'mono', text: `$ ${hook.then.command}` }));
    }
    const target =
      hook.when.type === 'agentStop' && !hook.then.agent
        ? ['ao ', 'mesmo agente']
        : !hook.then.agent || hook.then.agent === '__general__'
          ? ['ao ', 'agente padrão']
          : ['a ', hook.then.agent];
    return h('span', { class: 'action-chip' }, `Pedir ${target[0]}`, h('strong', { text: target[1] }));
  }

  function toggleSwitch(hook) {
    return h('button', {
      type: 'button',
      class: `switch${hook.enabled ? ' on' : ''}`,
      role: 'switch',
      'aria-checked': String(hook.enabled),
      'aria-label': hook.enabled ? `Desativar ${hook.name}` : `Ativar ${hook.name}`,
      onclick: (event) => {
        event.stopPropagation();
        act(bridge.hooks.toggle({ id: hook.id, enabled: !hook.enabled }), hook.enabled ? 'Hook desativado.' : 'Hook ativado.');
      },
    });
  }

  function renderHookList() {
    const hooks = ks.data.hooks;
    const nodes = [];
    if (!ks.data.settings.hooksEnabled) {
      nodes.push(h('div', { class: 'knotice' }, 'Hooks desligados em settings.json ("hooks.enabled": false).'));
    }
    if (hooks.length === 0) {
      nodes.push(
        h(
          'div',
          { class: 'list-empty' },
          h('p', { text: 'Nenhum hook ainda.' }),
          h('p', { class: 'muted', text: 'Hooks ficam em .kiro/hooks/*.kiro.hook.' }),
        ),
      );
      return nodes;
    }
    for (const hook of hooks) {
      const active = ks.hook.selected === hook.id;
      nodes.push(
        h(
          'div',
          {
            class: `list-card hook-card${active ? ' active' : ''}${hook.enabled ? '' : ' disabled'}`,
            role: 'button',
            tabindex: '0',
            'aria-current': active ? 'true' : null,
            onclick: () => selectHook(hook.id),
            onkeydown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectHook(hook.id);
              }
            },
          },
          h(
            'div',
            { class: 'list-card-top' },
            toggleSwitch(hook),
            hook.running ? h('span', { class: 'status-dot running', title: 'em execução' }) : null,
            h('span', { class: 'list-card-title', text: hook.name }),
            !hook.trusted ? h('span', { class: 'badge warn', text: 'autorizar' }) : null,
            hook.warning ? h('span', { class: 'badge warn', title: hook.warning, text: '!' }) : null,
          ),
          hook.description ? h('p', { class: 'list-card-desc', text: hook.description }) : null,
          h('div', { class: 'hook-chips' }, triggerSummary(hook), actionSummary(hook)),
          hook.lastRun
            ? h(
                'div',
                { class: 'list-card-foot' },
                pill(hook.lastRun.status),
                h('span', { class: 'muted mono', text: formatDate(hook.lastRun.startedAt) }),
              )
            : null,
        ),
      );
    }
    return nodes;
  }

  function draftFromHook(hook) {
    return {
      previousId: hook ? hook.id : null,
      name: hook ? hook.name : '',
      description: hook ? hook.description : '',
      enabled: hook ? hook.enabled : true,
      when: { type: hook ? hook.when.type : 'fileEdited', patterns: hook ? hook.when.patterns.join('\n') : '' },
      then: {
        type: hook ? hook.then.type : 'askAgent',
        prompt: hook ? hook.then.prompt : '',
        command: hook ? hook.then.command : '',
        agent: hook ? hook.then.agent || '' : '',
        timeoutSec: hook && hook.then.timeoutMs ? String(Math.round(hook.then.timeoutMs / 1000)) : '',
      },
    };
  }

  function selectHook(id) {
    ks.hook.selected = id;
    ks.hook.draft = draftFromHook(id === '__new__' ? null : hookById(id));
    renderHooks();
  }

  function renderHookDetailPane() {
    if (ks.hook.selected && ks.hook.draft) return renderHookEditor();
    return renderHookOverview();
  }

  function renderRuns(runs, { showName = true } = {}) {
    if (runs.length === 0) return h('p', { class: 'muted', text: 'Nenhuma execução ainda.' });
    return h(
      'ol',
      { class: 'run-list' },
      runs.map((run) =>
        h(
          'li',
          { class: `run-row ${run.status}` },
          h(
            'div',
            { class: 'run-top' },
            pill(run.status),
            showName ? h('strong', { text: run.name }) : null,
            h('span', { class: 'muted', text: TRIGGER_BY_TYPE[run.trigger]?.label || run.trigger }),
            run.agent ? h('span', { class: 'muted', text: `· ${agentLabel(run.agent)}` }) : null,
            h(
              'span',
              { class: 'muted mono run-time' },
              `${formatTime(run.startedAt)}${run.finishedAt ? ` · ${formatDuration(run.startedAt, run.finishedAt)}` : ''}`,
            ),
          ),
          run.files.length > 0
            ? h('div', { class: 'run-files mono' }, run.files.slice(0, 6).join('\n') + (run.files.length > 6 ? `\n… +${run.files.length - 6}` : ''))
            : null,
          run.message ? h('div', { class: 'run-message', text: run.message }) : null,
          run.output
            ? h('details', { class: 'run-output' }, h('summary', { text: 'Saída' }), h('pre', { text: run.output }))
            : null,
        ),
      ),
    );
  }

  function renderHookOverview() {
    const warnings = ks.data.warnings || [];
    return h(
      'div',
      { class: 'kstack' },
      h(
        'div',
        { class: 'kcard' },
        h('div', { class: 'kcard-head' }, h('h3', { text: 'Gatilhos disponíveis' })),
        h(
          'ul',
          { class: 'trigger-grid' },
          TRIGGERS.map((trigger) =>
            h(
              'li',
              { class: 'trigger-card static' },
              h('span', { class: 'trigger-icon', 'aria-hidden': 'true', text: trigger.icon }),
              h('strong', { text: trigger.label }),
              h('span', { class: 'muted', text: trigger.hint }),
            ),
          ),
        ),
        h(
          'p',
          { class: 'muted small-print' },
          'Proteções: hooks criados ou alterados fora do Agent Bar só rodam depois de autorizados nesta máquina; edições feitas pelo próprio hook não o disparam de novo; e há um limite de execuções por minuto.',
        ),
      ),
      warnings.length > 0
        ? h(
            'div',
            { class: 'kcard' },
            h('div', { class: 'kcard-head' }, h('h3', { text: 'Avisos' })),
            h('ul', { class: 'warning-list' }, warnings.slice(0, 6).map((item) => h('li', {}, h('span', { class: 'mono muted', text: formatTime(item.at) }), ` ${item.message}`))),
          )
        : null,
      h(
        'div',
        { class: 'kcard' },
        h('div', { class: 'kcard-head' }, h('h3', { text: 'Execuções recentes' })),
        renderRuns(ks.data.hookRuns.slice(0, 20)),
      ),
    );
  }

  function optionCards(name, options, value, onSelect) {
    return h(
      'div',
      { class: 'option-grid', role: 'radiogroup', 'aria-label': name },
      options.map((option) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(option.value === value),
            class: `option-card${option.value === value ? ' selected' : ''}`,
            onclick: () => onSelect(option.value),
          },
          option.icon ? h('span', { class: 'trigger-icon', 'aria-hidden': 'true', text: option.icon }) : null,
          h('strong', { text: option.label }),
          option.hint ? h('span', { class: 'muted', text: option.hint }) : null,
        ),
      ),
    );
  }

  function renderHookEditor() {
    const draft = ks.hook.draft;
    const existing = draft.previousId ? hookById(draft.previousId) : null;
    const trigger = TRIGGER_BY_TYPE[draft.when.type];
    const rerenderEditor = () => rerender(byId('hook-detail'), renderHookDetailPane);

    const name = h('input', { id: 'hook-name', class: 'input', type: 'text', maxlength: '120', value: draft.name, placeholder: 'Ex.: Atualizar testes ao salvar' });
    name.addEventListener('input', () => {
      draft.name = name.value;
    });
    const description = h('input', { id: 'hook-description', class: 'input', type: 'text', maxlength: '1000', value: draft.description, placeholder: 'Opcional' });
    description.addEventListener('input', () => {
      draft.description = description.value;
    });
    const patterns = h('textarea', {
      id: 'hook-patterns',
      class: 'input textarea mono',
      rows: '3',
      value: draft.when.patterns,
      placeholder: 'APP/lib/**/*.dart\nAPI/app/**/*.php',
    });
    patterns.addEventListener('input', () => {
      draft.when.patterns = patterns.value;
    });

    const actionFields = [];
    if (draft.then.type === 'askAgent') {
      const prompt = h('textarea', {
        id: 'hook-prompt',
        class: 'input textarea',
        rows: '6',
        value: draft.then.prompt,
        placeholder:
          draft.when.type === 'promptSubmit'
            ? 'Ex.: Responda sempre em português e cite os arquivos alterados.'
            : 'Ex.: Revise o arquivo alterado e atualize os testes unitários correspondentes. Rode os testes no final.',
      });
      prompt.addEventListener('input', () => {
        draft.then.prompt = prompt.value;
      });
      if (draft.when.type !== 'promptSubmit') {
        actionFields.push(
          field(
            'Agente',
            agentSelect(
              'hook-agent',
              draft.then.agent || (draft.when.type === 'agentStop' ? '' : '__general__'),
              (value) => {
                draft.then.agent = value;
              },
              { extra: draft.when.type === 'agentStop' ? [{ value: '', label: 'Mesmo agente que terminou' }] : [] },
            ),
          ),
        );
      }
      actionFields.push(
        field(
          draft.when.type === 'promptSubmit' ? 'Instruções anexadas ao prompt' : 'Instruções para o agente',
          prompt,
          draft.when.type === 'promptSubmit'
            ? 'Vão junto de todo prompt enviado pelo Agent Bar (não se aplica a comandos /).'
            : 'O agente recebe também o gatilho e a lista de arquivos envolvidos.',
        ),
      );
    } else {
      const command = h('input', { id: 'hook-command', class: 'input mono', type: 'text', value: draft.then.command, placeholder: 'Ex.: cd APP && fvm flutter analyze' });
      command.addEventListener('input', () => {
        draft.then.command = command.value;
      });
      const timeout = h('input', { id: 'hook-timeout', class: 'input', type: 'number', min: '1', max: '1800', value: draft.then.timeoutSec, placeholder: '120' });
      timeout.addEventListener('input', () => {
        draft.then.timeoutSec = timeout.value;
      });
      actionFields.push(
        field(
          'Comando',
          command,
          'Roda no shell do sistema, na raiz do projeto. Variáveis: AGENT_BAR_FILES (um arquivo por linha), AGENT_BAR_TRIGGER e AGENT_BAR_HOOK.',
        ),
        field(
          'Tempo limite (segundos)',
          timeout,
          draft.when.type === 'promptSubmit' ? 'No envio de prompt o limite é 30 s; a saída vai anexada ao prompt.' : null,
        ),
      );
    }

    const enabled = h('input', { id: 'hook-enabled', type: 'checkbox', checked: draft.enabled });
    enabled.addEventListener('change', () => {
      draft.enabled = enabled.checked;
    });

    const save = h('button', { type: 'button', class: 'button primary' }, draft.previousId ? 'Salvar' : 'Criar hook');
    save.addEventListener('click', async () => {
      const timeoutSec = Number(draft.then.timeoutSec);
      const payload = {
        previousId: draft.previousId,
        hook: {
          name: draft.name,
          description: draft.description,
          enabled: draft.enabled,
          when: { type: draft.when.type, patterns: draft.when.patterns },
          then: {
            type: draft.then.type,
            prompt: draft.then.prompt,
            command: draft.then.command,
            agent: draft.then.agent && draft.then.agent !== '__general__' ? draft.then.agent : null,
            timeoutMs: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : null,
          },
        },
      };
      save.disabled = true;
      const saved = await act(bridge.hooks.save(payload), draft.previousId ? 'Hook salvo.' : 'Hook criado.');
      save.disabled = false;
      if (saved) {
        ks.hook.selected = saved.id;
        ks.hook.draft = draftFromHook(saved);
      }
    });

    const runs = existing ? ks.data.hookRuns.filter((run) => run.hookId === existing.id) : [];

    return h(
      'div',
      { class: 'kstack' },
      h(
        'div',
        { class: 'kcard' },
        h(
          'div',
          { class: 'kcard-head' },
          h('h3', { text: draft.previousId ? 'Editar hook' : 'Novo hook' }),
          existing ? h('span', { class: 'mono muted', text: existing.file }) : h('span', { class: 'mono muted', text: '.kiro/hooks/<nome>.kiro.hook' }),
        ),
        existing && !existing.trusted
          ? h(
              'div',
              { class: 'knotice warn' },
              h('span', {}, 'Este hook foi criado ou alterado fora do Agent Bar e não roda até você autorizar. Confira o gatilho e a ação abaixo.'),
              h(
                'button',
                { type: 'button', class: 'button small', onclick: () => act(bridge.hooks.authorize(existing.id), 'Hook autorizado.') },
                'Autorizar',
              ),
            )
          : null,
        existing && existing.warning ? h('div', { class: 'knotice error' }, existing.warning) : null,
        field('Nome', name),
        field('Descrição', description),
        h('div', { class: 'kfield' }, h('span', { class: 'kfield-label', text: 'Quando' }), optionCards(
          'Gatilho',
          TRIGGERS.map((item) => ({ value: item.type, label: item.label, icon: item.icon, hint: item.hint })),
          draft.when.type,
          (value) => {
            draft.when.type = value;
            rerenderEditor();
          },
        )),
        trigger?.files
          ? field('Padrões de arquivo', patterns, 'Um por linha, relativos ao projeto. ** = qualquer pasta. Padrão sem "/" (ex.: *.dart) casa pelo nome em qualquer pasta.')
          : null,
        h('div', { class: 'kfield' }, h('span', { class: 'kfield-label', text: 'Então' }), optionCards(
          'Ação',
          [
            { value: 'askAgent', label: 'Pedir ao agente', icon: '✦', hint: 'Um agente do OpenCode executa as instruções.' },
            { value: 'runCommand', label: 'Rodar comando', icon: '$', hint: 'Executa um comando de shell e guarda a saída.' },
          ],
          draft.then.type,
          (value) => {
            draft.then.type = value;
            rerenderEditor();
          },
        )),
        actionFields,
        h('label', { class: 'check-row' }, enabled, h('span', { text: 'Ativo' })),
        h(
          'div',
          { class: 'kactions' },
          existing
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'button danger',
                  onclick: async () => {
                    if (!window.confirm(`Apagar o hook "${existing.name}"?`)) return;
                    const ok = await act(bridge.hooks.remove(existing.id), 'Hook apagado.');
                    if (ok) {
                      ks.hook.selected = null;
                      ks.hook.draft = null;
                    }
                  },
                },
                'Apagar',
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              class: 'button ghost',
              onclick: () => {
                ks.hook.selected = null;
                ks.hook.draft = null;
                renderHooks();
              },
            },
            'Fechar',
          ),
          h('span', { class: 'kactions-spacer' }),
          existing
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'button',
                  disabled: existing.running,
                  title: 'Roda agora, sem arquivos de gatilho',
                  onclick: () => act(bridge.hooks.run(existing.id), 'Hook disparado.'),
                },
                '▶ Executar agora',
              )
            : null,
          save,
        ),
      ),
      existing
        ? h('div', { class: 'kcard' }, h('div', { class: 'kcard-head' }, h('h3', { text: 'Execuções deste hook' })), renderRuns(runs, { showName: false }))
        : null,
    );
  }

  /* ---------- Steering ---------- */

  function renderSteering() {
    rerender(byId('steering-list'), renderSteeringList);
    rerender(byId('steering-detail'), renderSteeringDetailPane);
  }

  function steeringById(id) {
    return ks.data.steering.find((doc) => doc.id === id) || null;
  }

  function firstLine(body) {
    const line = String(body || '')
      .split('\n')
      .map((item) => item.replace(/^#+\s*/, '').trim())
      .find(Boolean);
    return line ? line.slice(0, 140) : 'Documento vazio';
  }

  function inclusionChip(doc) {
    return h(
      'span',
      { class: `inclusion-chip ${doc.inclusion}` },
      INCLUSION[doc.inclusion]?.label || doc.inclusion,
      doc.inclusion === 'fileMatch' && doc.patterns.length > 0 ? h('span', { class: 'mono', text: ` ${doc.patterns.join(', ')}` }) : null,
      doc.inclusion === 'manual' ? h('span', { class: 'mono', text: ` #${doc.name}` }) : null,
    );
  }

  function renderSteeringList() {
    const docs = ks.data.steering;
    const nodes = [];
    if (!ks.data.settings.steeringEnabled) {
      nodes.push(h('div', { class: 'knotice' }, 'Steering desligado em settings.json ("steering.enabled": false).'));
    }
    if (docs.length === 0) {
      nodes.push(
        h(
          'div',
          { class: 'list-empty' },
          h('p', { text: 'Nenhum documento ainda.' }),
          h('p', { class: 'muted', text: 'Projeto: .kiro/steering/ · Global: ~/.kiro/steering/' }),
        ),
      );
      return nodes;
    }
    for (const origin of ['project', 'global']) {
      const group = docs.filter((doc) => doc.origin === origin);
      if (group.length === 0) continue;
      nodes.push(h('div', { class: 'list-group-title', text: origin === 'project' ? 'Projeto' : 'Global' }));
      for (const doc of group) {
        const active = ks.steering.selected === doc.id;
        nodes.push(
          h(
            'button',
            {
              type: 'button',
              class: `list-card${active ? ' active' : ''}${doc.shadowed ? ' disabled' : ''}`,
              'aria-current': active ? 'true' : null,
              onclick: () => selectSteering(doc.id),
            },
            h(
              'div',
              { class: 'list-card-top' },
              h('span', { class: 'list-card-title mono', text: `${doc.name}.md` }),
              doc.warning ? h('span', { class: 'badge warn', title: doc.warning, text: '!' }) : null,
              doc.shadowed ? h('span', { class: 'badge mode', title: 'Um documento do projeto com o mesmo nome tem precedência.', text: 'sobrescrito' }) : null,
            ),
            h('div', { class: 'list-card-desc', text: firstLine(doc.body) }),
            h('div', { class: 'hook-chips' }, inclusionChip(doc), h('span', { class: 'muted mono', text: `${Math.max(1, Math.round(doc.size / 1024))} KB` })),
          ),
        );
      }
    }
    return nodes;
  }

  function draftFromDoc(doc) {
    return {
      previousId: doc ? doc.id : null,
      origin: doc ? doc.origin : 'project',
      name: doc ? doc.name : '',
      inclusion: doc ? doc.inclusion : 'always',
      patterns: doc ? doc.patterns.join('\n') : '',
      body: doc ? doc.body.replace(/^\n+/, '') : '',
    };
  }

  function selectSteering(id) {
    ks.steering.selected = id;
    ks.steering.draft = draftFromDoc(id === '__new__' ? null : steeringById(id));
    renderSteering();
  }

  function renderSteeringDetailPane() {
    const nodes = [];
    if (ks.steering.selected && ks.steering.draft) nodes.push(renderSteeringEditor());
    else nodes.push(renderSteeringGenerate());
    nodes.push(renderSteeringPreview());
    return h('div', { class: 'kstack' }, nodes);
  }

  function renderSteeringGenerate() {
    const hasBase = ['product', 'tech', 'structure'].every((name) => steeringById(`project:${name}`));
    if (!ks.steering.generateAgent) ks.steering.generateAgent = '__general__';
    return h(
      'div',
      { class: 'kcard' },
      h('div', { class: 'kcard-head' }, h('h3', { text: hasBase ? 'Atualizar documentos base' : 'Gerar documentos base' })),
      h(
        'p',
        { class: 'muted' },
        'Um agente analisa o repositório e escreve ',
        h('code', { text: 'product.md' }),
        ', ',
        h('code', { text: 'tech.md' }),
        ' e ',
        h('code', { text: 'structure.md' }),
        ' em .kiro/steering/ (inclusion: always). Revise o resultado antes de confiar nele.',
      ),
      h(
        'div',
        { class: 'kactions' },
        h(
          'label',
          { class: 'inline-label' },
          h('span', { class: 'muted', text: 'Agente' }),
          agentSelect('steering-generate-agent', ks.steering.generateAgent, (value) => {
            ks.steering.generateAgent = value;
          }),
        ),
        h('span', { class: 'kactions-spacer' }),
        h(
          'button',
          {
            type: 'button',
            class: 'button primary',
            onclick: async () => {
              const agent = ks.steering.generateAgent;
              const ok = await act(
                bridge.steering.generate({ agent }),
                `${Who(agent)} está analisando o projeto…`,
              );
              if (ok) openAgent(agent);
            },
          },
          hasBase ? 'Atualizar com o agente' : 'Gerar com o agente',
        ),
      ),
    );
  }

  function renderSteeringEditor() {
    const draft = ks.steering.draft;
    const existing = draft.previousId ? steeringById(draft.previousId) : null;
    const rerenderEditor = () => rerender(byId('steering-detail'), renderSteeringDetailPane);

    const name = h('input', { id: 'steering-name', class: 'input mono', type: 'text', maxlength: '80', value: draft.name, placeholder: 'api-padroes' });
    name.addEventListener('input', () => {
      draft.name = name.value.replace(/\.md$/i, '');
    });
    const origin = h(
      'select',
      { id: 'steering-origin', class: 'select' },
      h('option', { value: 'project', text: 'Projeto (.kiro/steering/)' }),
      h('option', { value: 'global', text: 'Global (~/.kiro/steering/)' }),
    );
    origin.value = draft.origin;
    origin.addEventListener('change', () => {
      draft.origin = origin.value;
    });
    const patterns = h('textarea', { id: 'steering-patterns', class: 'input textarea mono', rows: '2', value: draft.patterns, placeholder: 'API/**/*.php' });
    patterns.addEventListener('input', () => {
      draft.patterns = patterns.value;
    });
    const body = h('textarea', {
      id: 'steering-body',
      class: 'input textarea mono editor',
      rows: '16',
      spellcheck: 'false',
      value: draft.body,
      placeholder:
        '# Padrões da API\n\n- Controllers finos; regra de negócio em Services.\n- Validação com FormRequest.\n- Respostas JSON com Resources.\n\nContrato completo: #[[file:API/docs/openapi.yaml]]',
    });
    body.addEventListener('input', () => {
      draft.body = body.value;
    });

    const save = h('button', { type: 'button', class: 'button primary' }, existing ? 'Salvar' : 'Criar documento');
    save.addEventListener('click', async () => {
      save.disabled = true;
      const saved = await act(
        bridge.steering.save({
          previousId: draft.previousId,
          origin: draft.origin,
          name: draft.name,
          inclusion: draft.inclusion,
          patterns: draft.patterns,
          body: draft.body,
        }),
        existing ? 'Documento salvo.' : 'Documento criado.',
      );
      save.disabled = false;
      if (saved) {
        ks.steering.selected = saved.id;
        ks.steering.draft = draftFromDoc(saved);
      }
    });

    return h(
      'div',
      { class: 'kcard' },
      h(
        'div',
        { class: 'kcard-head' },
        h('h3', { text: existing ? `${existing.name}.md` : 'Novo documento' }),
        existing ? h('span', { class: 'mono muted', text: existing.origin === 'project' ? `.kiro/steering/${existing.name}.md` : `~/.kiro/steering/${existing.name}.md` }) : null,
      ),
      existing && existing.warning ? h('div', { class: 'knotice error' }, existing.warning) : null,
      existing && existing.shadowed ? h('div', { class: 'knotice' }, 'Há um documento do projeto com o mesmo nome; ele tem precedência sobre este global.') : null,
      h('div', { class: 'kgrid-2' }, field('Nome do arquivo', name, 'Sem .md. Também é o nome usado em #referência.'), field('Local', origin)),
      h('div', { class: 'kfield' }, h('span', { class: 'kfield-label', text: 'Inclusão' }), optionCards(
        'Inclusão',
        Object.entries(INCLUSION).map(([value, item]) => ({ value, label: item.label, hint: item.hint })),
        draft.inclusion,
        (value) => {
          draft.inclusion = value;
          rerenderEditor();
        },
      )),
      draft.inclusion === 'fileMatch'
        ? field('Padrões de arquivo', patterns, 'Um por linha, relativos ao projeto. Ex.: API/**/*.php, **/*.{ts,tsx}')
        : null,
      field('Conteúdo', body, h('span', {}, 'Markdown. Use ', h('code', { text: '#[[file:caminho/do/arquivo]]' }), ' para incluir um arquivo do projeto.')),
      h(
        'div',
        { class: 'kactions' },
        existing
          ? h(
              'button',
              {
                type: 'button',
                class: 'button danger',
                onclick: async () => {
                  if (!window.confirm(`Apagar ${existing.name}.md?`)) return;
                  const ok = await act(bridge.steering.remove(existing.id), 'Documento apagado.');
                  if (ok) {
                    ks.steering.selected = null;
                    ks.steering.draft = null;
                  }
                },
              },
              'Apagar',
            )
          : null,
        existing
          ? h('button', { type: 'button', class: 'button ghost', onclick: () => openFile(existing.file) }, 'Abrir arquivo')
          : null,
        h(
          'button',
          {
            type: 'button',
            class: 'button ghost',
            onclick: () => {
              ks.steering.selected = null;
              ks.steering.draft = null;
              renderSteering();
            },
          },
          'Fechar',
        ),
        h('span', { class: 'kactions-spacer' }),
        save,
      ),
    );
  }

  function renderSteeringPreview() {
    const input = h('textarea', {
      id: 'steering-preview-input',
      class: 'input textarea',
      rows: '2',
      value: ks.steering.previewText,
      placeholder: 'Escreva um prompt de exemplo, ex.: "corrija API/app/Http/Controllers/PostController.php #deploy"',
    });
    input.addEventListener('input', () => {
      ks.steering.previewText = input.value;
    });
    const result = ks.steering.previewResult;
    const run = async () => {
      const value = await act(bridge.steering.preview({ prompt: ks.steering.previewText }));
      if (value) {
        ks.steering.previewResult = value;
        rerender(byId('steering-detail'), renderSteeringDetailPane);
      }
    };
    input.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        run();
      }
    });
    return h(
      'div',
      { class: 'kcard' },
      h('div', { class: 'kcard-head' }, h('h3', { text: 'Simular inclusão' }), h('span', { class: 'muted', text: 'o que vai junto de um prompt' })),
      input,
      h('div', { class: 'kactions' }, h('span', { class: 'kactions-spacer' }), h('button', { type: 'button', class: 'button small', onclick: run }, 'Simular')),
      result
        ? h(
            'div',
            { class: 'preview-result' },
            result.included.length > 0
              ? h(
                  'ul',
                  { class: 'preview-list' },
                  result.included.map((item) =>
                    h('li', {}, h('span', { class: 'mono', text: `${item.name}.md` }), h('span', { class: 'muted', text: ` · ${item.reason}` })),
                  ),
                )
              : h('p', { class: 'muted', text: 'Nenhum documento entraria neste prompt.' }),
            result.onDemand.length > 0
              ? h(
                  'p',
                  { class: 'muted small-print' },
                  'Sob demanda (o agente é avisado para ler se precisar): ',
                  result.onDemand.map((item) => `${item.name}.md`).join(', '),
                )
              : null,
            result.omitted.length > 0
              ? h('p', { class: 'muted small-print', text: `Omitidos pelo limite de tamanho: ${result.omitted.map((item) => item.name).join(', ')}` })
              : null,
            result.contextFiles.length > 0
              ? h('p', { class: 'muted small-print' }, 'Arquivos detectados no prompt: ', h('span', { class: 'mono', text: result.contextFiles.join(', ') }))
              : null,
            h('p', { class: 'muted small-print mono', text: `${result.chars.toLocaleString('pt-BR')} caracteres de contexto` }),
          )
        : null,
    );
  }

  /* ---------- Dados ---------- */

  let detailTimer = null;
  function applyData(data) {
    ks.data = data;
    renderNav();

    const latest = data.warnings?.[0];
    if (latest && latest.at !== ks.lastWarningAt) {
      if (ks.lastWarningAt !== null) toast(latest.message, 'error');
      ks.lastWarningAt = latest.at;
    } else if (!latest && ks.lastWarningAt === null) {
      ks.lastWarningAt = '';
    }

    if (ks.spec.selected && !data.specs.some((spec) => spec.name === ks.spec.selected)) {
      ks.spec.selected = null;
      ks.spec.detail = null;
    }
    if (ks.hook.selected && ks.hook.selected !== '__new__' && !data.hooks.some((hook) => hook.id === ks.hook.selected)) {
      ks.hook.selected = null;
      ks.hook.draft = null;
    }
    if (ks.steering.selected && ks.steering.selected !== '__new__' && !data.steering.some((doc) => doc.id === ks.steering.selected)) {
      ks.steering.selected = null;
      ks.steering.draft = null;
    }

    if (ks.view === 'specs') {
      rerender(byId('spec-list'), renderSpecList);
      if (ks.spec.selected) {
        clearTimeout(detailTimer);
        detailTimer = setTimeout(loadSpecDetail, 120);
      } else {
        rerender(byId('spec-detail'), renderSpecDetailPane);
      }
    } else if (ks.view === 'hooks') {
      rerender(byId('hook-list'), renderHookList);
      // O editor mantém o rascunho; só redesenha o painel quando não há edição aberta
      // ou para atualizar autorização/execuções do hook aberto.
      rerender(byId('hook-detail'), renderHookDetailPane);
    } else if (ks.view === 'steering') {
      rerender(byId('steering-list'), renderSteeringList);
      if (!ks.steering.selected) rerender(byId('steering-detail'), renderSteeringDetailPane);
    }
  }

  function bind() {
    document.querySelectorAll('.view-tab').forEach((tab) => {
      tab.addEventListener('click', () => setView(tab.dataset.view));
    });
    byId('spec-new-button').addEventListener('click', startNewSpec);
    byId('hook-new-button').addEventListener('click', () => {
      selectHook('__new__');
      setTimeout(() => byId('hook-name')?.focus(), 30);
    });
    byId('steering-new-button').addEventListener('click', () => {
      selectSteering('__new__');
      setTimeout(() => byId('steering-name')?.focus(), 30);
    });
    document.addEventListener('keydown', (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const view = { 1: 'agents', 2: 'specs', 3: 'hooks', 4: 'steering' }[event.key];
      if (view) {
        event.preventDefault();
        setView(view);
      }
    });

    bridge.kiro.onUpdated(applyData);
    bridge.kiro.onNotice((notice) => {
      if (notice?.message) toast(notice.message, notice.type === 'error' ? 'error' : '');
    });
    bridge.onAgentsUpdated(() => {
      if (ks.view !== 'agents' && ks.data) renderCurrent();
    });
  }

  async function init() {
    bind();
    let view = 'agents';
    try {
      view = localStorage.getItem(VIEW_KEY) || 'agents';
    } catch {
      // armazenamento indisponível
    }
    // Troca de aba antes de os dados chegarem: applyData desenha a aba atual.
    setView(view);
    try {
      applyData(await bridge.kiro.state());
    } catch (error) {
      toast(`Specs/hooks/steering: ${cleanError(error)}`, 'error');
    }
  }

  init();
})();
