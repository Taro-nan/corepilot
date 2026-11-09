import path from 'node:path';
import type { Candidate, CommandExecution, Experiment, Measurement } from '../contracts/optimization-domain.js';
import type { LoadedFormalEvaluatorBundle } from '../contracts/formal-evaluator.js';
import type { ExperimentExecutionPlan, FormalExecutionContext } from '../contracts/runner-rpc.js';
import { formalCaseParameters, formalWorkloadParameters } from '../evaluator/formal-arguments.js';
import { measurementPayload } from '../evaluator/measurement-protocol.js';
import { runnerArtifactPathCheckMatches } from '../evaluator/runner-artifact-path-check.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
// runValidationCommand retains at most this many UTF-16 code units and does
// not record whether the output was truncated; a full buffer is ambiguous.
const MAX_RETAINED_STDOUT = 2 * 1024 * 1024;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const equal = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const samePath = (left: unknown, right: unknown) => {
  if (typeof left !== 'string' || !left || typeof right !== 'string' || !right) return false;
  const api = /^[a-z]:[\\/]/i.test(right) || right.includes('\\') ? path.win32 : path.posix;
  return api.resolve(left) === api.resolve(right);
};

/** Verify retained RPC facts against the fixed plan and each command's retained output. */
export function assertMeasurementTrace(input: { candidate: Candidate; experiment: Experiment; rows: readonly Measurement[];
  commands: readonly CommandExecution[]; bundle: LoadedFormalEvaluatorBundle }): void {
  const { candidate, experiment, rows, bundle } = input;
  const fail = (detail: string): never => {
    throw new Error(`${experiment.type} 的测量身份或执行记录无法核验：${detail}。请核对原始 Runner 记录并重新验证；历史证据不会被改写。`);
  };
  const saved = experiment.declared_context.runner_execution_plan;
  if (!object(saved) || !object(saved.candidate) || !object(saved.evaluator) || !Array.isArray(saved.steps)) return fail('缺少原始 RPC 执行计划');
  const plan = saved as unknown as Omit<ExperimentExecutionPlan, 'experiment'>;
  if (!sha(candidate.source.archive_sha256) || plan.candidate?.candidate_id !== candidate.candidate_id || plan.candidate.commit !== candidate.source.commit ||
      plan.candidate.tree !== candidate.source.tree || plan.candidate.source_sha256 !== candidate.source.archive_sha256 ||
      plan.evaluator?.evaluator_id !== experiment.evaluator.id || plan.evaluator.version !== experiment.evaluator.version ||
      plan.evaluator.digest !== experiment.evaluator.digest) return fail('计划中的候选源码或评价器身份不一致');

  const commands = [...input.commands].sort((a, b) => a.sequence - b.sequence);
  if (commands.length !== plan.steps.length) return fail('执行计划与命令记录数量不一致');
  let candidateDigest: string | undefined, baselineDigest: string | undefined;
  const benchmarkDigests = new Map<string, string>();
  let candidateArtifact: FormalExecutionContext['artifact'] | undefined, baselineArtifact: FormalExecutionContext['artifact'] | undefined;
  const visited = new Set<string>();
  const measured = new Map<string, Measurement>();
  const key = (kind: string, role: unknown, subject: unknown, index: unknown) => JSON.stringify([kind, role, subject, index]);
  for (const row of rows) if (row.kind === 'CORRECTNESS_CASE' || row.kind === 'PERFORMANCE_SAMPLE') {
    const id = key(row.kind, row.role, row.subject_id, row.sample_index);
    if (measured.has(id)) return fail(`用例 ${row.subject_id} 的测量记录重复`);
    measured.set(id, row);
  }
  for (const [index, step] of plan.steps.entries()) {
    const command = commands[index];
    if (!step || !step.command || !command || command.sequence !== index || command.experiment_id !== experiment.experiment_id ||
        command.step !== step.step || command.command !== step.command.executable || !equal(command.args, step.command.args) ||
        !samePath(command.cwd, step.command.cwd) || command.exit_code !== 0 || command.timed_out || command.cancelled ||
        command.evaluator?.id !== experiment.evaluator.id || command.evaluator.version !== experiment.evaluator.version ||
        command.evaluator.digest !== experiment.evaluator.digest) return fail(`第 ${index + 1} 条执行命令与计划不一致`);
    const context = step.formal_context;
    if (context && (typeof command.stdout !== 'string' || command.stdout.length >= MAX_RETAINED_STDOUT)) {
      return fail(`第 ${index + 1} 条命令输出达到保留上限或缺失，可能已截断`);
    }
    if (!context || context.phase === 'PERFORMANCE_WARMUP') continue;
    const isCorrectness = context.phase === 'CORRECTNESS_CASE';
    if (!isCorrectness && context.phase !== 'PERFORMANCE_SAMPLE') return fail('存在未知正式测量类型');
    const declared = isCorrectness ? bundle.correctness.cases.find(row => row.case_id === context.subject_id)
      : bundle.workloads.workloads.find(row => row.workload_id === context.subject_id);
    if (!declared || !object(context.resources) || !object(context.artifact) || typeof context.artifact.artifact_id !== 'string' ||
        typeof context.artifact.path !== 'string' || !object(context.parameters) ||
        !equal(context.parameters, isCorrectness ? formalCaseParameters(declared as typeof bundle.correctness.cases[number])
          : formalWorkloadParameters(declared as typeof bundle.workloads.workloads[number])) ||
        context.resources.threads !== declared.threads) return fail(`用例 ${context.subject_id} 的计划参数与评价器不一致`);
    const role = isCorrectness ? 'EVALUATOR' : context.role;
    if (isCorrectness ? context.role !== 'EVALUATOR' || context.iteration_index !== null
      : !['BASELINE', 'CANDIDATE'].includes(context.role) || !Number.isSafeInteger(context.iteration_index) || context.iteration_index! < 0) {
      return fail(`用例 ${context.subject_id} 的测量角色或序号不一致`);
    }
    const row = measured.get(key(isCorrectness ? 'CORRECTNESS_CASE' : 'PERFORMANCE_SAMPLE', role, context.subject_id, context.iteration_index));
    if (!row || visited.has(row.measurement_id)) return fail(`用例 ${context.subject_id} 的测量记录缺失或重复`);
    visited.add(row.measurement_id);
    const prefix = isCorrectness ? bundle.manifest.correctness.command.measurement_prefix : bundle.manifest.performance.command.measurement_prefix;
    const payloads = command.stdout.split(/\r?\n/).map(line => measurementPayload(line, prefix)).filter((line): line is string => line !== null);
    if (payloads.length !== 1) return fail(`用例 ${context.subject_id} 缺少唯一命令原始输出`);
    let output: unknown;
    try { output = JSON.parse(payloads[0]); } catch { return fail(`用例 ${context.subject_id} 的命令输出不是有效 JSON`); }
    if (!object(output) || !object(output.domain_payload) || !object(row.domain_payload)) return fail(`用例 ${context.subject_id} 缺少原始测量内容`);
    for (const field of ['kind', 'role', 'subject_id', 'sample_index', 'value', 'unit', 'validity'] as const) {
      if (output[field] !== row[field]) return fail(`用例 ${context.subject_id} 的测量与命令输出不一致`);
    }
    const recordedPayload = { ...row.domain_payload }, outputPayload = { ...output.domain_payload };
    // The path check is Runner-owned and must never originate in evaluator stdout.
    if (Object.hasOwn(outputPayload, 'runner_artifact_path_check')) return fail(`用例 ${context.subject_id} 的评价程序使用了 Runner 保留字段`);
    delete recordedPayload.runner_artifact_path_check;
    // Runner overwrites these two fields with its own observations after parsing stdout.
    for (const key of ['evaluator_identity', 'resource_policy']) { delete recordedPayload[key]; delete outputPayload[key]; }
    if (!equal(recordedPayload, outputPayload)) return fail(`用例 ${context.subject_id} 的测量内容与命令输出不一致`);
    if (!isCorrectness && row.unit !== 'seconds') return fail(`负载 ${context.subject_id} 的时间单位不是秒`);
    const parameters = row.domain_payload.parameters;
    if (!object(parameters)) return fail(`用例 ${context.subject_id} 缺少输入参数`);
    const actual = { ...parameters }, expected = { ...context.parameters };
    if (Object.hasOwn(actual, 'threads') && actual.threads !== context.resources.threads) return fail(`用例 ${context.subject_id} 的线程数不一致`);
    delete actual.threads; delete expected.threads;
    if (!equal(actual, expected)) return fail(`用例 ${context.subject_id} 的输入参数与固定计划不一致`);
    const identity = row.domain_payload.artifact_identity;
    const apiKey = `resolved_${bundle.manifest.domain.api.replace(/[^A-Za-z0-9_]/g, '_')}_path`;
    const pathFields = object(identity) ? ['resolved_symbol_path', apiKey].filter((key, index, fields) =>
      fields.indexOf(key) === index && Object.hasOwn(identity, key)) : [];
    const checkedFields = object(identity) ? [...(Object.hasOwn(identity, 'input_path') ? ['input_path'] : []), ...pathFields] : [];
    if (!object(identity) || !sha(identity.sha256) || pathFields.length === 0 ||
        checkedFields.some(key => typeof identity[key] !== 'string' || !(identity[key] as string).trim())) {
      return fail(`用例 ${context.subject_id} 缺少库产物身份`);
    }
    const pathCheck = row.domain_payload.runner_artifact_path_check;
    if (pathCheck === undefined) {
      return fail(`用例 ${context.subject_id} 缺少 Runner 库路径核对记录；请升级 Runner 并重新执行正式实验和独立复验`);
    } else if (!runnerArtifactPathCheckMatches(identity, pathCheck, bundle.manifest.domain.api, context.artifact.path)) {
      return fail(`用例 ${context.subject_id} 的 Runner 库路径核对记录无效`);
    }
    const digest = identity.sha256.toLowerCase();
    if (isCorrectness || role === 'CANDIDATE') {
      if (candidateDigest && candidateDigest !== digest || candidateArtifact && !equal(candidateArtifact, context.artifact) ||
          context.artifact.sha256 !== null && (!sha(context.artifact.sha256) || context.artifact.sha256.toLowerCase() !== digest)) return fail('正确性与候选性能样本的库身份不一致');
      candidateDigest = digest; candidateArtifact = context.artifact;
    } else {
      if (!sha(experiment.baseline.digest) || digest !== experiment.baseline.digest.toLowerCase() ||
          !sha(context.artifact.sha256) || context.artifact.sha256.toLowerCase() !== digest || baselineDigest && baselineDigest !== digest ||
          baselineArtifact && !equal(baselineArtifact, context.artifact)) return fail('基线性能样本与冻结基线身份不一致');
      baselineDigest = digest; baselineArtifact = context.artifact;
    }
    const binary = row.domain_payload[isCorrectness ? 'evaluator_binary_identity' : 'benchmark_identity'];
    if (!object(binary) || !sha(binary.sha256)) return fail(`用例 ${context.subject_id} 缺少评价程序自报身份`);
    if (!isCorrectness) {
      const benchmarkDigest = binary.sha256.toLowerCase();
      const previousDigest = benchmarkDigests.get(context.subject_id);
      if (previousDigest && previousDigest !== benchmarkDigest) return fail(`负载 ${context.subject_id} 的两端性能样本评价程序自报身份不一致`);
      benchmarkDigests.set(context.subject_id, benchmarkDigest);
    }
  }
  if (visited.size !== measured.size || !candidateDigest || !baselineDigest || benchmarkDigests.size !== bundle.workloads.workloads.length) fail('未能关联全部正确性和性能测量');
}
