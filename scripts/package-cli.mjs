// Build a self-contained CLI tarball.
//
// The tarball contains the compiled `dist/`, production dependencies installed
// from the lockfile into a clean staging directory (NOT a copy of the dev
// node_modules), the project config examples, the README, third-party license
// notices and launcher scripts. After extraction the CLI runs without any
// network access (only a matching Node.js version and any external tools the
// commands themselves need are required).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const pkgName = `${pkg.name}-${version}`;
const stageRoot = path.join(root, 'build', 'package', 'cli');
const stage = path.join(stageRoot, pkgName);

console.log('[package-cli] building dist...');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

console.log('[package-cli] staging into', stage);
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const f of ['package.json', 'package-lock.json', 'README.md']) {
  cpSync(path.join(root, f), path.join(stage, f));
}
// The package's postinstall applies the ink resize-reflow patch, so the patch
// script must ship with the tarball (see scripts/apply-ink-patch.mjs).
cpSync(path.join(root, 'scripts'), path.join(stage, 'scripts'), { recursive: true });
cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
for (const directory of ['packages', 'evaluators']) {
  cpSync(path.join(root, directory), path.join(stage, directory), { recursive: true });
}
// Include only the build-time verified knowledge snapshot. The catalog carries
// reviewed records and hashes, not private raw evidence or source archives.
execSync(`node "${path.join(root, 'scripts', 'generate-knowledge-catalog.mjs')}" "${path.join(stage, 'dist', 'knowledge')}" "${root}"`, {
  cwd: root,
  stdio: 'inherit',
});
// The tarball's `bin` points at dist/entry.js; it must carry a node shebang so
// npm generates shims that invoke `node` (otherwise PowerShell runs the .js directly).
const cliEntry = path.join(stage, 'dist', 'entry.js');
const cliSrc = readFileSync(cliEntry, 'utf8');
if (!cliSrc.startsWith('#!')) {
  writeFileSync(cliEntry, '#!/usr/bin/env node\n' + cliSrc);
}
if (existsSync(path.join(root, 'examples'))) {
  cpSync(path.join(root, 'examples'), path.join(stage, 'examples'), { recursive: true });
}

console.log('[package-cli] installing production deps from lockfile (npm ci --omit=dev)...');
execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: stage, stdio: 'inherit' });

console.log('[package-cli] applying the ink resize-reflow patch to staged deps...');
execSync(`node "${path.join(root, 'scripts', 'apply-ink-patch.mjs')}" "${stage}"`, {
  cwd: root,
  stdio: 'inherit',
});

console.log('[package-cli] writing third-party notices...');
writeFileSync(path.join(stage, 'THIRD_PARTY_NOTICES.md'), collectLicenses(path.join(stage, 'node_modules')));

console.log('[package-cli] packing tarball...');
const out = path.join(root, 'build', `${pkgName}.tgz`);
// bsdtar (Windows) rejects --force-local; GNU tar needs it to avoid treating a
// "C:" drive prefix as a remote host. Detect the tar flavour and pick the flag.
const tarVersion = execSync('tar --version 2>&1', { cwd: root, encoding: 'utf8' });
const forceLocal = /bsdtar|libarchive/i.test(tarVersion) ? '' : '--force-local';
execSync(`tar ${forceLocal} -czf "${out}" -C "${stageRoot}" "${pkgName}"`, { cwd: root, stdio: 'inherit' });
console.log('[package-cli] wrote', out);

function collectLicenses(nodeModulesDir) {
  const entries = [];
  for (const entry of readdirSync(nodeModulesDir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = path.join(nodeModulesDir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(full)) {
        const subFull = path.join(full, sub);
        if (statSync(subFull).isDirectory()) collectPackage(subFull, entries);
      }
    } else {
      collectPackage(full, entries);
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    '# Third-party notices',
    '',
    'Production dependencies bundled with this package:',
    '',
  ];
  for (const e of entries) {
    lines.push(`- ${e.name}@${e.version} (${e.license})`);
  }
  return lines.join('\n') + '\n';
}

function collectPackage(dir, out) {
  const pj = path.join(dir, 'package.json');
  if (!existsSync(pj)) return;
  try {
    const p = JSON.parse(readFileSync(pj, 'utf8'));
    const license = typeof p.license === 'string' ? p.license : (p.license?.type ?? 'license not specified');
    out.push({ name: p.name ?? path.basename(dir), version: p.version ?? '?', license });
  } catch {
    // ignore unreadable package.json
  }
}
