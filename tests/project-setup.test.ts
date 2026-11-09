import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { ProjectSetupService } from '../src/application/project-setup-service.js';
import type { ProjectSetup } from '../src/contracts/project-setup.js';
import { LibraryPackageLoader } from '../src/library-package/loader.js';
import { loadFormalEvaluatorBundle } from '../src/evaluator/formal-evaluator.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import type { RunnerToolchain, ProjectBuildOptions } from '../src/contracts/build-planning.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { initialOptimizationWorkflowRecord, SqliteOptimizationWorkflowStore } from '../src/workflow/optimization-workflow.js';
import { hypothesisProposal } from './hypothesis-fixture.js';
import { commandBuild } from '../src/config/build-command.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';

test('a new library is inspected through the shared API and CLI, persists evidence and generates its own unqualified draft', async () => {
  const f = await startWebFixture();
  try {
    const root = path.join(f.root, 'spectral-library');
    for (const directory of ['include', 'src', 'tests', 'benchmarks']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'project(spectral LANGUAGES C)\nadd_library(spectral src/transform.c)\n');
    fs.writeFileSync(path.join(root, 'include/spectral.h'), 'int spectral_transform(void);\n');
    fs.writeFileSync(path.join(root, 'src/transform.c'), 'int spectral_transform(void) { return 1; }\n');
    fs.writeFileSync(path.join(root, 'tests/transform.c'), 'int main(void) { return 0; }\n');
    fs.writeFileSync(path.join(root, 'benchmarks/transform.c'), 'int main(void) { return 0; }\n');
    const project = f.projects.add({ name: 'Spectral library', repository_root: root });
    const originalConfig = fs.readFileSync(project.config_path, 'utf8');
    const originalSource = fs.readFileSync(path.join(root, 'src/transform.c'), 'utf8');
    const api = new ApiClient(f.url, { token: f.token });
    const before = await api.projectAction(project.project_id, 'setup') as ProjectSetup;
    assert.equal(before.discovery, null);
    assert.ok(before.checks.every(check => check.state === 'MISSING'));
    const inspection = await api.projectAction(project.project_id, 'source-inspection', {}) as ProjectSetup;
    assert.equal(inspection.discovery?.repository.name, 'spectral-library');
    assert.equal(inspection.discovery?.builds[0].status, 'DISCOVERED');
    assert.match(inspection.discovery?.builds[0].command ?? '', /cmake -S .*cmake --build/);
    assert.ok(inspection.discovery?.functions.some(item => item.symbol === 'spectral_transform'));
    assert.deepEqual(inspection.discovery?.tests, ['tests/transform.c']);
    assert.deepEqual(inspection.discovery?.benchmarks, ['benchmarks/transform.c']);
    const restored = await new ProjectSetupService(f.dataDir).status(project, f.projects.config(project.project_id));
    assert.equal(restored.discovery?.inspected_at, inspection.discovery?.inspected_at);
    const cli = await runFixtureCli(f.url, f.token, ['project', 'setup', project.project_id]);
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).discovery.repository.name, 'spectral-library');
    const rescan = await runFixtureCli(f.url, f.token, ['project', 'setup', project.project_id, '--inspect']);
    assert.equal(rescan.code, 0, rescan.stderr);
    assert.equal(JSON.parse(rescan.stdout).discovery.repository.name, 'spectral-library');
    const command = 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Release\ncmake --build build --parallel 2';
    const draft = await api.projectAction(project.project_id, 'discover', { symbol: 'spectral_transform', build_command: command, build_cwd: '.' }) as { state: string; evidence: { generated: { package_id: string; version: string } } };
    assert.equal(draft.state, 'DRAFT');
    const generated = draft.evidence.generated;
    assert.ok(generated.package_id.startsWith('project-'));
    const loader = new LibraryPackageLoader({ catalogRoot: path.join(f.dataDir, 'catalog') });
    const loaded = loader.loadPackage(generated.package_id, generated.version);
    assert.equal(loaded.manifest.functions[0].api, 'spectral_transform');
    const target = loaded.manifest.targets[0];
    const build = loader.resolveBuildDefinition(loaded, target.target_id);
    assert.equal(build.executable, 'bash');
    assert.deepEqual(build.args, ['-e', '-o', 'pipefail', '-c', command]);
    assert.equal(loaded.manifest.qualification.state, 'DRAFT');
    assert.equal(fs.readFileSync(project.config_path, 'utf8'), originalConfig);
    assert.equal(fs.readFileSync(path.join(root, 'src/transform.c'), 'utf8'), originalSource);
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: {
      library_package: { package_id: generated.package_id, package_version: generated.version, target_id: target.target_id }, baseline_artifact: '' } });
    const partial = f.projects.config(project.project_id);
    assert.equal(partial.validation.library_package?.target_id, target.target_id);
    assert.equal(partial.validation.baseline_artifact, undefined);
    const incomplete = await api.projectAction(project.project_id, 'setup') as ProjectSetup;
    assert.equal(incomplete.checks.find(item => item.id === 'baseline')?.state, 'MISSING');
    await assert.rejects(api.submitOptimizationWorkflow({ project_id: project.project_id }), /qualif/i);
    f.projects.saveConfig(project.project_id, { ...partial, validation: { ...partial.validation, baseline_artifact: path.join(f.root, 'baseline.so') } });
    const status = await api.projectAction(project.project_id, 'setup') as ProjectSetup;
    assert.equal(status.validation?.evaluator_status, 'DRAFT');
    assert.equal(status.checks.find(item => item.id === 'evaluator')?.state, 'NEEDS_REVIEW');
    await assert.rejects(api.projectAction(project.project_id, 'check', {}), /qualif/i);
    await assert.rejects(api.submitOptimizationWorkflow({ project_id: project.project_id }), /qualif/i);
    assert.equal(f.modelRequests.inference, 0);
    assert.equal(f.service.list().length, 0);
  } finally { await f.close(); }
});

