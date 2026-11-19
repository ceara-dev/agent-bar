'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parseJsonc } = require('./jsonc');
const {
  parseFrontmatter,
  normalizeMode,
  formatModel,
  asString,
} = require('./frontmatter');

const execFileAsync = promisify(execFile);
const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';
const AGENT_DIR_NAMES = ['agent', 'agents'];
const COMMAND_DIR_NAMES = ['command', 'commands'];
// A lista de agentes precisa refletir criação/remoção imediata via fs.watch;
// por isso não reutilizamos a lista entre descobertas.
const CLI_CACHE_MS = 0;

let cliCache = null;
let cliCacheAt = 0;

function resolveGlobalConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return path.resolve(process.env.OPENCODE_CONFIG_DIR);
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  }
  return path.join(os.homedir(), '.config', 'opencode');
}

function getRoots(projectDir) {
  const globalConfigDir = resolveGlobalConfigDir();
  const legacyGlobalDir = path.join(os.homedir(), '.opencode');
  return { globalConfigDir, legacyGlobalDir };
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readText(target) {
  try {
    return await fsp.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

async function listMarkdown(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.mdx?$/i.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function basename(file) {
  return path.basename(file).replace(/\.mdx?$/i, '');
}

function appendWarning(list, message) {
  if (message) list.push(message);
}

function shortError(error) {
  const message = error && error.message ? error.message : String(error);
  return message.split('\n')[0].slice(0, 240);
}

function agentFromFile(file, origin) {
  return readText(file).then((raw) => {
    const fallbackName = basename(file);
    if (raw === null) {
      return {
        name: fallbackName,
        description: '',
        mode: 'all',
        model: null,
        origin,
        hidden: false,
        warning: 'Não foi possível ler o arquivo do agente.',
        sourcePath: file,
        sourceType: 'file',
        color: null,
        icon: null,
      };
    }

    const { data, warning } = parseFrontmatter(raw);
    return {
      name: asString(data.name).trim() || fallbackName,
      description: asString(data.description).trim(),
      mode: normalizeMode(data.mode),
      model: formatModel(data.model),
      origin,
      hidden: data.hidden === true || String(data.hidden).toLowerCase() === 'true',
      warning: warning || null,
      sourcePath: file,
      sourceType: 'file',
      color: asString(data.color).trim() || null,
      icon: asString(data.icon).trim() || null,
    };
  });
}

async function readAgentFiles(dir, origin) {
  const files = await listMarkdown(dir);
  return Promise.all(files.map((file) => agentFromFile(file, origin)));
}

function agentFromConfig(name, value, file, origin, warnings) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    appendWarning(warnings, `${file}: agente "${name}" inválido (esperado objeto).`);
    return {
      name,
      description: '',
      mode: 'all',
      model: null,
      origin,
      hidden: false,
      warning: 'Definição de agente inválida em opencode.json.',
      sourcePath: file,
      sourceType: 'config',
      color: null,
      icon: null,
    };
  }

  return {
    name: asString(value.name).trim() || name,
    description: asString(value.description).trim(),
    mode: normalizeMode(value.mode),
    model: formatModel(value.model),
    origin,
    hidden: value.hidden === true || value.disable === true,
    warning: null,
    sourcePath: file,
    sourceType: 'config',
    color: asString(value.color).trim() || null,
    icon: asString(value.icon).trim() || null,
  };
}

function commandsFromConfig(name, value, file, origin, warnings) {
  if (typeof value === 'string') {
    return {
      name,
      description: '',
      agent: null,
      template: value,
      origin,
      warning: null,
      sourcePath: file,
      sourceType: 'config',
      argumentHint: '',
    };
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    appendWarning(warnings, `${file}: comando "${name}" inválido.`);
    return {
      name,
      description: '',
      agent: null,
      template: '',
      origin,
      warning: 'Definição de comando inválida em opencode.json.',
      sourcePath: file,
      sourceType: 'config',
      argumentHint: '',
    };
  }

  return {
    name: asString(value.name).trim() || name,
    description: asString(value.description).trim(),
    agent: asString(value.agent).trim() || null,
    template: asString(value.template),
    origin,
    warning: null,
    sourcePath: file,
    sourceType: 'config',
    argumentHint: asString(value.argumentHint || value['argument-hint']).trim(),
  };
}

function commandFromFile(file, origin) {
  return readText(file).then((raw) => {
    const fallbackName = basename(file);
    if (raw === null) {
      return {
        name: fallbackName,
        description: '',
        agent: null,
        template: '',
        origin,
        warning: 'Não foi possível ler o arquivo do comando.',
        sourcePath: file,
        sourceType: 'file',
        argumentHint: '',
      };
    }

    const { data, body, warning } = parseFrontmatter(raw);
    return {
      name: asString(data.name).trim() || fallbackName,
      description: asString(data.description).trim(),
      agent: asString(data.agent).trim() || null,
      template: body,
      origin,
      warning: warning || null,
      sourcePath: file,
      sourceType: 'file',
      argumentHint: asString(data['argument-hint'] || data.argumentHint).trim(),
    };
  });
}

async function readCommandFiles(dir, origin) {
  const files = await listMarkdown(dir);
  return Promise.all(files.map((file) => commandFromFile(file, origin)));
}

function configCandidates(projectDir, globalConfigDir, legacyGlobalDir) {
  return [
    { file: path.join(projectDir, 'opencode.json'), origin: 'project' },
    { file: path.join(projectDir, 'opencode.jsonc'), origin: 'project' },
    { file: path.join(projectDir, '.opencode', 'opencode.json'), origin: 'project' },
    { file: path.join(projectDir, '.opencode', 'opencode.jsonc'), origin: 'project' },
    { file: path.join(legacyGlobalDir, 'opencode.json'), origin: 'global' },
    { file: path.join(legacyGlobalDir, 'opencode.jsonc'), origin: 'global' },
    { file: path.join(globalConfigDir, 'opencode.json'), origin: 'global' },
    { file: path.join(globalConfigDir, 'opencode.jsonc'), origin: 'global' },
  ];
}

async function readConfig(file, origin, warnings) {
  const raw = await readText(file);
  if (raw === null) return { agents: [], commands: [], exists: false };

  const { value, error } = parseJsonc(raw, file);
  if (error) {
    appendWarning(warnings, error);
    return { agents: [], commands: [], exists: true };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    appendWarning(warnings, `${file}: configuração deve ser um objeto.`);
    return { agents: [], commands: [], exists: true };
  }

  const agents = [];
  const commands = [];

  if (value.agent) {
    if (Array.isArray(value.agent)) {
      for (const item of value.agent) {
        if (!item || typeof item !== 'object') continue;
        const name = asString(item.name || item.id).trim();
        if (!name) {
          appendWarning(warnings, `${file}: agente sem nome na chave "agent".`);
          continue;
        }
        agents.push(agentFromConfig(name, item, file, origin, warnings));
      }
    } else if (typeof value.agent === 'object') {
      for (const [name, item] of Object.entries(value.agent)) {
        agents.push(agentFromConfig(name, item, file, origin, warnings));
      }
    } else {
      appendWarning(warnings, `${file}: chave "agent" deve ser um objeto.`);
    }
  }

  if (value.command) {
    if (Array.isArray(value.command)) {
      for (const item of value.command) {
        if (!item || typeof item !== 'object') continue;
        const name = asString(item.name).trim();
        if (!name) continue;
        commands.push(commandsFromConfig(name, item, file, origin, warnings));
      }
    } else if (typeof value.command === 'object') {
      for (const [name, item] of Object.entries(value.command)) {
        commands.push(commandsFromConfig(name, item, file, origin, warnings));
      }
    } else {
      appendWarning(warnings, `${file}: chave "command" deve ser um objeto.`);
    }
  }

  return { agents, commands, exists: true };
}

function mergeByName(lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list) {
      if (!item || !item.name) continue;
      map.set(item.name, item);
    }
  }
  return Array.from(map.values());
}

