'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = {
  history: {
    retentionDays: 90,
    maxSessionBytes: 5 * 1024 * 1024,
  },
  meeting: {
    maxAgents: 4,
    maxRounds: 3,
    turnTimeoutMs: 10 * 60 * 1000,
  },
  server: {
    startupTimeoutMs: 20000,
    restartAttempts: 3,
  },
  steering: {
    enabled: true,
    maxChars: 60000,
  },
  hooks: {
    enabled: true,
    debounceMs: 1500,
    maxRunsPerMinute: 12,
    commandTimeoutMs: 120000,
    maxWatchedDirs: 5000,
  },
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, override) {
  if (!isObject(override)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(base[key])) {
      result[key] = merge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function readSettings(atlasDir) {
  const file = path.join(atlasDir, 'settings.json');
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, values: DEFAULT_SETTINGS, warning: null, fromFile: false };
  }

  try {
    const parsed = JSON.parse(raw);
    const values = merge(DEFAULT_SETTINGS, parsed);
    values.history.retentionDays = Math.max(
      1,
      Number(values.history.retentionDays) || DEFAULT_SETTINGS.history.retentionDays,
    );
    values.history.maxSessionBytes = Math.max(
      64 * 1024,
      Number(values.history.maxSessionBytes) || DEFAULT_SETTINGS.history.maxSessionBytes,
    );
    values.meeting.maxAgents = Math.max(
      2,
      Math.min(12, Number(values.meeting.maxAgents) || DEFAULT_SETTINGS.meeting.maxAgents),
    );
    values.meeting.maxRounds = Math.max(
      1,
      Math.min(20, Number(values.meeting.maxRounds) || DEFAULT_SETTINGS.meeting.maxRounds),
    );
    values.meeting.turnTimeoutMs = Math.max(
      30_000,
      Number(values.meeting.turnTimeoutMs) || DEFAULT_SETTINGS.meeting.turnTimeoutMs,
    );
    values.server.startupTimeoutMs = Math.max(
      5_000,
      Number(values.server.startupTimeoutMs) || DEFAULT_SETTINGS.server.startupTimeoutMs,
    );
    values.steering.enabled = values.steering.enabled !== false;
    values.steering.maxChars = Math.max(
      2_000,
      Math.min(400_000, Number(values.steering.maxChars) || DEFAULT_SETTINGS.steering.maxChars),
    );
    values.hooks.enabled = values.hooks.enabled !== false;
    values.hooks.debounceMs = Math.max(
      200,
      Math.min(60_000, Number(values.hooks.debounceMs) || DEFAULT_SETTINGS.hooks.debounceMs),
    );
    values.hooks.maxRunsPerMinute = Math.max(
      1,
      Math.min(120, Number(values.hooks.maxRunsPerMinute) || DEFAULT_SETTINGS.hooks.maxRunsPerMinute),
    );
    values.hooks.commandTimeoutMs = Math.max(
      1_000,
      Number(values.hooks.commandTimeoutMs) || DEFAULT_SETTINGS.hooks.commandTimeoutMs,
    );
    values.hooks.maxWatchedDirs = Math.max(
      50,
      Math.min(50_000, Number(values.hooks.maxWatchedDirs) || DEFAULT_SETTINGS.hooks.maxWatchedDirs),
    );
    return { file, values, warning: null, fromFile: true };
  } catch (error) {
    return {
      file,
      values: DEFAULT_SETTINGS,
      warning: `${file}: ${error.message}`,
      fromFile: true,
    };
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  readSettings,
  merge,
};
