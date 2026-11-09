import fs from 'node:fs';
import type { Candidate, Experiment, Measurement, OptimizationTask } from '../contracts/optimization-domain.js';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';
import type { FrozenValidationTestpack, ValidationCase, ValidationTestpack } from '../contracts/validation-testpack.js';
import { VALIDATION_TESTPACK_SCHEMA_VERSION } from '../contracts/validation-testpack.js';
import { parseStatisticsPolicy, evaluateStatisticalPerformance } from '../evaluator/performance-statistics.js';
import { validationTestpackDigest } from '../testpack/validation-freeze.js';
import { parametersAreSubset, validationCaseParameters } from '../testpack/validation-parameters.js';

type Source = { workflow: OptimizationWorkflowRecord; task: OptimizationTask; candidate: Candidate | null;
  experiment: Experiment; measurements: Measurement[] };
type PlanStatus = 'AVAILABLE' | 'MISSING' | 'MISMATCH' | 'INVALID';
type Plan = { status: PlanStatus; testpack: ValidationTestpack | null };

export const EXPERIMENT_REVIEW_FORMAT = 'COREPILOT_EXPERIMENT_REVIEW_V1';
export const EXPERIMENT_REVIEW_NOTICE = '仅为单次实验的本机事实数值投影。数值、种子和阈值可能敏感，分享前须人工审阅。快照不证明来源、目标机执行、正确性、样本同步完整、批准或交付。';
export const EXPERIMENT_RECALC_NOTICE = '只重算数值，不证明记录来源、测试条件、正确性或审批。';
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const anonymous = (prefix: string, index: number) => `${prefix}${String(index + 1).padStart(3, '0')}`;
const known = <T extends string>(value: unknown, choices: readonly T[]): T | 'UNKNOWN' =>
  typeof value === 'string' && choices.includes(value as T) ? value as T : 'UNKNOWN';

/** Bound both bytes and object depth before hashing untrusted historical files. */
function readBounded(filename: string): Buffer {
  const fd = fs.openSync(filename, 'r');
  let bytes: Buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('invalid file');
    bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw new Error('changed file'); offset += n; }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length)) throw new Error('changed file');
  } finally { fs.closeSync(fd); }
  return bytes;
}

function readFrozenFile(filename: string): FrozenValidationTestpack {
  const before = readBounded(filename), after = readBounded(filename);
  if (!before.equals(after)) throw new Error('changed file');
  const value: unknown = JSON.parse(before.toString('utf8'));
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]; let count = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++count > 100_000 || next.depth > 64) throw new Error('invalid structure');
    if (typeof next.value === 'number' && !Number.isFinite(next.value)) throw new Error('invalid number');
    if (!next.value || typeof next.value !== 'object') continue;
    for (const [key, child] of Object.entries(next.value)) {
      if (key === '__proto__') throw new Error('invalid key');
      pending.push({ value: child, depth: next.depth + 1 });
    }
  }
  return value as FrozenValidationTestpack;
}

