import assert from 'node:assert/strict';
import { proposeFixtureHypothesis } from './hypothesis-fixture.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { WorkspaceToolset } from '../src/agent/workspace-tools.js';
import { runCommandArgs, type CommandIO } from '../src/cli-interactive/commands.js';
import type { WorkbenchContext } from '../src/cli-interactive/context.js';
import { LibraryPackageManifestSchema, type LibraryPackageSelection } from '../src/contracts/library-package.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { createFormalEvaluatorSteps } from '../src/evaluator/formal-plan.js';
import { loadFormalEvaluatorBundle } from '../src/evaluator/formal-evaluator.js';
import { assertCandidateSourceScope, candidatePathAllowed } from '../src/library-package/candidate-scope.js';
import { LibraryPackageLoader, binaryBundleIdentitySha256, validateBinaryBundleBaselineDefinition, validateLibraryPackageManifest, validateLibraryPackageSelection } from '../src/library-package/loader.js';
import { packageOptimizationTaskInput, packageValidationTestpack, resolveLibraryPackageTask } from '../src/library-package/task-definition.js';
import { parseOptimizationConfig, stringifyOptimizationConfig } from '../src/config/optimization-config.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { loadPublicOptimizationPreflight } from '../src/workflow/public-optimization.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';

const selection: LibraryPackageSelection = { package_id: 'ftblas', package_version: '1.0.0', target_id: 'sgemv-n' };
const fixtureSelection: LibraryPackageSelection = { package_id: 'example-vector', package_version: '0.1.0', target_id: 'vector-scale-add' };
const loader = new LibraryPackageLoader();
const evaluatorDigest = 'e1d2effa606f2ef4f028a490ffef8dc7a9b2968fc15128250a281a2539c8ae58';
const qualificationDigest = '06c50b60eb7de07861c39c87b4ab46030b881a9b2dcea352293df4c6a5656eab';

function temporaryRoot(context: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-library-package-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function manifest(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync('packages/ftblas/1.0.0/package.json', 'utf8'));
}

function sourceSnapshot(): string {
  const hash = createHash('sha256');
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else { hash.update(filename); hash.update(fs.readFileSync(filename)); }
    }
  };
  for (const directory of ['src/core', 'src/workflow', 'src/runner']) visit(directory);
  return hash.digest('hex');
}

function configValue(packageSelection = selection) {
  return {
    model: { model_id: 'test-model', api_key: 'package-test-secret', endpoint: 'https://model.example/v1', timeout_ms: 1000 },
    target: { ssh_alias: 'test-target', workspace_root: '/runner/workspace' },
    validation: { library_package: packageSelection, baseline_artifact: '/runtime/baseline.so' },
    runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:14327', token: 'test-runner-secret' },
    output_dir: './runs',
  };
}

test('library packages discover, enumerate functions/targets, and resolve build and candidate scope', () => {
  assert.deepEqual(loader.listPackages().map((item) => `${item.package_id}@${item.version}`), ['example-vector@0.1.0', 'ftblas@1.0.0', 'ippi-ft@0.1.0']);
  const loaded = loader.loadPackage('ftblas', '1.0.0');
  assert.equal(loader.listFunctions(loaded)[0].api, 'cblas_sgemv');
  assert.equal(loader.listTargets(loaded)[0].target_id, 'sgemv-n');
  const build = loader.resolveBuildDefinition(loaded, 'sgemv-n');
  assert.equal(build.executable, 'bash');
  assert.ok(build.args.join(' ').includes('TARGET=FT2000'));
  assert.ok(loader.resolveCandidateScope(loaded, 'sgemv-n').include.includes('kernel/arm64/gemv_n.S'));
  assert.throws(() => loader.resolveTarget(loaded, 'missing'), /unknown target/);
  assert.equal(loaded.manifest.qualification.state, 'DRAFT');
});

