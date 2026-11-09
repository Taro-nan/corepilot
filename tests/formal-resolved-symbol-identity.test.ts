import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunnerClient } from '../src/client/runner-client.js';
import { sourceTreeSha256 } from '../src/core/source-identity.js';
import { evaluatorContentSha256, loadFormalEvaluatorBundle } from '../src/evaluator/formal-evaluator.js';
import { createFormalEvaluatorSteps } from '../src/evaluator/formal-plan.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import type { FormalResourceCommandRunner } from '../src/runner/resource-enforcement.js';
import { runValidationCommand } from '../src/workspace/validation-runner.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';

// These are synthetic measurements and simulated resource observations. They
// test the Runner RPC contract, not hardware execution or performance.
const token = 'symbol-identity-local-fixture';
const resourceRunner: FormalResourceCommandRunner = async (command, resources, signal) => {
  const node = String(resources.numa_node), threads = String(resources.threads);
  const threadConfiguration = { OMP_NUM_THREADS: threads, OPENBLAS_NUM_THREADS: threads, GOTO_NUM_THREADS: threads };
  return { result: await runValidationCommand(command, command.cwd, { signal }), resourceContext: {
    declared: { ...resources },
    applied: { cpu_affinity: { mechanism: 'taskset', cpu_set: resources.cpu_set },
      numa_policy: { mechanism: 'numactl', policy: 'bind', cpu_nodes: node, memory_nodes: node }, thread_configuration: threadConfiguration },
    observed: { cpu_set: resources.cpu_set, child_cpu_set: resources.cpu_set, mems_allowed_list: node,
      numa_policy: { policy: 'bind', cpu_nodes: node, node_bind: node, memory_nodes: node }, thread_configuration: threadConfiguration,
      max_runtime_threads: resources.threads, runtime_thread_observation: 'OBSERVED' },
    enforcement: { cpu_set: 'ENFORCED', numa_node: 'ENFORCED', threads: 'ENFORCED' }, validity: 'VALID', errors: [],
  } };
};

type Variation = 'named-mismatch' | 'generic-mismatch' | 'conflicting-fields' | 'performance-mismatch' | 'unresolved' | 'matching' | 'alias-match' | 'hardlink-match' | 'input-hardlink-match' | 'reserved-field' | 'legacy-generated';