async function getCliInfo(projectDir) {
  const now = Date.now();
  if (cliCache && now - cliCacheAt < CLI_CACHE_MS) return cliCache;

  const info = {
    available: false,
    version: null,
    supportsCommandFlag: false,
    agentList: null,
    agentListSource: null,
    warnings: [],
  };

  try {
    const { stdout } = await execFileAsync(OPENCODE_BIN, ['--version'], {
      cwd: projectDir,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    info.version = stdout.trim();
    info.available = true;
  } catch (error) {
    info.warnings.push(`OpenCode CLI não encontrado: ${shortError(error)}`);
    cliCache = info;
    cliCacheAt = now;
    return info;
  }

  try {
    const { stdout } = await execFileAsync(OPENCODE_BIN, ['run', '--help'], {
      cwd: projectDir,
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    });
    info.supportsCommandFlag = /(^|\s)--command\b/m.test(stdout);
  } catch (error) {
    info.warnings.push(`Não foi possível ler opencode run --help: ${shortError(error)}`);
  }

  // Versões novas podem expor `opencode agent list`.
  try {
    const { stdout } = await execFileAsync(OPENCODE_BIN, ['agent', 'list'], {
      cwd: projectDir,
      timeout: 4000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    const list = Array.isArray(parsed) ? parsed : parsed.data;
    if (Array.isArray(list)) {
      info.agentList = list;
      info.agentListSource = 'opencode agent list';
    }
  } catch {
    // Comando inexistente ou saída não JSON: cai para a API.
  }

  // Fallback para a API do serviço, que cobre agentes embutidos.
  if (!info.agentList) {
    try {
      const query = `/api/agent?location%5Bdirectory%5D=${encodeURIComponent(projectDir)}`;
      const { stdout } = await execFileAsync(OPENCODE_BIN, ['api', 'get', query], {
        cwd: projectDir,
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout);
      const list = parsed.data || parsed;
      if (Array.isArray(list)) {
        info.agentList = list;
        info.agentListSource = 'opencode api /api/agent';
      }
    } catch (error) {
      info.warnings.push(`Não foi possível listar agentes embutidos: ${shortError(error)}`);
    }
  }

  if (!info.agentList) {
    info.agentList = [
      {
        id: 'build',
        name: 'build',
        description: 'The default agent. Executes tools based on configured permissions.',
        mode: 'primary',
      },
      {
        id: 'plan',
        name: 'plan',
        description: 'Read-only agent for exploring the codebase and planning.',
        mode: 'primary',
      },
    ];
    info.agentListSource = 'fallback local (build/plan)';
  }

  cliCache = info;
  cliCacheAt = now;
  return info;
}

function builtinAgentsFromList(list) {
  return list
    .filter((item) => item && item.hidden !== true)
    .map((item) => ({
      name: asString(item.id || item.name).trim(),
      description: asString(item.description).trim(),
      mode: normalizeMode(item.mode),
      model: formatModel(item.model),
      origin: 'builtin',
      hidden: false,
      warning: null,
      sourcePath: 'opencode',
      sourceType: 'builtin',
      color: null,
      icon: null,
    }))
    .filter((agent) => agent.name);
}

async function readOverrides(atlasDir) {
  const file = path.join(atlasDir, 'agents.json');
  const raw = await readText(file);
  if (raw === null) {
    return { file, values: {}, warning: null };
  }

  const { value, error } = parseJsonc(raw, file);
  if (error) {
    return { file, values: {}, warning: error };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { file, values: {}, warning: 'agents.json deve ser um objeto.' };
  }

  const values = {};
  for (const [name, patch] of Object.entries(value)) {
    if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
      values[name] = patch;
    }
  }
  return { file, values, warning: null };
}

function applyOverrides(agent, overrides) {
  const patch = overrides.values[agent.name] || overrides.values[agent.id] || null;
  if (!patch) return agent;

  const result = { ...agent };
  if (patch.hidden === true) result.hidden = true;
  if (patch.icon) result.icon = String(patch.icon);
  if (patch.color) result.color = String(patch.color);
  if (Number.isFinite(Number(patch.order))) result.order = Number(patch.order);
  return result;
}

async function discoverAll({ projectDir, atlasDir }) {
  const { globalConfigDir, legacyGlobalDir } = getRoots(projectDir);
  const warnings = [];

  const configFiles = configCandidates(projectDir, globalConfigDir, legacyGlobalDir);
  const configs = await Promise.all(
    configFiles.map(async (candidate) => {
      const parsed = await readConfig(candidate.file, candidate.origin, warnings);
      return { ...candidate, ...parsed };
    }),
  );

  const projectConfig = configs.filter((c) => c.origin === 'project');
  const globalConfig = configs.filter((c) => c.origin === 'global');

  const projectAgentDirs = AGENT_DIR_NAMES.map((name) => ({
    dir: path.join(projectDir, '.opencode', name),
    origin: 'project',
  }));
  const globalAgentDirs = [
    ...AGENT_DIR_NAMES.map((name) => ({
      dir: path.join(legacyGlobalDir, name),
      origin: 'global',
    })),
    ...AGENT_DIR_NAMES.map((name) => ({
      dir: path.join(globalConfigDir, name),
      origin: 'global',
    })),
  ];

  const commandDirs = [
    ...COMMAND_DIR_NAMES.map((name) => ({
      dir: path.join(projectDir, '.opencode', name),
      origin: 'project',
    })),
    ...COMMAND_DIR_NAMES.map((name) => ({
      dir: path.join(legacyGlobalDir, name),
      origin: 'global',
    })),
    ...COMMAND_DIR_NAMES.map((name) => ({
      dir: path.join(globalConfigDir, name),
      origin: 'global',
    })),
  ];

  const [projectFileAgents, globalFileAgents] = await Promise.all([
    Promise.all(projectAgentDirs.map((entry) => readAgentFiles(entry.dir, entry.origin))).then(
      (groups) => groups.flat(),
    ),
    Promise.all(globalAgentDirs.map((entry) => readAgentFiles(entry.dir, entry.origin))).then(
      (groups) => groups.flat(),
    ),
  ]);

  const [projectFileCommands, globalFileCommands] = await Promise.all([
    Promise.all(commandDirs.filter((entry) => entry.origin === 'project').map((entry) => readCommandFiles(entry.dir, entry.origin))).then(
      (groups) => groups.flat(),
    ),
    Promise.all(commandDirs.filter((entry) => entry.origin === 'global').map((entry) => readCommandFiles(entry.dir, entry.origin))).then(
      (groups) => groups.flat(),
    ),
  ]);

  const projectAgents = mergeByName([
    ...projectConfig.map((config) => config.agents),
    projectFileAgents,
  ]);
  const globalAgents = mergeByName([
    ...globalConfig.map((config) => config.agents),
    globalFileAgents,
  ]);
  const projectCommands = mergeByName([
    ...projectConfig.map((config) => config.commands),
    projectFileCommands,
  ]);
  const globalCommands = mergeByName([
    ...globalConfig.map((config) => config.commands),
    globalFileCommands,
  ]);

  const cliInfo = await getCliInfo(projectDir);
  warnings.push(...cliInfo.warnings);
  const builtinAgents = builtinAgentsFromList(cliInfo.agentList || []);

  // Prioridade: projeto > global > embutido.
  const agentMap = new Map();
  for (const agent of builtinAgents) agentMap.set(agent.name, agent);
  for (const agent of globalAgents) agentMap.set(agent.name, agent);
  for (const agent of projectAgents) agentMap.set(agent.name, agent);

  const overrides = await readOverrides(atlasDir);
  if (overrides.warning) warnings.push(overrides.warning);

  const agents = Array.from(agentMap.values())
    .map((agent) => applyOverrides(agent, overrides))
    .map((agent) => ({
      ...agent,
      id: agent.name,
      order: Number.isFinite(agent.order) ? agent.order : 999,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  const visibleAgentNames = new Set(agents.filter((agent) => !agent.hidden).map((agent) => agent.name));

  const commandMap = new Map();
  for (const command of globalCommands) commandMap.set(command.name, command);
  for (const command of projectCommands) commandMap.set(command.name, command);

  const commands = Array.from(commandMap.values())
    .map((command) => {
      const agentName = command.agent || null;
      const agentExists = agentName ? visibleAgentNames.has(agentName) : false;
      return {
        ...command,
        id: `${command.name}@${command.origin}`,
        agent: agentName,
        agentExists,
        group: agentExists ? agentName : '__general__',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  const agentWarnings = agents
    .filter((agent) => agent.warning)
    .map((agent) => `${agent.name}: ${agent.warning}`);
  warnings.push(...agentWarnings);

  return {
    projectDir,
    atlasDir,
    globalConfigDir,
    legacyGlobalDir,
    generatedAt: new Date().toISOString(),
    agents,
    commands,
    warnings,
    overrides: {
      file: overrides.file,
      values: overrides.values,
      warning: overrides.warning,
    },
    opencode: {
      bin: OPENCODE_BIN,
      available: cliInfo.available,
      version: cliInfo.version,
      supportsCommandFlag: cliInfo.supportsCommandFlag,
      agentListSource: cliInfo.agentListSource,
      agentListAvailable: cliInfo.agentListSource === 'opencode agent list',
    },
  };
}

function getWatchTargets(projectDir, atlasDir) {
  const { globalConfigDir, legacyGlobalDir } = getRoots(projectDir);
  const targets = new Set();

  targets.add(projectDir);
  targets.add(path.join(projectDir, '.opencode'));
  for (const name of AGENT_DIR_NAMES) {
    targets.add(path.join(projectDir, '.opencode', name));
  }
  for (const name of COMMAND_DIR_NAMES) {
    targets.add(path.join(projectDir, '.opencode', name));
  }

  targets.add(path.dirname(globalConfigDir));
  targets.add(globalConfigDir);
  for (const name of AGENT_DIR_NAMES) {
    targets.add(path.join(globalConfigDir, name));
  }
  for (const name of COMMAND_DIR_NAMES) {
    targets.add(path.join(globalConfigDir, name));
  }

  targets.add(legacyGlobalDir);
  for (const name of AGENT_DIR_NAMES) {
    targets.add(path.join(legacyGlobalDir, name));
  }
  for (const name of COMMAND_DIR_NAMES) {
    targets.add(path.join(legacyGlobalDir, name));
  }

  targets.add(atlasDir);
  targets.add(path.join(atlasDir, 'agents.json'));

  return Array.from(targets);
}

module.exports = {
  discoverAll,
  getWatchTargets,
  resolveGlobalConfigDir,
  readOverrides,
  _private: {
    stripJsonComments: require('./jsonc').stripJsonComments,
    parseFrontmatter,
  },
};
