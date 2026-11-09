import fs from 'node:fs';
import path from 'node:path';
import type { ValidationQualityPlan, ValidationQualityResult } from '../contracts/validation-quality.js';
import type { FormalCaseDefinition } from '../contracts/formal-evaluator.js';
import type { Measurement } from '../contracts/optimization-domain.js';
import type { ExperimentExecutionStep } from '../contracts/runner-rpc.js';

export const QUALITY_PLAN_FILE = 'correctness/quality-plan.json';
export function parseValidationQuality(value: unknown, inputs?: string[]): ValidationQualityPlan {
  const plan = value as ValidationQualityPlan;
  if (!plan || plan.schema_version !== 1 || !Array.isArray(plan.coverage) || plan.coverage.length > 24 || !Array.isArray(plan.probes) || plan.probes.length > 12) throw new Error('测试辨别力方案需要 coverage 和 probes 列表（最多 24 项覆盖、12 个错误实现）');
  const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  const ids = (value: unknown) => Array.isArray(value) && value.length <= 200 && value.every(id => text(id, 200) && (!inputs || inputs.includes(id))) && new Set(value).size === value.length;
  const dimensions = new Set<string>(), probes = new Set<string>();
  for (const row of plan.coverage) {
    if (!text(row.dimension, 200) || dimensions.has(row.dimension) || !text(row.rationale, 3000) || !ids(row.input_ids) || !['COVERED', 'NOT_APPLICABLE', 'UNKNOWN'].includes(row.status)
      || row.status === 'COVERED' && row.input_ids.length === 0) throw new Error('覆盖项需要唯一维度、依据和实际逻辑输入；未覆盖项请标记 UNKNOWN');
    dimensions.add(row.dimension);
  }
  for (const row of plan.probes) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(row.probe_id) || probes.has(row.probe_id) || !text(row.defect, 2000) || !ids(row.input_ids) || !row.input_ids.length
      || !text(row.artifact, 300) || !/^sensitivity\/[A-Za-z0-9_./+-]+$/.test(row.artifact) || row.artifact.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('错误实现需要唯一 ID、缺陷说明、检验输入和 sensitivity/ 下的运行产物相对路径');
    probes.add(row.probe_id);
  }
  return structuredClone(plan);
}
export function readValidationQuality(root: string, cases: FormalCaseDefinition[]): ValidationQualityPlan | undefined {
  const filename = path.join(root, QUALITY_PLAN_FILE);
  return fs.existsSync(filename) ? parseValidationQuality(JSON.parse(fs.readFileSync(filename, 'utf8')), [...new Set(cases.map(row => row.execution?.input_id ?? row.case_id))]) : undefined;
}
export function validationQualityResult(plan: ValidationQualityPlan | undefined, caseIds: Array<{ input_id: string }>, measurements: Measurement[]): ValidationQualityResult {
  const probes = (plan?.probes ?? []).map(probe => {
    const observations = measurements.filter(row => row.kind === 'OBSERVATION' && row.validity === 'VALID' && row.unit === null
      && row.domain_payload.probe_id === probe.probe_id && probe.input_ids.includes(String(row.domain_payload.input_id)) && row.domain_payload.classification === 'TEST_SENSITIVITY');
    return { probe_id: probe.probe_id, defect: probe.defect, detected: observations.some(row => row.value === 'DETECTED'), observations: observations.length,
      detecting_inputs: [...new Set(observations.filter(row => row.value === 'DETECTED').map(row => String(row.domain_payload.input_id)))] };
  });
  return { logical_inputs: new Set(caseIds.map(row => row.input_id)).size, correctness_executions: caseIds.length,
    coverage: plan?.coverage ?? [], status: !probes.length ? 'NOT_CONFIGURED' : probes.every(row => row.detected) ? 'PASSED' : probes.some(row => !row.observations) ? 'PENDING' : 'FAILED',
    probes, unknown_dimensions: (plan?.coverage ?? []).filter(row => row.status === 'UNKNOWN').map(row => row.dimension) };
}

export function qualityProbeSteps(plan: ValidationQualityPlan | undefined, cases: FormalCaseDefinition[], steps: ExperimentExecutionStep[], runtimeRoot: string): ExperimentExecutionStep[] {
  return (plan?.probes ?? []).flatMap(probe => steps.filter(step => step.formal_context?.phase === 'CORRECTNESS_CASE').flatMap(step => {
    const testCase = cases.find(row => row.case_id === step.formal_context!.subject_id)!;
    const inputId = testCase.execution?.input_id ?? testCase.case_id;
    if (!probe.input_ids.includes(inputId)) return [];
    const artifact = path.posix.join(runtimeRoot, probe.artifact);
    const clone = structuredClone(step);
    clone.diagnostic_probe = { probe_id: probe.probe_id, defect: probe.defect, input_id: inputId };
    clone.command.args = clone.command.args.map(value => value === clone.formal_context!.artifact.path ? artifact : value);
    clone.command.environment.COREPILOT_CANDIDATE_ARTIFACT = artifact;
    clone.formal_context!.artifact = { artifact_id: `sensitivity:${probe.probe_id}`, path: artifact, sha256: null };
    return [clone];
  }));
}
