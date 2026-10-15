import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { runCli } from '../src/cli.js';
import { loadFormalEvaluatorBundle } from '../src/evaluator/formal-evaluator.js';
import { LibraryPackageLoader } from '../src/library-package/loader.js';
import { onboardLibraryRepository, OnboardingToolset } from '../src/onboarding/onboarding-agent.js';
import { RepositoryInspector } from '../src/onboarding/repository-inspector.js';

function temporaryRoot(context: test.TestContext): { root: string; repository: string; packagesRoot: string; evaluatorsRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-onboarding-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, 'source');
  fs.cpSync('fixtures/example-vector-repo', repository, { recursive: true });
  return { root, repository, packagesRoot: path.join(root, 'catalog/packages'), evaluatorsRoot: path.join(root, 'catalog/evaluators') };
}

function snapshot(root: string): string {
  const hash = createHash('sha256');
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else { hash.update(path.relative(root, filename)); hash.update(fs.readFileSync(filename)); }
    }
  };
  visit(root);
  return hash.digest('hex');
}

const piModel = {
  id: 'onboarding-test-model', name: 'onboarding-test-model', api: 'openai-completions', provider: 'test',
  baseUrl: 'http://test.invalid', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<Api>;

function onboardingStream(): StreamFn {
  return () => {
    const message: AssistantMessage = {
      role: 'assistant', api: 'openai-completions', provider: 'test', model: piModel.id, stopReason: 'toolUse', timestamp: Date.now(),
      content: [{
        type: 'toolCall', id: 'submit-onboarding', name: 'submit_onboarding_findings',
        arguments: { selected_symbol: 'vector_add', build_kind: 'make', observations: ['Selected only repository-observed evidence.'] },
      }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'toolUse', message });
      stream.end();
    });
    return stream;
  };
}