async function runFixture(variation: Variation) {
  const temp = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'corepilot-symbol-identity-'));
  assert.ok(path.resolve(root).startsWith(temp + path.sep));
  const candidateRoot = path.join(root, 'candidate'), evaluatorRoot = path.join(root, 'evaluator');
  fs.mkdirSync(candidateRoot); fs.mkdirSync(evaluatorRoot);
  const artifact = path.join(candidateRoot, 'candidate.bin'), other = path.join(candidateRoot, 'other.bin');
  fs.writeFileSync(artifact, 'fixture candidate'); fs.writeFileSync(other, 'different fixture provider');
  const alias = path.join(variation === 'alias-match' ? root : candidateRoot, 'candidate-alias.bin');
  if (variation === 'alias-match') {
    try { fs.symlinkSync(artifact, alias, 'file'); }
    catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
  }
  if (variation === 'hardlink-match' || variation === 'input-hardlink-match') fs.linkSync(artifact, alias);
  createFormalEvaluatorFixture(evaluatorRoot);
  const performance = variation === 'performance-mismatch';
  const script = path.join(evaluatorRoot, 'scripts', performance ? 'run-performance.sh' : 'run-correctness.sh');
  let original = fs.readFileSync(script, 'utf8');
  if (variation === 'legacy-generated') {
    fs.mkdirSync(path.join(evaluatorRoot, 'support'));
    fs.writeFileSync(path.join(evaluatorRoot, 'support', 'corepilot_test.py'), `class TestContext:\n  def emit(self):\n    return {"input_path": self.artifact_path, "resolved_symbol_path": self.artifact_path}\n`);
    fs.writeFileSync(path.join(evaluatorRoot, 'support', 'test-correctness.py'), 'from corepilot_test import TestContext\n');
    original += '\n// support/test-correctness.py\n';
  }
  const named = `resolved_cblas_sgemv_path:a[${performance ? 3 : 1}]`;
  assert.ok(original.includes(named));
  const replacement = variation === 'named-mismatch' || performance ? `resolved_cblas_sgemv_path:${JSON.stringify(other)}`
    : variation === 'generic-mismatch' ? `resolved_symbol_path:${JSON.stringify(other)}`
      : variation === 'conflicting-fields' ? `resolved_symbol_path:a[1],resolved_cblas_sgemv_path:${JSON.stringify(other)}`
        : variation === 'unresolved' ? "resolved_cblas_sgemv_path:'unresolved'"
          : variation === 'alias-match' || variation === 'hardlink-match' ? `resolved_cblas_sgemv_path:${JSON.stringify(alias)}`
            : variation === 'input-hardlink-match' ? `resolved_cblas_sgemv_path:${JSON.stringify(artifact)}` : named;
  let modified = original.replace(named, replacement);
  if (variation === 'input-hardlink-match') modified = modified.replace('input_path:a[1]', `input_path:${JSON.stringify(artifact)}`);
  if (variation === 'reserved-field') modified = modified.replace('domain_payload:{parameters:p,', "domain_payload:{runner_artifact_path_check:'forged',parameters:p,");
  fs.writeFileSync(script, modified);
  const manifestPath = path.join(evaluatorRoot, 'manifest.json'), qualificationPath = path.join(evaluatorRoot, 'qualification.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.digest = evaluatorContentSha256(evaluatorRoot);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
  qualification.subject_digest = manifest.digest;
  fs.writeFileSync(qualificationPath, JSON.stringify(qualification));
  const digest = manifest.digest, artifactDigest = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  const now = new Date().toISOString();
  const experiment = { schema_version: 1 as const, experiment_id: `experiment:symbol-${variation}`, task_id: 'task:symbol-fixture',
    candidate_id: `candidate:${variation}`, type: 'FORMAL_EVALUATION' as const, status: 'PENDING' as const, validity: 'UNKNOWN' as const,
    failure_category: null, evaluator: { id: 'evaluator:test', version: '1.0.0', digest }, baseline: { id: 'baseline:test', digest: artifactDigest },
    declared_context: {}, observed_context: null, evaluation: null, started_at: null, ended_at: null, created_at: now, updated_at: now };
  const bundle = loadFormalEvaluatorBundle(evaluatorRoot, { requireQualified: true });
  const plannedArtifact = variation === 'input-hardlink-match' ? alias : artifact;
  const plan = { experiment, candidate: { candidate_id: experiment.candidate_id, commit: 'fixture', tree: 'fixture',
    source_sha256: sourceTreeSha256(candidateRoot), workspace_path: candidateRoot },
  evaluator: { evaluator_id: 'evaluator:test', version: '1.0.0', digest, workspace_path: evaluatorRoot },
  steps: createFormalEvaluatorSteps({ bundle, stagedEvaluatorRoot: evaluatorRoot, runtimeRoot: path.join(candidateRoot, '.runtime'),
    candidateArtifact: { artifactId: 'candidate', path: plannedArtifact, sha256: artifactDigest },
    baselineArtifact: { artifactId: 'baseline', path: artifact, sha256: artifactDigest },
    correctnessTimeoutMs: 5000, performanceTimeoutMs: 5000, includePerformance: performance }) };
  const server = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token, dbPath: path.join(root, 'runner.sqlite'),
    workspaceRoot: root, resourceEnforcement: 'REQUIRED', formalResourceCommandRunner: resourceRunner });
  try {
    const client = new RunnerClient({ baseUrl: server.url, token });
    await client.submitExperiment(plan);
    for (let index = 0; index < 300; index++) {
      const result = await client.getExperiment(experiment.experiment_id);
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(result.status)) return { result, other, artifact,
        measurements: (await client.getMeasurements(experiment.experiment_id)).measurements };
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('fixture experiment did not finish');
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

for (const variation of ['named-mismatch', 'generic-mismatch', 'conflicting-fields', 'performance-mismatch', 'unresolved', 'reserved-field', 'legacy-generated'] as const) {
  test(`Runner rejects ${variation} between symbol provider and pinned artifact`, async () => {
    const { result } = await runFixture(variation);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.validity, 'INVALID');
    assert.equal(result.failure?.code, 'FORMAL_CONTRACT_VIOLATION');
  });
}

test('Runner records a hard-linked alias as the same file', async () => {
  const { result, measurements } = await runFixture('hardlink-match');
  assert.equal(result.status, 'SUCCEEDED', result.failure?.message);
  const check = measurements[0].domain_payload.runner_artifact_path_check as { input_file_id: { device: string; inode: string };
    reported_paths: Array<{ field: string; file_id: { device: string; inode: string } }> };
  assert.deepEqual(check.reported_paths.find(entry => entry.field === 'resolved_cblas_sgemv_path')?.file_id, check.input_file_id);
  assert.notEqual(check.input_file_id.inode, '0');
});

test('Runner accepts an input artifact alias when the evaluator reports its real file', async () => {
  const { result } = await runFixture('input-hardlink-match');
  assert.equal(result.status, 'SUCCEEDED', result.failure?.message);
});

test('Runner accepts an unchanged matching legacy symbol-path field', async () => {
  const { result, measurements } = await runFixture('matching');
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.validity, 'VALID');
  assert.equal(measurements.length, 1);
});

test('Runner accepts a symbolic link to the pinned artifact', async t => {
  try {
    const { result } = await runFixture('alias-match');
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.validity, 'VALID');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) return t.skip('symbolic links unavailable');
    throw error;
  }
});
