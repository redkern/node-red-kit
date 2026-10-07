'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const composeFile = path.join(root, 'test/fixtures/redis-cluster/compose.yml');
const certDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'redkern-redis-cluster-'));
const project = `redkern-cluster-${process.pid}`;
const compose = ['compose', '-p', project, '-f', composeFile];
const hosts = ['redis-1', 'redis-2', 'redis-3', 'redis-4', 'redis-5', 'redis-6', 'toxiproxy'];
const env = {
  ...process.env,
  REDKERN_REPO_ROOT: root,
  REDKERN_NODE_MODULES: path.join(root, 'node_modules'),
  REDKERN_TEST_CERT_DIR: certDirectory
};

let exitCode = 1;
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(certDirectory, 'server.key'),
    '-out', path.join(certDirectory, 'server.crt'),
    '-days', '1', '-subj', '/CN=redkern-redis-integration',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', `subjectAltName=${hosts.map((host) => `DNS:${host}`).concat('DNS:localhost').join(',')}`
  ], { stdio: 'inherit' });
  execFileSync('docker', [...compose, 'up', '--abort-on-container-exit', '--exit-code-from', 'integration-test'], {
    cwd: root,
    env,
    stdio: 'inherit'
  });
  exitCode = 0;
} catch (error) {
  exitCode = Number.isInteger(error.status) ? error.status : 1;
} finally {
  const cleanup = spawnSync('docker', [...compose, 'down', '--volumes', '--remove-orphans'], { cwd: root, env, stdio: 'inherit' });
  if (cleanup.status !== 0) exitCode = exitCode || cleanup.status || 1;
  fs.rmSync(certDirectory, { recursive: true, force: true });
}

process.exitCode = exitCode;