test('bulk target selection creates one package with separate reviewable evaluators', async () => {
  const f = await startWebFixture();
  try {
    const root = path.join(f.root, 'two-functions');
    for (const directory of ['include', 'src']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, 'include/library.h'), 'int fast_sum(void);\nint fast_max(void);\n');
    fs.writeFileSync(path.join(root, 'src/sum.c'), 'int fast_sum(void) { return 1; }\n');
    fs.writeFileSync(path.join(root, 'src/max.c'), 'int fast_max(void) { return 2; }\n');
    const project = f.projects.add({ name: 'Two functions', repository_root: root });
    const api = new ApiClient(f.url, { token: f.token });
    const inspected = await api.projectAction(project.project_id, 'source-inspection', {}) as ProjectSetup;
    assert.deepEqual(inspected.discovery?.functions.map(item => item.symbol).sort(), ['fast_max', 'fast_sum']);
    const before = f.projects.catalog().length;
    await assert.rejects(api.projectAction(project.project_id, 'discover', { symbols: ['fast_sum', 'fast_sum'] }), /unique/);
    await assert.rejects(api.projectAction(project.project_id, 'discover', { symbols: ['fast_sum', 'invented'] }), /public API evidence/);
    assert.equal(f.projects.catalog().length, before);
    const draft = await api.projectAction(project.project_id, 'discover', { symbols: ['fast_sum', 'fast_max'] }) as {
      package_path: string; evaluator_path: string; evaluator_paths: string[];
      targets: Array<{ symbol: string; target_id: string; evaluator_path: string }>;
      evidence: { generated: { package_id: string; version: string } };
    };
    assert.equal(draft.targets.length, 2);
    assert.equal(draft.evaluator_path, draft.targets[0].evaluator_path);
    assert.deepEqual(draft.evaluator_paths, draft.targets.map(item => item.evaluator_path));
    const loader = new LibraryPackageLoader({ catalogRoot: path.join(f.dataDir, 'catalog') });
    const loaded = loader.loadPackage(draft.evidence.generated.package_id, draft.evidence.generated.version);
    assert.deepEqual(loaded.manifest.functions.map(item => item.api), ['fast_sum', 'fast_max']);
    assert.deepEqual(loaded.manifest.targets.map(item => item.target_id), draft.targets.map(item => item.target_id));
    for (const target of draft.targets) {
      const resolved = loader.resolveSelection({ package_id: loaded.manifest.package_id, package_version: loaded.manifest.version, target_id: target.target_id });
      assert.equal(resolved.bundle.manifest.domain.api, target.symbol);
      assert.equal(loadFormalEvaluatorBundle(target.evaluator_path).qualification.status, 'DRAFT');
      assert.deepEqual(loader.resolveCandidateScope(loaded, target.target_id).include, [`src/${target.symbol === 'fast_sum' ? 'sum' : 'max'}.c`]);
    }
    assert.equal(fs.existsSync(path.join(root, 'catalog')), false);
  } finally { await f.close(); }
});

