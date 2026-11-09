import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ControlIdentityGuard, CONTROL_DATA_IDENTITY_FILE } from '../src/storage/control-identity.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-control-identity-'));
  const dbPath = path.join(root, 'workflow.sqlite'), dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const store = new SqliteTaskStore(dbPath); store.init();
  return { root, dbPath, dataDir, store, close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('legacy nonempty storage adopts stable identities without changing existing records', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dataDir, 'legacy.txt'), 'preserve original data');
    const sql = new DatabaseSync(f.dbPath);
    sql.exec("CREATE TABLE legacy_record (value TEXT); INSERT INTO legacy_record VALUES ('keep')"); sql.close();
    const first = ControlIdentityGuard.initialize(f.store, f.dataDir).current();
    assert.deepEqual(ControlIdentityGuard.initialize(f.store, f.dataDir).current(), first);
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'legacy.txt'), 'utf8'), 'preserve original data');
    const check = new DatabaseSync(f.dbPath);
    assert.equal((check.prepare('SELECT value FROM legacy_record').get() as { value: string }).value, 'keep'); check.close();
  } finally { f.close(); }
});

test('lost or damaged markers and database identities remain unavailable; a new directory requires explicit initialization', () => {
  const f = fixture();
  try {
    const first = ControlIdentityGuard.initialize(f.store, f.dataDir).current();
    const marker = path.join(f.dataDir, CONTROL_DATA_IDENTITY_FILE);
    const original = fs.readFileSync(marker);
    const guard = ControlIdentityGuard.initialize(f.store, f.dataDir);
    fs.unlinkSync(marker);
    assert.throws(() => guard.current(), /无法核对/);
    assert.throws(() => ControlIdentityGuard.initialize(f.store, f.dataDir).current(), /无法核对/);
    assert.equal(fs.existsSync(marker), false);
    fs.writeFileSync(marker, '{broken');
    assert.throws(() => ControlIdentityGuard.initialize(f.store, f.dataDir, { initializeNewDataDir: true }).current(), /无法核对/);
    assert.equal(fs.readFileSync(marker, 'utf8'), '{broken');
    fs.writeFileSync(marker, original);
    assert.deepEqual(ControlIdentityGuard.initialize(f.store, f.dataDir).current(), first);
    const other = path.join(f.root, 'new-data');
    assert.throws(() => ControlIdentityGuard.initialize(f.store, other).current(), /无法核对/);
    assert.equal(fs.existsSync(path.join(other, CONTROL_DATA_IDENTITY_FILE)), false);
    const adopted = ControlIdentityGuard.initialize(f.store, other, { initializeNewDataDir: true }).current();
    assert.equal(adopted.database_id, first.database_id);
    assert.notEqual(adopted.data_root_id, first.data_root_id);
    const sql = new DatabaseSync(f.dbPath); sql.exec('DELETE FROM control_database_identity'); sql.close();
    assert.throws(() => guard.current(), /无法核对/);
    assert.throws(() => ControlIdentityGuard.initialize(f.store, f.dataDir).current(), /无法核对/);
  } finally { f.close(); }
});

test('an interrupted first initialization resumes from the published data marker', () => {
  const f = fixture();
  try {
    const marker = path.join(f.dataDir, CONTROL_DATA_IDENTITY_FILE);
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    fs.writeFileSync(marker, JSON.stringify({ version: 1, data_root_id: id }));
    assert.equal(f.store.readControlDatabaseIdentity(), null);
    const identity = ControlIdentityGuard.initialize(f.store, f.dataDir).current();
    assert.equal(identity.data_root_id, id);
    assert.deepEqual(ControlIdentityGuard.initialize(f.store, f.dataDir).current(), identity);
  } finally { f.close(); }
});

test('different databases can share a data directory while retaining distinct request identities', () => {
  const f = fixture();
  const other = new SqliteTaskStore(path.join(f.root, 'other.sqlite'));
  try {
    other.init();
    const first = ControlIdentityGuard.initialize(f.store, f.dataDir).current();
    const second = ControlIdentityGuard.initialize(other, f.dataDir).current();
    assert.notEqual(first.database_id, second.database_id);
    assert.equal(first.data_root_id, second.data_root_id);
  } finally { other.close(); f.close(); }
});

test('losing either database identity table does not recreate the identity', () => {
  const f = fixture();
  try {
    ControlIdentityGuard.initialize(f.store, f.dataDir).current();
    const sql = new DatabaseSync(f.dbPath); sql.exec('DROP TABLE control_database_identity'); sql.close();
    assert.throws(() => ControlIdentityGuard.initialize(f.store, f.dataDir).current(), /无法核对/);
    assert.throws(() => f.store.readControlDatabaseIdentity(), /身份缺失或损坏/);
  } finally { f.close(); }
});

test('independent processes initialize one shared pair without replacing the marker', async () => {
  const f = fixture();
  const source = `
import { SqliteTaskStore } from './src/storage/sqlite-task-store.ts';
import { ControlIdentityGuard } from './src/storage/control-identity.ts';
const store = new SqliteTaskStore(process.env.TEST_DB);
process.stdout.write('READY\\n');
process.stdin.once('data', () => {
  try { process.stdout.write('RESULT ' + JSON.stringify(ControlIdentityGuard.initialize(store, process.env.TEST_DATA).current()) + '\\n'); }
  catch (error) { process.stdout.write('ERROR ' + error.message + '\\n'); }
  store.close(); process.stdin.destroy();
});`;
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEST_DB: f.dbPath, TEST_DATA: f.dataDir },
    });
    let output = '', stderr = '';
    child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exited = once(child, 'exit');
    async function until(text: string) {
      const deadline = Date.now() + 15_000;
      while (!output.includes(text)) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`${output} ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    return { child, exited, until, result: () => JSON.parse(output.split('RESULT ')[1].split('\n')[0]) };
  });
  try {
    await Promise.all(children.map(child => child.until('READY')));
    for (const child of children) child.child.stdin.end('go');
    await Promise.all(children.map(child => child.until('RESULT ')));
    await Promise.all(children.map(child => child.exited));
    assert.deepEqual(children[0].result(), children[1].result());
    assert.deepEqual(ControlIdentityGuard.initialize(f.store, f.dataDir).current(), children[0].result());
  } finally { for (const child of children) child.child.kill(); f.close(); }
});
