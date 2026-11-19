'use strict';

/*
 * Steering no formato do Kiro: arquivos Markdown em `.kiro/steering/` (projeto)
 * e `~/.kiro/steering/` (global), com frontmatter opcional:
 *
 *   ---
 *   inclusion: always | fileMatch | manual     (padrão: always)
 *   fileMatchPattern: "API/**\/*.php"           (só para fileMatch; aceita lista)
 *   ---
 *
 * - always:    entra em todo prompt enviado pelo Agent Bar;
 * - fileMatch: entra quando um arquivo do contexto casa com o padrão (arquivos
 *              citados no prompt, arquivos que dispararam um hook, arquivos da
 *              spec). Os que não entram viram um índice "leia se precisar";
 * - manual:    entra quando o prompt cita `#nome-do-arquivo`.
 *
 * Dentro do documento, `#[[file:caminho/relativo]]` é substituído pelo conteúdo
 * do arquivo (limitado ao projeto). Documento do projeto com o mesmo nome de um
 * global tem precedência.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseFrontmatter } = require('./frontmatter');
const { matchAny, toPatternList, normalizePath } = require('./glob');

const INCLUSIONS = ['always', 'fileMatch', 'manual'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const FILE_REF_RE = /#\[\[file:([^\]\n]+)\]\]/g;
const MANUAL_REF_RE = /(^|[\s(,;])#([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const PATH_TOKEN_RE = /(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@-][A-Za-z0-9_@.-]*\.[A-Za-z0-9]{1,10}\b|(?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@.-]+/g;
const MAX_REF_BYTES = 50 * 1024;

function defaultGlobalDir() {
  return path.join(os.homedir(), '.kiro', 'steering');
}

function normalizeName(value) {
  const name = String(value || '')
    .trim()
    .replace(/\.md$/i, '');
  if (!NAME_RE.test(name)) {
    throw new Error(
      'Nome inválido: use letras, números, ponto, hífen ou sublinhado (até 80 caracteres).',
    );
  }
  return name;
}

function parseInclusion(data) {
  if (data.inclusion === undefined || data.inclusion === '') {
    return { inclusion: 'always', warning: null };
  }
  const raw = String(data.inclusion).trim();
  const found = INCLUSIONS.find((item) => item.toLowerCase() === raw.toLowerCase());
  if (found) return { inclusion: found, warning: null };
  return {
    inclusion: 'manual',
    warning: `inclusion "${raw}" não é suportado; tratado como manual.`,
  };
}

function readDoc(file, origin) {
  const raw = fs.readFileSync(file, 'utf8');
  const stat = fs.statSync(file);
  const parsed = parseFrontmatter(raw);
  const { inclusion, warning: inclusionWarning } = parseInclusion(parsed.data);
  const patterns = toPatternList(parsed.data.fileMatchPattern);
  const warnings = [parsed.warning, inclusionWarning].filter(Boolean);
  if (inclusion === 'fileMatch' && patterns.length === 0) {
    warnings.push('inclusion fileMatch sem fileMatchPattern; o documento nunca será incluído.');
  }
  const name = path.basename(file).replace(/\.md$/i, '');
  return {
    id: `${origin}:${name}`,
    name,
    file,
    origin,
    inclusion,
    patterns,
    description: typeof parsed.data.description === 'string' ? parsed.data.description : '',
    body: parsed.body,
    size: Buffer.byteLength(raw),
    mtimeMs: stat.mtimeMs,
    warning: warnings.length > 0 ? warnings.join(' ') : null,
    shadowed: false,
  };
}

function listMarkdown(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function serialize({ inclusion, patterns, description, body }) {
  const lines = ['---', `inclusion: ${inclusion}`];
  if (inclusion === 'fileMatch') {
    const list = patterns.length === 1 ? JSON.stringify(patterns[0]) : JSON.stringify(patterns);
    lines.push(`fileMatchPattern: ${list}`);
  }
  if (description) lines.push(`description: ${JSON.stringify(description)}`);
  lines.push('---', '');
  const content = String(body || '').replace(/^\s*\n/, '');
  return `${lines.join('\n')}\n${content.endsWith('\n') ? content : `${content}\n`}`;
}

class SteeringStore {
  constructor({ projectDir, globalDir = defaultGlobalDir(), maxChars = 60_000 }) {
    this.projectDir = projectDir;
    this.globalDir = globalDir;
    this.maxChars = maxChars;
  }

  get projectSteeringDir() {
    return path.join(this.projectDir, '.kiro', 'steering');
  }

  dirFor(origin) {
    if (origin === 'project') return this.projectSteeringDir;
    if (origin === 'global') return this.globalDir;
    throw new Error('Local de steering inválido.');
  }

  list() {
    const docs = [];
    for (const [dir, origin] of [
      [this.projectSteeringDir, 'project'],
      [this.globalDir, 'global'],
    ]) {
      for (const file of listMarkdown(dir)) {
        try {
          docs.push(readDoc(file, origin));
        } catch (error) {
          docs.push({
            id: `${origin}:${path.basename(file, '.md')}`,
            name: path.basename(file, '.md'),
            file,
            origin,
            inclusion: 'manual',
            patterns: [],
            description: '',
            body: '',
            size: 0,
            mtimeMs: 0,
            warning: `Falha ao ler: ${error.message}`,
            shadowed: false,
          });
        }
      }
    }
    const projectNames = new Set(docs.filter((doc) => doc.origin === 'project').map((doc) => doc.name));
    for (const doc of docs) {
      if (doc.origin === 'global' && projectNames.has(doc.name)) doc.shadowed = true;
    }
    return docs;
  }

  get(id) {
    const doc = this.list().find((item) => item.id === id);
    if (!doc) throw new Error('Documento de steering não encontrado.');
    return doc;
  }

  save(input = {}) {
    const origin = input.origin === 'global' ? 'global' : 'project';
    const name = normalizeName(input.name);
    const inclusion = INCLUSIONS.includes(input.inclusion) ? input.inclusion : 'always';
    const patterns = toPatternList(input.patterns);
    if (inclusion === 'fileMatch' && patterns.length === 0) {
      throw new Error('Informe ao menos um padrão de arquivo para inclusion fileMatch.');
    }
    const body = String(input.body ?? '');
    if (body.length > 200_000) throw new Error('Documento grande demais (máx. 200 mil caracteres).');

    const dir = this.dirFor(origin);
    const file = path.join(dir, `${name}.md`);
    const id = `${origin}:${name}`;
    const previousId = input.previousId || null;

    if (previousId !== id && fs.existsSync(file)) {
      throw new Error(`Já existe um documento "${name}.md" em ${origin === 'global' ? 'global' : 'projeto'}.`);
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      serialize({ inclusion, patterns, description: String(input.description || '').trim(), body }),
    );

    if (previousId && previousId !== id) {
      try {
        const previous = this.get(previousId);
        fs.rmSync(previous.file, { force: true });
      } catch {
        // o anterior já não existe
      }
    }
    return this.get(id);
  }

  remove(id) {
    const doc = this.get(id);
    fs.rmSync(doc.file, { force: true });
    return { ok: true };
  }

  relative(file) {
    return normalizePath(path.relative(this.projectDir, file));
  }

  /** Caminhos citados no texto que existem (ou poderiam existir) no projeto. */
  pathsFromText(text) {
    const found = new Set();
    for (const match of String(text || '').matchAll(PATH_TOKEN_RE)) {
      let token = match[0].replace(/[.,;:)]+$/, '');
      if (!token) continue;
      if (path.isAbsolute(token)) {
        const rel = path.relative(this.projectDir, token);
        if (rel.startsWith('..')) continue;
        token = rel;
      }
      found.add(normalizePath(token));
    }
    return Array.from(found);
  }

  expandFileRefs(body) {
    return String(body || '').replace(FILE_REF_RE, (_full, target) => {
      const raw = target.trim();
      const resolved = path.resolve(this.projectDir, raw);
      if (resolved !== this.projectDir && !resolved.startsWith(`${this.projectDir}${path.sep}`)) {
        return `[referência ignorada: ${raw} está fora do projeto]`;
      }
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) return `[referência ignorada: ${raw} não é arquivo]`;
        const buffer = fs.readFileSync(resolved);
        const truncated = buffer.length > MAX_REF_BYTES;
        const text = buffer.subarray(0, MAX_REF_BYTES).toString('utf8');
        const ext = path.extname(resolved).slice(1);
        return `\n\`\`\`${ext}\n// ${raw}${truncated ? ' (truncado)' : ''}\n${text}\n\`\`\`\n`;
      } catch {
        return `[referência ignorada: ${raw} não encontrado]`;
      }
    });
  }

  /**
   * Decide quais documentos entram no prompt.
   * `files` são caminhos (relativos ou absolutos) que fazem parte do contexto.
   */
  resolve({ prompt = '', files = [] } = {}) {
    const docs = this.list().filter((doc) => !doc.shadowed);
    const manualRefs = new Set();
    for (const match of String(prompt).matchAll(MANUAL_REF_RE)) {
      manualRefs.add(match[2].replace(/\.md$/i, '').replace(/[.]+$/, ''));
    }
    const contextFiles = new Set(this.pathsFromText(prompt));
    for (const file of files || []) {
      if (!file) continue;
      const rel = path.isAbsolute(file) ? path.relative(this.projectDir, file) : file;
      if (!rel.startsWith('..')) contextFiles.add(normalizePath(rel));
    }
    const fileList = Array.from(contextFiles);

    const included = [];
    const onDemand = [];
    for (const doc of docs) {
      if (doc.inclusion === 'always') {
        included.push({ doc, reason: 'sempre' });
      } else if (doc.inclusion === 'manual') {
        if (manualRefs.has(doc.name)) included.push({ doc, reason: `#${doc.name}` });
      } else if (doc.inclusion === 'fileMatch') {
        const hit = fileList.find((file) => matchAny(doc.patterns, file));
        if (hit) included.push({ doc, reason: `arquivo ${hit}` });
        else if (doc.patterns.length > 0) onDemand.push(doc);
      }
    }

    return this.build(included, onDemand, fileList);
  }

  build(included, onDemand, contextFiles) {
    const sections = [];
    const omitted = [];
    let used = 0;
    for (const { doc, reason } of included) {
      const body = this.expandFileRefs(doc.body).trim();
      const section = `### ${doc.name}.md · ${reason}\n${body}`;
      if (used + section.length > this.maxChars) {
        omitted.push(doc);
        continue;
      }
      used += section.length;
      sections.push(section);
    }

    const index = [
      ...onDemand.map(
        (doc) =>
          `- \`${this.displayPath(doc)}\` — leia antes de mexer em arquivos que casem com: ${doc.patterns.join(', ')}`,
      ),
      ...omitted.map(
        (doc) => `- \`${this.displayPath(doc)}\` — omitido por tamanho; leia o arquivo se for relevante`,
      ),
    ];

    if (sections.length === 0 && index.length === 0) {
      return { text: '', included: [], onDemand: [], omitted: [], contextFiles, chars: 0 };
    }

    const parts = [
      '<steering>',
      'Diretrizes persistentes deste projeto (steering). Siga-as durante toda a tarefa; se alguma conflitar com o pedido, aponte o conflito antes de agir.',
    ];
    if (sections.length > 0) parts.push('', sections.join('\n\n'));
    if (index.length > 0) parts.push('', '### Diretrizes sob demanda', index.join('\n'));
    parts.push('</steering>');
    const text = parts.join('\n');

    return {
      text,
      included: included
        .filter(({ doc }) => !omitted.includes(doc))
        .map(({ doc, reason }) => ({ id: doc.id, name: doc.name, origin: doc.origin, reason })),
      onDemand: onDemand.map((doc) => ({ id: doc.id, name: doc.name, patterns: doc.patterns })),
      omitted: omitted.map((doc) => ({ id: doc.id, name: doc.name })),
      contextFiles,
      chars: text.length,
    };
  }

  displayPath(doc) {
    if (doc.origin === 'project') return this.relative(doc.file);
    return doc.file.replace(os.homedir(), '~');
  }
}