test('build discovery supports distinct toolchains and does not invent tests or qualification', async () => {
  const f = await startWebFixture();
  try {
    const api = new ApiClient(f.url, { token: f.token });
    for (const library of [{ name: 'rust-algorithms', file: 'Cargo.toml', source: 'lib.rs', language: 'Rust', build: 'cargo' }, { name: 'go-algorithms', file: 'go.mod', source: 'main.go', language: 'Go', build: 'go' }]) {
      const root = path.join(f.root, library.name); fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, library.file), library.build === 'cargo' ? '[package]\nname="algorithms"\nversion="0.1.0"\n' : 'module example.invalid/algorithms\n');
      fs.writeFileSync(path.join(root, library.source), '// fixture source\n');
      const project = f.projects.add({ name: library.name, repository_root: root });
      const result = await api.projectAction(project.project_id, 'source-inspection', {}) as ProjectSetup;
      assert.ok(result.discovery?.languages.includes(library.language));
      assert.equal(result.discovery?.builds[0].kind, library.build);
      assert.equal(result.discovery?.builds[0].status, 'DISCOVERED');
      assert.deepEqual(result.discovery?.tests, []);
      assert.equal(result.validation, null);
      assert.ok(result.checks.every(check => check.state === 'MISSING'));
    }
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});

test('setup assessment explains invalid imported tests without treating files as verified experiments', async () => {
  const f = await startWebFixture();
  try {
    const project = f.projects.add({ name: 'Imported tests', repository_root: f.repo, config_path: f.configPath });
    const api = new ApiClient(f.url, { token: f.token });
    const status = await api.projectAction(project.project_id, 'setup') as ProjectSetup;
    assert.equal(status.validation?.function_name, 'kernel');
    assert.equal(status.validation?.correctness_cases, 1);
    assert.equal(status.checks.find(check => check.id === 'build')?.state, 'CONFIGURED');
    assert.equal(status.checks.find(check => check.id === 'evaluator')?.state, 'NEEDS_REVIEW');
    fs.writeFileSync(f.projects.config(project.project_id).validation.testpack, '{}');
    const invalid = await api.projectAction(project.project_id, 'setup') as ProjectSetup;
    assert.ok(invalid.checks.some(check => check.state === 'INVALID'));
    assert.equal(f.modelRequests.inference, 0);
    assert.equal(f.service.list().length, 0);
  } finally { await f.close(); }
});

