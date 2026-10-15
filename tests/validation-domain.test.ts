import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ValidationCommand, ValidationTestpack } from '../src/contracts/validation-testpack.js';
import { runValidationCycle } from '../src/workspace/validation-runner.js';

function nodeCommand(root: string, script: string): ValidationCommand {
  return { executable: process.execPath, args: ['-e', script], cwd: root, environment: {}, timeout_ms: 10_000 };
}

function testpack(root: string): ValidationTestpack {
  const success = nodeCommand(root, 'process.exit(0)');
  return {
    schema_version: 1,
    testpack_id: 'parameterized-correctness',
    function_name: 'example',
    function_family: 'test',
    operation: 'test',
    data_type: 'test',
    resources: { cpu_set: '0', numa_nodes: [0], thread_counts: [1] },
    correctness: {
      command: nodeCommand(root, "const id=process.argv[1]; console.log(id); process.exit(id === 'case-a' || id === 'case-b' ? 0 : 9)"),
      cases: [
        { case_id: 'case-a', m: 1, n: 1, threads: 1, seed: 1, critical: true, weight: 1, args: ['case-a'] },
        { case_id: 'case-b', m: 2, n: 2, threads: 1, seed: 2, critical: true, weight: 1, args: ['case-b'] },
      ],
      pass_required: 2,
    },
    performance: {
      command: success,
      cases: [{ case_id: 'perf', m: 1, n: 1, threads: 1, seed: 3, critical: true, weight: 1 }],
      sampling: { warmup: 0, samples: 1, interleave_seed: 1, bootstrap_iterations: 1 },
      baselines: {
        current: { id: 'current', library: 'test', version: '1', sha256: '0'.repeat(64), path: root },
        comparison: { id: 'comparison', library: 'test', version: '1', sha256: '1'.repeat(64), path: root },
      },
      thresholds: { weighted_geomean_min: 1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: 0.95 },
      key_cases: ['perf'],
    },
    revalidation: {
      formal: { required: false, timeout_ms: 10_000, command: success },
      independent: { required: false, timeout_ms: 10_000, command: success },
    },
  };
}

test('executes every declared correctness case with its actual arguments', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-correctness-'));
  const pack = testpack(root);
  const result = await runValidationCycle({
    workspace: root,
    testpack: pack,
    build: nodeCommand(root, 'process.exit(0)'),
    sourceRoot: root,
    includePerformance: false,
  });
  assert.equal(result.passed, true);
  assert.equal(result.formal_correctness_complete, true);
  assert.deepEqual(result.correctness_coverage, { planned: 2, executed: 2, passed: 2, failed: 0, complete: true });
  assert.deepEqual(result.correctness_cases.map((item) => item.case_id), ['case-a', 'case-b']);
  assert.deepEqual(result.correctness_cases.map((item) => item.command?.args.at(-1)), ['case-a', 'case-b']);
  assert.match(result.correctness?.stdout ?? '', /case-a/);
  assert.match(result.correctness?.stdout ?? '', /case-b/);
  fs.rmSync(root, { recursive: true, force: true });
});
test('keeps exit-code-only aggregate correctness compatible but marks it incomplete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-correctness-legacy-'));
  const pack = testpack(root);
  pack.correctness.cases = pack.correctness.cases.map(({ args: _args, ...item }) => item);
  pack.correctness.command = nodeCommand(root, 'process.exit(0)');
  const result = await runValidationCycle({ workspace: root, testpack: pack, build: nodeCommand(root, 'process.exit(0)'), sourceRoot: root, includePerformance: false });
  assert.equal(result.passed, true, 'legacy public workflow remains compatible during migration');
  assert.equal(result.formal_correctness_complete, false);
  assert.deepEqual(result.correctness_coverage, { planned: 2, executed: 0, passed: 0, failed: 0, complete: false });
  fs.rmSync(root, { recursive: true, force: true });
});