function steeringGeneratePrompt() {
  return [
    'Analise este repositório e crie (ou atualize, se já existirem) os documentos de steering do projeto em `.kiro/steering/`:',
    '',
    '1. `product.md` — propósito do produto, público, principais funcionalidades e regras de negócio importantes.',
    '2. `tech.md` — stack (linguagens, frameworks, bibliotecas e versões relevantes), ferramentas de build, comandos comuns (rodar, testar, lint, build) e restrições técnicas.',
    '3. `structure.md` — organização das pastas, onde fica cada tipo de código, convenções de nomes, padrões de arquitetura e de imports.',
    '',
    'Regras:',
    '- Cada arquivo começa com o frontmatter:',
    '  ---',
    '  inclusion: always',
    '  ---',
    '- Baseie tudo no código real: leia manifestos (package.json, pubspec.yaml, composer.json etc.), configurações e uma amostra representativa do código. Não invente.',
    '- Seja conciso e direto: listas curtas, sem texto de marketing. Cada documento deve caber em uma tela.',
    '- Nunca copie segredos para os documentos: senhas, tokens, chaves de API, credenciais de banco, URLs com credenciais ou valores de arquivos .env. Cite apenas o nome das variáveis quando for útil.',
    '- Se um arquivo já existir, preserve o que continua verdadeiro e corrija o que estiver desatualizado.',
    '- Não altere nenhum outro arquivo do projeto.',
    '',
    'Termine com um resumo de uma linha por arquivo criado ou atualizado.',
  ].join('\n');
}

module.exports = {
  SteeringStore,
  steeringGeneratePrompt,
  INCLUSIONS,
  _private: { serialize, normalizeName, parseInclusion },
};