test('build options use actual library history and source plus selected Runner facts', async () => {
  const f = await startWebFixture();
  const toolchain = (runnerId: string, cmake: 'AVAILABLE' | 'MISSING'): RunnerToolchain => ({
    runner_id: runnerId, checked_at: new Date().toISOString(), architecture: process.arch, platform: 'linux',
    available_parallelism: 16, cpu_count: 32, memory_total_bytes: 32 * 1024 ** 3,
    tools: Object.fromEntries(['cmake', 'gcc', 'g++', 'clang', 'clang++', 'make', 'ninja', 'meson', 'cargo', 'rustc', 'go', 'python3', 'bash']
      .map(name => [name, { status: name === 'cmake' ? cmake : ['gcc', 'g++', 'make', 'ninja', 'bash'].includes(name) ? 'AVAILABLE' : 'MISSING', version: name === 'cmake' && cmake === 'AVAILABLE' ? 'cmake version 3.19.2' : null }])),
  });
  let runnerA: Awaited<ReturnType<typeof startRunnerHttpServer>> | undefined;
  let runnerB: Awaited<ReturnType<typeof startRunnerHttpServer>> | undefined;
  try {
    const root = path.join(f.root, 'image-library');
    for (const directory of ['src', 'tests']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\noption(ENABLE_OPENMP "Use OpenMP" ON)\nproject(image LANGUAGES C CXX)\n');
    fs.writeFileSync(path.join(root, 'src', 'image.cpp'), 'bool image() { return std::is_same_v<int, int>; }\n');
    fs.writeFileSync(path.join(root, 'tests', 'Makefile'), 'all:\n\t@echo tests only\n');
    const project = f.projects.add({ name: 'Image library', repository_root: root });
    const api = new ApiClient(f.url, { token: f.token });
    const inspected = await api.projectAction(project.project_id, 'source-inspection', {}) as ProjectSetup;
    assert.deepEqual(inspected.discovery?.build_requirements?.root_builds, [{ kind: 'cmake', path: 'CMakeLists.txt' }]);
    assert.deepEqual(inspected.discovery?.builds.map(item => item.kind), ['cmake']);
    assert.equal(inspected.discovery?.build_requirements?.cxx_standard, 17);
    assert.equal(inspected.discovery?.build_requirements?.openmp_option, 'ENABLE_OPENMP');
    const withoutMachine = await api.projectAction(project.project_id, 'build-options') as ProjectBuildOptions;
    assert.equal(withoutMachine.recent, null); assert.equal(withoutMachine.recommended, null);
    runnerA = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'planning-a', dbPath: path.join(f.root, 'runner-a.sqlite'), workspaceRoot: path.join(f.root, 'runner-a'), toolchainProbe: () => Promise.resolve(toolchain(runnerA!.runnerId, 'AVAILABLE')) });
    runnerB = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'planning-b', dbPath: path.join(f.root, 'runner-b.sqlite'), workspaceRoot: path.join(f.root, 'runner-b'), toolchainProbe: () => Promise.resolve(toolchain(runnerB!.runnerId, 'MISSING')) });
    const machineA = f.projects.machines.save({ name: 'ARM with CMake', runner: { mode: 'rpc', endpoint: runnerA.url, token: 'planning-a' }, target: { ssh_alias: 'fixture-a', workspace_root: '/tmp/a' } });
    const machineB = f.projects.machines.save({ name: 'ARM without CMake', runner: { mode: 'rpc', endpoint: runnerB.url, token: 'planning-b' }, target: { ssh_alias: 'fixture-b', workspace_root: '/tmp/b' } });
    f.projects.bindMachine(project.project_id, machineA.machine_id);
    const available = await api.projectAction(project.project_id, 'build-options') as ProjectBuildOptions;
    assert.ok(available.recommended, available.message ?? 'recommendation missing');
    assert.match(available.recommended?.command ?? '', /cmake -S \. -B \.corepilot-build/);
    assert.match(available.recommended?.command ?? '', /-DCMAKE_CXX_STANDARD=17/);
    assert.match(available.recommended?.command ?? '', /-DENABLE_OPENMP=ON/);
    assert.match(available.recommended?.command ?? '', /--parallel 16/);
    assert.doesNotMatch(available.recommended?.command ?? '', /^make /);
    assert.equal(available.recommended?.status, 'NOT_BUILT');
    assert.equal(available.recommended?.machine_id, machineA.machine_id);
    assert.equal(available.recommended?.evidence[0].path, 'CMakeLists.txt');
    const cli = await runFixtureCli(f.url, f.token, ['project', 'build-options', project.project_id]);
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal((JSON.parse(cli.stdout) as ProjectBuildOptions).recommended?.command, available.recommended?.command);
    const unavailable = await api.projectAction(project.project_id, `build-options?machine_id=${machineB.machine_id}`) as ProjectBuildOptions;
    assert.equal(unavailable.recommended, null);

    const build = commandBuild('cmake -S . -B build && cmake --build build', { executable: '', args: [], cwd: '.', environment: {}, timeout_ms: 1000 });
    const runtime = new OptimizationRuntime(f.store);
    const workflowId = 'workflow:build-planning';
    const task = runtime.createTask({ workflowId, target: { kind: 'kernel', name: 'image', scope: { build } },
      sourceBaseline: { id: 'git:base' }, performanceBaseline: null, evaluator: { id: 'evaluator:fixture' }, declaredContext: {} });
    const hypothesis = runtime.proposeHypothesis({ taskId: task.task_id, parentHypothesisId: null, proposal: hypothesisProposal(), agentIdentity: { model: 'fixture-model' } });
    f.store.createCandidate({ schema_version: 1, candidate_id: 'candidate:build-planning', task_id: task.task_id, hypothesis_id: hypothesis.hypothesis_id,
      parent_candidate_id: null, sequence: 1, status: 'FROZEN', source: { repository: root, commit: 'source', tree: 'tree', archive_sha256: 'archive', changed_files: [] },
      hypothesis: hypothesis.description, development_findings: null, agent_identity: { model: 'fixture-model' }, created_at: new Date().toISOString() });
    const experiment = runtime.startExperiment({ taskId: task.task_id, candidateId: 'candidate:build-planning', type: 'DEVELOPMENT' });
    const workflow = initialOptimizationWorkflowRecord(workflowId, { functionName: 'image', entryFile: null, repositoryRoot: root, configPath: project.config_path, enablePerformance: false });
    workflow.execution_machine = { machine_id: machineA.machine_id, name: 'ARM with CMake', revision: 1 };
    workflow.baseline_commit = 'abc123';
    new SqliteOptimizationWorkflowStore(f.store).save(workflow);
    for (const [sequence, exitCode] of [[1, 0], [2, 1]] as const) f.store.appendCommandExecution({ schema_version: 1,
      command_execution_id: `build:${sequence}`, experiment_id: experiment.experiment_id, evaluator: null, step: 'BUILD', sequence,
      command: build.executable, args: build.args, cwd: '/remote/candidate-worktree', start_time: `2026-10-26T00:0${sequence}:00.000Z`, end_time: `2026-10-26T00:0${sequence}:01.000Z`,
      duration_ms: 1000, exit_code: exitCode, stdout: '', stderr: '', timeout_ms: 1000, timed_out: false, cancelled: false });
    const withHistory = await api.projectAction(project.project_id, 'build-options') as ProjectBuildOptions;
    assert.equal(withHistory.recent?.status, 'FAILED');
    assert.equal(withHistory.recent?.command, 'cmake -S . -B build && cmake --build build');
    assert.equal(withHistory.recent?.build?.cwd, '.');
    assert.equal(withHistory.recent?.machine_name, 'ARM with CMake');
    assert.equal(withHistory.recent?.command_execution_id, 'build:2');
    assert.equal(withHistory.recommended?.status, 'NOT_BUILT');
    assert.equal(f.modelRequests.inference, 0);
  } finally { await runnerA?.close(); await runnerB?.close(); await f.close(); }
});
