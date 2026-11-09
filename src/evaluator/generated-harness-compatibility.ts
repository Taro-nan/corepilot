import fs from 'node:fs';
import path from 'node:path';
import type { LoadedFormalEvaluatorBundle } from '../contracts/formal-evaluator.js';
import { readValidationTestPlan } from './validation-test-plan.js';

function read(bundle: LoadedFormalEvaluatorBundle, relative: string): string {
  try { return fs.readFileSync(path.join(bundle.root, ...relative.split('/')), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Identify the platform-generated entrypoints without imposing their contract on custom evaluators. */
export function generatedHarnessUsage(bundle: LoadedFormalEvaluatorBundle): { correctness: boolean; performance: boolean } {
  const uses = (kind: 'correctness' | 'performance') => read(bundle, bundle.manifest[kind].command.script).includes(`support/test-${kind}.py`)
    && /(?:from|import)\s+corepilot_test\b/.test(read(bundle, `support/test-${kind}.py`));
  return { correctness: uses('correctness'), performance: uses('performance') };
}

/** Detect the previously generated adapter that reported its input path as an observed symbol path. */
export function assertGeneratedHarnessResolution(bundle: LoadedFormalEvaluatorBundle): void {
  const harness = read(bundle, 'support/corepilot_test.py');
  if (!harness.includes('class TestContext:') ||
      !/["']input_path["']\s*:\s*self\.artifact_path\s*,\s*["']resolved_symbol_path["']\s*:\s*self\.artifact_path/.test(harness)) return;
  const uses = generatedHarnessUsage(bundle);
  if (uses.correctness || uses.performance) {
    throw new Error('测试方案使用旧版生成适配器，它把输入库路径误记为符号解析结果。请重新生成测试脚本、审阅并重新取得测试方案资格，再执行新的实验；历史记录保持不变。');
  }
}

/** Generated Python resolves the API declared for each role at measurement time. */
export function assertGeneratedHarnessApis(bundle: LoadedFormalEvaluatorBundle, options: { correctness: boolean; performance: boolean; baseline: boolean }): void {
  const uses = generatedHarnessUsage(bundle);
  const correctness = uses.correctness && options.correctness, performance = uses.performance && options.performance;
  if (!correctness && !performance) return;
  if (!fs.existsSync(path.join(bundle.root, 'test-plan.json'))) throw new Error('生成的测试脚本需要已保存的测试条件，请先保存测试方案。');
  const plan = readValidationTestPlan(bundle.root, bundle.manifest);
  if (!plan.candidate_api.trim()) throw new Error('请填写候选库实际导出的测试 API；内部函数可以通过公开包装 API 测试。');
  if (performance && options.baseline && !plan.baseline_api.trim()) throw new Error('请填写比较基线库实际导出的测试 API；内部函数可以通过公开包装 API 测试。');
}