test('every required manifest field is mandatory, unknown fields are rejected, and domain payload is opaque', () => {
  for (const field of Object.keys(manifest())) {
    const raw = manifest();
    delete raw[field];
    assert.throws(() => validateLibraryPackageManifest(raw), /invalid library package manifest/, field);
  }
  for (const field of ['unexpected', 'model', 'ssh_endpoint', 'm', 'n', 'lda', 'incx', 'incy', 'alpha', 'beta', 'sgemv', 'openblas']) {
    assert.throws(() => validateLibraryPackageManifest({ ...manifest(), [field]: 1 }), /invalid library package manifest/, field);
  }
  const raw = manifest();
  const targets = raw.targets as Array<Record<string, unknown>>;
  targets[0].m = 16;
  assert.throws(() => validateLibraryPackageManifest(raw), /invalid library package manifest/);
  delete targets[0].m;
  targets[0].domain_payload = { m: 16, n: 32, alpha: 1, beta: 0, library_owned: { extra: true } };
  assert.equal(validateLibraryPackageManifest(raw).targets[0].domain_payload.m, 16);
});

test('manifest validates referential integrity and selection has no domain-specific fields', () => {
  const raw = manifest();
  const targets = raw.targets as Array<Record<string, unknown>>;
  targets[0].function_id = 'unknown';
  assert.throws(() => validateLibraryPackageManifest(raw), /unknown function/);
  assert.throws(() => validateLibraryPackageSelection({ ...selection, m: 1 }), /invalid library package selection/);
  assert.throws(() => validateLibraryPackageSelection({ ...selection, evaluator_id: 'sgemv-n' }), /provided together/);
  assert.throws(() => loader.resolveSelection({ ...selection, evaluator_id: 'saxpy', evaluator_version: '0.1.0' }), /differs from target evaluator/);
  assert.throws(() => loader.loadPackage('../ftblas', '1.0.0'), /invalid library package selection/);
});

test('build definitions are strictly validated, package assets cannot escape, and digests cover added assets', (context) => {
  const root = temporaryRoot(context);
  fs.cpSync('packages/ftblas', path.join(root, 'packages/ftblas'), { recursive: true });
  const local = new LibraryPackageLoader({ packagesRoot: path.join(root, 'packages'), evaluatorsRoot: path.resolve('evaluators') });
  const before = local.loadPackage('ftblas', '1.0.0').content_digest;
  fs.writeFileSync(path.join(root, 'packages/ftblas/1.0.0/extra.txt'), 'not executed');
  fs.writeFileSync(path.join(root, 'packages/ftblas/1.0.0/unsafe.mjs'), 'throw new Error(\'PACKAGE_CODE_EXECUTED\');');
  assert.notEqual(local.loadPackage('ftblas', '1.0.0').content_digest, before);
  const buildPath = path.join(root, 'packages/ftblas/1.0.0/build/shared.json');
  const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
  fs.writeFileSync(buildPath, JSON.stringify({ ...build, adapter: './unsafe.ts' }));
  assert.throws(() => local.loadPackage('ftblas', '1.0.0'), /invalid build/);
  const raw = manifest();
  (raw.build_definitions as Array<Record<string, unknown>>)[0].definition = '../outside.json';
  assert.throws(() => validateLibraryPackageManifest(raw), /invalid library package manifest/);
});

test('evaluator identity resolves exactly and both SGEMV content and qualification digests remain unchanged', () => {
  const loaded = loader.loadPackage('ftblas', '1.0.0');
  const bundle = loader.resolveEvaluator(loaded, 'sgemv-n', '1.0.0', { requireQualified: true });
  assert.equal(bundle.content_digest, evaluatorDigest);
  assert.equal(bundle.qualification_digest, qualificationDigest);
  assert.equal(bundle.qualification.status, 'QUALIFIED');
  assert.equal(bundle.qualification.approved_at, '2026-09-29T08:06:21.240Z');
  assert.equal(bundle.correctness.cases.length, 29);
  assert.equal(bundle.workloads.workloads.length, 18);
  assert.throws(() => loader.resolveEvaluator(loaded, 'sgemv-n', '9.0.0'), /unknown evaluator/);
  loaded.manifest.formal_evaluators[0].digest = 'a'.repeat(64);
  assert.throws(() => loader.resolveEvaluator(loaded, 'sgemv-n', '1.0.0'), /digest differs/);
});

