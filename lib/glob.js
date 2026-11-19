'use strict';

/*
 * Glob mínimo, sem dependências, no estilo usado pelo Kiro em
 * `fileMatchPattern` (steering) e `when.patterns` (hooks).
 *
 *   **      zero ou mais segmentos de caminho
 *   *       qualquer sequência dentro de um segmento
 *   ?       um caractere (exceto /)
 *   {a,b}   alternativas
 *   [abc]   classe de caracteres ([!abc] nega)
 *
 * Caminhos são relativos ao projeto e usam "/". Um padrão sem "/" (ex.:
 * "*.dart") é comparado com o nome do arquivo, em qualquer pasta.
 */

const CACHE = new Map();

function escapeRegex(char) {
  return /[.+^$()|\\]/.test(char) ? `\\${char}` : char;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function findClosing(text, start, open, close) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function convert(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        const atSegmentStart = i === 0 || pattern[i - 1] === '/';
        const followedBySlash = pattern[i + 2] === '/';
        if (atSegmentStart && followedBySlash) {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
        continue;
      }
      out += '[^/]*';
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      continue;
    }

    if (char === '{') {
      const end = findClosing(pattern, i, '{', '}');
      if (end === -1) {
        out += '\\{';
        continue;
      }
      const alternatives = splitTopLevel(pattern.slice(i + 1, end)).map(convert);
      out += `(?:${alternatives.join('|')})`;
      i = end;
      continue;
    }

    if (char === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, end).replace(/\\/g, '\\\\');
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body}]`;
      i = end;
      continue;
    }

    out += escapeRegex(char);
  }
  return out;
}

function normalizePattern(pattern) {
  return String(pattern || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function compile(pattern) {
  const normalized = normalizePattern(pattern);
  if (CACHE.has(normalized)) return CACHE.get(normalized);
  const matchBase = !normalized.includes('/');
  const compiled = {
    pattern: normalized,
    matchBase,
    regex: new RegExp(`^${convert(normalized)}$`),
  };
  CACHE.set(normalized, compiled);
  return compiled;
}

function matches(pattern, relativePath) {
  const target = normalizePath(relativePath);
  if (!target || !normalizePattern(pattern)) return false;
  const compiled = compile(pattern);
  if (compiled.regex.test(target)) return true;
  if (compiled.matchBase) {
    const base = target.slice(target.lastIndexOf('/') + 1);
    return compiled.regex.test(base);
  }
  return false;
}

function matchAny(patterns, relativePath) {
  return (patterns || []).some((pattern) => matches(pattern, relativePath));
}

/** Prefixo de diretório sem curingas, usado para limitar o que é observado. */
function staticBase(pattern) {
  const normalized = normalizePattern(pattern);
  if (!normalized.includes('/')) return '';
  const segments = normalized.split('/');
  const base = [];
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (/[*?[{]/.test(segments[i])) break;
    base.push(segments[i]);
  }
  return base.join('/');
}

/** Aceita lista, string única, string JSON ("[...]") ou separada por vírgula/linha. */
function toPatternList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  const text = String(value ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return toPatternList(parsed);
    } catch {
      // cai para a separação manual
    }
  }
  return text
    .split(/\r?\n|,(?![^{]*\})/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

module.exports = {
  matches,
  matchAny,
  staticBase,
  toPatternList,
  normalizePath,
};
