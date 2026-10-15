// Generate the source-minimal knowledge catalog shipped in the CLI package.
// Only records whose original evidence verifies at build time are included;
// raw experiment logs and large source archives are never copied into the tar.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [outputDir, sourceRoot = process.cwd()] = process.argv.slice(2);
if (!outputDir) throw new Error('usage: generate-knowledge-catalog.mjs <output-dir> [source-root]');

const seedModule = await import(pathToFileURL(path.join(sourceRoot, 'dist', 'knowledge', 'seed-records.js')).href);
const verifierModule = await import(pathToFileURL(path.join(sourceRoot, 'dist', 'knowledge', 'verifier.js')).href);
const { SEED_RECORDS } = seedModule;
const { FileSourceVerifier, verifyAllSources } = verifierModule;
const verification = verifyAllSources(SEED_RECORDS, new FileSourceVerifier(sourceRoot));
const verified = new Set(verification.verified);
const records = SEED_RECORDS.filter((record) => verified.has(record.id));
const record_digests = Object.fromEntries(records.map((record) => [record.id, sha256(JSON.stringify(record))]));

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  path.join(outputDir, 'catalog.json'),
  `${JSON.stringify({ schema_version: 1, records, record_digests }, null, 2)}\n`,
);
console.log(`[knowledge-catalog] included ${records.length}/${SEED_RECORDS.length} verified records`);
if (verification.unavailable.length > 0) {
  console.log(`[knowledge-catalog] excluded ${verification.unavailable.length} unavailable records`);
}

function sha256(value) {
  // Keep this tiny build helper dependency-free; the runtime validates with
  // the same SHA-256 implementation used by the core.
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
