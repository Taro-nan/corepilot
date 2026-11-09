import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient } from '../src/client/api-client.js';
import { loadOptimizationConfig } from '../src/config/optimization-config.js';
import { ValidationGenerationRuns } from '../src/application/validation-generation-runs.js';
import { validationSourceExcerpt } from '../src/application/validation-generation.js';
import { checkGeneratedPython } from '../src/application/validation-code-check.js';
import { VALIDATION_PYTHON_HARNESS } from '../src/application/validation-python-harness.js';
import type { ValidationGenerationRecord } from '../src/contracts/validation-assets.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';

async function setup(f: Awaited<ReturnType<typeof startWebFixture>>, ready = true) {
  const project = f.projects.add({ name: 'Generation', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
  const d = await f.projects.discover(project.project_id, 'kernel');
  const pkg = d.evidence.generated.package_id, version = d.evidence.generated.version, target = d.targets[0].target_id;
  if (ready) f.readyValidation(project, pkg, version, target);
  const endpoint = `validation-assets/${pkg}/${version}/${target}`;
  return { project, pkg, version, target, endpoint, api: new ApiClient(f.url, { token: f.token }) };
}
async function finish(f: Awaited<ReturnType<typeof startWebFixture>>, projectId: string, id: string) {
  for (let i = 0; i < 150; i++) {
    const record = f.projects.validationAssets.generations.get(projectId, id);
    if (!['RUNNING', 'CANCELLING'].includes(record.status)) return record;
    await delay(20);
  }
  throw new Error('Fixture generation did not finish');
}

async function preparePerformance(f: Awaited<ReturnType<typeof startWebFixture>>, x: Awaited<ReturnType<typeof setup>>) {
  const artifact = path.join(f.root, 'baseline-library.so');
  fs.writeFileSync(artifact, 'offline baseline fixture, not a measured library');
  await f.projects.validationAssets.bindSingleBaseline(x.project, x.pkg, x.version, x.target, { artifactPath: artifact,
    sha256: createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'), library: 'fixture-kernel', versionLabel: '1.0', source: { kind: 'upload', detail: 'fixture' } });
  const config = loadOptimizationConfig(f.configPath).config;
  f.projects.saveConfig(x.project.project_id, { ...config, validation: { testpack: '', baseline_artifact: artifact, library_package: { package_id: x.pkg, package_version: x.version, target_id: x.target } } });
  const before = f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target);
  return f.projects.validationAssets.save(x.project, x.pkg, x.version, x.target, { ...before, source: 'edited', expected_digest: before.evaluator_digest,
    workloads: [{ workload_id: 'small-64', parameters: {}, threads: 1, critical: true, weight: 2 }],
    test_plan: { ...before.test_plan, execution_matrix: { thread_counts: [1, 2, 4], profiles: [{ id: 'node0', name: 'CPU pool', cpu_set: '0-7', numa_node: 0, cpu_allocation: 'per_thread', omp_proc_bind: 'close' }] } } });
}

test('a direct code request fills draft correctness gaps in the same model call without a prior plan', async () => {
  const f = await startWebFixture();
  try {
    const x = await setup(f, false);
    const record = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { scope: 'correctness', background: true }) as ValidationGenerationRecord;
    const result = await finish(f, x.project.project_id, record.generation_id);
    assert.equal(result.status, 'SUCCEEDED', result.message);
    assert.equal(result.model.request_count, 1); assert.equal(f.modelRequests.validationBodies.length, 1);
    assert.equal(f.modelRequests.planBodies.length, 0); assert.equal(result.proposal, undefined);
    assert.equal(result.result!.cases[0].case_id, 'small');
    assert.ok(result.result!.cases[0].input_generation);
    assert.match(result.result!.correctness_script, /test-correctness.py/);
    assert.equal(f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target).cases[0].case_id, 'review-required');
  } finally { await f.close(); }
});

test('actual configured model, upstream model, request identity and usage are retained without saving generated assets', async () => {
  const f = await startWebFixture();
  try {
    const x = await setup(f);
    const config = loadOptimizationConfig(f.configPath).config; config.model.model_id = 'user-configured-drafting-model';
    f.projects.saveConfig(x.project.project_id, config);
    const before = f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target);
    const started = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { scope: 'correctness', background: true }) as ValidationGenerationRecord;
    const result = await finish(f, x.project.project_id, started.generation_id);
    assert.equal(result.status, 'SUCCEEDED', result.message);
    assert.equal(result.model.requested_model, 'user-configured-drafting-model');
    assert.equal(result.model.sent_model, 'user-configured-drafting-model');
    assert.equal(result.model.response_model, 'user-configured-drafting-model');
    assert.equal((f.modelRequests.validationBodies[0] as { model: string }).model, 'user-configured-drafting-model');
    assert.equal(result.model.request_count, 1); assert.ok(result.model.request_id);
    assert.equal(result.model.usage!.total_tokens, 75);
    assert.equal(result.result!.expected_digest, before.evaluator_digest);
    assert.equal(f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target).evaluator_digest, before.evaluator_digest);
    assert.equal(new ValidationGenerationRuns(f.dataDir).get(x.project.project_id, started.generation_id).status, 'SUCCEEDED');
    assert.ok(!JSON.stringify(result).includes('fixture-model-secret'));
  } finally { await f.close(); }
});

