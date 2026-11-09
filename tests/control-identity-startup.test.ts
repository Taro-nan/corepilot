import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CONTROL_DATA_IDENTITY_FILE } from '../src/storage/control-identity.js';
import type { ControlIdentity } from '../src/contracts/control-identity.js';

async function availablePort(): Promise<number> {
  const socket = net.createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(resolve => socket.close(() => resolve())); return address.port;
}

test('CLI starts existing deployments, preserves identities and keeps legacy reads available when a marker is missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-control-startup-'));
  const db = path.join(root, 'workflow.sqlite'), data = path.join(root, 'data'), alternate = path.join(root, 'other-data');
  fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'legacy.txt'), 'preserve');
  const legacy = new DatabaseSync(db); legacy.exec("CREATE TABLE legacy_record (value TEXT); INSERT INTO legacy_record VALUES ('keep')"); legacy.close();
  const port = await availablePort(), url = `http://127.0.0.1:${port}`;
  const token = 'offline-control-fixture', shutdown = 'offline-shutdown-fixture';
  const headers = { authorization: `Bearer ${token}` };
  let running: ReturnType<typeof spawn> | null = null;
  async function start(dataDir: string, initialize = false) {
    const args = ['--import', 'tsx', 'src/entry.ts', 'backend', 'serve', '--transport', 'mock', '--host', '127.0.0.1', '--port', String(port),
      '--db', db, '--data-dir', dataDir, ...(initialize ? ['--initialize-control-data'] : [])];
    const child = spawn(process.execPath, args, { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, COREPILOT_SERVER_TOKEN: token, COREPILOT_MANAGED_BACKEND_TOKEN: shutdown } });
    running = child;
    let diagnostic = '';
    child.stdout?.on('data', chunk => { diagnostic += String(chunk); }); child.stderr?.on('data', chunk => { diagnostic += String(chunk); });
    const exited = once(child, 'exit');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Control exited before ready: ${diagnostic}`);
      try { if ((await fetch(url + '/v1/health', { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await fetch(url + '/v1/health')).status, 200, diagnostic);
    return {
      identity: () => fetch(url + '/v1/control-identity', { headers }),
      async stop() {
        const response = await fetch(url + '/v1/admin/shutdown', { method: 'POST', headers: { ...headers, 'x-corepilot-shutdown-token': shutdown } });
        assert.equal(response.status, 202);
        const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Control did not stop')), 10_000).unref());
        await Promise.race([exited, deadline]); running = null;
      },
    };
  }
  try {
    const first = await start(data);
    const originalResponse = await first.identity(); assert.equal(originalResponse.status, 200);
    const original = await originalResponse.json() as ControlIdentity;
    await first.stop();
    const restarted = await start(data);
    assert.deepEqual(await (await restarted.identity()).json(), original);
    await restarted.stop();
    const marker = path.join(data, CONTROL_DATA_IDENTITY_FILE), saved = fs.readFileSync(marker);
    fs.unlinkSync(marker);
    const missing = await start(data);
    assert.equal((await missing.identity()).status, 503);
    assert.equal((await fetch(url + '/v1/projects', { headers })).status, 200);
    assert.equal(fs.existsSync(marker), false);
    await missing.stop(); fs.writeFileSync(marker, saved);
    const newDirectory = await start(alternate);
    assert.equal((await newDirectory.identity()).status, 503);
    await newDirectory.stop();
    const adopted = await start(alternate, true);
    const changed = await (await adopted.identity()).json() as ControlIdentity;
    assert.equal(changed.database_id, original.database_id); assert.notEqual(changed.data_root_id, original.data_root_id);
    await adopted.stop();
    assert.equal(fs.readFileSync(path.join(data, 'legacy.txt'), 'utf8'), 'preserve');
    const check = new DatabaseSync(db);
    assert.equal((check.prepare('SELECT value FROM legacy_record').get() as { value: string }).value, 'keep'); check.close();
  } finally {
    if (running) { running.kill(); await once(running, 'exit').catch(() => {}); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
