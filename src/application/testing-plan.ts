import fs from 'node:fs';
import path from 'node:path';
import type { TestingPlanPreview, TestingPlanRef } from '../contracts/testing.js';
import { LibraryPackageLoader } from '../library-package/loader.js';
import { displayBuildCommand } from '../config/build-command.js';
import { readValidationTestPlan } from '../evaluator/validation-test-plan.js';

export type ResolvedTestingPlan = ReturnType<LibraryPackageLoader['resolveSelection']>;
export function previewTestingPlan(catalog: LibraryPackageLoader, ref: TestingPlanRef): { resolved: ResolvedTestingPlan; preview: TestingPlanPreview } {
  const resolved = catalog.resolveSelection(ref);
  const { bundle } = resolved;
  const issues: string[] = [];
  const available = (relative: string) => {
    const filename = path.join(bundle.root, relative);
    if (!fs.existsSync(filename)) { issues.push(`缺少测试文件：${relative}`); return false; }
    const source = fs.readFileSync(filename, 'utf8');
    if (!source.trim() || /DRAFT evaluator is not executable|COREPILOT_TODO|REVIEW_REQUIRED|NO_TRUSTED_ORACLE/.test(source)) {
      issues.push(`测试代码尚待完成：${relative}`); return false;
    }
    return true;
  };
  const setup = available('scripts/build-evaluator.sh');
  const correctness = available(bundle.manifest.correctness.command.script);
  const performance = available(bundle.manifest.performance.command.script);
  const preview: TestingPlanPreview = { ref: structuredClone(ref), function_name: resolved.functionDefinition.api,
    package_digest: resolved.loaded.content_digest,
    evaluator: { id: bundle.manifest.evaluator_id, version: bundle.manifest.version, digest: bundle.content_digest, qualification: bundle.qualification.status },
    build: { command: displayBuildCommand(resolved.build), cwd: resolved.build.cwd, artifact: resolved.target.artifacts.candidate.relative_path },
    code: { setup, correctness, performance, issues }, test_plan: readValidationTestPlan(bundle.root, bundle.manifest),
    correctness: { definition: bundle.manifest.correctness.definition,
      reference: { implementation: bundle.manifest.correctness.reference.implementation, accumulation: bundle.manifest.correctness.reference.accumulation },
      tolerance: { rule: bundle.manifest.correctness.tolerance.rule, absolute: bundle.manifest.correctness.tolerance.absolute,
        relative: bundle.manifest.correctness.tolerance.relative } },
    cases: structuredClone(bundle.correctness.cases), workloads: structuredClone(bundle.workloads.workloads),
    note: '测试代码可用性仅表示文件已准备；执行、正确性及性能分别由本次目标机运行结果确认。独立测试不产生优化审批或交付。' };
  return { resolved, preview };
}
