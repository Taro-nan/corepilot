import type { Experiment, Measurement } from '../contracts/optimization-domain.js';
import type { ValidationCase, ValidationTestpack } from '../contracts/validation-testpack.js';
import { VALIDATION_TESTPACK_SCHEMA_VERSION } from '../contracts/validation-testpack.js';
import { parseStatisticsPolicy } from '../evaluator/performance-statistics.js';
import { validationTestpackDigest } from '../testpack/validation-freeze.js';
import { parametersAreSubset, validationCaseParameters } from '../testpack/validation-parameters.js';
import { inspectVerifiedEvidenceArchive } from '../workspace/frozen-evidence.js';
import { assertPerformanceEvidenceConsistent } from './workflow-evidence-performance.js';

type RecalculationStatus = 'MATCH' | 'MISSING' | 'LEGACY' | 'UNSUPPORTED' | 'INVALID' | 'LIMIT_EXCEEDED' | 'INCONSISTENT';
type RoundResult = { status: RecalculationStatus; message: string; workload_count?: number; weighted_geomean?: number;
  overall_interval?: { lower: number; upper: number } | null; recomputed_sample_digest?: string };
export type EvidenceRecalculation = { status: RecalculationStatus; message: string; formal?: RoundResult; revalidation?: RoundResult };

// Bounds cover both rounds and the alternate v3 sample identity check. Exceeding
// them means only that this offline tool declined the work, not invalid evidence.
const LIMITS = { testpackBytes: 4 * 1024 * 1024, measurementBytes: 32 * 1024 * 1024,
  workloads: 64, samplesPerRole: 1000, sampleRows: 128_000, nodes: 100_000, depth: 64, workUnits: 10_000_000 };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

class CannotRecalculate extends Error {
  constructor(readonly status: Exclude<RecalculationStatus, 'MATCH'>, message: string) { super(message); }
}
const reject = (status: Exclude<RecalculationStatus, 'MATCH'>, message: string): never => { throw new CannotRecalculate(status, message); };

function readJson(files: ReadonlyMap<string, Buffer>, filename: string, maxBytes: number): unknown {
  const bytes = files.get(filename);
  if (!bytes) return reject('MISSING', '归档缺少重算所需文件。');
  if (bytes.length > maxBytes) return reject('LIMIT_EXCEEDED', '归档中的重算输入超过离线大小上限；这不代表证据无效。');
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { return reject('INVALID', '归档中的重算输入不是有效 JSON。'); }
}

function checkStructure(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++visited > LIMITS.nodes || next.depth > LIMITS.depth) reject('LIMIT_EXCEEDED', '冻结方案结构超过离线核验上限；这不代表证据无效。');
    if (typeof next.value === 'number' && !Number.isFinite(next.value)) reject('INVALID', '冻结方案包含无效数值。');
    if (!next.value || typeof next.value !== 'object') continue;
    for (const [key, child] of Object.entries(next.value)) {
      // canonicalValidationTestpack writes into normal objects; prohibit a
      // prototype setter from silently dropping or changing a hashed field.
      if (key === '__proto__') reject('INVALID', '冻结方案包含不安全的字段名。');
      pending.push({ value: child, depth: next.depth + 1 });
    }
  }
}

