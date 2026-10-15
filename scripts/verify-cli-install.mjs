// 在无 npm install、无网络的干净目录验证当前 CLI 压缩包和通用 backend 外壳。
import { execSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const packageName = `${pkg.name}-${version}`;
const tarball = path.join(root, 'build', `${packageName}.tgz`);

function fail(message) {
  console.error('VERIFY_FAIL', message);
  process.exit(1);
}

function runCli(cliDir, args, options = {}) {
  return spawnSync(process.execPath, [path.join(cliDir, 'dist', 'entry.js'), ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'corepilot-cli-verify-'));
const cliDir = path.join(temp, packageName);
try {
  execSync(`tar -xzf "${tarball.replace(/\\/g, '/')}" -C "${temp.replace(/\\/g, '/')}"`, { stdio: 'pipe' });

  const versionResult = runCli(cliDir, ['version']);
  if (versionResult.status !== 0 || versionResult.stdout.trim() !== version) fail(`version failed: ${versionResult.stdout}${versionResult.stderr}`);
  const helpResult = runCli(cliDir, ['--help']);
  if (helpResult.status !== 0 || !helpResult.stdout.includes('corepilot optimize')) fail(`help failed: ${helpResult.stdout}${helpResult.stderr}`);

  const port = await freePort();
  const db = path.join(temp, 'workflow.sqlite');
  const server = spawn(process.execPath, [path.join(cliDir, 'dist', 'entry.js'), 'serve', '--transport', 'mock', '--host', '127.0.0.1', '--port', String(port), '--db', db], {
    cwd: cliDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('corepilot server listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
    server.once('error', reject);
  });
  await ready;
  const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
  if (!health.ok) fail(`health failed: HTTP ${health.status}`);
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  console.log('CLI_VERIFY_OK', JSON.stringify({ tarball, version, port }));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
