import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { createTestingFixture, testingPlanRef, waitTestingPreparation } from './testing-fixture.js';
import { startWebFixture } from './web-fixture.js';

test('independent testing API preserves a malformed sample without claiming a performance result', async () => {
  const fixture = createTestingFixture();
  const web = await startWebFixture({ testingService: fixture.service });
  try {
    const api = new ApiClient(web.url, { token: web.token });
    const { task } = await api.testing.start({ machine_id: fixture.machine.identity.machine_id, plan: testingPlanRef, mode: 'both',
      candidate: await fixture.binary('candidate'), baseline: await fixture.binary('baseline') });
    const prepared = await waitTestingPreparation(fixture.service, task.task_id);
    fixture.complete(prepared);
    const measurements = Array.from({ length: 9 }, (_, index) => (['BASELINE', 'CANDIDATE'] as const).map(role =>
      fixture.measurement(prepared, { role, sample_index: role === 'CANDIDATE' && index === 1 ? 0.5 : index, value: role === 'BASELINE' ? 2 : 1 }))).flat();
    measurements.push(fixture.measurement(prepared, { kind: 'CORRECTNESS_CASE', role: 'EVALUATOR', subject_id: 'case-1',
      sample_index: null, value: 'PASS', unit: null }));
    fixture.setMeasurements(measurements);
    const result = await api.testing.get(task.task_id);
    assert.equal(result.task.execution.status, 'SUCCEEDED', JSON.stringify(result.task.execution));
    assert.equal(result.summary.correctness.status, 'PASSED');
    assert.equal(result.summary.performance.status, 'INVALID');
    assert.equal(result.summary.performance.speedup, null);
    assert.equal(result.formal_evidence, false);
    assert.ok(result.measurements.some(row => row.sample_index === 0.5));
  } finally { await web.close(); fixture.close(); }
});
