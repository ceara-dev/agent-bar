'use strict';

const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(value) {
  return String(value).replace(ANSI_PATTERN, '');
}

function basicAuth(password) {
  return `Basic ${Buffer.from(`opencode:${password || ''}`).toString('base64')}`;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error('Não foi possível obter porta livre.'))));
    });
  });
}

function httpJson({ baseUrl, path, authorization, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          Accept: 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
          } catch {
            resolve({ status: res.statusCode, body });
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

class ServerManager extends EventEmitter {
  constructor({
    cwd,
    bin = process.env.OPENCODE_BIN || 'opencode',
    hostname = '127.0.0.1',
    startupTimeoutMs = 20_000,
  }) {
    super();
    this.cwd = cwd;
    this.bin = bin;
    this.hostname = hostname;
    this.startupTimeoutMs = startupTimeoutMs;
    this.child = null;
    this.info = null;
    this.starting = null;
    this.stopping = false;
  }

  get available() {
    return Boolean(this.info && this.child && this.child.exitCode === null);
  }

  get baseUrl() {
    return this.info?.baseUrl || null;
  }

  get authorization() {
    return this.info?.password ? basicAuth(this.info.password) : null;
  }

  async start() {
    if (this.available) return this.info;
    if (this.starting) return this.starting;

    this.starting = this.#spawn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #spawn() {
    const port = await getFreePort();
    const args = ['serve', '--hostname', this.hostname, '--port', String(port)];

    this.stopping = false;
    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      shell: false,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    this.child = child;

    let buffer = '';
    let baseUrl = null;
    let password = null;

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout ao iniciar "opencode serve" (${this.startupTimeoutMs}ms).`));
      }, this.startupTimeoutMs);

      let urlSeenAt = 0;
      let passwordFallback = null;

      const finish = () => {
        if (!baseUrl) return;
        // A senha costuma vir logo após a URL; espera curta para não criar
        // cliente sem Authorization por corrida de leitura do stdout.
        if (!password && Date.now() - urlSeenAt < 1500) return;
        clearTimeout(timer);
        clearTimeout(passwordFallback);
        resolve();
      };

      const onData = (chunk) => {
        buffer += stripAnsi(chunk.toString());
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          const urlMatch = line.match(/server listening on (https?:\/\/\S+)/i);
          if (urlMatch) {
            baseUrl = urlMatch[1].replace(/\/$/, '');
            urlSeenAt = Date.now();
            this.emit('log', line);
            passwordFallback = setTimeout(finish, 1600);
            finish();
          }
          const passwordMatch = line.match(/server password (\S+)/i);
          if (passwordMatch) {
            password = passwordMatch[1];
            this.emit('log', line.replace(password, '***'));
            finish();
          }
        }
      };

      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.once('exit', (code, signal) => {
        if (this.stopping) return;
        if (!baseUrl) {
          clearTimeout(timer);
          reject(
            new Error(
              `"opencode serve" encerrou antes de ficar disponível (code=${code}, signal=${signal}).`,
            ),
          );
        }
      });
    });

    try {
      await ready;
    } catch (error) {
      this.stop();
      throw error;
    }

    const info = {
      baseUrl,
      password,
      port: Number(new URL(baseUrl).port),
      pid: child.pid,
      authorization: password ? basicAuth(password) : null,
    };

    // Health check final para garantir que a API está respondendo.
    const health = await httpJson({
      baseUrl,
      path: '/api/info',
      authorization: info.authorization,
      timeoutMs: 5000,
    });
    if (health.status !== 200) {
      this.stop();
      throw new Error(`Servidor respondeu ${health.status} em /api/info.`);
    }

    this.info = info;
    this.emit('status', { available: true, info });

    child.on('exit', (code, signal) => {
      const wasStopping = this.stopping;
      const previous = this.info;
      this.info = null;
      this.child = null;
      if (!wasStopping) {
        this.emit('exit', { code, signal, info: previous });
        this.emit('status', { available: false, reason: 'Servidor encerrou.' });
      }
    });

    return info;
  }

  stop() {
    this.stopping = true;
    this.info = null;
    const child = this.child;
    this.child = null;
    if (!child) return;

    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 3000);
    force.unref?.();
  }

  async restart() {
    this.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return this.start();
  }
}

class EventStream extends EventEmitter {
  constructor({ baseUrl, authorization, maxBackoffMs = 30_000 }) {
    super();
    this.baseUrl = baseUrl;
    this.authorization = authorization;
    this.maxBackoffMs = maxBackoffMs;
    this.req = null;
    this.stopped = true;
    this.reconnectTimer = null;
    this.attempt = 0;
    this.lastEventId = null;
    this.buffer = '';
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.req) {
      this.req.destroy();
      this.req = null;
    }
  }

  #connect() {
    if (this.stopped) return;
    const url = new URL('/api/event', this.baseUrl);
    const headers = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...(this.authorization ? { Authorization: this.authorization } : {}),
      ...(this.lastEventId ? { 'Last-Event-ID': this.lastEventId } : {}),
    };

    this.req = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          this.#scheduleReconnect(`HTTP ${res.statusCode}`);
          return;
        }

        this.attempt = 0;
        this.emit('connected');
        res.setEncoding('utf8');
        res.on('data', (chunk) => this.#consume(chunk));
        res.on('end', () => this.#scheduleReconnect('stream encerrado'));
        res.on('error', (error) => this.#scheduleReconnect(error.message));
      },
    );

    this.req.on('error', (error) => this.#scheduleReconnect(error.message));
  }

  #consume(chunk) {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    let index = this.buffer.indexOf('\n\n');
    while (index !== -1) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.#parseBlock(block);
      index = this.buffer.indexOf('\n\n');
    }
  }

  #parseBlock(block) {
    const lines = block.split(/\r?\n/);
    const dataLines = [];
    let eventId = null;

    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('id:')) eventId = line.slice(3).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }

    if (eventId) this.lastEventId = eventId;
    if (dataLines.length === 0) return;

    const raw = dataLines.join('\n');
    try {
      const event = JSON.parse(raw);
      if (event.id) this.lastEventId = event.id;
      this.emit('event', event);
    } catch (error) {
      this.emit('parse-error', { error: error.message, raw: raw.slice(0, 500) });
    }
  }

  #scheduleReconnect(reason) {
    if (this.stopped) return;
    this.emit('disconnected', { reason });
    this.req = null;
    this.attempt += 1;
    const delay = Math.min(this.maxBackoffMs, 500 * 2 ** Math.min(this.attempt, 6));
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.#connect(), delay);
    this.reconnectTimer.unref?.();
  }
}

module.exports = {
  ServerManager,
  EventStream,
  getFreePort,
};
