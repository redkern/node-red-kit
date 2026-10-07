'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const spec = fs.readFileSync(path.join(root, 'docs/spec.md'), 'utf8');
const verification = JSON.parse(fs.readFileSync(path.join(root, 'docs/verification.json'), 'utf8'));
const prefix = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).redkern?.reqPrefix;
if (!prefix) throw new Error('package.json redkern.reqPrefix is required');

const defined = [...spec.matchAll(/^[\t ]*[-*+•]\s+([A-Z]+-[A-Z]+-[0-9]+)\.\s/gm)].map((match) => match[1]);
const relevant = defined.filter((id) => id.startsWith(`${prefix}-`));
if (new Set(relevant).size !== relevant.length) throw new Error('duplicate requirement definition');
for (const id of relevant) {
  if (!new RegExp(`^${prefix}-[A-Z]+-[0-9]+$`).test(id)) throw new Error(`invalid requirement ID: ${id}`);
}

const evidenceIds = verification.requirements.map((item) => item.id);
for (const item of verification.requirements) {
  if (!['passed', 'partial', 'not-applicable'].includes(item.status)) throw new Error(`invalid evidence status for ${item.id}`);
  if (item.status === 'not-applicable' && (item.scope !== 'palette' || !item.evidence?.includes('docs/palette-publication.md') || !item.evidence.includes('scripts/check-pack.js'))) {
    throw new Error(`palette N/A evidence for ${item.id} must cite the checklist and package-boundary guard`);
  }
  if (item.method === 'test') {
    const references = [...item.evidence.matchAll(/(test\/[^:;]+): ([^;]+)/g)];
    if (!references.length) throw new Error(`test evidence for ${item.id} must cite a test file and title`);
    for (const [, file, title] of references) {
      const testSource = fs.readFileSync(path.join(root, file), 'utf8');
      if (!testSource.includes(`test('${title}'`) && !testSource.includes(`test("${title}"`)) {
        throw new Error(`stale test evidence for ${item.id}: ${file}: ${title}`);
      }
    }
  }
}
const missingIds = verification.missingRequirements;
const deferredIds = Object.values(verification.deferredRequirements).flat();
const accounted = [...evidenceIds, ...missingIds, ...deferredIds];
if (new Set(accounted).size !== accounted.length) throw new Error('requirement ID appears in more than one verification state');
const missingFromMap = relevant.filter((id) => !accounted.includes(id));
const unknownToSpec = accounted.filter((id) => !relevant.includes(id));
if (missingFromMap.length || unknownToSpec.length) {
  throw new Error(`verification mismatch: missing=${missingFromMap.join(',')} unknown=${unknownToSpec.join(',')}`);
}

console.log(`Verified ${relevant.length} unique ${prefix} requirement IDs`);