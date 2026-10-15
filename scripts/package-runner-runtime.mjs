#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const options = parseArgs(process.argv.slice(2));
const projectRoot = path.resolve(import.meta.dirname, '..');
const distRoot = path.join(projectRoot, 'dist');
if (!fs.existsSync(path.join(distRoot, 'runner-entry.js'))) {
  throw new Error('dist/runner-entry.js is missing; run npm run build first');
}
const nodeArchive = path.resolve(options.nodeArchive);
if (!fs.existsSync(nodeArchive) || !fs.statSync(nodeArchive).isFile()) throw new Error(`Node runtime archive not found: ${nodeArchive}`);
const output = path.resolve(options.output);
fs.mkdirSync(path.dirname(output), { recursive: true });

// Keep assembly beside the requested output. This works in restricted build
// environments where the system temporary directory is intentionally not writable.
const temporary = fs.mkdtempSync(path.join(path.dirname(output), '.corepilot-runner-package-'));
try {
  const packageRoot = path.join(temporary, 'corepilot-runner');
  const extracted = path.join(temporary, 'node-extracted');
  fs.mkdirSync(extracted, { recursive: true });
  const nodeRuntime = path.basename(nodeArchive).replace(/\.tar\.xz$/, '');
  if (!/^node-v\d+\.\d+\.\d+-linux-(?:arm64|x64)$/.test(nodeRuntime)) {
    throw new Error('Node runtime archive filename is not a supported official Linux archive');
  }
  const nodeEntry = `${nodeRuntime}/bin/node`;
  // The runner only needs the official node executable. Extracting the whole
  // upstream archive on Windows attempts to create npm/npx symlinks and can
  // fail without Developer Mode even though the archive itself is valid.
  run('tar', ['-xf', nodeArchive, '-C', extracted, nodeEntry]);
  const nodeExecutable = path.join(extracted, ...nodeEntry.split('/'));
  if (!fs.existsSync(nodeExecutable)) throw new Error('Node runtime archive did not extract bin/node');

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'node', 'bin'), { recursive: true });
  fs.copyFileSync(nodeExecutable, path.join(packageRoot, 'node', 'bin', 'node'));
  fs.chmodSync(path.join(packageRoot, 'node', 'bin', 'node'), 0o755);
  const nodeArchiveSha256 = createHash('sha256').update(fs.readFileSync(nodeArchive)).digest('hex');
  fs.writeFileSync(path.join(packageRoot, 'node', 'runtime.json'), `${JSON.stringify({
    runtime: nodeRuntime,
    source_archive: path.basename(nodeArchive),
    source_archive_sha256: nodeArchiveSha256,
  }, null, 2)}\n`);
  fs.mkdirSync(path.join(packageRoot, 'app'), { recursive: true });
  fs.cpSync(distRoot, path.join(packageRoot, 'app', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'app', 'package.json'), `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`);
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  const launcher = `#!/usr/bin/env sh
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
exec "$root/node/bin/node" "$root/app/dist/runner-entry.js" "$@"
`;
  const launcherPath = path.join(packageRoot, 'bin', 'corepilot-runner');
  fs.writeFileSync(launcherPath, launcher);
  fs.chmodSync(launcherPath, 0o755);
  const legacyLauncherPath = path.join(packageRoot, 'bin', 'phyopt-runner');
  fs.writeFileSync(legacyLauncherPath, launcher);
  fs.chmodSync(legacyLauncherPath, 0o755);
  run('tar', ['-cJf', output, '-C', temporary, 'corepilot-runner']);
  const sha256 = createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  process.stdout.write(`${JSON.stringify({ output, sha256, node_runtime: nodeRuntime, node_archive_sha256: nodeArchiveSha256, entrypoint: 'corepilot-runner/bin/corepilot-runner' }, null, 2)}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('usage: package-runner-runtime.mjs --node-archive <tar.xz> --output <tar.xz>');
    values.set(key, value);
  }
  for (const key of values.keys()) if (key !== '--node-archive' && key !== '--output') throw new Error(`unknown argument ${key}`);
  const nodeArchive = values.get('--node-archive');
  const output = values.get('--output');
  if (!nodeArchive || !output) throw new Error('usage: package-runner-runtime.mjs --node-archive <tar.xz> --output <tar.xz>');
  return { nodeArchive, output };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout ?? '';
}
