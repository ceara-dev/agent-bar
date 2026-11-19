'use strict';

function unquote(value) {
  const text = String(value).trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1).replace(/\\(["'\\])/g, '$1');
    }
  }
  return text;
}

function dedent(lines) {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return lines.map(() => '');
  const indent = Math.min(
    ...nonEmpty.map((line) => (line.match(/^[ \t]*/) || [''])[0].length),
  );
  return lines.map((line) => line.slice(indent));
}

function parseBlock(lines, folded) {
  const cleaned = dedent(lines);
  if (folded) {
    return cleaned
      .map((line) => line.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return cleaned.join('\n').replace(/\s+$/g, '');
}

/**
 * Parser de frontmatter suficiente para agentes/comandos do OpenCode.
 * Suporta chaves escalares, `|`/`>` e um nível de objeto (ex.: model).
 * Campos desconhecidos ou inválidos geram `warning`, sem lançar.
 */
function parseFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const open = text.match(/^---[ \t]*\r?\n/);
  if (!open) {
    return { data: {}, body: text, warning: null, hasFrontmatter: false };
  }

  const afterOpen = open[0].length;
  const rest = text.slice(afterOpen);
  const closeMatch = rest.match(/^---[ \t]*$/m);
  if (!closeMatch) {
    return {
      data: {},
      body: text,
      warning: 'Frontmatter sem linha de fechamento ---',
      hasFrontmatter: true,
    };
  }

  const closeIndex = closeMatch.index;
  const header = rest.slice(0, closeIndex);
  const body = rest.slice(closeIndex + closeMatch[0].length).replace(/^\r?\n/, '');
  const lines = header.split(/\r?\n/);
  const data = {};
  const warnings = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (/^[ \t]/.test(line)) {
      continue; // campos aninhados são tratados pelo bloco da chave pai
    }

    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!match) {
      warnings.push(`Linha inválida no frontmatter: ${line}`);
      continue;
    }

    const key = match[1];
    let value = match[2].trim();

    const blockLines = [];
    while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
      i += 1;
      const nextLine = lines[i];
      if (nextLine.trim() === '' && i + 1 < lines.length && !/^[ \t]/.test(lines[i + 1])) {
        break;
      }
      blockLines.push(nextLine);
    }

    if (/^[|>][-+]?$/.test(value)) {
      value = parseBlock(blockLines, value.startsWith('>'));
    } else if (value === '' && blockLines.length > 0) {
      const nested = {};
      let nestedOk = true;
      for (const blockLine of blockLines) {
        if (!blockLine.trim()) continue;
        const nestedMatch = blockLine.match(/^[ \t]+([^:]+):\s*(.*)$/);
        if (!nestedMatch) {
          nestedOk = false;
          break;
        }
        nested[nestedMatch[1].trim()] = unquote(nestedMatch[2]);
      }
      value = nestedOk && Object.keys(nested).length > 0 ? nested : parseBlock(blockLines, false);
    } else {
      value = unquote(value);
    }

    data[key] = value;
  }

  return {
    data,
    body,
    warning: warnings.length > 0 ? warnings.join('; ') : null,
    hasFrontmatter: true,
  };
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'primary' || mode === 'subagent' || mode === 'all') return mode;
  return 'all';
}

function formatModel(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const provider = value.providerID || value.provider || value.providerId;
    const model = value.modelID || value.model || value.modelId || value.id;
    if (provider && model) return `${provider}/${model}`;
    if (model) return String(model);
    return null;
  }
  return null;
}

function asString(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

module.exports = {
  parseFrontmatter,
  normalizeMode,
  formatModel,
  asString,
};