function validateTestpack(value: unknown, task: Record<string, unknown>, evidence: Record<string, unknown>): ValidationTestpack {
  if (!object(value) || !object(value.testpack)) return reject('INVALID', '归档中的冻结测试方案无效。');
  if (value.schema_version !== VALIDATION_TESTPACK_SCHEMA_VERSION || value.testpack.schema_version !== VALIDATION_TESTPACK_SCHEMA_VERSION)
    return reject('UNSUPPORTED', '此离线重算不支持该冻结测试方案版本。');
  checkStructure(value.testpack);
  if (!sha256(value.digest) || validationTestpackDigest(value.testpack as unknown as ValidationTestpack) !== value.digest)
    return reject('INVALID', '冻结测试方案摘要不匹配。');
  const testpack = value.testpack, performance = testpack.performance;
  if (!object(performance) || !object(performance.sampling) || !object(performance.thresholds) || !Array.isArray(performance.cases) || !Array.isArray(performance.key_cases))
    return reject('INVALID', '冻结测试方案缺少有效的性能统计输入。');
  if (performance.statistics === undefined) return reject('LEGACY', '历史 v2 方案可能包含外部下界，不能仅凭样本重算为 v3 区间。');
  if (!object(performance.statistics)) return reject('INVALID', '冻结的统计方案无效。');
  if (performance.statistics.method !== 'paired-block-bootstrap-v1') return reject('UNSUPPORTED', '此离线重算不支持归档中的统计方法。');
  let policy: ReturnType<typeof parseStatisticsPolicy>;
  try { policy = parseStatisticsPolicy(performance.statistics); }
  catch { return reject('INVALID', '冻结的统计方案参数无效。'); }
  const cases = performance.cases, samples = performance.sampling.samples;
  if (cases.length > LIMITS.workloads || typeof samples === 'number' && samples > LIMITS.samplesPerRole)
    return reject('LIMIT_EXCEEDED', '负载或采样数量超过离线重算上限；这不代表证据无效。');
  if (!cases.length || !Number.isSafeInteger(samples) || (samples as number) < policy.min_samples ||
      cases.length * (samples as number) * policy.iterations > LIMITS.workUnits)
    return reject(cases.length && Number.isSafeInteger(samples) && (samples as number) >= policy.min_samples ? 'LIMIT_EXCEEDED' : 'INVALID',
      '采样数量无效或重算规模超过离线上限；请核对冻结方案。');
  const ids = new Set<string>();
  for (const row of cases) {
    if (!object(row) || typeof row.case_id !== 'string' || !row.case_id.trim() || row.case_id.length > 256 || ids.has(row.case_id) ||
        !Number.isSafeInteger(row.threads) || (row.threads as number) < 1 || typeof row.critical !== 'boolean' || !positive(row.weight) ||
        (row.parameters !== undefined && (!object(row.parameters) || Object.values(row.parameters).some(item =>
          typeof item !== 'string' && typeof item !== 'boolean' && (typeof item !== 'number' || !Number.isFinite(item))))))
      return reject('INVALID', '冻结方案中的负载、权重、线程或参数无效。');
    ids.add(row.case_id);
  }
  if (!(cases.reduce((sum: number, row) => sum + (row.weight as number), 0) > 0) ||
      !Number.isFinite(cases.reduce((sum: number, row) => sum + (row.weight as number), 0)) ||
      performance.key_cases.some(id => typeof id !== 'string' || !ids.has(id)) || new Set(performance.key_cases).size !== performance.key_cases.length ||
      !nonnegative(performance.thresholds.weighted_geomean_min) || !nonnegative(performance.thresholds.overall_ci_lower_min) ||
      !nonnegative(performance.thresholds.key_case_ci_lower_min) || !positive(performance.thresholds.confidence_level) ||
      performance.thresholds.confidence_level >= 1)
    return reject('INVALID', '冻结方案中的权重、关键负载或验收线无效。');
  const evaluator = testpack.evaluator;
  if (!object(evaluator) || !object(task.evaluator) || !object(evidence.evaluator) || !sha256(evaluator.sha256) ||
      typeof evaluator.id !== 'string' || typeof evaluator.version !== 'string' ||
      [task.evaluator, evidence.evaluator].some(row => row.id !== evaluator.id || row.version !== evaluator.version || row.digest !== evaluator.sha256))
    return reject('INCONSISTENT', '冻结方案、任务和证据中的评价器身份不一致。');
  return testpack as unknown as ValidationTestpack;
}

