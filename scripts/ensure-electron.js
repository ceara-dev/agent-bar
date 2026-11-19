'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const pathFile = path.join(electronDir, 'path.txt');
const distDir = path.join(electronDir, 'dist');

if (!fs.existsSync(electronDir)) {
  // O pacote ainda não existe (ex.: instalação apenas de produção).
  process.exit(0);
}

if (fs.existsSync(pathFile) && fs.existsSync(distDir)) {
  process.exit(0);
}

console.log('[agent-bar] Binário do Electron ausente; executando install.js…');

try {
  execFileSync(process.execPath, [path.join(electronDir, 'install.js')], {
    stdio: 'inherit',
  });
} catch (error) {
  console.error(
    '[agent-bar] Falha ao baixar o Electron. Rode "npm rebuild electron" ou ' +
      '"node node_modules/electron/install.js" e tente novamente.',
  );
  process.exit(1);
}