test('background drafting keeps API responsive, is reconnectable and can cancel the actual model request', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await startWebFixture({ validationGate: gate });
  try {
    const x = await setup(f);
    const started = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { scope: 'correctness', background: true }) as ValidationGenerationRecord;
    for (let i = 0; i < 100 && f.modelRequests.validationBodies.length === 0; i++) await delay(20);
    assert.equal(f.modelRequests.validationBodies.length, 1);
    assert.equal((await x.api.projectAction(x.project.project_id, x.endpoint + '/generations/' + started.generation_id) as ValidationGenerationRecord).status, 'RUNNING');
    await x.api.projectAction(x.project.project_id, 'config');
    await assert.rejects(x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { background: true }), /已有测试代码正在生成/);
    await x.api.projectAction(x.project.project_id, x.endpoint + '/generations/' + started.generation_id + '/cancel', {});
    const stopped = await finish(f, x.project.project_id, started.generation_id);
    assert.equal(stopped.status, 'CANCELLED'); assert.equal(stopped.result, undefined);
  } finally { release(); await f.close(); }
});

test('model-declared missing evidence is not presented as successfully generated code', async () => {
  const f = await startWebFixture({ validationProposal: { status: 'needs_input', blockers: ['Need a declared reference ABI'] } });
  try {
    const x = await setup(f);
    const started = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { background: true }) as ValidationGenerationRecord;
    const result = await finish(f, x.project.project_id, started.generation_id);
    assert.equal(result.status, 'NEEDS_INPUT'); assert.equal(result.model.request_count, 1);
    assert.deepEqual(result.blockers, ['Need a declared reference ABI']); assert.equal(result.result, undefined);
  } finally { await f.close(); }
});

test('a ready proposal with the reported fake PASS marker and missing evaluator identity is rejected', async () => {
  const f = await startWebFixture({ validationProposal: { status: 'ready', correctness_script: "#!/bin/sh\npython3 - <<'PY'\npayload={'value':'PASS','evaluator_binary_identity':None,'review_required':True}\nprint(payload)\nPY\n" } });
  try {
    const x = await setup(f);
    const started = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { background: true }) as ValidationGenerationRecord;
    const result = await finish(f, x.project.project_id, started.generation_id);
    assert.equal(result.status, 'FAILED'); assert.equal(result.result, undefined);
  } finally { await f.close(); }
});

test('source context includes a selected function beyond the old file-prefix truncation', async () => {
  const f = await startWebFixture();
  try {
    const filename = path.join(f.repo, 'large.c');
    fs.writeFileSync(filename, '// unrelated prefix\n'.repeat(1000) + 'double selected_function(double x) { return x * x; }\n');
    const project = f.projects.add({ name: 'Source context', repository_root: f.repo });
    assert.match(validationSourceExcerpt(project, 'large.c', null, 'selected_function'), /return x \* x/);
  } finally { await f.close(); }
});

