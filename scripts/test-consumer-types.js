'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'redkern-kit-types-'));

try {
  const packReport = JSON.parse(execFileSync('npm', ['pack', '--pack-destination', temporary, '--json'], {
    cwd: root,
    encoding: 'utf8'
  }));
  const packed = Array.isArray(packReport) ? packReport[0] : packReport[Object.keys(packReport)[0]];
  if (!packed?.filename) throw new Error('npm pack did not report a tarball');
  const tarball = path.join(temporary, packed.filename);
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], {
    cwd: temporary,
    stdio: 'inherit'
  });
  fs.copyFileSync(path.join(root, 'test/fixtures/consumer.ts'), path.join(temporary, 'consumer.ts'));
  const compiler = path.join(root, 'node_modules/.bin/tsc');
  const modes = [
    ['--module', 'commonjs', '--moduleResolution', 'node10'],
    ['--module', 'Node16', '--moduleResolution', 'node16'],
    ['--module', 'NodeNext', '--moduleResolution', 'nodenext']
  ];
  for (const mode of modes) {
    execFileSync(compiler, [...mode, '--target', 'ES2022', '--noEmit', 'consumer.ts'], {
      cwd: temporary,
      stdio: 'inherit'
    });
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}