import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { startWebFixture } from './web-fixture.js';
import type { ValidationTestpack } from '../src/contracts/validation-testpack.js';
import type { Experiment, Measurement } from '../src/contracts/optimization-domain.js';
import type { ExperimentExecutionStep } from '../src/contracts/runner-rpc.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { evaluatorContentSha256, listFormalEvaluatorFiles, loadFormalEvaluatorBundle } from '../src/evaluator/formal-evaluator.js';
import { createFormalEvaluatorSteps } from '../src/evaluator/formal-plan.js';
import { freezeValidationTestpack, readFrozenValidationTestpack } from '../src/testpack/validation-freeze.js';
import { freezeEvidenceFiles } from '../src/workspace/freeze-evidence.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';
import { evaluatePerformanceGate, type CommandRunResult, type ValidationCycleResult } from '../src/workspace/validation-runner.js';
import { DEFAULT_STATISTICS } from '../src/contracts/performance-statistics.js';

/** Simulated evaluator and measurements for public API/browser tests, never hardware evidence. */
export function seedApprovalFacts(f: Awaited<ReturnType<typeof startWebFixture>>, workflowId: string, options: {
  omitRevalidationSamples?: boolean; omitRevalidationCandidateSample?: number; extraUnobservedWorkload?: boolean;
  statisticalGate?: boolean; distinctRevalidation?: boolean; revalidationCandidateSamples?: number[]; twoWorkloads?: boolean;
  statisticsMethod?: 'paired-block-bootstrap-v1' | 'paired-block-bootstrap-v2';
} = {}) {
  const workflow = f.service.get(workflowId)!;
  const task = f.store.getOptimizationTask(workflow.optimization_task_id!)!;
  const candidate = f.store.getCandidate(workflow.candidate_id!)!;
  const root = path.join(f.root, `evaluator-${randomUUID()}`);
  const statisticalGate = options.statisticalGate ?? true;
  const statistics = { ...DEFAULT_STATISTICS, method: options.statisticsMethod ?? DEFAULT_STATISTICS.method };
  const sampleCount = statisticalGate ? 9 : 3;
  createFormalEvaluatorFixture(root, { sampleCount });
  const manifestPath = path.join(root, 'manifest.json'), qualificationPath = path.join(root, 'qualification.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.domain.api = workflow.function_name;
  if (options.extraUnobservedWorkload || options.twoWorkloads) {
    const workloadPath = path.join(root, 'benchmark', 'workloads.json');
    const inventory = JSON.parse(fs.readFileSync(workloadPath, 'utf8'));
    inventory.workloads.push({ ...inventory.workloads[0], workload_id: 'workload-2' });
    manifest.performance.workload_ids.push('workload-2');
    fs.writeFileSync(workloadPath, JSON.stringify(inventory));
  }
  if (statisticalGate) fs.writeFileSync(path.join(root, 'test-plan.json'), JSON.stringify({ schema_version: 1,
    resources: { cpu_set: manifest.resource_requirements.cpu_set, numa_node: manifest.resource_requirements.numa_node },
    sampling: { warmup_count: manifest.performance.sampling.warmup_count, sample_count: sampleCount, order: 'alternating' },
    seed: 0, inner_iterations: 1, timing_scope: 'kernel', candidate_api: workflow.function_name,
    baseline_api: workflow.function_name, statistics }));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const digest = evaluatorContentSha256(root);
  manifest.digest = digest;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
  qualification.subject_digest = digest;
  fs.writeFileSync(qualificationPath, JSON.stringify(qualification));
  const testpack = JSON.parse(fs.readFileSync(path.join(f.root, 'testpack.json'), 'utf8')) as ValidationTestpack;
  testpack.evaluator = { id: manifest.evaluator_id, version: manifest.version, owner: manifest.owner, root, sha256: digest };
  testpack.correctness.cases[0].case_id = 'case-1';
  testpack.correctness.cases[0].parameters = { n: 1 };
  testpack.performance.cases[0].case_id = 'workload-1';
  testpack.performance.cases[0].parameters = { m: 2, n: 3 };
  testpack.performance.cases[0].critical = true;
  testpack.performance.cases[0].weight = 1;
  testpack.performance.key_cases = ['workload-1'];
  if (options.twoWorkloads) {
    testpack.performance.cases.push({ ...testpack.performance.cases[0], case_id: 'workload-2' });
    testpack.performance.key_cases.push('workload-2');
  }
  testpack.performance.sampling.warmup = manifest.performance.sampling.warmup_count;
  testpack.performance.sampling.samples = sampleCount;
  testpack.resources = { cpu_set: manifest.resource_requirements.cpu_set,
    numa_nodes: [manifest.resource_requirements.numa_node], thread_counts: manifest.resource_requirements.thread_counts };
  if (statisticalGate) testpack.performance.statistics = statistics;
  else delete testpack.performance.statistics;
  const snapshotDir = path.join(f.root, `frozen-${randomUUID()}`);
  const frozen = freezeValidationTestpack(testpack, snapshotDir);
  f.store.saveOptimizationTask({ ...task, source_baseline: { ...task.source_baseline, digest: workflow.baseline_commit },
    evaluator: { id: manifest.evaluator_id, version: manifest.version, digest } });
  const runtime = new OptimizationRuntime(f.store);
  const now = new Date().toISOString();
  const command: CommandRunResult = { command: 'fixture', args: [], cwd: f.root, start_time: now, end_time: now,
    duration_ms: 1, timeout_ms: 1000, ok: true, exit_code: 0, timed_out: false, cancelled: false, stdout: '', stderr: '' };
  const validation: ValidationCycleResult = { build: command, correctness: command,
    correctness_cases: [{ case_id: 'case-1', parameters: { n: 1 }, status: 'PASSED', error: null, command }],
    correctness_coverage: { planned: 1, executed: 1, passed: 1, failed: 0, complete: true }, formal_correctness_complete: true,
    performance: command, passed: true };
  const baseline = Array.from({ length: sampleCount }, (_, i) => [10, 11, 9][i % 3]);
  const candidateSamples = baseline.map(value => value / 2);
  const performance = evaluatePerformanceGate(testpack, testpack.performance.cases.map(({ case_id }) => ({ case_id, baseline_samples: baseline, candidate_samples: candidateSamples,
    ...(statisticalGate ? {} : { ci_lower: 1.5 }) })));
  assert.equal(performance.passed, true);
  const repeatedCandidate = options.distinctRevalidation ? baseline.map(value => value / 2.2) : candidateSamples;
  const repeatedPerformance = evaluatePerformanceGate(testpack, testpack.performance.cases.map(({ case_id }) => ({ case_id, baseline_samples: baseline, candidate_samples: repeatedCandidate,
    ...(statisticalGate ? { sample_indices: { baseline: baseline.map((_, index) => index), candidate: baseline.map((_, index) => index) } } : { ci_lower: 1.5 }) })));
  assert.equal(repeatedPerformance.passed, true);
  const observed = { machine: { machine_identity_sha256: 'a'.repeat(64), fixture: true }, resource_policy: { validity: 'VALID', fixture: true } };
  const first = runtime.startExperiment({ taskId: task.task_id, candidateId: candidate.candidate_id, type: 'FORMAL_EVALUATION', initialStatus: 'PENDING' });
  const bundle = loadFormalEvaluatorBundle(root);
  const populate = (experiment: Experiment, values: number[], omit: boolean) => {
    const remoteRoot = `/runner/fixture/${experiment.type.toLowerCase()}`;
    const candidatePath = `${remoteRoot}/build/libcandidate.so`, baselinePath = `${remoteRoot}/baseline/libreference.so`;
    const candidateSha = experiment.type === 'FORMAL_EVALUATION' ? '2'.repeat(64) : '3'.repeat(64);
    const binarySha = experiment.type === 'FORMAL_EVALUATION' ? '4'.repeat(64) : '5'.repeat(64);
    const steps: ExperimentExecutionStep[] = [{ step: 'BUILD', execution_domain: 'CANDIDATE',
      command: { executable: 'make', args: [], cwd: `${remoteRoot}/source`, environment: {}, timeout_ms: 1000 } },
      ...createFormalEvaluatorSteps({ bundle, stagedEvaluatorRoot: `${remoteRoot}/evaluator`, runtimeRoot: `${remoteRoot}/runtime`,
        candidateSourceRoot: `${remoteRoot}/source`, candidateArtifact: { artifactId: 'current', path: candidatePath, sha256: null },
        baselineArtifact: { artifactId: 'base', path: baselinePath, sha256: testpack.performance.baselines.comparison.sha256 },
        correctnessTimeoutMs: 1000, performanceTimeoutMs: 1000, includePerformance: true })];
    runtime.recordRemoteExecutionPlan(experiment.experiment_id, { candidate: { candidate_id: candidate.candidate_id,
      commit: candidate.source.commit, tree: candidate.source.tree, source_sha256: candidate.source.archive_sha256, workspace_path: `${remoteRoot}/source` },
      evaluator: { evaluator_id: manifest.evaluator_id, version: manifest.version, digest, workspace_path: `${remoteRoot}/evaluator` }, steps });
    for (const [sequence, step] of steps.entries()) {
      const context = step.formal_context;
      const correctness = context?.phase === 'CORRECTNESS_CASE', sample = context?.phase === 'PERFORMANCE_SAMPLE';
      let output: Omit<Measurement, 'schema_version' | 'measurement_id' | 'experiment_id' | 'evaluator' | 'recorded_at'> | null = null;
      if (context && (correctness || sample)) {
        const artifactSha = context.role === 'BASELINE' ? testpack.performance.baselines.comparison.sha256 : candidateSha;
        const workloadBinarySha = options.twoWorkloads && experiment.type === 'REVALIDATION' && context.subject_id === 'workload-2' ? '6'.repeat(64) : binarySha;
        output = { kind: correctness ? 'CORRECTNESS_CASE' : 'PERFORMANCE_SAMPLE', role: context.role,
          subject_id: context.subject_id, sample_index: context.iteration_index,
          value: correctness ? 'PASS' : context.role === 'BASELINE' ? baseline[context.iteration_index!] : values[context.iteration_index!],
          unit: correctness ? null : 'seconds', validity: 'VALID', domain_payload: { parameters: context.parameters,
            artifact_identity: { input_path: context.artifact.path, sha256: artifactSha, resolved_symbol_path: context.artifact.path },
            [correctness ? 'evaluator_binary_identity' : 'benchmark_identity']: { sha256: workloadBinarySha } } };
      }
      const prefix = correctness ? manifest.correctness.command.measurement_prefix : manifest.performance.command.measurement_prefix;
      f.store.appendCommandExecution({ schema_version: 1, command_execution_id: `command:${randomUUID()}`, experiment_id: experiment.experiment_id,
        evaluator: { id: manifest.evaluator_id, version: manifest.version, digest }, step: step.step, sequence,
        command: step.command.executable, args: step.command.args, cwd: step.command.cwd, start_time: now, end_time: now, duration_ms: 1,
        exit_code: 0, stdout: output ? `${prefix} ${JSON.stringify(output)}\n` : '', stderr: '', timeout_ms: step.command.timeout_ms,
        timed_out: false, cancelled: false, resource_context: context ? { validity: 'VALID' } : null });
      if (output && !(omit && sample && (options.omitRevalidationSamples || context?.role === 'CANDIDATE' && context.iteration_index === options.omitRevalidationCandidateSample))) {
        // Simulated Runner-owned path check; this is not a hardware observation.
        const fileId = { device: '1', inode: '42' };
        f.store.appendMeasurement({ ...output, schema_version: 1, measurement_id: `measurement:${randomUUID()}`, experiment_id: experiment.experiment_id,
          evaluator: { id: manifest.evaluator_id, version: manifest.version, digest }, recorded_at: now,
          domain_payload: { ...output.domain_payload, evaluator_identity: { id: manifest.evaluator_id, version: manifest.version, digest }, resource_policy: { validity: 'VALID' },
            runner_artifact_path_check: { planned_path: context!.artifact.path, input_realpath: context!.artifact.path, input_file_id: fileId,
              reported_paths: [{ field: 'input_path', path: context!.artifact.path, realpath: context!.artifact.path, file_id: fileId },
                { field: 'resolved_symbol_path', path: context!.artifact.path, realpath: context!.artifact.path, file_id: fileId }] } } });
      }
    }
    const saved = f.store.getExperiment(experiment.experiment_id)!;
    f.store.saveExperiment({ ...saved, status: 'SUCCEEDED', validity: 'VALID', observed_context: observed, ended_at: now, updated_at: now });
  };
  populate(first, candidateSamples, false);
  runtime.completeValidationExperiment({ experimentId: first.experiment_id, validation, performance, observedContext: observed, factsAlreadyPersisted: true });
  const repeated = runtime.startExperiment({ taskId: task.task_id, candidateId: candidate.candidate_id, type: 'REVALIDATION', initialStatus: 'PENDING' });
  populate(repeated, options.revalidationCandidateSamples ?? repeatedCandidate, true);
  runtime.completeRevalidationExperiment({ experimentId: repeated.experiment_id, revalidation: { formal: validation, independent: null, performance_gate: repeatedPerformance, passed: true }, observedContext: observed, factsAlreadyPersisted: true });
  Object.assign(workflow, { status: 'WAITING_APPROVAL', enable_performance: true, testpack_digest: frozen.digest,
    testpack_snapshot_path: path.join(snapshotDir, 'validation-testpack.json'), candidate_evaluation_feedback: null, candidate_evaluation_decision: null });
  f.store.saveOptimizationWorkflowJson(workflowId, JSON.stringify(workflow));
  assert.equal(f.service.report(workflowId)?.report.summary?.verification.ready, true);
  return { workflow, candidate, first, repeated, evaluatorRoot: root };
}

export async function approveFixture(f: Awaited<ReturnType<typeof startWebFixture>>, workflowId: string) {
  const { ApiClient } = await import('../src/client/api-client.js');
  const api = new ApiClient(f.url, { token: f.token });
  const { snapshot } = await api.prepareWorkflowEvidence(workflowId);
  const { approval } = await api.approveWorkflowEvidence(workflowId, { expected_evidence_digest: snapshot.artifact.digest,
    reviewer: 'fixture reviewer', authorization_reference: 'fixture owner explicitly authorizes approval' });
  return { snapshot, approval };
}

/** Model an existing approval written by a previous release under the v2 gate. */
export function seedLegacyApprovedEvidence(f: Awaited<ReturnType<typeof startWebFixture>>, workflowId: string,
  facts: ReturnType<typeof seedApprovalFacts>) {
  const workflow = f.service.get(workflowId)!;
  const task = f.store.getOptimizationTask(workflow.optimization_task_id!)!;
  const candidate = f.store.getCandidate(workflow.candidate_id!)!;
  const first = f.store.getExperiment(facts.first.experiment_id)!;
  const repeated = f.store.getExperiment(facts.repeated.experiment_id)!;
  const frozen = readFrozenValidationTestpack(workflow.testpack_snapshot_path!);
  const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const evidence = { record_type: 'OPTIMIZATION_EVIDENCE_FREEZE', schema_version: 1,
    task_id: task.task_id, workflow_id: workflowId, candidate_id: candidate.candidate_id,
    candidate_commit: candidate.source.commit, hypothesis_id: candidate.hypothesis_id,
    baseline: task.performance_baseline, evaluator: task.evaluator,
    machine_identity_sha256: (first.observed_context!.machine as { machine_identity_sha256: string }).machine_identity_sha256,
    first_formal_experiment_id: first.experiment_id, revalidation_experiment_id: repeated.experiment_id,
    acceptance_decision: { decision: 'PASS' }, claim_scope: { fixture: true } };
  const files = new Map<string, Buffer>([
    ['evidence.json', json(evidence)], ['task.json', json(task)], ['candidate.json', json(candidate)],
    ['source/candidate.patch', Buffer.from('fixture historical patch\n')],
    ['hypothesis.json', json(f.store.getHypothesis(candidate.hypothesis_id))], ['testpack.json', json(frozen)],
    ['formal/experiment.json', json(first)], ['formal/commands.json', json(f.store.listCommandExecutions(first.experiment_id))],
    ['formal/measurements.json', json(f.store.listMeasurements(first.experiment_id))],
    ['revalidation/experiment.json', json(repeated)], ['revalidation/commands.json', json(f.store.listCommandExecutions(repeated.experiment_id))],
    ['revalidation/measurements.json', json(f.store.listMeasurements(repeated.experiment_id))],
    ['hypothesis-outcomes.json', json(f.store.listHypothesisOutcomes(task.task_id).filter(item =>
      item.experiment_id === first.experiment_id || item.experiment_id === repeated.experiment_id))],
  ]);
  for (const relative of listFormalEvaluatorFiles(facts.evaluatorRoot)) {
    files.set(`evaluator/${relative}`, fs.readFileSync(path.join(facts.evaluatorRoot, ...relative.split('/'))));
  }
  const artifact = freezeEvidenceFiles(path.join(f.root, 'legacy-approval-fixture'), files);
  workflow.review_evidence = { schema_version: 1, task_id: task.task_id, candidate_id: candidate.candidate_id,
    candidate_commit: candidate.source.commit, first_formal_experiment_id: first.experiment_id,
    revalidation_experiment_id: repeated.experiment_id, artifact, frozen_at: new Date().toISOString() };
  f.store.saveOptimizationWorkflowJson(workflowId, JSON.stringify(workflow));
  const approval = new OptimizationRuntime(f.store).approveCandidate({ taskId: task.task_id, candidateId: candidate.candidate_id,
    firstFormalExperimentId: first.experiment_id, revalidationExperimentId: repeated.experiment_id,
    evaluatorRoot: facts.evaluatorRoot, evidence: artifact, reviewer: 'Fixture Reviewer',
    authorization: { kind: 'EXPLICIT_OWNER_DIRECTIVE', reference: 'legacy fixture' } });
  return { approval, artifact };
}