test('Python missing-import feedback returns through Pi tools and the model repairs the submitted code', async () => {
  const f = await startWebFixture({ validationMissingImportFirst: true });
  try {
    const x = await setup(f);
    const record = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { background: true }) as ValidationGenerationRecord;
    const result = await finish(f, x.project.project_id, record.generation_id);
    assert.equal(result.status, 'SUCCEEDED', result.message);
    assert.equal(result.model.request_count, 2);
    assert.match(JSON.stringify(f.modelRequests.validationBodies[1]), /undefined global ctypes/);
    assert.match(result.result!.correctness_script, /support\/test-correctness.py/);
    assert.ok(result.result!.supporting_files!.some(file => file.path === 'support/corepilot_test.py'));
  } finally { await f.close(); }
});

test('AI can propose missing correctness conditions without saving them; explicit adoption preserves other conditions and leaves a draft', async () => {
  const f = await startWebFixture();
  try {
    const x = await setup(f, false);
    const before = f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target);
    const started = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { purpose: 'CORRECTNESS_PLAN', background: true }) as ValidationGenerationRecord;
    const result = await finish(f, x.project.project_id, started.generation_id);
    assert.equal(result.status, 'SUCCEEDED', result.message);
    assert.equal(result.result, undefined); assert.ok(result.proposal);
    assert.equal(f.modelRequests.planBodies.length, 1);
    assert.equal(result.model.sent_model, 'fixture-model'); assert.equal(result.model.response_model, 'fixture-model');
    assert.deepEqual(f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target), before);
    const accepted = await x.api.projectAction(x.project.project_id, x.endpoint + '/generations/' + started.generation_id + '/adopt', { expected_digest: before.evaluator_digest }) as typeof before;
    assert.notEqual(accepted.evaluator_digest, before.evaluator_digest);
    assert.equal(accepted.qualification, 'DRAFT'); assert.deepEqual(accepted.correctness_generation_blockers, []);
    for (const key of ['workloads', 'test_plan', 'benchmark_description', 'candidate_artifact', 'correctness_script', 'performance_script', 'supporting_files'] as const) assert.deepEqual(accepted[key], before[key]);
    const reviews = fs.readdirSync(path.join(f.dataDir, 'catalog/packages', x.pkg, x.version, 'onboarding')).filter(file => file.startsWith('correctness-plan-review-'));
    assert.equal(reviews.length, 1);
    const review = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'catalog/packages', x.pkg, x.version, 'onboarding', reviews[0]), 'utf8'));
    assert.equal(review.decision, 'ADOPT_DRAFT_PLAN'); assert.equal(review.accepted_digest, accepted.evaluator_digest);
    assert.deepEqual(await x.api.projectAction(x.project.project_id, x.endpoint + '/generations/' + started.generation_id + '/adopt', { expected_digest: before.evaluator_digest }), accepted);
    const generated = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { scope: 'correctness' }) as { expected_digest: string };
    assert.equal(generated.expected_digest, accepted.evaluator_digest); assert.equal(f.modelRequests.validationBodies.length, 1);
  } finally { await f.close(); }
});

test('proposal cannot replace already configured correctness inputs, reference or tolerances', async () => {
  const f = await startWebFixture();
  try {
    const x = await setup(f);
    const before = f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target);
    const result = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { purpose: 'CORRECTNESS_PLAN' }) as { cases: unknown; oracle_description: string; tolerance_rule: string; tolerance_absolute: number; tolerance_relative: number };
    for (const key of ['cases', 'tolerance_rule', 'tolerance_absolute', 'tolerance_relative'] as const) assert.deepEqual(result[key], before[key]);
    assert.equal(result.oracle_description, before.oracle_description.trim());
  } finally { await f.close(); }
});

