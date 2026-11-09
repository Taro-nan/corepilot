import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadFormalEvaluatorBundle } from '../src/evaluator/formal-evaluator.js';
import { assertGeneratedHarnessApis, assertGeneratedHarnessResolution } from '../src/evaluator/generated-harness-compatibility.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';

test('generated adapter requires role-specific exported APIs but custom evaluators are unaffected', () => {
  const temp = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'corepilot-generated-api-'));
  assert.ok(path.resolve(root).startsWith(temp + path.sep));
  try {
    createFormalEvaluatorFixture(root);
    const bundle = loadFormalEvaluatorBundle(root);
    assert.doesNotThrow(() => assertGeneratedHarnessApis(bundle, { correctness: true, performance: true, baseline: true }));
    const support = path.join(root, 'support'); fs.mkdirSync(support);
    for (const kind of ['correctness', 'performance'] as const) {
      fs.appendFileSync(path.join(root, 'scripts', `run-${kind}.sh`), `\n// support/test-${kind}.py\n`);
      fs.writeFileSync(path.join(support, `test-${kind}.py`), 'from corepilot_test import TestContext\n');
    }
    fs.writeFileSync(path.join(support, 'corepilot_test.py'), 'class TestContext:\n  pass\n');
    const options = { correctness: true, performance: true, baseline: true };
    assert.throws(() => assertGeneratedHarnessApis(bundle, options), /先保存测试方案/);
    const plan = { schema_version: 1, resources: { cpu_set: '0', numa_node: 0 }, sampling: { warmup_count: 0, sample_count: 1, order: 'paired' },
      seed: 0, inner_iterations: 1, timing_scope: 'kernel', candidate_api: '', baseline_api: '' };
    const filename = path.join(root, 'test-plan.json');
    const save = () => fs.writeFileSync(filename, JSON.stringify(plan));
    save();
    assert.throws(() => assertGeneratedHarnessApis(bundle, options), /候选库实际导出的测试 API/);
    plan.candidate_api = 'candidate_wrapper'; save();
    assert.doesNotThrow(() => assertGeneratedHarnessApis(bundle, { ...options, baseline: false }));
    assert.throws(() => assertGeneratedHarnessApis(bundle, options), /比较基线库实际导出的测试 API/);
    plan.baseline_api = 'baseline_wrapper'; save();
    assert.doesNotThrow(() => assertGeneratedHarnessApis(bundle, options));
    fs.writeFileSync(path.join(support, 'corepilot_test.py'), 'class TestContext:\n def emit(self):\n  return {"input_path": self.artifact_path, "resolved_symbol_path": self.artifact_path}\n');
    assert.throws(() => assertGeneratedHarnessResolution(bundle), /重新生成测试脚本/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
