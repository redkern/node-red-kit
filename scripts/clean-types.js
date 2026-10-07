'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
for (const directory of [root, path.join(root, 'lib')]) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith('.d.ts') || /^.+\.d \d+\.ts$/.test(entry.name))) {
      fs.rmSync(path.join(directory, entry.name));
    }
  }
}