test('a proposal becomes stale after saved edits or a selected source branch advances', async () => {
  const f = await startWebFixture();
  try {
    const x = await setup(f, false);
    const proposal = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { purpose: 'CORRECTNESS_PLAN' }) as { generation_id: string; expected_digest: string };
    const before = f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target);
    f.projects.validationAssets.save(x.project, x.pkg, x.version, x.target, { ...before, source: 'edited', expected_digest: before.evaluator_digest,
      test_plan: { ...before.test_plan, seed: before.test_plan.seed + 1 } });
    await assert.rejects(x.api.projectAction(x.project.project_id, x.endpoint + '/generations/' + proposal.generation_id + '/adopt', { expected_digest: proposal.expected_digest }), /测试条件已变化/);
    const fresh = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { purpose: 'CORRECTNESS_PLAN' }) as typeof proposal;
    const { spawnSync } = await import('node:child_process');
    spawnSync('git', ['-C', f.repo, 'commit', '--allow-empty', '-m', 'Advance selected source'], { windowsHide: true });
    await assert.rejects(x.api.projectAction(x.project.project_id, x.endpoint + '/generations/' + fresh.generation_id + '/adopt', { expected_digest: fresh.expected_digest }), /源码分支版本已变化/);
  } finally { await f.close(); }
});

test('unresolved semantics in plan drafting return specific questions without accepting a proposal', async () => {
  const f = await startWebFixture({ correctnessPlanProposal: { status: 'needs_input', blockers: ['函数声明缺少输出归一化定义：除以 N 还是 N-1？'] } });
  try {
    const x = await setup(f, false);
    const started = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { purpose: 'CORRECTNESS_PLAN', background: true }) as ValidationGenerationRecord;
    const result = await finish(f, x.project.project_id, started.generation_id);
    assert.equal(result.status, 'NEEDS_INPUT'); assert.match(result.blockers![0], /N-1/); assert.equal(result.proposal, undefined);
  } finally { await f.close(); }
});

test('CLI proposal and adoption use the same persisted plan and API service', async () => {
  const f = await startWebFixture();
  try {
    const x = await setup(f, false);
    const args = ['project', 'validation', x.project.project_id, x.pkg, x.version, x.target];
    const proposed = await runFixtureCli(f.url, f.token, [...args, '--propose']);
    assert.equal(proposed.code, 0, proposed.stderr);
    const plan = JSON.parse(proposed.stdout) as { kind: string; generation_id: string; expected_digest: string };
    assert.equal(plan.kind, 'CORRECTNESS_PLAN');
    assert.equal(f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target).evaluator_digest, plan.expected_digest);
    const adopted = await runFixtureCli(f.url, f.token, [...args, '--accept-plan', plan.generation_id]);
    assert.equal(adopted.code, 0, adopted.stderr);
    assert.deepEqual(JSON.parse(adopted.stdout), f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target));
    assert.equal(f.modelRequests.planBodies.length, 1);
  } finally { await f.close(); }
});

test('drafting source context includes the function definition when discovery finds earlier call-site files', async () => {
  const f = await startWebFixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'aaa-caller.c'), 'int call_a(void) { return kernel(); }\n');
    fs.writeFileSync(path.join(f.repo, 'aab-caller.c'), 'int call_b(void) { return kernel(); }\n');
    f.git('add', '.'); f.git('commit', '-m', 'Call sites sort before actual definition');
    const x = await setup(f, false);
    await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { purpose: 'CORRECTNESS_PLAN' });
    const body = f.modelRequests.planBodies[0] as { messages: Array<{ role: string; content: string | Array<{ text: string }> }> };
    const content = body.messages.find(item => item.role === 'user')!.content;
    const context = JSON.parse(typeof content === 'string' ? content : content.map(item => item.text).join('')) as { evidence: Array<{ file: string; content: string }> };
    assert.ok(context.evidence.some(item => item.file === 'kernel.c' && /return 1 \+ 1/.test(item.content)));
  } finally { await f.close(); }
});