test('package qualification never grants Formal Evaluator qualification', () => {
  const loaded = loader.loadPackage('example-vector', '0.1.0');
  loaded.manifest.qualification = { state: 'QUALIFIED', reviewer: 'test-reviewer', reviewed_at: '2026-10-01T00:00:00Z' };
  assert.equal(loader.resolveEvaluator(loaded, 'saxpy', '0.1.0').qualification.status, 'QUALIFICATION_PENDING');
  assert.throws(() => loader.resolveEvaluator(loaded, 'saxpy', '0.1.0', { requireQualified: true }), /requires QUALIFIED evaluator/);
  assert.throws(() => resolveLibraryPackageTask(fixtureSelection, { requireQualified: true }), /requires QUALIFIED evaluator/);
});

test('owner-approved IPPI target binds its frozen self-baseline and qualified evaluator', () => {
  const loaded = loader.loadPackage('ippi-ft', '0.1.0');
  const targetId = 'ippi-dilate3x3-64f-c1r';
  const resolved = loader.resolveSelection({ package_id: 'ippi-ft', package_version: '0.1.0', target_id: targetId });
  assert.equal(loaded.manifest.qualification.state, 'QUALIFIED');
  assert.equal(loader.resolveBinaryBaseline(loaded, targetId), null);
  assert.equal(resolved.bundle.qualification.status, 'QUALIFIED');
  assert.equal(resolved.bundle.qualification.subject_digest, resolved.bundle.content_digest);
  assert.equal(resolved.functionDefinition.api, 'ippiDilate3x3_64f_C1R');
  assert.deepEqual(resolved.target.candidate_scope.include, ['src/morphological-operations/Dilate3x3.cpp']);
  assert.equal(candidatePathAllowed(resolved.target.candidate_scope, 'ctest/morphological-operations/Dilate3x3.cpp'), false);
  assert.equal(packageOptimizationTaskInput(resolved, { sourceBaseline: { id: 'source' } }).performanceBaseline?.digest, '87805e10942159d8cf28b2cc48efe0cc690c1297631ee8f302d16f2e23c57b6a');
  assert.equal(packageValidationTestpack(resolved, '/runtime/libftppi.so').testpack.performance.cases.length, 6);
  assert.equal(loader.resolveSelection({ package_id: 'ippi-ft', package_version: '0.1.0', target_id: targetId }, { requireQualified: true }).bundle.content_digest, resolved.bundle.content_digest);
  assert.deepEqual(resolved.target.performance_acceptance, { weighted_geomean_min: 1.03, overall_ci_lower_min: 1, key_case_ci_lower_min: 0.97, confidence_level: 0.95 });
  assert.deepEqual(resolved.target.domain_payload.out_of_scope, ['NaN', 'Inf', 'source/destination overlap', 'byte strides not divisible by sizeof(double)']);
});

test('historical invalid binary bundle identity remains recorded but is not selected', () => {
  const baseline = validateBinaryBundleBaselineDefinition(JSON.parse(fs.readFileSync('packages/ippi-ft/0.1.0/baselines/performance.json', 'utf8')));
  assert.equal(baseline.state, 'INVALID');
  assert.equal(baseline.dependency_closure.status, 'INVALID');
  assert.equal(baseline.headers.length, 7);
  assert.equal(baseline.libraries.length, 6);
  assert.equal(baseline.sha256, binaryBundleIdentitySha256(baseline));
  assert.equal(baseline.libraries.find((item) => item.soname === 'libHMPP_image.so.2.5.2')?.needed.filter((item) => item.classification === 'BUNDLED_DEPENDENCY').length, 2);
});

