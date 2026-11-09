import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { HarnessEvent } from '@earendil-works/pi-agent-core';
import { PiOptimizationSession } from '../src/agent/pi-optimization-session.js';
import { ApiClient } from '../src/client/api-client.js';
import { RunnerClient } from '../src/client/runner-client.js';
import { createPiModels, COREPILOT_PI_PROVIDER_ID } from '../src/model/pi-provider.js';
import { startWebFixture } from './web-fixture.js';
import { prepareReviewFixture } from './validation-review-fixture.js';

for (const cancelFirst of [false, true]) test(`a pending development job survives a thrown session after ${cancelFirst ? 'a user cancellation' : 'an unknown Runner event'}`, async () => {
  let expected = ''; let attempts = 0; let sessionRuns = 0; let injected = false;
  const f = await startWebFixture({ execute: true, rpcTransport: {
    async runRemote(argv) { return { command: argv[0], argv, exit_code: 0, stderr: '', stdout: argv.join(' ').includes('sha256sum') ? `${expected}  artifact.so\n` : '' }; },
    uploadFile() { return { exit_code: 0, stderr: '' }; },
  } });
  const r = await prepareReviewFixture(f).catch(async error => { await f.close(); throw error; });
  const originalRun = PiOptimizationSession.prototype.run;
  const originalSubmit = RunnerClient.prototype.submitExperiment;
  let workflowId = '';
  try {
    expected = r.record.baseline_digest;
    const review = await f.projects.validationReview.preview(r.project, r.pkg, r.version, r.target);
    await f.projects.validationReview.approve(r.project, r.pkg, r.version, r.target, { expected_digest: review.evaluator_digest,
      expected_package_digest: review.package_digest, trial_id: r.trialId, reviewer: 'Fixture owner', confirm: true });
    r.state.status = 'UNKNOWN';
    RunnerClient.prototype.submitExperiment = async () => { attempts++; throw new Error('the original job must not be re-submitted'); };
    PiOptimizationSession.prototype.run = async function (_prompt, _tools, signal) {
      sessionRuns++;
      await this.record('development-job', { experiment: { experiment_id: 'development:pending-fixture' } });
      if (cancelFirst) f.service.cancel(f.service.list(1)[0].workflow_id);
      const onEvent = (this as unknown as { options: { onEvent: (event: HarnessEvent) => Promise<void> } }).options.onEvent;
      await onEvent({ type: 'tool_end', toolName: 'run_dev_benchmark', isError: true } as HarnessEvent);
      assert.equal(signal.aborted, true);
      injected = true;
      throw new Error('injected session failure after tool_end');
    };
    const api = new ApiClient(f.url, { token: f.token });
    workflowId = (await api.submitOptimizationWorkflow({ project_id: r.project.project_id }) as { workflow_id: string }).workflow_id;
    const wait = async () => {
      for (let i = 0; i < 800; i++) {
        const record = f.service.get(workflowId)!;
        if (record.status !== 'CREATED' && record.status !== 'GENERATING' && !f.service.activeWorkflowIds().length) return record;
        await delay(20);
      }
      assert.fail(JSON.stringify(f.service.get(workflowId)));
    };
    const first = await wait();
    assert.equal(injected, true);
    assert.equal(first.status, 'INTERRUPTED');
    assert.equal(f.store.getOptimizationTask(first.optimization_task_id!)?.status, 'INTERRUPTED');
    assert.match(first.error!, /development:pending-fixture/);
    assert.equal(attempts, 0);
    const models = createPiModels({ modelId: 'fixture-model', endpoint: 'http://fixture.invalid/v1', apiKey: 'fixture' });
    const session = await PiOptimizationSession.open({ id: first.agent_session!.id, directory: first.agent_session!.directory,
      models, model: models.getModel(COREPILOT_PI_PROVIDER_ID, 'fixture-model')!, systemPrompt: 'fixture' });
    try { assert.equal((await session.readRecord<{ experiment: { experiment_id: string } }>('development-job'))?.experiment.experiment_id, 'development:pending-fixture'); }
    finally { await session.close(); }
    await api.resumeOptimizationWorkflow(workflowId);
    const resumed = await wait();
    assert.equal(resumed.status, 'INTERRUPTED');
    assert.equal(f.store.getOptimizationTask(resumed.optimization_task_id!)?.status, 'INTERRUPTED');
    assert.match(resumed.error!, /development:pending-fixture/);
    assert.equal(attempts, 0); assert.equal(sessionRuns, 1, 'reconciliation must precede any further Agent work');
    const reopened = await PiOptimizationSession.open({ id: resumed.agent_session!.id, directory: resumed.agent_session!.directory,
      models, model: models.getModel(COREPILOT_PI_PROVIDER_ID, 'fixture-model')!, systemPrompt: 'fixture' });
    try { assert.equal((await reopened.readRecord<{ experiment: { experiment_id: string } }>('development-job'))?.experiment.experiment_id, 'development:pending-fixture'); }
    finally { await reopened.close(); }
  } finally {
    PiOptimizationSession.prototype.run = originalRun; RunnerClient.prototype.submitExperiment = originalSubmit;
    await r.close(); await f.close();
  }
});