test('optional instructions reach the configured model through API and CLI and remain in generation receipts', async () => {
  const f = await startWebFixture();
  try {
    const x = await setup(f);
    const instructions = '重点测试非连续步长，并在失败时输出输入参数。';
    const record = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { background: true, instructions }) as ValidationGenerationRecord;
    const result = await finish(f, x.project.project_id, record.generation_id);
    assert.equal(result.status, 'SUCCEEDED', result.message); assert.equal(result.instructions, instructions);
    assert.ok(JSON.stringify(f.modelRequests.validationBodies.at(-1)).includes(instructions));
    const cli = await runFixtureCli(f.url, f.token, ['project', 'validation', x.project.project_id, x.pkg, x.version, x.target, '--generate', '--prompt', 'Also print diagnostic outputs']);
    assert.equal(cli.code, 0, cli.stderr);
    assert.match(JSON.stringify(f.modelRequests.validationBodies.at(-1)), /Also print diagnostic outputs/);
    const before = f.modelRequests.inference;
    for (const value of [42, null, 'x'.repeat(12001)]) {
      await assert.rejects(x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { instructions: value }), /生成提示词必须/);
    }
    assert.equal(f.modelRequests.inference, before);
  } finally { await f.close(); }
});

test('logical inputs stay distinct from matrix executions and missing data recipes survive saving and loading', async () => {
  const logical = Array.from({ length: 16 }, (_, i) => ({ case_id: `input-${i}`, parameters: { pattern: 'domain-pattern', n: 4 }, threads: 1 }));
  const f = await startWebFixture({ validationProposal: { status: 'ready', cases: logical.map(item => ({ ...item, input_generation: 'i=0..3: value=i/4, converted to the declared dtype. Padding is zero.' })),
    supporting_files: [{ path: 'support/test-correctness.py', content: 'from corepilot_test import TestContext\nctx = TestContext.for_correctness(__file__)\nlib = ctx.load_library()\nctx.emit_correctness(lib.kernel() == 2)\n' }] } });
  try {
    const x = await setup(f);
    const original = f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target);
    const before = f.projects.validationAssets.save(x.project, x.pkg, x.version, x.target, { ...original, source: 'edited', expected_digest: original.evaluator_digest,
      cases: logical, test_plan: { ...original.test_plan, execution_matrix: { thread_counts: [1, 2, 4, 8], profiles: [{ id: 'node0', name: 'CPU pool', cpu_set: '0-15', numa_node: 0, cpu_allocation: 'per_thread', omp_proc_bind: 'close' }] } } });
    const generated = await f.projects.validationAssets.generate(x.project, loadOptimizationConfig(f.configPath).config, x.pkg, x.version, x.target);
    const body = f.modelRequests.validationBodies[0] as { messages: Array<{ role: string; content: string | Array<{ text: string }> }> };
    const content = body.messages.find(item => item.role === 'user')!.content;
    const context = JSON.parse(typeof content === 'string' ? content : content.map(item => item.text).join(''));
    assert.equal(context.input_layout, 'LOGICAL_INPUTS'); assert.equal(context.cases.length, 16);
    assert.equal(context.execution_expansion.correctness_executions, 64);
    assert.equal(context.maximum_case_count, undefined); assert.equal(context.maximum_new_case_count, undefined);
    assert.ok(context.cases.every((item: { execution?: unknown }) => !item.execution));
    assert.deepEqual(generated.cases.map(({ input_generation: _recipe, ...item }) => item), before.cases);
    const saved = f.projects.validationAssets.save(x.project, x.pkg, x.version, x.target, generated);
    assert.notEqual(saved.evaluator_digest, before.evaluator_digest);
    assert.deepEqual(saved.test_plan, before.test_plan); assert.deepEqual(saved.workloads, before.workloads);
    assert.ok(saved.cases.every(item => item.input_generation?.includes('i=0..3')));
    const resolved = f.projects.packageLoader.resolveSelection({ package_id: x.pkg, package_version: x.version, target_id: x.target });
    assert.equal(resolved.bundle.correctness.cases.length, 64);
    assert.ok(resolved.bundle.correctness.cases.every(item => Object.keys(item.parameters).length === 2));
    const recipes = JSON.parse(fs.readFileSync(path.join(resolved.bundle.root, 'correctness/input-generation.json'), 'utf8'));
    assert.equal(Object.keys(recipes.inputs).length, 16);
    assert.ok(Object.values(recipes.inputs).every(recipe => String(recipe).includes('i=0..3')));
    assert.equal(f.projects.validationAssets.save(x.project, x.pkg, x.version, x.target, { ...saved, source: 'edited', expected_digest: saved.evaluator_digest }).evaluator_digest, saved.evaluator_digest);
  } finally { await f.close(); }
});

