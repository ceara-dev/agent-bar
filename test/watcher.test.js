'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectWatcher } = require('../lib/watcher');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('detecta criar, editar e apagar; ignora pastas pesadas e fora da base', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bar-watch-'));
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'existing.ts'), 'a');

  const watcher = new ProjectWatcher({ root, debounceMs: 30 });
  t.after(() => {
    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const events = [];
  watcher.on('change', (event) => events.push(`${event.type}:${path.relative(root, event.file)}`));
  watcher.setBases(['src']);
  assert.equal(watcher.watchedDirCount(), 2, 'src e src/deep; node_modules fica de fora');

  fs.writeFileSync(path.join(root, 'src', 'deep', 'new.ts'), 'x');
  fs.writeFileSync(path.join(root, 'src', 'node_modules', 'pkg', 'index.js'), 'x');
  fs.writeFileSync(path.join(root, 'other', 'ignored.ts'), 'x');
  await wait(200);
  fs.writeFileSync(path.join(root, 'src', 'existing.ts'), 'bb');
  await wait(200);
  fs.rmSync(path.join(root, 'src', 'existing.ts'));
  await wait(200);
  fs.mkdirSync(path.join(root, 'src', 'feature'));
  await wait(150);
  fs.writeFileSync(path.join(root, 'src', 'feature', 'x.ts'), 'x');
  await wait(200);

  assert.deepEqual(events, [
    `created:${path.join('src', 'deep', 'new.ts')}`,
    `edited:${path.join('src', 'existing.ts')}`,
    `deleted:${path.join('src', 'existing.ts')}`,
    `created:${path.join('src', 'feature', 'x.ts')}`,
  ]);
});
