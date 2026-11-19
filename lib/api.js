'use strict';

const http = require('node:http');

class ApiError extends Error {
  constructor(status, body, path) {
    const message =
      (body && (body.message || body._tag)) || `HTTP ${status} em ${path}`;
    super(String(message));
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

class OpenCodeApi {
  constructor() {
    this.baseUrl = null;
    this.authorization = null;
  }

  configure({ baseUrl, authorization }) {
    this.baseUrl = baseUrl;
    this.authorization = authorization;
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  request(method, path, body = null, { timeoutMs = 30_000 } = {}) {
    if (!this.baseUrl) {
      return Promise.reject(new Error('Servidor OpenCode não configurado.'));
    }

    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const payload = body === null || body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          method,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: {
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(this.authorization ? { Authorization: this.authorization } : {}),
          },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            if (res.statusCode === 204) {
              resolve(null);
              return;
            }
            let data = null;
            try {
              data = raw ? JSON.parse(raw) : null;
            } catch {
              data = raw;
            }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new ApiError(res.statusCode, data, path));
            }
          });
        },
      );

      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout em ${method} ${path}`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  getInfo() {
    return this.request('GET', '/api/info');
  }

  getAgents(directory) {
    const query = `?location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
    return this.request('GET', `/api/agent${query}`);
  }

  createSession({ directory, agent = null, title = null, parentID = null }) {
    const body = {
      location: { directory },
      ...(agent ? { agent } : {}),
      ...(title ? { title } : {}),
      ...(parentID ? { parentID } : {}),
    };
    return this.request('POST', '/api/session', body);
  }

  getSession(sessionID) {
    return this.request('GET', `/api/session/${encodeURIComponent(sessionID)}`);
  }

  listSessions({ directory, limit = 50, order = 'desc', parentID = null } = {}) {
    const params = new URLSearchParams();
    if (directory) params.set('directory', directory);
    params.set('limit', String(limit));
    params.set('order', order);
    if (parentID) params.set('parentID', parentID);
    return this.request('GET', `/api/session?${params.toString()}`);
  }

  sendPrompt(sessionID, text, extra = {}) {
    return this.request('POST', `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      text,
      ...extra,
    });
  }

  runCommand(sessionID, name, text = '') {
    return this.request('POST', `/api/session/${encodeURIComponent(sessionID)}/command`, {
      name,
      text,
    });
  }

  interrupt(sessionID) {
    return this.request(
      'POST',
      `/api/session/${encodeURIComponent(sessionID)}/interrupt?resume=false`,
    );
  }

  getMessages(sessionID, { limit = 200, order = 'asc' } = {}) {
    const params = new URLSearchParams({ limit: String(limit), order });
    return this.request(
      'GET',
      `/api/session/${encodeURIComponent(sessionID)}/message?${params.toString()}`,
    );
  }

  getPermissions(sessionID) {
    return this.request(
      'GET',
      `/api/session/${encodeURIComponent(sessionID)}/permission`,
    );
  }

  replyPermission(sessionID, requestID, decision, message = null) {
    return this.request(
      'POST',
      `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
      { decision, ...(message ? { message } : {}) },
    );
  }

  deleteSession(sessionID) {
    return this.request('DELETE', `/api/session/${encodeURIComponent(sessionID)}`);
  }
}

module.exports = { OpenCodeApi, ApiError };
