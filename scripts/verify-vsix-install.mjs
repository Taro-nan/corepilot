// Verify the VSIX by INSTALLING it (unpacking its payload into a clean
// extensions dir, which is exactly what `code --install-extension` produces)
// and confirming: (1) the extension is listed in that dir, and (2) it ACTIVATES
// when the EDP test host loads it from that installed location (NOT the source
// tree, NOT a throwaway unpack dir).
//
// `code --install-extension --extensions-dir` is unreliable on this Windows
// machine (forwards to a running instance or launches a full instance), so we
// unpack manually; the extensionDevelopmentPath in the EDP run points at the
// INSTALLED extension directory inside the clean extensions-dir.
import { runTests } from '@vscode/test-electron';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApiClient } from '../dist/client/api-client.js';

const NL = String.fromCharCode(10);

function toUnix(p) {
  return p.replace(/\\/g, '/');
}

function findCodePath() {
  const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['code'], { encoding: 'utf8' });
  const line = (w.stdout ?? '').split(NL)[0].trim();
  if (!line) return 'code';
  const exe = path.join(path.dirname(path.dirname(line)), 'Code.exe');
  if (existsSync(exe)) return exe;
  return line;
}

async function main() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'd18-vsix-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'fixture.c'), 'int fixture;\n');
  const dbPath = path.join(dir, 'phyopt.sqlite');
  const extDir = path.join(dir, 'extensions');
  mkdirSync(extDir);
  const userDataDir = path.join(dir, 'user-data');
  const cwd = path.resolve('.');

  const vsix = path.resolve('extensions/vscode/phyopt-agent-vscode-0.2.0.vsix');
  const codePath = findCodePath();
  console.log('VSCODE', codePath);

  // 1. install: unpack the VSIX `extension/` payload into the extensions dir
  const unpackDir = path.join(dir, 'unpack');
  mkdirSync(unpackDir);
  const unzip = spawnSync('unzip', ['-q', toUnix(vsix), '-d', toUnix(unpackDir)], { encoding: 'utf8' });
  if (unzip.status !== 0) throw new Error(`vsix unpack failed: ${unzip.stderr}`);
  const extTarget = path.join(extDir, 'phyopt.phyopt-agent-vscode-0.2.0');
  mkdirSync(extTarget, { recursive: true });
  for (const entry of ['package.json', 'dist', 'media']) {
    const src = path.join(unpackDir, 'extension', entry);
    if (existsSync(src)) cpSync(src, path.join(extTarget, entry), { recursive: true });
  }
  if (!existsSync(path.join(extTarget, 'package.json'))) throw new Error('VSIX install missing package.json');
  // confirm the installed manifest identifies the extension (publisher.name)
  const manifest = JSON.parse(readFileSync(path.join(extTarget, 'package.json'), 'utf8'));
  if (manifest.name !== 'phyopt-agent-vscode' || manifest.publisher !== 'phyopt') {
    throw new Error(`unexpected extension manifest: ${manifest.publisher}.${manifest.name}`);
  }
  console.log('INSTALL_OK', extTarget);

  // 3. start backend (independent of any extension host)
  const backend = spawn(process.execPath, ['--import', 'tsx', 'extensions/vscode/test/backend.ts', dbPath], { cwd });
  const backendLine = await new Promise((resolve, reject) => {
    let buf = '';
    backend.stdout.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) resolve(buf.slice(0, nl)); });
    backend.on('error', reject);
  });
  const backendInfo = JSON.parse(backendLine);
  const serverUrl = `http://127.0.0.1:${backendInfo.port}`;
  console.log('BACKEND', JSON.stringify(backendInfo));

  // 4. compile the EDP runner
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: ['extensions/vscode/test/runner.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'extensions/vscode/dist/test/runner.js',
    external: ['vscode'],
  });

  const runnerJs = path.resolve('extensions/vscode/dist/test/runner.js');
  const launchArgs = [
    workspace,
    '--disable-updates',
    '--disable-workspace-trust',
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extDir}`,
  ];

  // 5. EDP phase 1: loads the INSTALLED extension and activates it
  const rc1 = await runTests({
    vscodeExecutablePath: codePath,
    extensionDevelopmentPath: extTarget, // the INSTALLED extension dir
    extensionTestsPath: runnerJs,
    launchArgs,
    extensionTestsEnv: { PHYOPT_SERVER_URL: serverUrl, PHYOPT_PHASE: '1' },
  });
  console.log('EDP1_RC', rc1);
  if (rc1 !== 0) throw new Error('EDP phase 1 failed (installed VSIX)');

  // 6. CLI cross-query after EDP 1 closed
  const cli = new ApiClient(serverUrl);
  const tasks = (await cli.listTasks()).tasks ?? [];
  if (tasks.length < 1) throw new Error('no tasks after EDP 1 closed');
  console.log('CLI_AFTER_EDP1', JSON.stringify(tasks));

  // 7. EDP phase 2
  const rc2 = await runTests({
    vscodeExecutablePath: codePath,
    extensionDevelopmentPath: extTarget,
    extensionTestsPath: runnerJs,
    launchArgs,
    extensionTestsEnv: { PHYOPT_SERVER_URL: serverUrl, PHYOPT_PHASE: '2' },
  });
  console.log('EDP2_RC', rc2);
  if (rc2 !== 0) throw new Error('EDP phase 2 failed (installed VSIX)');

  // 8. final state: a task cancelled
  const finalTasks = (await cli.listTasks()).tasks ?? [];
  const cancelled = finalTasks.filter((t) => t.status === 'CANCELLED' || t.status === 'CANCEL_REQUESTED');
  if (cancelled.length < 1) throw new Error('expected a cancelled task');

  console.log('VSIX_VERIFY_OK', JSON.stringify({ tasks: finalTasks.map((t) => t.task_id + ':' + t.status) }));
  backend.kill('SIGTERM');
  await new Promise((r) => { backend.once('exit', () => r()); setTimeout(r, 5000); });
  rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('VSIX_VERIFY_FAIL', err.message);
  process.exit(1);
});
