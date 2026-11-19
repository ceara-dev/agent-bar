'use strict';

/*
 * Observador recursivo de arquivos que pula pastas pesadas (node_modules,
 * vendor, build...) e só cobre os diretórios-base pedidos. Emite:
 *
 *   'change'  { type: 'created' | 'edited' | 'deleted', file }
 *   'warning' mensagem
 *
 * O fs.watch recursivo do Node no Linux observaria tudo, inclusive pastas
 * ignoradas; aqui cada diretório ganha seu próprio watcher não recursivo.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DEFAULT_IGNORED_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'bower_components',
  'build',
  'dist',
  'out',
  'target',
  'coverage',
  '.dart_tool',
  '.pub-cache',
  '.fvm',
  '.gradle',
  '.cxx',
  'Pods',
  'DerivedData',
  '.idea',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.expo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
]);

class ProjectWatcher extends EventEmitter {
  constructor({
    root,
    ignoredNames = DEFAULT_IGNORED_NAMES,
    ignoredPaths = [],
    maxDirs = 5000,
    debounceMs = 250,
  }) {
    super();
    this.root = path.resolve(root);
    this.ignoredNames = ignoredNames;
    this.ignoredPaths = ignoredPaths.map((item) => path.resolve(item));
    this.maxDirs = maxDirs;
    this.debounceMs = debounceMs;
    this.watchers = new Map(); // dir → FSWatcher
    this.known = new Map(); // arquivo → mtimeMs
    this.timers = new Map();
    this.bases = [];
    this.limitWarned = false;
  }

  isIgnored(target) {
    const rel = path.relative(this.root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
    if (
      this.ignoredPaths.some((item) => target === item || target.startsWith(`${item}${path.sep}`))
    ) {
      return true;
    }
    return rel.split(path.sep).some((segment) => this.ignoredNames.has(segment));
  }

  /** Define os diretórios-base (relativos ao root). Lista vazia desliga tudo. */
  setBases(relativeBases) {
    const absolute = Array.from(new Set((relativeBases || []).map((base) => path.resolve(this.root, base || '.'))))
      .filter((base) => base === this.root || base.startsWith(`${this.root}${path.sep}`))
      .sort((a, b) => a.length - b.length);
    const reduced = absolute.filter(
      (base, index) =>
        !absolute.slice(0, index).some((other) => base === other || base.startsWith(`${other}${path.sep}`)),
    );
    if (reduced.join('\n') === this.bases.join('\n')) return;
    this.stop();
    this.bases = reduced;
    this.limitWarned = false;
    for (const base of reduced) {
      let stat = null;
      try {
        stat = fs.statSync(base);
      } catch {
        continue;
      }
      if (stat.isDirectory()) this.watchTree(base, false);
    }
  }

  watchedDirCount() {
    return this.watchers.size;
  }

  watchTree(dir, emitCreated) {
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (this.watchers.has(current) || this.isIgnored(current)) continue;
      if (this.watchers.size >= this.maxDirs) {
        if (!this.limitWarned) {
          this.limitWarned = true;
          this.emit(
            'warning',
            `Limite de ${this.maxDirs} pastas observadas atingido; use padrões mais específicos nos hooks.`,
          );
        }
        return;
      }
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      try {
        const watcher = fs.watch(current, { persistent: false }, (_eventType, filename) => {
          if (filename) this.schedule(path.join(current, filename.toString()));
        });
        watcher.on('error', () => this.unwatchTree(current));
        this.watchers.set(current, watcher);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && !this.isIgnored(full)) {
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(full).mtimeMs;
          } catch {
            continue;
          }
          const isNew = !this.known.has(full);
          this.known.set(full, mtimeMs);
          if (emitCreated && isNew) this.emit('change', { type: 'created', file: full });
        }
      }
    }
  }

  unwatchTree(dir) {
    for (const [target, watcher] of this.watchers.entries()) {
      if (target === dir || target.startsWith(`${dir}${path.sep}`)) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        this.watchers.delete(target);
      }
    }
  }

  schedule(full) {
    clearTimeout(this.timers.get(full));
    const timer = setTimeout(() => {
      this.timers.delete(full);
      this.process(full);
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(full, timer);
  }

  process(full) {
    if (this.isIgnored(full)) return;
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      stat = null;
    }

    if (!stat) {
      if (this.watchers.has(full)) {
        for (const file of Array.from(this.known.keys())) {
          if (file.startsWith(`${full}${path.sep}`)) {
            this.known.delete(file);
            this.emit('change', { type: 'deleted', file });
          }
        }
        this.unwatchTree(full);
      }
      if (this.known.has(full)) {
        this.known.delete(full);
        this.emit('change', { type: 'deleted', file: full });
      }
      return;
    }

    if (stat.isDirectory()) {
      if (!this.watchers.has(full)) this.watchTree(full, true);
      return;
    }

    if (!stat.isFile()) return;
    const previous = this.known.get(full);
    if (previous === undefined) {
      this.known.set(full, stat.mtimeMs);
      this.emit('change', { type: 'created', file: full });
    } else if (previous !== stat.mtimeMs) {
      this.known.set(full, stat.mtimeMs);
      this.emit('change', { type: 'edited', file: full });
    }
  }

  stop() {
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.watchers.clear();
    this.timers.clear();
    this.known.clear();
    this.bases = [];
  }
}

module.exports = { ProjectWatcher, DEFAULT_IGNORED_NAMES };
