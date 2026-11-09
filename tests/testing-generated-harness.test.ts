import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { evaluatorContentSha256 } from '../src/evaluator/formal-evaluator.js';
import { createTestingFixture, testingPlanRef, waitTestingPreparation } from './testing-fixture.js';
import { startWebFixture } from './web-fixture.js';

function generated(f: ReturnType<typeof createTestingFixture>, options: { legacy?: boolean; candidateApi?: string; baselineApi?: string }) {
  const read = (filename: string) => JSON.parse(fs.readFileSync(filename, 'utf8'));
  const write = (filename: string, value: unknown) => fs.writeFileSync(filename, JSON.stringify(value, null, 2));
  const manifestPath = path.join(f.evaluatorRoot, 'manifest.json'), manifest = read(manifestPath);
  fs.mkdirSync(path.join(f.evaluatorRoot, 'support'), { recursive: true });
  for (const kind of ['correctness', 'performance'] as const) {
    fs.writeFileSync(path.join(f.evaluatorRoot, `support/test-${kind}.py`), 'from corepilot_test import TestContext\n');
    const script = path.join(f.evaluatorRoot, manifest[kind].command.script);
    fs.appendFileSync(script, `\n# generated fixture: support/test-${kind}.py\n`);
  }
  fs.writeFileSync(path.join(f.evaluatorRoot, 'support/corepilot_test.py'), options.legacy
    ? "class TestContext:\n  def identity(self): return {'input_path': self.artifact_path, 'resolved_symbol_path': self.artifact_path}\n"
    : 'class TestContext: pass\n');
  const testPlanPath = path.join(f.evaluatorRoot, 'test-plan.json'), testPlan = read(testPlanPath);
  testPlan.candidate_api = options.candidateApi ?? 'cblas_saxpy'; testPlan.baseline_api = options.baselineApi ?? 'cblas_saxpy'; write(testPlanPath, testPlan);
  manifest.digest = evaluatorContentSha256(f.evaluatorRoot); write(manifestPath, manifest);
  const qualificationPath = path.join(f.evaluatorRoot, 'qualification.json'), qualification = read(qualificationPath);
  qualification.subject_digest = manifest.digest; write(qualificationPath, qualification);
  const packagePath = path.join(f.packageRoot, 'package.json'), pkg = read(packagePath);
  pkg.formal_evaluators[0].digest = manifest.digest; write(packagePath, pkg);
}

test('known unsafe generated adapter is rejected for new testing tasks but prior request replay stays readable', async () => {
  const f = createTestingFixture(), testingWeb = await startWebFixture({ testingService: f.service });
  const api = new ApiClient(testingWeb.url, { token: testingWeb.token });
  try {
    const candidate = await f.binary('candidate');
    const input = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' as const };
    const { task } = await api.testing.start(input, 'existing-request'); await waitTestingPreparation(f.service, task.task_id);
    generated(f, { legacy: true });
    assert.equal((await api.testing.start(input, 'existing-request')).task.task_id, task.task_id);
    await assert.rejects(api.testing.start(input, 'new-request'), /旧版生成适配器/);
    assert.equal(f.plans.length, 1); assert.equal((await api.testing.list()).tasks.length, 1);
  } finally { await testingWeb.close(); f.close(); }
});

test('generated API requirements follow the selected test mode and compared subjects', async () => {
  const f = createTestingFixture(), web = await startWebFixture({ testingService: f.service });
  const api = new ApiClient(web.url, { token: web.token });
  try {
    const candidate = await f.binary('candidate'), baseline = await f.binary('baseline');
    generated(f, { candidateApi: '', baselineApi: 'cblas_saxpy' });
    await assert.rejects(api.testing.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' }), /候选库实际导出/);
    generated(f, { candidateApi: 'cblas_saxpy', baselineApi: '' });
    const { task } = await api.testing.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, baseline, mode: 'correctness' });
    assert.equal((await waitTestingPreparation(f.service, task.task_id)).execution.status, 'PENDING');
    await assert.rejects(api.testing.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, baseline, mode: 'performance' }), /比较基线库实际导出/);
    assert.equal(f.plans.length, 1);
  } finally { await web.close(); f.close(); }
});