test('performance code is drafted before candidate build and fills empty workload details without saving or changing resources', async () => {
  const proposal = { status: 'ready', workloads: [{ workload_id: 'small-64', parameters: { size: 8 }, threads: 99, weight: 99, critical: false,
    input_generation: 'Eight integer values i=0..7; no random input.' }], benchmark_description: 'Time the kernel call only; identical inputs per role; report seconds per call.',
    test_plan: { seed: 999 }, supporting_files: [{ path: 'support/test-performance.py', content: 'from corepilot_test import TestContext\nctx=TestContext.for_performance(__file__)\nlib=ctx.load_library()\n# Offline protocol fixture; no measurement or generated timing claim.\n' }] };
  const f = await startWebFixture({ validationProposal: proposal });
  try {
    const x = await setup(f);
    const before = await preparePerformance(f, x);
    const instructions = '对比两端相同输入，不计入内存分配。';
    const started = await x.api.projectAction(x.project.project_id, x.endpoint + '/generate', { scope: 'performance', background: true, instructions }) as ValidationGenerationRecord;
    const result = await finish(f, x.project.project_id, started.generation_id);
    assert.equal(result.status, 'SUCCEEDED', result.message);
    assert.match(result.result!.performance_script, /support\/test-performance.py/);
    assert.deepEqual(result.result!.workloads[0], { ...before.workloads[0], parameters: { size: 8 }, input_generation: proposal.workloads[0].input_generation });
    assert.deepEqual(result.result!.test_plan, before.test_plan);
    assert.deepEqual(result.result!.cases, before.cases); assert.equal(result.result!.correctness_script, before.correctness_script);
    assert.equal(result.result!.candidate_artifact, before.candidate_artifact); assert.equal(result.instructions, instructions);
    assert.equal(f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target).evaluator_digest, before.evaluator_digest);
    assert.match(JSON.stringify(f.modelRequests.validationBodies[0]), /CODE_DRAFTING_BEFORE_EXECUTION/);
    const saved = f.projects.validationAssets.save(x.project, x.pkg, x.version, x.target, result.result);
    const resolved = f.projects.packageLoader.resolveSelection({ package_id: x.pkg, package_version: x.version, target_id: x.target });
    assert.equal(resolved.bundle.workloads.workloads.length, 3);
    const recipes = JSON.parse(fs.readFileSync(path.join(resolved.bundle.root, 'benchmark/input-generation.json'), 'utf8'));
    assert.equal(recipes.inputs['small-64'], proposal.workloads[0].input_generation);
    assert.deepEqual(saved.workloads, result.result!.workloads);
    assert.equal(f.projects.validationAssets.save(x.project, x.pkg, x.version, x.target, { ...saved, source: 'edited', expected_digest: saved.evaluator_digest }).evaluator_digest, saved.evaluator_digest);
    const explicit = f.projects.validationAssets.get(x.project, x.pkg, x.version, x.target);
    const changed = f.projects.validationAssets.save(x.project, x.pkg, x.version, x.target, { ...explicit, source: 'edited', expected_digest: explicit.evaluator_digest,
      workloads: [{ ...explicit.workloads[0], parameters: { size: 128 }, input_generation: 'Saved input recipe, 128 values' }], benchmark_description: 'Saved benchmark definition' });
    const regenerated = await f.projects.validationAssets.generate(x.project, loadOptimizationConfig(f.configPath).config, x.pkg, x.version, x.target, 'performance');
    assert.deepEqual(regenerated.workloads, changed.workloads); assert.equal(regenerated.benchmark_description, changed.benchmark_description.trim());
  } finally { await f.close(); }
});

