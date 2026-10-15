import { TaskHost } from '../../../src/core/task-host.js';
import { SqliteTaskStore } from '../../../src/storage/sqlite-task-store.js';
import { createHttpServer } from '../../../src/http/server.js';
import { MockRunner } from '../../../src/runner/mock-runner.js';

const dbPath = process.argv[2];
const store = new SqliteTaskStore(dbPath);
store.init();
const host = new TaskHost(store, {
  // Use the `slow` scenario so submitted tasks stay RUNNING long enough to
  // prove the backend keeps executing after the EDP window closes.
  runnerFactory: () => new MockRunner('slow', { slowRunMs: 30_000 }),
  leaseTtlMs: 30_000,
  slowRunMs: 30_000,
});
void (async () => {
  await host.start();
  const server = createHttpServer(host, { host: '127.0.0.1', port: 0 });
  server.on('listening', () => {
    const port = (server.address() as { port: number }).port;
    process.stdout.write(JSON.stringify({ pid: process.pid, port, dbPath }) + '\n');
  });
  const shutdown = async () => {
    server.close();
    await host.stop();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