test('read-only investigation discovers build alternatives, public functions, tests and benchmarks', (context) => {
  const { repository } = temporaryRoot(context);
  const before = snapshot(repository);
  const inspector = new RepositoryInspector(repository);
  const inspection = inspector.inspect();
  assert.deepEqual(inspection.build_candidates.map((item) => [item.kind, item.status]), [['make', 'DISCOVERED'], ['cmake', 'DISCOVERED']]);
  assert.equal(inspection.functions.find((item) => item.symbol === 'vector_add')?.public_api, 'vector_add');
  assert.deepEqual(inspection.functions.find((item) => item.symbol === 'vector_add')?.implementation_files, ['src/vector_add.c']);
  assert.ok(inspection.public_headers.includes('include/vector_add.h'));
  assert.ok(inspection.tests.includes('tests/test_vector_add.c'));
  assert.ok(inspection.benchmarks.includes('benchmarks/bench_vector_add.c'));
  assert.ok(inspection.inspected_files.some((item) => item.path === 'Makefile' && /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.equal(snapshot(repository), before);
});

test('onboarding tools cannot write, escape, or nominate unsupported evidence', async (context) => {
  const { repository } = temporaryRoot(context);
  const before = snapshot(repository);
  const inspector = new RepositoryInspector(repository);
  const inspection = inspector.inspect();
  const tools = new OnboardingToolset(inspector, inspection).asAgentTools();
  assert.deepEqual(tools.map((item) => item.name).sort(), [
    'inspect_benchmarks', 'inspect_build_system', 'inspect_git', 'inspect_public_api', 'inspect_tests', 'list_files', 'read_file', 'search_code', 'submit_onboarding_findings',
  ]);
  const read = tools.find((item) => item.name === 'read_file')!;
  await assert.rejects(() => read.execute('read', { path: '../outside' }, new AbortController().signal), /indexed regular file/);
  const api = tools.find((item) => item.name === 'inspect_public_api')!;
  const apiPage = await api.execute('api', { query: 'vector', limit: 1 }, new AbortController().signal);
  const apiPayload = JSON.parse((apiPage.content[0] as { text: string }).text) as { functions: { total: number; matched: number; items: unknown[] } };
  assert.ok(apiPayload.functions.total >= 1);
  assert.equal(apiPayload.functions.matched, 1);
  assert.equal(apiPayload.functions.items.length, 1);
  inspection.functions[0].implementation_files = Array.from({ length: 50 }, (_, index) => `src/implementation-${index}.c`);
  const boundedApi = await api.execute('api', { limit: 1 }, new AbortController().signal);
  const boundedPayload = JSON.parse((boundedApi.content[0] as { text: string }).text) as { functions: { items: Array<{ implementation_count: number; implementation_files: string[] }> } };
  assert.equal(boundedPayload.functions.items[0].implementation_count, 50);
  assert.equal(boundedPayload.functions.items[0].implementation_files.length, 20);
  const submit = tools.find((item) => item.name === 'submit_onboarding_findings')!;
  await assert.rejects(() => submit.execute('submit', { selected_symbol: 'invented', build_kind: 'make', observations: [] }, new AbortController().signal), /no public API evidence/);
  assert.equal(snapshot(repository), before);
});

test('fixture becomes a valid unqualified package and unexecutable evaluator draft without touching source or runtime', async (context) => {
  const paths = temporaryRoot(context);
  const before = snapshot(paths.repository);
  const runtimeBefore = snapshot('src/core') + snapshot('src/workflow') + snapshot('src/runner');
  const draft = await onboardLibraryRepository({
    ...paths, repositoryRoot: paths.repository, packageId: 'onboarded-vector', targetSymbol: 'vector_add',
    runAgent: async (tools) => {
      const build = await tools.find((item) => item.name === 'inspect_build_system')!.execute('build', {}, new AbortController().signal);
      assert.match(JSON.stringify(build), /cmake/);
      const api = await tools.find((item) => item.name === 'inspect_public_api')!.execute('api', {}, new AbortController().signal);
      assert.match(JSON.stringify(api), /vector_add/);
      return { selected_symbol: 'vector_add', build_kind: 'make', observations: ['Header and source agree on vector_add.'] };
    },
  });
  assert.equal(snapshot(paths.repository), before);
  assert.equal(snapshot('src/core') + snapshot('src/workflow') + snapshot('src/runner'), runtimeBefore);
  const loader = new LibraryPackageLoader({ packagesRoot: paths.packagesRoot, evaluatorsRoot: paths.evaluatorsRoot });
  const loaded = loader.loadPackage('onboarded-vector', '0.1.0');
  assert.equal(loaded.manifest.qualification.state, 'DRAFT');
  assert.equal(loader.resolveBuildDefinition(loaded, 'vector-add').executable, 'make');
  assert.deepEqual(loader.resolveCandidateScope(loaded, 'vector-add').include, ['src/vector_add.c']);
  assert.equal(loader.resolveSelection({ package_id: 'onboarded-vector', package_version: '0.1.0', target_id: 'vector-add' }).bundle.qualification.status, 'DRAFT');
  assert.throws(() => loader.resolveSelection({ package_id: 'onboarded-vector', package_version: '0.1.0', target_id: 'vector-add' }, { requireQualified: true }), /requires QUALIFIED evaluator/);
  assert.equal(loadFormalEvaluatorBundle(draft.evaluatorPath).qualification.status, 'DRAFT');
  assert.equal(draft.evidence.agent.runtime, 'pi-agent-core');
  assert.equal(draft.evidence.human_decisions.every((item) => item.status === 'PENDING'), true);
  assert.ok(draft.evidence.unknowns.some((item) => item.includes('oracle')));
  assert.ok(draft.evidence.test_evidence.every((item) => item.status === 'DISCOVERED_TEST'));
  assert.ok(draft.evidence.benchmark_evidence.every((item) => item.status === 'DISCOVERED'));
  assert.equal(fs.existsSync(path.join(paths.repository, 'packages')), false);
});

test('configured onboarding runs through the existing Pi Agent loop with read-only tools', async (context) => {
  const paths = temporaryRoot(context);
  const before = snapshot(paths.repository);
  const draft = await onboardLibraryRepository({
    ...paths, repositoryRoot: paths.repository, packageId: 'pi-vector', targetSymbol: 'vector_add',
    pi: { model: piModel, streamFn: onboardingStream() },
  });
  assert.equal(draft.evidence.agent.runtime, 'pi-agent-core');
  assert.equal(draft.evidence.agent.model_id, 'onboarding-test-model');
  assert.deepEqual(draft.evidence.agent.observations, ['Selected only repository-observed evidence.']);
  assert.deepEqual(draft.evidence.candidate_scope_proposal.include, ['src/vector_add.c']);
  assert.equal(snapshot(paths.repository), before);
});

test('missing benchmark and oracle stay unknown and output cannot be placed in source', async (context) => {
  const paths = temporaryRoot(context);
  fs.unlinkSync(path.join(paths.repository, 'benchmarks/bench_vector_add.c'));
  const draft = await onboardLibraryRepository({ ...paths, repositoryRoot: paths.repository, packageId: 'no-benchmark' });
  assert.deepEqual(draft.evidence.benchmark_evidence, []);
  assert.ok(draft.evidence.unknowns.some((item) => item.includes('benchmark')));
  assert.ok(draft.evidence.unknowns.some((item) => item.includes('oracle')));
  await assert.rejects(() => onboardLibraryRepository({
    repositoryRoot: paths.repository, packagesRoot: path.join(paths.repository, 'packages'),
    evaluatorsRoot: path.join(paths.repository, 'evaluators'), packageId: 'unsafe',
  }), /must not be inside the source repository/);
  assert.equal(fs.existsSync(path.join(paths.repository, 'packages')), false);
});

test('package init CLI writes reviewable draft to the chosen catalog and stops', async (context) => {
  const paths = temporaryRoot(context);
  const output: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => { output.push(values.join(' ')); };
  try {
    assert.equal(await runCli(['package', 'init', paths.repository, '--id', 'cli-vector', '--target', 'vector_add', '--output-root', path.join(paths.root, 'catalog')]), 0);
  } finally { console.log = original; }
  const review = JSON.parse(output.join('\n')) as { qualification: { package: string; evaluator: string }; known_unknowns: string[] };
  assert.deepEqual(review.qualification, { package: 'DRAFT', evaluator: 'DRAFT' });
  assert.ok(review.known_unknowns.some((item) => item.includes('oracle')));
  assert.ok(fs.existsSync(path.join(paths.packagesRoot, 'cli-vector/0.1.0/package.json')));
});

test('SGEMV formal evaluator identity and qualification remain unchanged', () => {
  const loader = new LibraryPackageLoader();
  const loaded = loader.loadPackage('ftblas', '1.0.0');
  const evaluator = loader.resolveEvaluator(loaded, 'sgemv-n', '1.0.0', { requireQualified: true });
  assert.equal(evaluator.content_digest, 'e1d2effa606f2ef4f028a490ffef8dc7a9b2968fc15128250a281a2539c8ae58');
  assert.equal(evaluator.qualification_digest, '06c50b60eb7de07861c39c87b4ab46030b881a9b2dcea352293df4c6a5656eab');
});
