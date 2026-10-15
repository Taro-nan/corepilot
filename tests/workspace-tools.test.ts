import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceToolset } from '../src/agent/workspace-tools.js';

test('search_code uses ripgrep semantics for fixed and regex searches while excluding protected trees', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-rg-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'kernel.c'), 'int sgemv_n(void) { return 0; }\nconst char *literal = "a+b";\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored.c'), 'int sgemv_hidden(void);\n');
  const tools = new WorkspaceToolset(root);
  const signal = new AbortController().signal;

  const fixed = await tools.execute('search_code', { query: 'a+b', regex: false }, signal);
  assert.equal(fixed.isError, false);
  assert.deepEqual(JSON.parse(fixed.text).hits, [{ path: 'src/kernel.c', line: 2, text: 'const char *literal = "a+b";' }]);

  const regex = await tools.execute('search_code', { query: 'sgemv_\\w+', regex: true }, signal);
  assert.equal(regex.isError, false);
  assert.deepEqual(JSON.parse(regex.text).hits, [{ path: 'src/kernel.c', line: 1, text: 'int sgemv_n(void) { return 0; }' }]);
});

test('search_code stops ripgrep at the 500-result contract limit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-rg-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'many.c'), Array.from({ length: 600 }, (_, index) => `needle_${index}`).join('\n'));

  const tools = new WorkspaceToolset(root);
  const output = await tools.execute('search_code', { query: 'needle_', regex: false }, new AbortController().signal);
  assert.equal(output.isError, false);
  const parsed = JSON.parse(output.text) as { hits: unknown[]; truncated: boolean };
  assert.equal(parsed.hits.length, 500);
  assert.equal(parsed.truncated, true);
});

test('development execution tools are exposed only when their callbacks are configured', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-workspace-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const readOnlyNames = new WorkspaceToolset(root).asAgentTools().map((tool) => tool.name);
  assert.equal(readOnlyNames.includes('run_build'), false);
  assert.equal(readOnlyNames.includes('run_correctness'), false);
  assert.equal(readOnlyNames.includes('run_performance'), false);

  const configuredNames = new WorkspaceToolset(root, {
    runBuild: async () => ({ isError: false, text: 'ok' }),
    runCorrectness: async () => ({ isError: false, text: 'ok' }),
    runPerformance: async () => ({ isError: false, text: 'ok' }),
  }).asAgentTools().map((tool) => tool.name);
  assert.equal(configuredNames.includes('run_build'), true);
  assert.equal(configuredNames.includes('run_correctness'), true);
  assert.equal(configuredNames.includes('run_performance'), true);
});

test('target investigation tools are opt-in and source mutation requires structured findings', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-investigation-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'kernel.c'), 'old\n');
  const callback = async () => ({ isError: false, text: '{"classification":"DEVELOPMENT_ONLY"}' });
  const tools = new WorkspaceToolset(root, {
    inspectMachine: callback,
    inspectBinary: callback,
    disassemble: callback,
    runDevBenchmark: callback,
    profilePerfStat: callback,
    requireDevelopmentFindingsBeforeMutation: true,
  });
  const names = tools.asAgentTools().map((tool) => tool.name);
  for (const name of ['inspect_machine', 'inspect_binary', 'disassemble', 'run_dev_benchmark', 'profile_perf_stat', 'record_development_findings']) {
    assert.equal(names.includes(name), true, `${name} is exposed`);
  }
  const signal = new AbortController().signal;
  const premature = await tools.execute('replace_text', { path: 'kernel.c', old_text: 'old', new_text: 'new' }, signal);
  assert.equal(premature.isError, true);
  assert.match(premature.text, /record_development_findings/);

  const noChange = await tools.execute('record_development_findings', {
    observations: ['No target evidence supports a mutation.'],
    suspected_bottleneck: 'unknown',
    supporting_measurements: [],
    chosen_transformation: null,
    rejected_alternatives: ['speculative rewrite'],
  }, signal);
  assert.equal(noChange.isError, false);
  const noChangeAgentTool = tools.asAgentTools().find((tool) => tool.name === 'record_development_findings');
  const noChangeTermination = await noChangeAgentTool?.execute('findings-stop', {
    observations: ['No target evidence supports a mutation.'],
    suspected_bottleneck: 'unknown',
    supporting_measurements: [],
    chosen_transformation: null,
    rejected_alternatives: ['speculative rewrite'],
  }, signal);
  assert.equal(noChangeTermination?.terminate, true);
  const unjustified = await tools.execute('replace_text', { path: 'kernel.c', old_text: 'old', new_text: 'new' }, signal);
  assert.equal(unjustified.isError, true);
  assert.match(unjustified.text, /do not justify/);

  await tools.execute('record_development_findings', {
    observations: ['perf stat shows higher branch misses in the Candidate.'],
    suspected_bottleneck: 'dispatch branch overhead',
    supporting_measurements: [{
      tool: 'profile_perf_stat',
      subject_id: 'wide_1024x16384_t1',
      summary: 'Candidate branch misses exceed Baseline.',
      experiment_id: 'development:test',
    }],
    chosen_transformation: 'remove one redundant dispatch branch',
    rejected_alternatives: ['change Formal tolerance'],
  }, signal);
  const changed = await tools.execute('replace_text', { path: 'kernel.c', old_text: 'old', new_text: 'new' }, signal);
  assert.equal(changed.isError, false);
  assert.equal(fs.readFileSync(path.join(root, 'kernel.c'), 'utf8'), 'new\n');
  assert.equal(tools.developmentFindings()?.classification, 'DEVELOPMENT_ONLY');

  tools.beginInvestigationRound();
  assert.equal(tools.developmentFindings(), null);
});
