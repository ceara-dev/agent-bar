'use strict';

process.env.OPENCODE_BIN = '/bin/true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverAll } = require('../lib/discovery');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

test('descobre agentes e comandos com prioridade projeto > global', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bar-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const projectDir = path.join(root, 'project');
  const globalDir = path.join(root, 'global');
  const atlasDir = path.join(root, 'atlas-bar');
  process.env.OPENCODE_CONFIG_DIR = globalDir;

  write(
    path.join(projectDir, '.opencode', 'agent', 'atlas.md'),
    `---
description: Projeto vence
mode: all
model: opencode-go/deepseek
color: "#14B8A6"
---
Instruções do projeto.
`,
  );

  write(
    path.join(projectDir, '.opencode', 'agents', 'cajueiro.md'),
    `---
description: Agente oculto
mode: subagent
---
Instruções.
`,
  );

  write(
    path.join(projectDir, '.opencode', 'agent', 'broken.md'),
    '---\ndescription: frontmatter sem fim\n',
  );

  write(
    path.join(projectDir, '.opencode', 'command', 'atlas.md'),
    `---
description: Planejar
agent: atlas
---
Planeje $ARGUMENTS.
`,
  );

  write(
    path.join(projectDir, '.opencode', 'opencode.json'),
    JSON.stringify({
      agent: {
        'config-agent': { description: 'Veio do JSON', mode: 'primary' },
      },
      command: {
        'config-cmd': { template: 'Comando do JSON', agent: null },
      },
    }),
  );

  write(
    path.join(globalDir, 'agent', 'atlas.md'),
    `---
description: Global não deve vencer
mode: primary
---
Global.
`,
  );

  write(
    path.join(globalDir, 'agent', 'global-only.md'),
    `---
description: Só global
mode: primary
---
Global.
`,
  );

  write(
    path.join(globalDir, 'command', 'globalcmd.md'),
    `---
description: Comando global
---
Faça algo.
`,
  );

  write(
    path.join(globalDir, 'opencode.json'),
    JSON.stringify({
      agent: {
        'global-config-agent': { description: 'Config global' },
      },
    }),
  );

  write(
    path.join(atlasDir, 'agents.json'),
    JSON.stringify({
      atlas: { icon: '🧭', order: 1 },
      cajueiro: { hidden: true },
    }),
  );

  const snapshot = await discoverAll({ projectDir, atlasDir });
  const byName = new Map(snapshot.agents.map((agent) => [agent.name, agent]));

  assert.equal(byName.get('atlas').description, 'Projeto vence');
  assert.equal(byName.get('atlas').origin, 'project');
  assert.equal(byName.get('atlas').icon, '🧭');
  assert.equal(byName.get('atlas').order, 1);
  assert.equal(byName.get('cajueiro').hidden, true);
  assert.equal(byName.get('global-only').origin, 'global');
  assert.equal(byName.get('config-agent').origin, 'project');
  assert.equal(byName.get('global-config-agent').origin, 'global');
  assert.ok(byName.get('broken'));
  assert.match(byName.get('broken').warning, /fechamento/);
  assert.ok(byName.has('build'));
  assert.ok(byName.has('plan'));

  const commands = new Map(snapshot.commands.map((command) => [command.name, command]));
  assert.equal(commands.get('atlas').group, 'atlas');
  assert.equal(commands.get('globalcmd').group, '__general__');
  assert.equal(commands.get('config-cmd').group, '__general__');
  assert.equal(snapshot.opencode.supportsCommandFlag, false);
});
