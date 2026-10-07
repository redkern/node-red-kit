'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packOutput = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8'
}));
const packed = Array.isArray(packOutput) ? packOutput[0] : packOutput[Object.keys(packOutput)[0]];
if (!packed?.files) throw new Error('npm pack did not return a file list');

function fail(message) {
  throw new Error(`check-pack: ${message}`);
}

if (manifest.publishConfig?.access !== 'public') fail('scoped package must set publishConfig.access to public');
if (manifest.repository?.url !== 'git+https://github.com/redkern/node-red-kit.git') fail('repository.url does not match the canonical GitHub repository');
if (manifest['node-red'] || manifest.keywords?.includes('node-red')) fail('runtime kit must not publish Node-RED palette metadata');
for (const dependencyType of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  if (manifest[dependencyType] && Object.keys(manifest[dependencyType]).length > 0) fail(`${dependencyType} must be empty`);
}
if (!manifest.exports?.['.']?.types || !manifest.exports?.['./redis']?.types) fail('public entrypoint type declarations are required');
if (!fs.existsSync(path.join(root, 'index.d.ts')) || !fs.existsSync(path.join(root, 'redis.d.ts'))) fail('root declaration files must be generated and committed');
if (!fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes(`## ${manifest.version}`)) fail(`CHANGELOG.md has no entry for ${manifest.version}`);

const allowedFiles = new Set([
  'CHANGELOG.md', 'LICENSE', 'README.md', 'SECURITY.md', 'package.json',
  'index.js', 'index.d.ts', 'redis.js', 'redis.d.ts'
]);
const unexpected = [];
for (const file of packed.files) {
  const name = file.path;
  const allowed = allowedFiles.has(name) || /^lib\/[a-z0-9-]+\.(?:js|d\.ts)$/.test(name);
  if (!allowed) unexpected.push(name);
  if (/(?:^|\s)\d+\.(?:js|ts|md)$/.test(name) || / 2\./.test(name)) fail(`duplicate/renamed file detected: ${name}`);
}
if (unexpected.length) fail(`unexpected tarball files: ${unexpected.join(', ')}`);

console.log(`check-pack: validated ${packed.files.length} files in ${packed.filename || manifest.name}`);