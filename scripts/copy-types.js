'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const generated = path.join(root, '.types');

for (const entry of fs.readdirSync(generated, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    fs.cpSync(path.join(generated, entry.name), path.join(root, entry.name), { recursive: true });
  } else if (entry.name.endsWith('.d.ts')) {
    fs.copyFileSync(path.join(generated, entry.name), path.join(root, entry.name));
  }
}

fs.rmSync(generated, { recursive: true, force: true });