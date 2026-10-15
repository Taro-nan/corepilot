import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { PiAgentRuntimeResult } from '../src/agent/pi-agent-runtime.js';
import { loadPublicOptimizationPreflight } from '../src/workflow/public-optimization.js';
import { runPublicAgentWorkflow } from '../src/workflow/public-agent-workflow.js';

function configFile(root: string): string {
  const testpack = path.join(root, 'testpack.yaml').replace(/\\/g, '/');
  fs.writeFileSync(testpack, [
    'schema_version: 1', 'testpack_id: loop', 'function_name: cblas_sgemv', 'function_family: gemv', 'operation: N', 'data_type: float32',
    'resources:', '  cpu_set: "0"', '  numa_nodes: [0]', '  thread_counts: [1]',
    'correctness:', '  command: { executable: node, args: [-e, "process.exit(0)"], cwd: ., environment: {}, timeout_ms: 10000 }',
    '  cases: [{ case_id: c1, m: 1, n: 1, threads: 1, seed: 1, critical: true, weight: 1 }]', '  pass_required: 1',
    'performance:', '  command: { executable: node, args: [-e, "process.exit(0)"], cwd: ., environment: {}, timeout_ms: 10000 }',
    '  cases: [{ case_id: p1, m: 1, n: 1, threads: 1, seed: 2, critical: true, weight: 1 }]',
    '  sampling: { warmup: 0, samples: 1, interleave_seed: 1, bootstrap_iterations: 1 }', '  baselines:',
    '    current: { id: current, library: current, version: "1", sha256: "0000000000000000000000000000000000000000000000000000000000000000", path: /tmp/current }',
    '    comparison: { id: comparison, library: comparison, version: "1", sha256: "1111111111111111111111111111111111111111111111111111111111111111", path: /tmp/comparison }',
    '  thresholds: { weighted_geomean_min: 1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: 0.95 }', '  key_cases: [p1]',
    'revalidation:', '  formal: { required: true, timeout_ms: 10000, command: { executable: node, args: [-e, "process.exit(0)"], cwd: ., environment: {}, timeout_ms: 10000 } }',
    '  independent: { required: true, timeout_ms: 10000, command: { executable: node, args: [-e, "process.exit(0)"], cwd: ., environment: {}, timeout_ms: 10000 } }',
  ].join('\n') + '\n');
  const file = path.join(root, 'phyopt.yaml');
  fs.writeFileSync(file, `model:\n  model_id: kimi-k2.7-code\n  api_key: sk-loop-secret\n  endpoint: https://api.moonshot.cn/v1\n  timeout_ms: 1000\ntarget:\n  ssh_alias: target\n  workspace_root: /tmp/phyopt\nbuild:\n  executable: node\n  args: [-e, \"process.exit(require('node:path').basename(process.cwd()) === 'build-dir' ? 0 : 9)\"]\n  cwd: build-dir\n  environment: {}\n  timeout_ms: 10000\nvalidation:\n  testpack: ${testpack}\noutput_dir: ./.phyopt/runs\n`);
  return file;
}