function loadPlan(source: Source): Plan {
  const { workflow, task, experiment } = source;
  if (experiment.type !== 'FORMAL_EVALUATION' && experiment.type !== 'REVALIDATION') return { status: 'MISSING', testpack: null };
  if (!workflow.testpack_snapshot_path || !sha(workflow.testpack_digest)) return { status: 'MISSING', testpack: null };
  let frozen: FrozenValidationTestpack;
  try { frozen = readFrozenFile(workflow.testpack_snapshot_path); }
  catch (error) { return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'INVALID', testpack: null }; }
  try {
    if (frozen.schema_version !== VALIDATION_TESTPACK_SCHEMA_VERSION || !frozen.testpack || !sha(frozen.digest) ||
        validationTestpackDigest(frozen.testpack) !== frozen.digest || frozen.digest !== workflow.testpack_digest) return { status: 'MISMATCH', testpack: null };
    const evaluator = frozen.testpack.evaluator;
    if (!evaluator || !task.evaluator || !sha(evaluator.sha256) || !sha(task.evaluator.digest) || !sha(experiment.evaluator.digest) ||
        frozen.testpack.function_name !== task.target.name || frozen.testpack.function_name !== workflow.function_name ||
        [task.evaluator, experiment.evaluator].some(value => value.id !== evaluator.id || value.version !== evaluator.version || value.digest !== evaluator.sha256)) {
      return { status: 'MISMATCH', testpack: null };
    }
    const perf = frozen.testpack.performance;
    if (!perf || !Array.isArray(perf.cases) || perf.cases.length > 64 || !Array.isArray(perf.key_cases) ||
        !perf.sampling || !integer(perf.sampling.warmup) || !integer(perf.sampling.samples) || perf.sampling.samples > 1000 ||
        !integer(perf.sampling.interleave_seed) || !integer(perf.sampling.bootstrap_iterations) || !perf.thresholds ||
        !perf.baselines?.comparison || !sha(perf.baselines.comparison.sha256) ||
        !nonnegative(perf.thresholds.weighted_geomean_min) || !nonnegative(perf.thresholds.overall_ci_lower_min) ||
        !nonnegative(perf.thresholds.key_case_ci_lower_min) || !positive(perf.thresholds.confidence_level) || perf.thresholds.confidence_level >= 1 ||
        !frozen.testpack.correctness || !Array.isArray(frozen.testpack.correctness.cases) || frozen.testpack.correctness.cases.length > 256) return { status: 'INVALID', testpack: null };
    const ids = new Set<string>();
    for (const c of perf.cases) {
      if (!c || typeof c.case_id !== 'string' || !c.case_id || ids.has(c.case_id) || !integer(c.threads) || c.threads < 1 ||
          !positive(c.weight) || typeof c.critical !== 'boolean') return { status: 'INVALID', testpack: null };
      ids.add(c.case_id);
    }
    if (perf.key_cases.some(id => typeof id !== 'string' || !ids.has(id)) || new Set(perf.key_cases).size !== perf.key_cases.length ||
        !Number.isFinite(perf.cases.reduce((sum, c) => sum + c.weight, 0)) ||
        frozen.testpack.correctness.cases.some(c => !c || typeof c.case_id !== 'string' || !c.case_id) ||
        new Set(frozen.testpack.correctness.cases.map(c => c.case_id)).size !== frozen.testpack.correctness.cases.length) return { status: 'INVALID', testpack: null };
    return { status: 'AVAILABLE', testpack: frozen.testpack };
  } catch { return { status: 'INVALID', testpack: null }; }
}

function sameEvaluator(row: Measurement, experiment: Experiment): boolean {
  return row.experiment_id === experiment.experiment_id && !!row.evaluator && row.evaluator.id === experiment.evaluator.id &&
    row.evaluator.version === experiment.evaluator.version && row.evaluator.digest === experiment.evaluator.digest;
}