function recalculateRound(files: ReadonlyMap<string, Buffer>, filename: 'formal' | 'revalidation',
  experiment: Record<string, unknown>, testpack: ValidationTestpack): RoundResult {
  try {
    const rows = readJson(files, `${filename}/measurements.json`, LIMITS.measurementBytes);
    if (!Array.isArray(rows) || rows.length > LIMITS.sampleRows) return reject(Array.isArray(rows) ? 'LIMIT_EXCEEDED' : 'INVALID',
      '测量记录无效或超过离线数量上限。');
    if (!object(experiment.evaluator) || experiment.evaluator.id !== testpack.evaluator!.id ||
        experiment.evaluator.version !== testpack.evaluator!.version || experiment.evaluator.digest !== testpack.evaluator!.sha256 ||
        experiment.status !== 'SUCCEEDED' || experiment.validity !== 'VALID' || !object(experiment.evaluation) || experiment.evaluation.performance !== 'PASSED')
      return reject('INCONSISTENT', '实验保存的状态或评价器身份与归档不一致。');
    const perfRows = rows.filter(row => object(row) && row.kind === 'PERFORMANCE_SAMPLE');
    if (rows.some(row => !object(row)) || perfRows.length !== testpack.performance.cases.length * testpack.performance.sampling.samples * 2)
      return reject('INVALID', '原始性能样本缺失、重复或格式无效。');
    const specs = new Map(testpack.performance.cases.map(row => [row.case_id, row]));
    const chosenPrefix = (filename === 'revalidation' ? ['', 'formal.'] : ['']).find(prefix => perfRows.every(row =>
      typeof row.subject_id === 'string' && row.subject_id.startsWith(prefix) && specs.has(row.subject_id.slice(prefix.length))));
    if (chosenPrefix === undefined) return reject('INVALID', '原始性能样本的负载与冻结方案不一致。');
    for (const row of perfRows) {
      if (typeof row.subject_id !== 'string') return reject('INVALID', '原始性能样本缺少负载身份。');
      const spec = specs.get(row.subject_id.slice(chosenPrefix.length));
      const payload = row.domain_payload;
      const parameters = object(payload) ? payload.parameters : null;
      if (!row.subject_id.startsWith(chosenPrefix) || !spec || row.experiment_id !== experiment.experiment_id ||
          !['BASELINE', 'CANDIDATE'].includes(row.role as string) || !Number.isSafeInteger(row.sample_index) || (row.sample_index as number) < 0 ||
          !positive(row.value) || row.value > Number.MAX_VALUE / 2 || row.unit !== 'seconds' || row.validity !== 'VALID' ||
          !object(row.evaluator) || row.evaluator.id !== experiment.evaluator.id || row.evaluator.version !== experiment.evaluator.version ||
          row.evaluator.digest !== experiment.evaluator.digest || !object(parameters) ||
          Object.values(parameters).some(item => typeof item !== 'string' && typeof item !== 'boolean' && (typeof item !== 'number' || !Number.isFinite(item))))
        return reject('INVALID', '原始性能样本的实验、单位、数值或评价器身份无效。');
      const expected = validationCaseParameters(spec as ValidationCase);
      // Earlier evaluator outputs may omit the redundant threads field; when
      // present it must agree. The other declared parameters are required.
      if (!Object.hasOwn(parameters, 'threads')) delete expected.threads;
      if (!parametersAreSubset(expected, parameters as Record<string, string | number | boolean>))
        return reject('INCONSISTENT', '原始样本参数与冻结测试方案不一致。');
    }
    let gate: ReturnType<typeof assertPerformanceEvidenceConsistent>;
    try { gate = assertPerformanceEvidenceConsistent(experiment as unknown as Experiment, rows as Measurement[], testpack); }
    catch { return reject('INCONSISTENT', '重算结果与本轮归档保存的样本或性能结论不一致。'); }
    return { status: 'MATCH', message: '本轮原始样本按归档中的固定方法重算，与保存的统计结果一致。', workload_count: gate.workloads.length,
      weighted_geomean: gate.weighted_geomean, overall_interval: gate.statistics?.overall_interval ?? null,
      recomputed_sample_digest: gate.statistics?.sample_digest };
  } catch (error) {
    if (error instanceof CannotRecalculate) return { status: error.status, message: error.message };
    return { status: 'INVALID', message: '无法解析本轮归档中的重算输入。' };
  }
}

/** Pure calculation of archived facts. It does not execute or trust archive content. */
export function recalculateEvidenceStatistics(files: ReadonlyMap<string, Buffer>, identity: {
  task: Record<string, unknown>; evidence: Record<string, unknown>; formal: Record<string, unknown>; revalidation: Record<string, unknown>;
}): EvidenceRecalculation {
  try {
    const testpack = validateTestpack(readJson(files, 'testpack.json', LIMITS.testpackBytes), identity.task, identity.evidence);
    const formal = recalculateRound(files, 'formal', identity.formal, testpack);
    const revalidation = recalculateRound(files, 'revalidation', identity.revalidation, testpack);
    const status = formal.status !== 'MATCH' ? formal.status : revalidation.status;
    return { status, message: status === 'MATCH' ? '两轮分别重算一致；这不证明来源、实验真实性、正确性、审批或交付。'
      : '至少一轮未能完成一致性核对；请查看各轮状态。', formal, revalidation };
  } catch (error) {
    if (error instanceof CannotRecalculate) return { status: error.status, message: error.message };
    return { status: 'INVALID', message: '无法解析归档中的冻结方案。' };
  }
}

/** Do not parse or calculate any archived measurements until integrity and identity verification succeeds. */
export function recalculateFrozenEvidenceArchive(archivePath: string, expectedSha256: string) {
  const { summary, selected, records } = inspectVerifiedEvidenceArchive(archivePath, expectedSha256, {}, true);
  const performanceRecalculation = recalculateEvidenceStatistics(selected, records);
  return { ...summary,
    verified: [...summary.verified, ...(performanceRecalculation.status === 'MATCH' ? ['separate numerical consistency of both performance records'] : [])],
    not_verified: [...summary.not_verified.map(item => item === 'statistical conclusions and experiment validity'
      ? 'experiment authenticity, measurement validity and statistical assumptions' : item), 'correctness and evaluator qualification'],
    performance_recalculation: performanceRecalculation };
}
