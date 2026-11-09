// 在无 npm install、无网络的干净目录验证当前 CLI 压缩包和通用 backend 外壳。
import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  throw new Error(`VERIFY_FAIL ${message}`);
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
let server;
try {
  execSync(`tar -xzf "${tarball.replace(/\\/g, '/')}" -C "${temp.replace(/\\/g, '/')}"`, { stdio: 'pipe' });
  for (const removed of ['dist/core/task-service.js', 'dist/cli-interactive/banner.js', 'dist/onboarding/build-requirements.js', 'scripts/generate-knowledge-catalog.mjs', 'scripts/corepilot-remote-agent.sh', 'scripts/package-cli.mjs']) {
    if (existsSync(path.join(cliDir, removed))) fail(`obsolete/development file shipped: ${removed}`);
  }
  if (!existsSync(path.join(cliDir, 'scripts', 'apply-ink-patch.mjs'))) fail('required postinstall script is missing');

  const versionResult = runCli(cliDir, ['version']);
  if (versionResult.status !== 0 || versionResult.stdout.trim() !== version) fail(`version failed: ${versionResult.stdout}${versionResult.stderr}`);
  const helpResult = runCli(cliDir, ['--help']);
  if (helpResult.status !== 0 || !helpResult.stdout.includes('corepilot optimize')) fail(`help failed: ${helpResult.stdout}${helpResult.stderr}`);
  if (!helpResult.stdout.includes('workflow status|watch|report|events|cancel') || !helpResult.stdout.includes('workflow resume') || !helpResult.stdout.includes('workflow message') || !helpResult.stdout.includes('corepilot check')) fail('installed CLI is missing the optimization/session/report commands');

  const port = await freePort();
  const db = path.join(temp, 'workflow.sqlite');
  const accessToken = 'installation-fixture-access';
  server = spawn(process.execPath, [path.join(cliDir, 'dist', 'entry.js'), 'web', '--transport', 'mock', '--host', '127.0.0.1', '--port', String(port), '--db', db, '--data-dir', path.join(temp, 'data')], {
    cwd: cliDir,
    env: { ...process.env, COREPILOT_SERVER_TOKEN: accessToken },
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
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${accessToken}` };
  const html = await fetch(baseUrl + '/');
  const body = await html.text();
  if (!html.ok || !body.includes('CorePilot')) fail('installed web shell is unavailable');
  const asset = body.match(/src="([^\"]+\.js)"/)?.[1];
  if (!asset || !(await fetch(baseUrl + asset)).ok) fail('installed frontend assets are missing');
  const session = await fetch(baseUrl + '/v1/session', { method: 'POST', body: JSON.stringify({ token: accessToken }) });
  const cookie = session.headers.get('set-cookie')?.split(';')[0];
  if (!cookie || !(await fetch(baseUrl + '/v1/projects', { headers: { cookie } })).ok) fail('installed browser session is unavailable');
  if (!existsSync(path.join(cliDir, 'deploy', 'linux', 'corepilot.service'))) fail('Linux deployment template is missing');
  const listing = await fetch(baseUrl + '/v1/workflows', { headers });
  if (!listing.ok || !Array.isArray((await listing.json()).workflows)) fail('installed workflow listing failed');
  const missingReport = await fetch(baseUrl + '/v1/workflows/missing/report', { headers });
  if (missingReport.status !== 404 || (await missingReport.json()).error.code !== 'WORKFLOW_NOT_FOUND') fail('installed report endpoint is unavailable');
  const repository = path.join(temp, 'source-fixture');
  mkdirSync(repository);
  writeFileSync(path.join(repository, 'CMakeLists.txt'), 'project(install_fixture LANGUAGES C)\n');
  writeFileSync(path.join(repository, 'kernel.h'), 'int installed_kernel(void);\n');
  writeFileSync(path.join(repository, 'kernel.c'), 'int installed_kernel(void) { return 1; }\n');
  const added = await fetch(baseUrl + '/v1/projects', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Install fixture', repository_root: repository }) });
  if (!added.ok) fail('installed shared project service is unavailable');
  const { project } = await added.json();
  const projects = runCli(cliDir, ['project', 'list'], { env: { ...process.env, COREPILOT_SERVER_URL: baseUrl, COREPILOT_SERVER_TOKEN: accessToken } });
  if (projects.status !== 0 || JSON.parse(projects.stdout).projects[0]?.name !== 'Install fixture') fail('installed CLI cannot read browser projects');
  const setup = runCli(cliDir, ['project', 'setup', project.project_id, '--inspect'], { env: { ...process.env, COREPILOT_SERVER_URL: baseUrl, COREPILOT_SERVER_TOKEN: accessToken } });
  if (setup.status !== 0) fail(`installed source inspection failed: ${setup.stderr}`);
  const inspected = JSON.parse(setup.stdout);
  if (inspected.discovery?.builds[0]?.kind !== 'cmake' || inspected.validation !== null) fail('installed setup worker did not return real discovery facts');
  console.log('CLI_VERIFY_OK', JSON.stringify({ tarball, version, port }));
} finally {
  if (server && server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM'); await stopped;
  }
  if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('corepilot-cli-verify-')) fail('unexpected temporary cleanup path');
  rmSync(temp, { recursive: true, force: true });
}
