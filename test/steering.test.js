'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SteeringStore } = require('../lib/steering');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bar-steering-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  fs.mkdirSync(path.join(projectDir, '.kiro', 'steering'), { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  return { projectDir, globalDir, store: new SteeringStore({ projectDir, globalDir }) };
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('sem frontmatter o documento é always', (t) => {
  const { projectDir, store } = setup(t);
  write(path.join(projectDir, '.kiro', 'steering', 'product.md'), '# Produto\nApp de notícias.');
  const [doc] = store.list();
  assert.equal(doc.inclusion, 'always');
  const resolved = store.resolve({ prompt: 'qualquer coisa' });
  assert.deepEqual(resolved.included.map((item) => item.name), ['product']);
  assert.match(resolved.text, /App de notícias/);
});

test('fileMatch entra só quando um arquivo do contexto casa', (t) => {
  const { projectDir, store } = setup(t);
  write(
    path.join(projectDir, '.kiro', 'steering', 'api.md'),
    '---\ninclusion: fileMatch\nfileMatchPattern: "API/**/*.php"\n---\nUse FormRequest.',
  );
  let resolved = store.resolve({ prompt: 'ajuste o layout do app' });
  assert.equal(resolved.included.length, 0);
  assert.equal(resolved.onDemand[0].name, 'api');
  assert.match(resolved.text, /leia antes de mexer/);

  resolved = store.resolve({ prompt: 'corrija API/app/Http/Controllers/PostController.php' });
  assert.deepEqual(resolved.included.map((item) => item.name), ['api']);

  resolved = store.resolve({ prompt: 'tarefa', files: ['API/routes/web.php'] });
  assert.deepEqual(resolved.included.map((item) => item.name), ['api']);
});

test('fileMatch aceita lista de padrões', (t) => {
  const { projectDir, store } = setup(t);
  write(
    path.join(projectDir, '.kiro', 'steering', 'front.md'),
    '---\ninclusion: fileMatch\nfileMatchPattern: ["**/*.tsx", "**/*.css"]\n---\nFront.',
  );
  assert.deepEqual(store.list()[0].patterns, ['**/*.tsx', '**/*.css']);
  assert.equal(store.resolve({ prompt: 'mude WEB/src/app.css' }).included.length, 1);
});

test('manual entra quando o prompt cita #nome', (t) => {
  const { projectDir, store } = setup(t);
  write(path.join(projectDir, '.kiro', 'steering', 'deploy.md'), '---\ninclusion: manual\n---\nPasso a passo.');
  assert.equal(store.resolve({ prompt: 'faça o deploy' }).included.length, 0);
  assert.equal(store.resolve({ prompt: 'faça o deploy seguindo #deploy' }).included.length, 1);
});

test('documento do projeto sombreia global com o mesmo nome', (t) => {
  const { projectDir, globalDir, store } = setup(t);
  write(path.join(globalDir, 'tech.md'), 'global');
  write(path.join(globalDir, 'style.md'), 'estilo global');
  write(path.join(projectDir, '.kiro', 'steering', 'tech.md'), 'projeto');
  const docs = store.list();
  assert.equal(docs.find((doc) => doc.id === 'global:tech').shadowed, true);
  const resolved = store.resolve({ prompt: 'x' });
  assert.deepEqual(resolved.included.map((item) => item.id).sort(), ['global:style', 'project:tech']);
  assert.doesNotMatch(resolved.text, /\nglobal\n/);
});

test('#[[file:...]] inclui arquivos do projeto e recusa caminhos externos', (t) => {
  const { projectDir, store } = setup(t);
  write(path.join(projectDir, 'docs', 'openapi.yaml'), 'openapi: 3.0.0');
  write(
    path.join(projectDir, '.kiro', 'steering', 'api.md'),
    'Contrato:\n#[[file:docs/openapi.yaml]]\nFora: #[[file:../../etc/passwd]]',
  );
  const { text } = store.resolve({ prompt: 'x' });
  assert.match(text, /openapi: 3\.0\.0/);
  assert.match(text, /fora do projeto/);
});

test('inclusion desconhecido vira manual com aviso', (t) => {
  const { projectDir, store } = setup(t);
  write(path.join(projectDir, '.kiro', 'steering', 'x.md'), '---\ninclusion: auto\n---\nx');
  const [doc] = store.list();
  assert.equal(doc.inclusion, 'manual');
  assert.match(doc.warning, /não é suportado/);
});

test('save grava frontmatter, renomeia e impede duplicata', (t) => {
  const { projectDir, store } = setup(t);
  const doc = store.save({
    origin: 'project',
    name: 'api',
    inclusion: 'fileMatch',
    patterns: 'API/**/*.php',
    body: 'Regras da API',
  });
  const raw = fs.readFileSync(doc.file, 'utf8');
  assert.match(raw, /inclusion: fileMatch/);
  assert.match(raw, /fileMatchPattern: "API\/\*\*\/\*\.php"/);
  assert.deepEqual(store.get('project:api').patterns, ['API/**/*.php']);

  store.save({ origin: 'project', name: 'outro', inclusion: 'always', body: 'x' });
  assert.throws(
    () => store.save({ origin: 'project', name: 'outro', inclusion: 'always', body: 'y' }),
    /Já existe/,
  );

  store.save({ previousId: 'project:api', origin: 'project', name: 'backend', inclusion: 'always', body: 'z' });
  assert.equal(fs.existsSync(path.join(projectDir, '.kiro', 'steering', 'api.md')), false);
  assert.equal(store.get('project:backend').body.trim(), 'z');
  assert.throws(() => store.save({ origin: 'project', name: '../x', body: '' }), /Nome inválido/);
});

test('respeita o limite de tamanho e lista o omitido', (t) => {
  const { projectDir, globalDir } = setup(t);
  const store = new SteeringStore({ projectDir, globalDir, maxChars: 2000 });
  write(path.join(projectDir, '.kiro', 'steering', 'a.md'), 'a'.repeat(1500));
  write(path.join(projectDir, '.kiro', 'steering', 'b.md'), 'b'.repeat(1500));
  const resolved = store.resolve({ prompt: 'x' });
  assert.equal(resolved.included.length, 1);
  assert.equal(resolved.omitted.length, 1);
  assert.match(resolved.text, /omitido por tamanho/);
});
