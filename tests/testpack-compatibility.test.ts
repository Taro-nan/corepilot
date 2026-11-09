import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ValidationTestpack } from '../src/contracts/validation-testpack.js';
import { DEFAULT_STATISTICS } from '../src/contracts/performance-statistics.js';
import { evaluatorContentSha256, loadFormalEvaluatorBundle } from '../src/evaluator/formal-evaluator.js';
import { validateFormalTestpackCompatibility } from '../src/evaluator/testpack-compatibility.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';

test('the executed and approved plan must retain the qualified workload weights, critical cases and statistics', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-testpack-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createFormalEvaluatorFixture(root, { sampleCount: 9 });
  fs.writeFileSync(path.join(root, 'test-plan.json'), JSON.stringify({ schema_version: 1,
    resources: { cpu_set: '0', numa_node: 0 }, sampling: { warmup_count: 1, sample_count: 9, order: 'alternating' },
    seed: 0, inner_iterations: 1, timing_scope: 'kernel', candidate_api: 'cblas_sgemv', baseline_api: 'cblas_sgemv', statistics: DEFAULT_STATISTICS }));
  const manifestPath = path.join(root, 'manifest.json'), qualificationPath = path.join(root, 'qualification.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.digest = evaluatorContentSha256(root);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
  qualification.subject_digest = manifest.digest;
  fs.writeFileSync(qualificationPath, JSON.stringify(qualification));
  const bundle = loadFormalEvaluatorBundle(root, { requireQualified: true });
  const valid = { correctness: { cases: [{ case_id: 'case-1', parameters: { n: 1 }, threads: 1 }] },
    performance: { cases: [{ case_id: 'workload-1', parameters: { m: 2, n: 3 }, threads: 1, critical: true, weight: 1 }],
      key_cases: ['workload-1'], sampling: { warmup: 1, samples: 9 }, statistics: { ...DEFAULT_STATISTICS } },
    resources: { cpu_set: '0', numa_nodes: [0], thread_counts: [1] } } as ValidationTestpack;
  assert.doesNotThrow(() => validateFormalTestpackCompatibility(valid, bundle));
  for (const [mutate, reason] of [
    [(plan: ValidationTestpack) => { plan.performance.cases[0].critical = false; }, /critical status/],
    [(plan: ValidationTestpack) => { plan.performance.cases[0].weight = 9; }, /weight/],
    [(plan: ValidationTestpack) => { plan.performance.key_cases = []; }, /critical status/],
    [(plan: ValidationTestpack) => { plan.performance.statistics!.seed = 7; }, /statistical policy/],
    [(plan: ValidationTestpack) => { delete plan.performance.statistics; }, /statistical policy/],
    [(plan: ValidationTestpack) => { plan.performance.sampling.warmup = 2; }, /sampling/],
    [(plan: ValidationTestpack) => { plan.resources.cpu_set = '1'; }, /resource policy/],
  ] as const) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => validateFormalTestpackCompatibility(changed, bundle), reason);
  }
});