/** A numeric diagnostic, not a qualification or a frozen approval artifact. */
export function experimentReview(source: Source) {
  const { task, candidate, experiment, measurements } = source;
  const plan = loadPlan(source), testpack = plan.testpack;
  const candidateIdentity = !candidate ? 'MISSING' : candidate.task_id === task.task_id && candidate.candidate_id === experiment.candidate_id ? 'CONSISTENT' : 'MISMATCH';
  const workloadIds = new Map<string, string>(), caseIds = new Map<string, string>();
  const extraWorkloads = new Map<string, string>(), extraCases = new Map<string, string>();
  testpack?.performance.cases.forEach((c, i) => workloadIds.set(c.case_id, anonymous('W', i)));
  testpack?.correctness.cases.forEach((c, i) => caseIds.set(c.case_id, anonymous('C', i)));
  let unknownWorkloads = 0, unknownCases = 0;
  const mapId = (row: Measurement, planned: Map<string, string>, extra: Map<string, string>, kind: 'W' | 'C') => {
    const raw = typeof row.subject_id === 'string' ? row.subject_id : null;
    const direct = raw !== null && planned.has(raw);
    const clean = experiment.type === 'REVALIDATION' && raw?.startsWith('formal.') ? raw.slice(7) : null;
    const prefixed = clean !== null && planned.has(clean);
    if (direct && !prefixed) return { id: planned.get(raw!)!, planned: 'YES', prefix: 'NONE' };
    if (prefixed && !direct) return { id: planned.get(clean!)!, planned: 'YES', prefix: 'FORMAL' };
    let id = raw === null ? undefined : extra.get(raw);
    if (!id) {
      id = anonymous(kind === 'W' ? 'U' : 'V', kind === 'W' ? unknownWorkloads++ : unknownCases++);
      if (raw !== null) extra.set(raw, id);
    }
    // A literal workload name can itself begin with "formal.". When both
    // interpretations exist, neither attribution is a trustworthy fact.
    return { id, planned: direct && prefixed ? 'UNKNOWN' : testpack ? 'NO' : 'UNKNOWN', prefix: 'UNKNOWN' };
  };
  const performance = measurements.filter(row => row.kind === 'PERFORMANCE_SAMPLE').map(row => {
    const subject = mapId(row, workloadIds, extraWorkloads, 'W');
    return { workload: subject.id, planned: subject.planned, prefix: subject.prefix,
      role: known(row.role, ['BASELINE', 'CANDIDATE'] as const),
      sample_index: typeof row.sample_index === 'number' && Number.isFinite(row.sample_index) ? row.sample_index : null,
      sample_index_status: row.sample_index === null ? 'RECORDED_NULL' : typeof row.sample_index === 'number' && Number.isFinite(row.sample_index) ? 'RECORDED_NUMBER' : 'OMITTED_UNSUPPORTED',
      value: typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : null,
      value_status: typeof row.value === 'number' && Number.isFinite(row.value) ? 'RECORDED_NUMBER' : 'UNREPRESENTABLE_OR_NONNUMERIC',
      unit: row.unit === 'seconds' ? 'seconds' : 'UNKNOWN', validity: known(row.validity, ['VALID', 'INVALID'] as const),
      experiment_identity: row.experiment_id === experiment.experiment_id ? 'MATCH' : 'MISMATCH',
      evaluator_identity: sameEvaluator(row, experiment) ? 'MATCH' : 'UNKNOWN_OR_MISMATCH' };
  });
  const correctness = measurements.filter(row => row.kind === 'CORRECTNESS_CASE').map(row => {
    const subject = mapId(row, caseIds, extraCases, 'C');
    const value = row.value === 'PASS' || row.value === 'FAIL' || typeof row.value === 'boolean' ? row.value : null;
    return { case: subject.id, planned: subject.planned, prefix: subject.prefix,
      role: known(row.role, ['EVALUATOR'] as const), sample_index: row.sample_index === null ? null :
        typeof row.sample_index === 'number' && Number.isFinite(row.sample_index) ? row.sample_index : null,
      sample_index_status: row.sample_index === null ? 'RECORDED_NULL' : typeof row.sample_index === 'number' && Number.isFinite(row.sample_index) ? 'RECORDED_NUMBER' : 'OMITTED_UNSUPPORTED',
      value, value_status: value === null ? 'OMITTED_UNSUPPORTED' : 'RECORDED', unit: row.unit === null ? 'NONE' : 'UNKNOWN',
      validity: known(row.validity, ['VALID', 'INVALID'] as const), experiment_identity: row.experiment_id === experiment.experiment_id ? 'MATCH' : 'MISMATCH',
      evaluator_identity: sameEvaluator(row, experiment) ? 'MATCH' : 'UNKNOWN_OR_MISMATCH' };
  });
  if (unknownWorkloads > 256 || unknownCases > 256) throw new Error('实验存在过多不同的未识别输入，无法进行有界诊断导出；原记录未修改。');
  let policy: ReturnType<typeof parseStatisticsPolicy> | null = null;
  try { if (testpack?.performance.statistics) policy = parseStatisticsPolicy(testpack.performance.statistics); } catch { /* Unknown policies are not invented. */ }
  const spec = testpack?.performance;
  const declared = spec ? { sampling: { warmup: spec.sampling.warmup, samples: spec.sampling.samples,
    interleave_seed: spec.sampling.interleave_seed, bootstrap_iterations: spec.sampling.bootstrap_iterations },
    thresholds: { weighted_geomean_min: spec.thresholds.weighted_geomean_min, overall_ci_lower_min: spec.thresholds.overall_ci_lower_min,
      key_case_ci_lower_min: spec.thresholds.key_case_ci_lower_min, confidence_level: spec.thresholds.confidence_level }, statistics: policy,
    workloads: spec.cases.map((c, i) => ({ id: anonymous('W', i), threads: c.threads, weight: c.weight,
      critical: c.critical, key: spec.key_cases.includes(c.case_id) })), correctness_case_count: testpack!.correctness.cases.length } : null;
  const calculation = calculate(testpack, policy, source, performance);
  const evaluation = experiment.evaluation;
  return { format: EXPERIMENT_REVIEW_FORMAT, review: 'REVIEW_REQUIRED', notice: EXPERIMENT_REVIEW_NOTICE,
    consistency: { database: 'SQLITE_READ_TRANSACTION', plan: plan.status, candidate_task_link: candidateIdentity,
      runner_synchronization: 'NOT_PROVEN', source_and_binary: 'NOT_INCLUDED', machine: 'NOT_INCLUDED', correctness_oracle: 'NOT_INCLUDED',
      approval: 'NOT_INCLUDED', delivery: 'NOT_INCLUDED' },
    recorded: { type: known(experiment.type, ['FORMAL_EVALUATION', 'REVALIDATION', 'DEVELOPMENT_FEEDBACK'] as const),
      execution: known(experiment.status, ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const),
      validity: known(experiment.validity, ['VALID', 'INVALID'] as const),
      failure_category: experiment.failure_category === null ? null : known(experiment.failure_category,
        ['BUILD_FAILURE', 'CORRECTNESS_FAILURE', 'PERFORMANCE_REGRESSION', 'PERFORMANCE_TARGET_NOT_MET', 'INFRASTRUCTURE_FAILURE',
          'RESOURCE_UNAVAILABLE', 'EVALUATOR_FAILURE', 'CANCELLED', 'AGENT_FAILURE', 'INVALID_EXPERIMENT'] as const),
      build: evaluation ? known(evaluation.build, ['PASSED', 'FAILED', 'NOT_EXECUTED'] as const) : 'UNKNOWN',
      correctness: evaluation ? known(evaluation.correctness, ['PASSED', 'FAILED', 'INVALID', 'INCOMPLETE', 'NOT_EXECUTED'] as const) : 'UNKNOWN',
      performance: evaluation ? known(evaluation.performance, ['PASSED', 'FAILED', 'INVALID', 'INCONCLUSIVE', 'NOT_EXECUTED'] as const) : 'UNKNOWN' },
    plan: declared, correctness, performance, other_measurement_count: measurements.length - correctness.length - performance.length, calculation };
}

