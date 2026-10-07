'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const verification = JSON.parse(fs.readFileSync(path.join(root, 'docs/verification.json'), 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
const blockers = [];

if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) blockers.push(`package version ${manifest.version} is not a stable semver release`);
if (tag && tag !== `v${manifest.version}`) blockers.push(`release tag ${tag} does not match v${manifest.version}`);
if (verification.releaseReady !== true) blockers.push('docs/verification.json does not mark the release ready');
if (verification.coverage.lines !== 100 || verification.coverage.branches !== 100 || verification.coverage.functions !== 100) {
  blockers.push('line, branch, and function coverage must all be 100%');
}
if (verification.audit?.command !== 'npm audit --omit=dev') blockers.push('release audit must cover production dependencies only');
if (verification.audit?.vulnerabilities !== 0) blockers.push(`${verification.audit?.vulnerabilities ?? 'unknown'} production npm audit vulnerabilities remain`);
if (verification.missingRequirements.length) blockers.push(`${verification.missingRequirements.length} requirements are missing evidence`);
if (Object.values(verification.deferredRequirements).some((items) => items.length)) blockers.push('deferred requirements remain');
if (verification.requirements.some((item) => item.status !== 'passed' && !(item.status === 'not-applicable' && item.scope === 'palette'))) {
  blockers.push('requirement evidence is not fully passed or validly scoped to palette repositories');
}
if (manifest.publishConfig?.access !== 'public') blockers.push('publishConfig.access must be public');
if (manifest.dependencies || manifest.optionalDependencies || manifest.peerDependencies) blockers.push('runtime dependency fields must be empty');

if (blockers.length) {
  console.error(`Release blocked for ${manifest.name}@${manifest.version}:`);
  for (const blocker of blockers) console.error(`- ${blocker}`);
  process.exitCode = 1;
} else {
  console.log(`Release gate passed for ${manifest.name}@${manifest.version}`);
}