test('binary bundle schema rejects incomplete, inconsistent and falsely verified identities', () => {
  const baseline = validateBinaryBundleBaselineDefinition(JSON.parse(fs.readFileSync('packages/ippi-ft/0.1.0/baselines/performance.json', 'utf8')));
  const missing = structuredClone(baseline) as Record<string, unknown>;
  delete missing.headers;
  assert.throws(() => validateBinaryBundleBaselineDefinition(missing), /invalid binary bundle baseline definition/);
  assert.throws(() => validateBinaryBundleBaselineDefinition({ ...baseline, unexpected: true }), /invalid binary bundle baseline definition/);
  const changed = structuredClone(baseline);
  changed.libraries[0].sha256 = 'a'.repeat(64);
  assert.throws(() => validateBinaryBundleBaselineDefinition(changed), /aggregate digest differs/);
  const absent = structuredClone(baseline);
  absent.libraries.find((item) => item.role === 'ENTRY')!.needed.push({ soname: 'libabsent.so', classification: 'BUNDLED_DEPENDENCY' });
  assert.throws(() => validateBinaryBundleBaselineDefinition(absent), /undeclared bundled dependency/);
  const falselyVerified = structuredClone(baseline);
  falselyVerified.state = 'VERIFIED';
  falselyVerified.dependency_closure.status = 'UNVERIFIED';
  assert.throws(() => validateBinaryBundleBaselineDefinition(falselyVerified), /valid target dependency closure/);
  const unchecked = structuredClone(baseline);
  unchecked.dependency_closure.status = 'VALID';
  unchecked.dependency_closure.target_machine = null;
  unchecked.dependency_closure.checked_at = null;
  assert.throws(() => validateBinaryBundleBaselineDefinition(unchecked), /target check/);
  const invalid = structuredClone(baseline);
  invalid.state = 'DRAFT';
  invalid.libraries[0].needed[0].classification = 'MISSING_DEPENDENCY';
  assert.throws(() => validateBinaryBundleBaselineDefinition(invalid), /requires INVALID baseline state/);
});

