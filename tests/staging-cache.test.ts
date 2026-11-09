import assert from 'node:assert/strict';
import test from 'node:test';
import { createStagingCache } from '../src/workflow/staging-cache.js';

test('staging shares concurrent attempts and can recover after a transient failure', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stage = createStagingCache(async () => {
    calls++;
    if (calls === 1) { await gate; throw new Error('temporary transfer failure'); }
    return { remote: '/runner/verified-baseline' };
  });
  const first = stage(), concurrent = stage();
  release();
  const failures = await Promise.allSettled([first, concurrent]);
  assert.equal(calls, 1);
  assert.ok(failures.every(result => result.status === 'rejected' && result.reason.message === 'temporary transfer failure'));
  const [retried, reused] = await Promise.all([stage(), stage()]);
  assert.equal(calls, 2);
  assert.deepEqual(retried, { remote: '/runner/verified-baseline' });
  assert.equal(retried, reused);
  await stage();
  assert.equal(calls, 2, 'a verified successful result is reused');
});

test('a cancelled staging attempt does not prevent a later attempt with a fresh signal', async () => {
  const stage = createStagingCache(async (signal) => { signal?.throwIfAborted(); return 'ready'; });
  const controller = new AbortController();
  controller.abort('cancelled');
  await assert.rejects(stage(controller.signal), reason => reason === 'cancelled');
  assert.equal(await stage(new AbortController().signal), 'ready');
});
