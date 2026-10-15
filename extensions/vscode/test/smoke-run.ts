import { runTests } from '@vscode/test-electron';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync as fsExists } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApiClient } from '../../../src/client/api-client.js';

const NL = String.fromCharCode(10);

function findCodePath(): string {
  const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['code'], { encoding: 'utf8' });
  const line = (w.stdout ?? '').split(NL)[0].trim();
  if (!line) return 'code';
  // `where code` resolves to <root>/bin/code (a shell shim); the launcher is Code.exe in <root>.
  const exe = path.join(path.dirname(path.dirname(line)), "Code.exe");
  if (fsExists(exe)) return exe;
  return line;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'd16-smoke-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'fixture.c'), 'int fixture;\n');
  const dbPath = path.join(dir, 'phyopt.sqlite');
  const cwd = path.resolve('.');

  // 1. start backend (independent of any extension host)
  const backend = spawn(process.execPath, ['--import', 'tsx', 'extensions/vscode/test/backend.ts', dbPath], { cwd });
  backendProc = backend;
  const backendLine: string = await new Promise((resolve, reject) => {
    let buf = '';
    backend.stdout.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) resolve(buf.slice(0, nl)); });
    backend.on('error', reject);
  });
  const backendInfo = JSON.parse(backendLine) as { pid: number; port: number; dbPath: string };
  const serverUrl = `http://127.0.0.1:${backendInfo.port}`;
  console.log('BACKEND', JSON.stringify(backendInfo));

  // 2. compile the EDP runner (use esbuild JS API to avoid npx/cmd quirks)
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: ['extensions/vscode/test/runner.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'extensions/vscode/dist/test/runner.js',
    external: ['vscode'],
  });
  const codePath = findCodePath();
  console.log('VSCODE', codePath);

  // 3. EDP phase 1: activation + submit task
  const rc1 = await runTests({
    vscodeExecutablePath: codePath,
    extensionDevelopmentPath: path.resolve('extensions/vscode'),
    extensionTestsPath: path.resolve('extensions/vscode/dist/test/runner.js'),
    launchArgs: [workspace, '--disable-updates', '--disable-workspace-trust'],
    extensionTestsEnv: { PHYOPT_SERVER_URL: serverUrl, PHYOPT_PHASE: '1' },
  });
  console.log('EDP1_RC', rc1);
  if (rc1 !== 0) throw new Error('EDP phase 1 failed');

  // 4. CLI cross-query after EDP 1 closed; backend must still be alive and the
  //    task must have actually progressed (RUNNING status / execution event /
  //    completion), not merely sat in PENDING.
  const cli = new ApiClient(serverUrl);
  const tasksRes = (await cli.listTasks()) as { tasks: Array<{ task_id: string; status: string; is_mock: boolean; target?: { name?: string } }> };
  const tasks = tasksRes.tasks;
  if (tasks.length < 1) throw new Error('no tasks after EDP 1 closed');
  console.log('CLI_AFTER_EDP1', JSON.stringify(tasks));
  const firstTask = tasks[0];
  const eventsRes = (await cli.getEvents(firstTask.task_id)) as { events: Array<{ type: string; payload?: Record<string, unknown> }> };
  const progressed =
    firstTask.status === 'RUNNING' ||
    firstTask.status === 'COMPLETED' ||
    eventsRes.events.some((e) => e.type === 'TASK_STATUS_CHANGED' && e.payload?.to === 'RUNNING') ||
    eventsRes.events.some((e) => e.type === 'RUNNER_EXECUTED');
  if (!progressed) throw new Error('task did not progress past PENDING after EDP 1 closed (no RUNNING/execution/completion evidence)');
  console.log('CLI_EVENTS', JSON.stringify(eventsRes.events.map((e) => e.type)));

  // 5. EDP phase 2: query prior task, open report, cancel a second task
  const rc2 = await runTests({
    vscodeExecutablePath: codePath,
    extensionDevelopmentPath: path.resolve('extensions/vscode'),
    extensionTestsPath: path.resolve('extensions/vscode/dist/test/runner.js'),
    launchArgs: [workspace, '--disable-updates', '--disable-workspace-trust'],
    extensionTestsEnv: { PHYOPT_SERVER_URL: serverUrl, PHYOPT_PHASE: '2' },
  });
  console.log('EDP2_RC', rc2);
  if (rc2 !== 0) throw new Error('EDP phase 2 failed');

  // 6. final state: a task cancelled
  const finalTasks = (await cli.listTasks()) as { tasks: Array<{ task_id: string; status: string }> };
  const cancelled = finalTasks.tasks.filter((t) => t.status === 'CANCELLED' || t.status === 'CANCEL_REQUESTED');
  if (cancelled.length < 1) throw new Error('expected a cancelled task');

  console.log('SMOKE_OK', JSON.stringify({ backendPid: backendInfo.pid, dbPath, tasks: finalTasks.tasks.map((t) => t.task_id + ':' + t.status) }));
  // Gracefully stop the backend (SIGTERM -> server.close + host.stop) and wait
  // for it to exit before returning, to avoid a libuv handle assertion on
  // Windows when the process exits with a live child and open SQLite handles.
  await new Promise<void>((resolve) => {
    backend.once('exit', () => resolve());
    backend.kill();
  });
}

let backendProc: ReturnType<typeof spawn> | null = null;

main().catch((err) => {
  console.error('SMOKE_FAIL', (err as Error).message);
  if (backendProc) { backendProc.kill(); }
  process.exit(1);
});