test('package loader rejects a binary bundle asset that differs from its manifest reference', (context) => {
  const root = temporaryRoot(context);
  fs.cpSync('packages/ippi-ft', path.join(root, 'packages/ippi-ft'), { recursive: true });
  const local = new LibraryPackageLoader({ packagesRoot: path.join(root, 'packages'), evaluatorsRoot: path.resolve('evaluators') });
  const manifestPath = path.join(root, 'packages/ippi-ft/0.1.0/package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.targets[0].artifacts.baseline = {
    id: 'hmippi-binary-2-5-2', library: 'HMiPPI', version: '2.5.2',
    sha256: '9d46f0b490f0dc8a3bed4ce12006a05722d25afab44e0f7ae0bb3d39c9f94617',
    kind: 'binary_bundle', definition: 'baselines/performance.json',
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const definitionPath = path.join(root, 'packages/ippi-ft/0.1.0/baselines/performance.json');
  const definition = JSON.parse(fs.readFileSync(definitionPath, 'utf8'));
  definition.baseline_id = 'different-baseline';
  fs.writeFileSync(definitionPath, JSON.stringify(definition));
  assert.throws(() => local.loadPackage('ippi-ft', '0.1.0'), /identity differs from target/);
});

test('SGEMV package preserves evaluator-owned inventory, sampling, resource policy, baseline, and formal plan', () => {
  const resolved = resolveLibraryPackageTask(selection, { requireQualified: true });
  const original = loadFormalEvaluatorBundle(path.resolve('evaluators/sgemv-n/1.0.0'), { requireQualified: true });
  const packed = packageValidationTestpack(resolved, '/runtime/baseline.so').testpack;
  assert.deepEqual(packed.correctness.cases.map((item) => item.parameters), original.correctness.cases.map((item) => item.parameters));
  assert.deepEqual(packed.performance.cases.map((item) => item.parameters), original.workloads.workloads.map((item) => item.parameters));
  assert.equal(packed.performance.sampling.warmup, original.manifest.performance.sampling.warmup_count);
  assert.equal(packed.performance.sampling.samples, original.manifest.performance.sampling.sample_count);
  assert.deepEqual(packed.resources.thread_counts, original.manifest.resource_requirements.thread_counts);
  assert.equal(packed.resources.cpu_set, original.manifest.resource_requirements.cpu_set);
  assert.deepEqual(packed.resources.numa_nodes, [original.manifest.resource_requirements.numa_node]);
  assert.equal(packed.performance.baselines.comparison.sha256, '6c5246e4c2aee253064a5b5e25b8292faacb8147c824c136606d76dad00c9257');
  const planInput = {
    stagedEvaluatorRoot: '/runner/evaluator', runtimeRoot: '/runner/runtime',
    candidateArtifact: { artifactId: 'candidate', path: '/runner/candidate.so', sha256: null },
    baselineArtifact: { artifactId: 'baseline', path: '/runner/baseline.so', sha256: 'b'.repeat(64) },
    correctnessTimeoutMs: 120000, performanceTimeoutMs: 1200000, includePerformance: true,
  };
  assert.deepEqual(createFormalEvaluatorSteps({ ...planInput, bundle: resolved.bundle }), createFormalEvaluatorSteps({ ...planInput, bundle: original }));
});

test('second fixture is onboarded by adding files only, without changing Core, Workflow or Runner', (context) => {
  const root = temporaryRoot(context);
  const before = sourceSnapshot();
  fs.cpSync('packages/ftblas', path.join(root, 'packages/ftblas'), { recursive: true });
  const local = new LibraryPackageLoader({ packagesRoot: path.join(root, 'packages'), evaluatorsRoot: path.resolve('evaluators') });
  assert.deepEqual(local.listPackages().map((item) => item.package_id), ['ftblas']);
  fs.cpSync('packages/example-vector', path.join(root, 'packages/example-vector'), { recursive: true });
  assert.deepEqual(local.listPackages().map((item) => item.package_id), ['example-vector', 'ftblas']);
  const resolved = resolveLibraryPackageTask(fixtureSelection, { loader: local });
  assert.equal(resolved.functionDefinition.api, 'cblas_saxpy');
  assert.equal(resolved.build.executable, 'cc');
  assert.equal(resolved.bundle.manifest.evaluator_id, 'saxpy');
  const database = path.join(root, 'tasks.sqlite');
  let store = new SqliteTaskStore(database);
  store.init();
  const task = new OptimizationRuntime(store).createTask(packageOptimizationTaskInput(resolved, { sourceBaseline: { id: 'fixture-source' } }));
  assert.equal(task.library_package?.package_id, 'example-vector');
  assert.equal(task.library_package?.function_id, 'vector-scale-add');
  store.close();
  store = new SqliteTaskStore(database);
  store.init();
  try { assert.deepEqual(new OptimizationRuntime(store).getTask(task.task_id), task); }
  finally { store.close(); }
  assert.equal(sourceSnapshot(), before);
});

test('domain parameters remain under domain_payload, never in generic package/target or OptimizationTask schemas', () => {
  const resolved = resolveLibraryPackageTask(selection);
  resolved.target.domain_payload = { m: 32, n: 16, lda: 32, incx: 1, incy: 1, alpha: 1, beta: 0 };
  const input = packageOptimizationTaskInput(resolved, { sourceBaseline: { id: 'source' } });
  assert.equal((input.target.scope.domain_payload as Record<string, unknown>).m, 32);
  for (const key of ['m', 'n', 'lda', 'incx', 'incy', 'alpha', 'beta', 'sgemv', 'openblas']) {
    assert.equal(Object.hasOwn(input, key), false);
    assert.equal(Object.hasOwn(input.target, key), false);
    assert.equal(Object.hasOwn(LibraryPackageManifestSchema.properties, key), false);
    assert.equal(Object.hasOwn(LibraryPackageManifestSchema.properties.targets.items.properties, key), false);
  }
  assert.doesNotMatch(fs.readFileSync('src/contracts/optimization-domain.ts', 'utf8'), /^\s*(?:m|n|lda|incx|incy|alpha|beta|sgemv|openblas)\??:/m);
});

test('package candidate scope is enforced while Agent reads remain unrestricted', async (context) => {
  const root = temporaryRoot(context);
  fs.mkdirSync(path.join(root, 'fixtures'));
  fs.writeFileSync(path.join(root, 'fixtures/vector.c'), 'source');
  fs.writeFileSync(path.join(root, 'oracle.txt'), 'readable but protected');
  const scope = { include: ['fixtures/'], exclude: ['fixtures/oracle.c'] };
  assert.equal(candidatePathAllowed(scope, 'fixtures/vector.c'), true);
  for (const filename of ['oracle.txt', 'fixtures/oracle.c', 'fixtures/../oracle.txt', 'evaluators/oracle.c', '/fixtures/vector.c', 'C:/fixtures/vector.c']) {
    assert.throws(() => assertCandidateSourceScope(scope, [filename]), /outside package scope/);
  }
  assert.equal(candidatePathAllowed({ include: ['.GIT/'], exclude: [] }, '.GIT/config'), false);
  const tools = new WorkspaceToolset(root, { candidateSourceScope: scope });
  const signal = new AbortController().signal;
  assert.equal((await tools.execute('read_file', { path: 'oracle.txt' }, signal)).isError, false);
  assert.equal((await tools.execute('write_file', { path: 'oracle.txt', content: 'tamper' }, signal)).isError, true);
  assert.equal((await tools.execute('write_file', { path: 'fixtures/vector.c', content: 'candidate' }, signal)).isError, false);
});

test('package config materializes the existing formal workflow and persists a package-backed task', (context) => {
  const root = temporaryRoot(context);
  const configPath = path.join(root, 'phyopt.yaml');
  fs.writeFileSync(configPath, JSON.stringify(configValue()));
  const request = { function_name: 'cblas_sgemv', entry_file: null, config_path: configPath, repository_root: root };
  const preflight = loadPublicOptimizationPreflight(request, { env: {} });
  assert.equal(preflight.config.config.build.executable, 'bash');
  assert.equal(preflight.libraryPackage?.loaded.manifest.package_id, 'ftblas');
  assert.equal(preflight.testpack.testpack.correctness.cases.length, 29);
  assert.doesNotMatch(JSON.stringify(preflight.audit), /package-test-secret|test-runner-secret/);
  const store = new SqliteTaskStore(path.join(root, 'workflow.sqlite'));
  store.init();
  try {
    const service = new OptimizationWorkflowService({ store, transportFactory: () => { throw new Error('intake must not execute'); } });
    const submitted = service.submitPublic(request);
    const task = store.getOptimizationTaskByWorkflowId(submitted.workflowId)!;
    assert.equal(task.library_package?.package_id, 'ftblas');
    assert.equal(task.library_package?.target_id, 'sgemv-n');
    assert.equal(task.evaluator.digest, evaluatorDigest);
    assert.equal(task.target.scope.domain_payload !== undefined, true);
    assert.equal(task.performance_baseline?.details?.path, '/runtime/baseline.so');
  } finally { store.close(); }
  const withLegacy = { ...configValue(), validation: { ...configValue().validation, testpack: 'legacy.yaml' } };
  assert.throws(() => parseOptimizationConfig(withLegacy, root), /mutually exclusive/);
  assert.throws(() => parseOptimizationConfig({ ...configValue(), build: { executable: 'evil', args: [] } }, root), /owned by the selected library package/);
  fs.writeFileSync(configPath, JSON.stringify(configValue(fixtureSelection)));
  assert.throws(() => loadPublicOptimizationPreflight({ ...request, function_name: 'cblas_saxpy' }, { env: {} }), /requires QUALIFIED evaluator/);
});

test('package configuration survives persistence without serializing a competing build or legacy testpack', () => {
  const parsed = parseOptimizationConfig(configValue());
  const output = stringifyOptimizationConfig(parsed);
  const saved = parseYaml(output);
  assert.equal(Object.hasOwn(saved, 'build'), false);
  assert.equal(Object.hasOwn(saved.validation, 'testpack'), false);
  assert.deepEqual(parseOptimizationConfig(saved), parsed);
});

test('OptimizationRuntime rejects out-of-domain candidate checkpoints before persisting them', (context) => {
  const root = temporaryRoot(context);
  const store = new SqliteTaskStore(path.join(root, 'scope.sqlite'));
  store.init();
  try {
    const runtime = new OptimizationRuntime(store);
    const resolved = resolveLibraryPackageTask(fixtureSelection);
    const task = runtime.createTask(packageOptimizationTaskInput(resolved, { sourceBaseline: { id: 'fixture-source' } }));
    const input = {
      taskId: task.task_id,
      hypothesisId: proposeFixtureHypothesis(runtime, task.task_id, 'fixture hypothesis', ['fixtures/vector.c']).hypothesis_id,
      workspace: { repository: root, baseline_commit: 'source', run_id: 'run', editing: root, validation: root, editing_created: true, validation_created: true, candidate_commit: 'candidate', candidate_tree: 'tree' },
      checkpoint: { commit: 'candidate', tree: 'tree', source_archive_sha256: 'a'.repeat(64), files: [{ path: 'oracle.c', before_sha256: null, after_sha256: 'b'.repeat(64) }] },
      hypothesis: null,
      agentIdentity: {},
    };
    assert.throws(() => runtime.recordCandidate(input), /outside package scope/);
    assert.equal(store.listCandidates(task.task_id).length, 0);
    input.checkpoint.files[0].path = 'fixtures/vector.c';
    assert.equal(runtime.recordCandidate(input).status, 'FROZEN');
    assert.equal(store.listCandidates(task.task_id).length, 1);
  } finally { store.close(); }
});

test('existing interactive optimize accepts package-owned build without a new build wizard', async (context) => {
  const root = temporaryRoot(context);
  const configPath = path.join(root, 'phyopt.yaml');
  fs.writeFileSync(configPath, JSON.stringify(configValue()));
  let submittedFunction: string | undefined;
  const workbench = {
    configPath,
    hasConfig: () => true,
    getApi: async () => ({ submitOptimizationWorkflow: async (request: { function_name: string }) => {
      submittedFunction = request.function_name;
      return { workflow_id: 'package-workflow' };
    } }),
  } as unknown as WorkbenchContext;
  const io: CommandIO = {
    print: () => {}, error: () => {},
    prompt: async () => { throw new Error('must not prompt'); },
    select: async () => { throw new Error('must not select'); },
    confirm: async () => { throw new Error('must not confirm'); },
  };
  const outcome = await runCommandArgs(workbench, '/optimize', ['--function', 'cblas_sgemv', '--api-key', 'explicit-test-key'], io);
  assert.equal(outcome.ok, true, outcome.message);
  assert.equal(submittedFunction, 'cblas_sgemv');
  const buildOutcome = await runCommandArgs(workbench, '/build', [], io);
  assert.equal(buildOutcome.ok, false);
  assert.match(buildOutcome.message, /Library Package/);
});
