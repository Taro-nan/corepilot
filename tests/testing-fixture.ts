import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TestingService, type TestingServiceOptions } from '../src/application/testing-service.js';
import type { TestingRunner } from '../src/application/testing-subjects.js';
import type { TestingTaskRecord, TestingSubject } from '../src/contracts/testing.js';
import type { ExperimentExecutionPlan, ExperimentStatusResponse } from '../src/contracts/runner-rpc.js';
import { RUNNER_PROTOCOL_VERSION } from '../src/contracts/runner-rpc.js';
import type { Measurement } from '../src/contracts/optimization-domain.js';
import type { ProjectRecord } from '../src/contracts/project.js';
import { DEFAULT_STATISTICS } from '../src/contracts/performance-statistics.js';
import { LibraryPackageLoader } from '../src/library-package/loader.js';
import { evaluatorContentSha256 } from '../src/evaluator/formal-evaluator.js';
import { stringifyOptimizationConfig } from '../src/config/optimization-config.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';

export const testingPlanRef = { package_id: 'testing-fixture', package_version: '1.0.0', target_id: 'test-function' };
const writeJson = (filename: string, value: unknown) => { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, JSON.stringify(value, null, 2)); };
export function createTestingFixture(options: { testPlan?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-testing-'));
  const catalogRoot = path.join(root, 'catalog');
  const evaluatorRoot = path.join(catalogRoot, 'evaluators', 'test-evaluator', '1.0.0');
  const evaluator = createFormalEvaluatorFixture(evaluatorRoot, { domain: 'saxpy', state: 'DRAFT', sampleCount: 9 });
  evaluator.manifest.evaluator_id = 'test-evaluator';
  writeJson(path.join(evaluatorRoot, 'manifest.json'), evaluator.manifest);
  if (options.testPlan !== false) writeJson(path.join(evaluatorRoot, 'test-plan.json'), { schema_version: 1, resources: { cpu_set: '0', numa_node: 0 },
    sampling: { warmup_count: 1, sample_count: 9, order: 'alternating' }, seed: 17, inner_iterations: 10,
    timing_scope: 'kernel', candidate_api: 'cblas_saxpy', baseline_api: 'cblas_saxpy', statistics: { ...DEFAULT_STATISTICS, iterations: 1000 } });
  evaluator.manifest.digest = evaluatorContentSha256(evaluatorRoot);
  writeJson(path.join(evaluatorRoot, 'manifest.json'), evaluator.manifest);
  const qualificationPath = path.join(evaluatorRoot, 'qualification.json');
  const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
  qualification.evaluator_id = 'test-evaluator'; qualification.subject_digest = evaluator.manifest.digest;
  writeJson(qualificationPath, qualification);
  const packageRoot = path.join(catalogRoot, 'packages', testingPlanRef.package_id, testingPlanRef.package_version);
  const build = { executable: 'bash', args: ['-lc', 'cmake -S . -B build && cmake --build build'], cwd: '.', environment: {}, timeout_ms: 30000 };
  writeJson(path.join(packageRoot, 'build.json'), build);
  writeJson(path.join(packageRoot, 'package.json'), { schema_version: 1, package_id: testingPlanRef.package_id, version: '1.0.0', owner: 'test-owner',
    library: { name: 'Independent test fixture', source_compatibility: ['test-only'], target_compatibility: ['mock target'] },
    qualification: { state: 'DRAFT', reviewer: null, reviewed_at: null }, functions: [{ function_id: 'test-function', api: 'cblas_saxpy' }],
    build_definitions: [{ build_id: 'fixture', definition: 'build.json' }],
    formal_evaluators: [{ evaluator_id: 'test-evaluator', version: '1.0.0', owner: 'test-owner', digest: evaluator.manifest.digest, catalog_path: 'test-evaluator/1.0.0' }],
    targets: [{ target_id: 'test-function', function_id: 'test-function', build_id: 'fixture', evaluator: { evaluator_id: 'test-evaluator', evaluator_version: '1.0.0' },
      candidate_scope: { include: ['kernel.c'], exclude: [] }, development_benchmark: { evaluator: { evaluator_id: 'test-evaluator', evaluator_version: '1.0.0' }, workload_ids: ['workload-1'] },
      artifacts: { candidate: { artifact_id: 'fixture', relative_path: 'build/libfixture.so' }, baseline: { id: 'unused-project-baseline', library: 'must-not-be-overwritten', version: 'old', sha256: '0'.repeat(64) } },
      performance_acceptance: { weighted_geomean_min: 1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: 0.95 },
      analysis_sampling: { interleave_seed: 0, bootstrap_iterations: 1000 }, domain_payload: {} }] });
  const catalog = new LibraryPackageLoader({ packagesRoot: path.join(catalogRoot, 'packages'), evaluatorsRoot: path.join(catalogRoot, 'evaluators') });
  const machine = { identity: { machine_id: 'fixture-machine', name: 'Fixture CPU', revision: 1 },
    runner: { mode: 'rpc' as const, endpoint: 'http://fixture.invalid', token: 'fixture-secret', request_timeout_ms: 1000, poll_interval_ms: 100 },
    target: { ssh_alias: 'fixture', workspace_root: '/runner/workspace' } };
  const projects = new Map<string, ProjectRecord>();
  const plans: ExperimentExecutionPlan[] = [];
  let remoteStatus: ExperimentStatusResponse['status'] = 'RUNNING', cancelRequested = false, getCalls = 0;
  let measurements: Measurement[] = [], failSubmit: Error | null = null, stagingGate: Promise<void> | null = null;
  const uploads: Array<{ sha256: string; workspacePath: string }> = [];
  const runner: TestingRunner = {
    async probe() { return { health: { status: 'READY', runner_id: 'fixture-runner', protocol_version: RUNNER_PROTOCOL_VERSION, resource_enforcement: 'REQUIRED',
      capabilities: { controlled_validation: 1, source_archive_upload: 1, resource_matrix: 1 } },
      machine: { hostname: 'mock-cpu', architecture: 'aarch64', cpu_count: 4, machine_identity_sha256: 'a'.repeat(64), cpu_topology: { online_cpus: '0-3', node_cpu_lists: { node0: '0-3' } } } }; },
    async submitExperiment(plan) { plans.push(plan); if (failSubmit) throw failSubmit; return { experiment_id: plan.experiment.experiment_id, status: 'PENDING' }; },
    async getExperiment(id) { getCalls++; const experiment = plans.find(plan => plan.experiment.experiment_id === id)!.experiment;
      return { ...experiment, status: remoteStatus, current_step: remoteStatus === 'RUNNING' ? 'PERFORMANCE' : null, cancel_requested: cancelRequested, failure: null }; },
    async cancelExperiment(id) { cancelRequested = true; return { experiment_id: id, status: remoteStatus, cancel_requested: true }; },
    async getCommandExecutions(id) { return { experiment_id: id, command_executions: [] }; },
    async getMeasurements(id) { return { experiment_id: id, measurements }; },
    async getExecutionOutput() { return { stdout: 'fixture output', stderr: '', stdout_path: '/runner/logs/stdout.log', stderr_path: '/runner/logs/stderr.log', truncated: false }; },
    async uploadSourceArchive(input) { uploads.push(input); const bytes = fs.readFileSync(input.filename);
      return { workspace_path: input.workspacePath, source_sha256: 'b'.repeat(64), archive_sha256: createHash('sha256').update(bytes).digest('hex'), archive_bytes: bytes.length }; },
  };
  const serviceOptions: TestingServiceOptions = { dataDir: root, catalog, projects: { get(id) { const project = projects.get(id); if (!project) throw new Error('project should not be required'); return project; } },
    machines: { resolve() { return structuredClone(machine); } }, runnerFactory: () => runner,
    transportFactory: () => ({ async runRemote(argv) { await stagingGate; return { command: argv[0], argv, stdout: '', stderr: '', exit_code: 0 }; }, uploadFile() { return { exit_code: 0, stderr: '' }; } }),
    async stageBinary(input) { await stagingGate; return { ok: true, machine_identity_sha256: 'a'.repeat(64), checked_at: new Date().toISOString(),
      entry_sha256: input.files.find(file => file.path === input.entryPath)!.sha256, libraries: [], resolved_libraries: [], issues: [] }; } };
  const service = new TestingService(serviceOptions);
  async function binary(name: string): Promise<TestingSubject> {
    const asset = service.assets.create({ name, version: '1.0' });
    await service.assets.upload(asset.asset_id, 'lib/libfixture.so', (async function* () { yield Buffer.from(name); })());
    await service.assets.upload(asset.asset_id, 'lib/libdependency.so', (async function* () { yield Buffer.from('dependency-' + name); })());
    await service.assets.upload(asset.asset_id, 'include/fixture.h', (async function* () { yield Buffer.from('int kernel(void);'); })());
    await service.assets.finalize(asset.asset_id, { entry_path: 'lib/libfixture.so' });
    return { kind: 'binary', asset_id: asset.asset_id };
  }
  function source(): { project: ProjectRecord; commit: string; nextCommit: string } {
    const repo = path.join(root, 'repo-' + projects.size); fs.mkdirSync(repo);
    const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
    git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
    fs.writeFileSync(path.join(repo, 'kernel.c'), 'int kernel(void) { return 1 + 1; }'); git(['add', '.']); git(['commit', '-qm', 'first']);
    const commit = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'kernel.c'), 'int kernel(void) { return 2; }'); git(['add', '.']); git(['commit', '-qm', 'candidate']);
    const nextCommit = git(['rev-parse', 'HEAD']);
    const configPath = path.join(repo, 'corepilot.yaml');
    fs.writeFileSync(configPath, stringifyOptimizationConfig({ model: { model_id: 'fixture', endpoint: 'https://model.invalid/v1', timeout_ms: 1000 },
      target: machine.target, build, validation: { testpack: '' }, output_dir: path.join(root, 'reports') }));
    const now = new Date().toISOString();
    const project = { project_id: randomUUID(), name: 'Source fixture', repository_root: repo, config_path: configPath, source_branch: 'main', created_at: now, updated_at: now };
    projects.set(project.project_id, project); return { project, commit, nextCommit };
  }
  function measurement(task: TestingTaskRecord, data: Partial<Measurement>): Measurement {
    return { schema_version: 1, measurement_id: randomUUID(), experiment_id: task.task_id, evaluator: null, kind: 'PERFORMANCE_SAMPLE', role: 'CANDIDATE',
      subject_id: 'workload-1', sample_index: 0, value: 1, unit: 'seconds', validity: 'VALID', domain_payload: {}, recorded_at: new Date().toISOString(), ...data };
  }
  function complete(task: TestingTaskRecord) {
    measurements = Array.from({ length: 9 }, (_, i) => [measurement(task, { role: 'CANDIDATE', sample_index: i, value: 1 }), measurement(task, { role: 'BASELINE', sample_index: i, value: 2 })]).flat();
    if (task.input.mode !== 'performance') measurements.push(measurement(task, { kind: 'CORRECTNESS_CASE', role: 'EVALUATOR', subject_id: 'case-1', sample_index: null, value: 'PASS', unit: null }));
    remoteStatus = 'SUCCEEDED';
  }
  return { root, evaluatorRoot, packageRoot, service, options: serviceOptions, machine, projects, plans, uploads, binary, source, measurement, complete,
    setStatus(status: ExperimentStatusResponse['status']) { remoteStatus = status; },
    setMeasurements(value: Measurement[]) { measurements = value; },
    failSubmit(error: Error) { failSubmit = error; }, setStagingGate(gate: Promise<void> | null) { stagingGate = gate; },
    get getCalls() { return getCalls; }, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
export async function waitTestingPreparation(service: TestingService, id: string) {
  for (let i = 0; i < 150; i++) { const task = service.list().find(row => row.task_id === id)!;
    if (task.execution.status !== 'PREPARING') return task; await delay(10); }
  throw new Error('testing preparation did not finish');
}
