import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TestingService } from '../src/application/testing-service.js';
import { TestingStore } from '../src/storage/testing-store.js';
import { RunnerClientError } from '../src/client/runner-client.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { TaskHost } from '../src/core/task-host.js';
import type { TestingRunner } from '../src/application/testing-subjects.js';

const [action, descriptionPath] = process.argv.slice(2);
const description = JSON.parse(fs.readFileSync(descriptionPath, 'utf8'));
const host = new TaskHost(new SqliteTaskStore(description.hostDb));
await host.start();

if (action === 'hold-lock') {
  const db = new DatabaseSync(path.join(description.root, 'testing', 'task-write-lock.sqlite'));
  db.exec('BEGIN IMMEDIATE'); process.stdout.write('LOCKED\n');
  setInterval(() => { db.exec('SELECT 1'); }, 1_000);
} else if (action === 'hold-update') {
  new TestingStore(description.root).updateTask(description.taskId, record => {
    fs.writeFileSync(description.marker, 'locked');
    const signal = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(description.release)) Atomics.wait(signal, 0, 0, 10);
    record.execution.phase = 'STAGING_TESTS';
  });
  process.stdout.write('UPDATED\n'); await host.stop();
} else if (action === 'owner') {
  const runner = {
    async probe() {
      if (description.pause === 'probe') { fs.writeFileSync(description.marker, 'probing'); await new Promise<void>(() => {}); }
      return description.probe;
    }, bindStoreIdentity() {},
    async submitExperiment(plan: { experiment: { experiment_id: string } }) {
      fs.writeFileSync(description.marker, plan.experiment.experiment_id);
      await new Promise<void>(() => {});
      throw new Error('unreachable');
    },
  } as unknown as TestingRunner;
  const service = new TestingService({ dataDir: description.root, projects: { get() { throw new Error('unexpected project'); } },
    machines: { resolve() { return description.machine; } }, runnerFactory: () => runner,
    transportFactory: () => ({ async runRemote(argv) { return { command: argv[0], argv, stdout: '', stderr: '', exit_code: 0 }; },
      uploadFile() { return { exit_code: 0, stderr: '' }; } }),
    async stageBinary(input) { return { ok: true, machine_identity_sha256: description.probe.machine.machine_identity_sha256,
      checked_at: new Date().toISOString(), entry_sha256: input.files.find(file => file.path === input.entryPath)!.sha256,
      libraries: [], resolved_libraries: [], issues: [] }; } });
  const task = await service.start(description.input, { requestId: description.requestId });
  process.stdout.write(JSON.stringify({ task_id: task.task_id }) + '\n');
  setInterval(() => {}, 1_000);
} else {
  const id = description.taskId;
  const missing = () => { throw new RunnerClientError(404, 'NOT_FOUND', 'offline fixture has no accepted job'); };
  const runner = { bindStoreIdentity() {},
    async cancelExperiment() { if (description.reply === 'missing') return missing(); return { experiment_id: id, status: 'CANCELLED', cancel_requested: true }; },
    async getExperiment() { if (description.reply === 'missing') return missing(); return { experiment_id: id, status: 'RUNNING', current_step: 'PERFORMANCE', cancel_requested: false, failure: null }; },
    async getCommandExecutions() { return { experiment_id: id, command_executions: [] }; },
    async getMeasurements() { return { experiment_id: id, measurements: [] }; },
    async getExecutionOutput() { return { stdout: '', stderr: '', stdout_path: null, stderr_path: null, truncated: false }; },
  } as unknown as TestingRunner;
  const service = new TestingService({ dataDir: description.root, projects: { get() { throw new Error('unexpected project'); } },
    machines: { resolve() { return description.machine; } }, runnerFactory: () => runner });
  try {
    if (description.announce) process.stdout.write('CANCEL_READY\n');
    const result = action === 'get' ? await service.get(id) : await service.cancel(id);
    process.stdout.write(JSON.stringify({ execution: result.task.execution }) + '\n');
  } finally { await host.stop(); }
}