function calculate(testpack: ValidationTestpack | null, policy: ReturnType<typeof parseStatisticsPolicy> | null, source: Source,
  projected: Array<{ workload: string; planned: string; prefix: string; role: string; sample_index: number | null; value: number | null;
    unit: string; validity: string; evaluator_identity: string }>) {
  const unavailable = (reason: string) => ({ status: 'NOT_COMPUTED' as const, reason });
  if (!testpack) return unavailable('PLAN_UNAVAILABLE');
  if (!policy) return unavailable('STATISTICS_POLICY_UNAVAILABLE');
  if (!source.candidate || source.candidate.task_id !== source.task.task_id || source.candidate.candidate_id !== source.experiment.candidate_id) return unavailable('CANDIDATE_IDENTITY_UNAVAILABLE');
  if (!source.candidate.source || !sha(source.candidate.source.archive_sha256) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(source.candidate.source.commit) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(source.candidate.source.tree)) return unavailable('CANDIDATE_SOURCE_UNAVAILABLE');
  if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(source.experiment.status)) return unavailable('EXPERIMENT_NOT_TERMINAL');
  const recordedVerdict = source.experiment.evaluation?.performance;
  if (!['FAILED', 'INCONCLUSIVE'].includes(recordedVerdict ?? '')) return unavailable('RECORDED_PERFORMANCE_NOT_COMPARABLE');
  const p = testpack.performance, samples = p.sampling.samples;
  if (!p.cases.length || samples < policy.min_samples || p.cases.length * samples * policy.iterations > 10_000_000) return unavailable('INSUFFICIENT_OR_OVER_LIMIT');
  const saved = source.experiment.declared_context.runner_execution_plan;
  if (!object(saved) || !object(saved.candidate) || !object(saved.evaluator) || !Array.isArray(saved.steps)) return unavailable('EXECUTION_PLAN_UNAVAILABLE');
  const candidate = source.candidate;
  if (saved.candidate.candidate_id !== candidate.candidate_id || saved.candidate.commit !== candidate.source.commit ||
      saved.candidate.tree !== candidate.source.tree || saved.candidate.source_sha256 !== candidate.source.archive_sha256 ||
      saved.evaluator.evaluator_id !== source.experiment.evaluator.id || saved.evaluator.version !== source.experiment.evaluator.version ||
      saved.evaluator.digest !== source.experiment.evaluator.digest || !sha(source.experiment.baseline.digest) ||
      source.experiment.baseline.digest !== p.baselines.comparison.sha256) return unavailable('EXECUTION_PLAN_MISMATCH');
  const steps = saved.steps.flatMap(step => object(step) && object(step.formal_context) && step.formal_context.phase === 'PERFORMANCE_SAMPLE' ? [step.formal_context] : []);
  if (steps.length !== p.cases.length * samples * 2) return unavailable('EXECUTION_PLAN_MISMATCH');
  const stepKeys = new Set<string>();
  for (const step of steps) {
    const spec = p.cases.find(row => row.case_id === step.subject_id);
    if (!spec || !['BASELINE', 'CANDIDATE'].includes(String(step.role)) || !integer(step.iteration_index) || step.iteration_index >= samples ||
        !object(step.resources) || step.resources.threads !== spec.threads || !object(step.parameters) || !object(step.artifact) ||
        step.role === 'BASELINE' && step.artifact.sha256 !== source.experiment.baseline.digest) return unavailable('EXECUTION_PLAN_MISMATCH');
    const expected = validationCaseParameters(spec);
    if (!Object.hasOwn(step.parameters, 'threads')) delete expected.threads;
    if (!parametersAreSubset(expected, step.parameters as Record<string, string | number | boolean>)) return unavailable('EXECUTION_PLAN_MISMATCH');
    const key = JSON.stringify([step.subject_id, step.role, step.iteration_index]);
    if (stepKeys.has(key)) return unavailable('EXECUTION_PLAN_MISMATCH');
    stepKeys.add(key);
  }
  if (projected.length !== p.cases.length * samples * 2 || projected.some(row => row.planned !== 'YES' || row.unit !== 'seconds' ||
      row.validity !== 'VALID' || row.evaluator_identity !== 'MATCH' || !['BASELINE', 'CANDIDATE'].includes(row.role) ||
      !integer(row.sample_index) || !positive(row.value))) return unavailable('SAMPLES_MISSING_OR_INVALID');
  const prefixes = new Set(projected.map(row => row.prefix));
  if (prefixes.size !== 1 || prefixes.has('UNKNOWN')) return unavailable('SAMPLE_PREFIX_MISMATCH');
  const measurements: Array<{ case_id: string; baseline_samples: number[]; candidate_samples: number[]; sample_indices: { baseline: number[]; candidate: number[] } }> = [];
  const artifacts = new Map<string, string>();
  let benchmarkIdentity: string | null = null;
  for (let i = 0; i < p.cases.length; i++) {
    const c = p.cases[i], id = anonymous('W', i), result: { baseline: number[]; candidate: number[] } = { baseline: [], candidate: [] };
    for (const [role, key] of [['BASELINE', 'baseline'], ['CANDIDATE', 'candidate']] as const) {
      const rows = source.measurements.filter(row => row.kind === 'PERFORMANCE_SAMPLE' && row.role === role &&
        (row.subject_id === c.case_id || source.experiment.type === 'REVALIDATION' && row.subject_id === `formal.${c.case_id}`))
        .sort((a, b) => (a.sample_index ?? -1) - (b.sample_index ?? -1));
      if (rows.length !== samples || rows.some((row, index) => row.sample_index !== index || !sameEvaluator(row, source.experiment) ||
          row.validity !== 'VALID' || row.unit !== 'seconds' || !positive(row.value))) return unavailable('SAMPLES_MISSING_OR_INVALID');
      for (const row of rows) {
        const payload = row.domain_payload, parameters = object(payload) ? payload.parameters : null;
        const artifact = object(payload) && object(payload.artifact_identity) ? payload.artifact_identity.sha256 : null;
        const benchmark = object(payload) && object(payload.benchmark_identity) ? payload.benchmark_identity.sha256 : null;
        if (!object(parameters) || !sha(artifact) || !sha(benchmark)) return unavailable('SAMPLE_CONTEXT_UNAVAILABLE');
        const expected = validationCaseParameters(c as ValidationCase);
        if (!Object.hasOwn(parameters, 'threads')) delete expected.threads;
        if (!parametersAreSubset(expected, parameters as Record<string, string | number | boolean>)) return unavailable('SAMPLE_CONTEXT_MISMATCH');
        if (role === 'BASELINE' && artifact !== source.experiment.baseline.digest ||
            artifacts.has(role) && artifacts.get(role) !== artifact ||
            benchmarkIdentity !== null && benchmarkIdentity !== benchmark) return unavailable('SAMPLE_CONTEXT_MISMATCH');
        artifacts.set(role, artifact); benchmarkIdentity = benchmark;
      }
      result[key] = rows.map(row => row.value as number);
    }
    measurements.push({ case_id: id, baseline_samples: result.baseline, candidate_samples: result.candidate,
      sample_indices: { baseline: result.baseline.map((_, n) => n), candidate: result.candidate.map((_, n) => n) } });
  }
  const cases = p.cases.map((c, i) => ({ case_id: anonymous('W', i), threads: c.threads, weight: c.weight, critical: c.critical }));
  const gate = evaluateStatisticalPerformance({ performance: { sampling: p.sampling, thresholds: p.thresholds, statistics: policy, cases,
    key_cases: p.cases.flatMap((c, i) => p.key_cases.includes(c.case_id) ? [anonymous('W', i)] : []) } }, measurements);
  if (gate.statistics?.verdict === 'INVALID') return unavailable('NUMERICAL_CALCULATION_INVALID');
  if (gate.statistics?.verdict !== recordedVerdict) return unavailable('STATISTICAL_RECORD_MISMATCH');
  const interval = gate.statistics?.overall_interval;
  return { status: 'COMPUTED' as const, notice: EXPERIMENT_RECALC_NOTICE,
    verdict: recordedVerdict, weighted_geomean: Number.isFinite(gate.weighted_geomean) ? gate.weighted_geomean : null,
    overall_interval: interval && Number.isFinite(interval.lower) && Number.isFinite(interval.upper) ? interval : null,
    workloads: gate.workloads.map(row => ({ id: row.case_id, speedup: Number.isFinite(row.speedup) ? row.speedup : null,
      ci_lower: Number.isFinite(row.ci_lower) ? row.ci_lower : null, ci_upper: Number.isFinite(row.ci_upper) ? row.ci_upper : null,
      conclusion: row.conclusion ?? 'UNKNOWN' })) };
}
