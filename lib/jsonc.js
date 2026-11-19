'use strict';

/**
 * Remove comentários `//` e `/* *\/` de um JSONC sem tocar em strings.
 * A saída preserva quebras de linha para manter mensagens de erro legíveis.
 */
function stripJsonComments(input) {
  let out = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      out += char;
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') {
        i += 1;
      }
      out += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        if (input[i] === '\n') out += '\n';
        i += 1;
      }
      i += 1;
      continue;
    }

    out += char;
  }

  return out;
}

/** Remove vírgulas sobrando antes de `}` ou `]`, fora de strings. */
function stripTrailingCommas(input) {
  let out = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      out += char;
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === ',') {
      let lookahead = i + 1;
      while (lookahead < input.length && /\s/.test(input[lookahead])) {
        lookahead += 1;
      }
      if (input[lookahead] === '}' || input[lookahead] === ']') {
        continue;
      }
    }

    out += char;
  }

  return out;
}

/**
 * Lê JSON ou JSONC. Nunca lança: retorna `{ value, error }`.
 */
function parseJsonc(text, filename = '') {
  const cleaned = stripTrailingCommas(stripJsonComments(String(text)));
  try {
    return { value: JSON.parse(cleaned), error: null };
  } catch (error) {
    const prefix = filename ? `${filename}: ` : '';
    return { value: null, error: `${prefix}${error.message}` };
  }
}

module.exports = {
  parseJsonc,
  stripJsonComments,
  stripTrailingCommas,
};