test('runs build and correctness in the validation tree and stops before approval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-public-loop-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const init = spawnSync('git', ['-C', repo, 'init', '--initial-branch=main'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const args of [['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'PhyOpt Test']]) {
    assert.equal(spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).status, 0);
  }
  fs.writeFileSync(path.join(repo, 'kernel.c'), 'int cblas_sgemv(void) { return 1; }\n');
  fs.mkdirSync(path.join(repo, 'build-dir'));
  fs.writeFileSync(path.join(repo, 'build-dir', '.keep'), '');
  assert.equal(spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['-C', repo, 'commit', '-m', 'baseline'], { encoding: 'utf8' }).status, 0);
  const selectedBaseline = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(repo, 'kernel.c'), 'int cblas_sgemv(void) { return 9; }\n');
  assert.equal(spawnSync('git', ['-C', repo, 'commit', '-am', 'later head'], { encoding: 'utf8' }).status, 0);
  const preflight = loadPublicOptimizationPreflight({ function_name: 'cblas_sgemv', entry_file: 'kernel.c', config_path: configFile(root), repository_root: repo }, { env: {} });
  const calls: string[] = [];
  const result = await runPublicAgentWorkflow({
    preflight, repository: repo, worktreeRoot: path.join(root, 'worktrees'), runId: 'run-1', baselineCommit: selectedBaseline, maxRounds: 1,
    runAgent: async (tools, prompt): Promise<PiAgentRuntimeResult> => {
      calls.push(`${tools.length}:${prompt}`);
      const write = tools.find((tool) => tool.name === 'replace_text');
      await write?.execute('replace-1', { path: 'kernel.c', old_text: 'return 1', new_text: 'return 2' }, new AbortController().signal);
      return { ok: true, text: 'done', hypothesis: 'test hypothesis', development_findings: null, no_source_mutation: false, turns: 1, tool_calls: 1, messages: [], error: null };
    },
  });
  assert.equal(result.status, 'WAITING_APPROVAL');
  assert.equal(result.validation?.build.ok, true);
  assert.equal(result.validation?.correctness.ok, true);
  assert.equal(result.workspace.candidate_commit !== null, true);
  assert.equal(result.workspace.baseline_commit, selectedBaseline);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /入口文件 kernel\.c 已在第一次模型调用前优先读取/);
  assert.match(calls[0], /int cblas_sgemv/);
  assert.match(calls[0], /configured software target cblas_sgemv/);
  assert.match(calls[0], /Do not assume the implementation is assembly, threaded, or BLAS-specific/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('stopping without another mutation after a regression is a normal threshold-not-met result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-public-stop-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  assert.equal(spawnSync('git', ['-C', repo, 'init', '--initial-branch=main'], { encoding: 'utf8' }).status, 0);
  for (const args of [['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'PhyOpt Test']]) {
    assert.equal(spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).status, 0);
  }
  fs.writeFileSync(path.join(repo, 'kernel.c'), 'int cblas_sgemv(void) { return 1; }\n');
  fs.mkdirSync(path.join(repo, 'build-dir'));
  fs.writeFileSync(path.join(repo, 'build-dir', '.keep'), '');
  assert.equal(spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['-C', repo, 'commit', '-m', 'baseline'], { encoding: 'utf8' }).status, 0);
  const preflight = loadPublicOptimizationPreflight({ function_name: 'cblas_sgemv', entry_file: 'kernel.c', config_path: configFile(root), repository_root: repo }, { env: {} });
  let round = 0;
  const result = await runPublicAgentWorkflow({
    preflight,
    repository: repo,
    worktreeRoot: path.join(root, 'worktrees'),
    runId: 'normal-stop',
    maxRounds: 2,
    enablePerformance: true,
    readPerformanceMeasurements: async () => [{ case_id: 'p1', baseline_samples: [1], candidate_samples: [2] }],
    runAgent: async (tools): Promise<PiAgentRuntimeResult> => {
      round += 1;
      if (round === 2) {
        return { ok: false, text: 'No defensible change remains.', hypothesis: 'No defensible change remains.', development_findings: null, no_source_mutation: true, turns: 1, tool_calls: 0, messages: [], error: 'agent completed without applying a source mutation' };
      }
      const write = tools.find((tool) => tool.name === 'replace_text');
      await write?.execute('replace-1', { path: 'kernel.c', old_text: 'return 1', new_text: 'return 2' }, new AbortController().signal);
      return { ok: true, text: 'first attempt', hypothesis: 'first attempt', development_findings: null, no_source_mutation: false, turns: 1, tool_calls: 1, messages: [], error: null };
    },
  });

  assert.equal(result.status, 'PERFORMANCE_THRESHOLD_NOT_MET');
  assert.equal(result.rounds, 1);
  assert.equal(result.performance?.passed, false);
  assert.equal(result.error, null);
  fs.rmSync(root, { recursive: true, force: true });
});