test('kernel timing rejects the observed Python call-loop and implicit workload defaults before accepting code', async () => {
  const file = { path: 'support/test-performance.py', content: 'import time\nfrom corepilot_test import TestContext\nctx=TestContext.for_performance(__file__)\nlib=ctx.load_library()\np=ctx.parameters\nwidth=p.get("width",64)\nt0=time.perf_counter()\nfor i in range(ctx.inner_iterations):\n lib.kernel()\nseconds=(time.perf_counter()-t0)/ctx.inner_iterations\nctx.emit_performance(seconds)\n' };
  await assert.rejects(checkGeneratedPython([file], { timing_scope: 'kernel', parameter_names: ['width'] }), error => {
    assert.match((error as Error).message, /kernel timing includes Python\/ctypes overhead/);
    assert.match((error as Error).message, /silently default saved input parameter width/); return true;
  });
  const repaired = { ...file, content: 'from corepilot_test import TestContext\nctx=TestContext.for_performance(__file__)\nlib=ctx.load_library()\nwidth=ctx.parameters["width"]\n# Clock and exact call loop are implemented inside the native adapter.\nseconds=lib.measure_kernel(width,ctx.inner_iterations)\nctx.emit_performance(seconds)\n' };
  await checkGeneratedPython([repaired], { timing_scope: 'kernel', parameter_names: ['width'] });
  const native = { ...file, content: 'import ctypes\nfrom corepilot_test import TestContext\nctx=TestContext.for_performance(__file__)\nlib=ctx.load_library()\nadapter=ctypes.CDLL("timer.so")\ninner=int(ctx.inner_iterations)\nelapsed=adapter.measure_total(lib,inner)\nctx.emit_performance(elapsed)\n' };
  await assert.rejects(checkGeneratedPython([native], { timing_scope: 'kernel', parameter_names: [] }), /TOTAL loop seconds.*explicit division/);
  await checkGeneratedPython([{ ...native, content: native.content.replace('ctx.emit_performance(elapsed)', 'ctx.emit_performance(elapsed/inner)') }], { timing_scope: 'kernel', parameter_names: [] });
});

test('library loading prefers C exports, resolves a unique C++ export and refuses ambiguous overloads', () => {
  const script = `import sys,types,unittest.mock as mock
namespace={}
exec(sys.stdin.read(),namespace)
Library=namespace['_Library']
def library(exports):
 obj=object.__new__(Library)
 obj._name='fixture-library.so'
 def find(pair):
  if pair[0] not in exports: raise AttributeError('missing export')
  return lambda: exports[pair[0]]
 obj._FuncPtr=find
 return obj
with mock.patch('subprocess.run',side_effect=AssertionError('C export must not inspect symbols')):
 assert library({'kernel':2}).kernel()==2
with mock.patch('subprocess.run',side_effect=[types.SimpleNamespace(stdout='000000 T _Z6kernelv\\n'),types.SimpleNamespace(stdout='kernel()\\n')]) as commands:
 lib=library({'_Z6kernelv':2})
 assert lib.kernel()==2
 assert lib.__dict__['_corepilot_api_resolutions']['kernel']['symbol']=='_Z6kernelv'
 assert commands.call_count==2
with mock.patch('subprocess.run',side_effect=[types.SimpleNamespace(stdout='000000 T _Z6kerneli\\n000001 T _Z6kernelv\\n'),types.SimpleNamespace(stdout='kernel(int)\\nkernel()\\n')]):
 try: library({'_Z6kerneli':1,'_Z6kernelv':2}).kernel()
 except RuntimeError as e: assert 'ambiguous C++ overloads' in str(e)
 else: raise AssertionError('Overloaded C++ ABI must not be guessed')
print('CPP_ABI_RESOLUTION_OK')
`;
  const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], { input: VALIDATION_PYTHON_HARNESS, encoding: 'utf8', windowsHide: true });
  assert.match(output, /CPP_ABI_RESOLUTION_OK/);
});
