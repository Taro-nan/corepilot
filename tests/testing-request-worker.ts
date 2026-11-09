import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { TestingService } from '../src/application/testing-service.js';
import type { TestingRunner } from '../src/application/testing-subjects.js';

const [descriptionPath, gate] = process.argv.slice(2);
const description = JSON.parse(fs.readFileSync(descriptionPath, 'utf8'));
const runner = { async probe() { fs.appendFileSync(description.log, `${description.key}\n`); throw new Error('offline fixture stops before Runner execution'); } } as unknown as TestingRunner;
const service = new TestingService({ dataDir: description.root, projects: { get() { throw new Error('unexpected source project'); } },
  machines: { resolve() { return description.machine; } }, runnerFactory: () => runner });
process.stdout.write('READY\n');
const deadline = Date.now() + 15_000;
while (!fs.existsSync(gate)) {
  if (Date.now() > deadline) throw new Error('testing request fixture timed out waiting for the start gate');
  await delay(10);
}
try {
  const result = description.action === 'close' ? service.closeRequest(description.key, description.controlIdentity)
    : await service.start(description.input, { requestId: description.key, controlIdentity: description.controlIdentity });
  await delay(100);
  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: (error as { code?: string }).code, message: (error as Error).message }) + '\n');
}
