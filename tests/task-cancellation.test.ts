import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { TaskHost } from '../src/core/task-host.js';
import { makeTarget } from '../src/contracts/target.js';
import { createHttpServer } from '../src/http/server.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import type { RunResult } from '../src/runner/runner.js';

test('repeated task cancellation remains requested until the runner confirms the stop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-task-cancel-'));
  const store = new SqliteTaskStore(path.join(root, 'control.sqlite'));
  let release!: (result: RunResult) => void;
  const running = new Promise<RunResult>(resolve => { release = resolve; });
  const host = new TaskHost(store, { tickMs: 5, runnerFactory: () => ({
    checkAvailability: () => ({ available: true, reason: null }), run: () => running,
  }) });
  await host.start();
  const server = createHttpServer(host, { host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const { task } = host.createTask('request-cancel', 'slow', makeTarget('fixture'));
    for (let i = 0; i < 200 && host.getTask(task.task_id)?.status !== 'RUNNING'; i++) await delay(5);
    assert.equal(host.getTask(task.task_id)?.status, 'RUNNING');
    const cancel = async (id: string) => {
      const response = await fetch(`${base}/v1/tasks/${task.task_id}/cancel`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command_id: id }) });
      assert.equal(response.status, 200); return response.json() as Promise<{ status: string }>;
    };
    assert.equal((await cancel('first')).status, 'cancel_requested');
    assert.equal((await cancel('second')).status, 'cancel_requested');
    assert.equal(host.getTask(task.task_id)?.status, 'CANCEL_REQUESTED');
    release({ ok: false, cancelled: true, error: 'stop confirmed' });
    for (let i = 0; i < 200 && host.getTask(task.task_id)?.status !== 'CANCELLED'; i++) await delay(5);
    assert.equal((await cancel('third')).status, 'already_cancelled');
  } finally {
    release({ ok: false, cancelled: true, error: 'cleanup' });
    await new Promise<void>(resolve => server.close(() => resolve())); await host.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
