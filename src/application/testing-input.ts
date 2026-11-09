import { createHash } from 'node:crypto';
import type { CreateTestingTask, TestingSubject } from '../contracts/testing.js';
import { ApiError } from '../core/api-error.js';

function invalid(message: string): never { throw new ApiError(400, 'INVALID_TESTING_INPUT', message); }
function relative(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /^(?:\/|\\|[A-Za-z]:)/.test(value) || value.includes('\0') || value.split(/[\\/]/).includes('..')) invalid(`${label}应为源码内相对路径。`);
  return value.replaceAll('\\', '/');
}
function subject(value: unknown): TestingSubject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请选择需要测试的源码或库文件。');
  const input = value as Record<string, unknown>;
  if (input.kind === 'binary') {
    if (typeof input.asset_id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.asset_id)) invalid('请选择已上传并固定的库文件。');
    return { kind: 'binary', asset_id: input.asset_id };
  }
  if (input.kind !== 'source' || typeof input.project_id !== 'string' || !input.project_id || typeof input.branch !== 'string' || !input.branch.trim() || input.branch.includes('\0')) invalid('请选择源码项目及分支。');
  if (input.commit !== undefined && (typeof input.commit !== 'string' || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(input.commit))) invalid('指定源码版本需要完整的 Git commit。');
  let build: Extract<TestingSubject, { kind: 'source' }>['build'];
  if (input.build !== undefined) {
    if (!input.build || typeof input.build !== 'object' || Array.isArray(input.build)) invalid('构建配置无效。');
    const source = input.build as Record<string, unknown>;
    if (typeof source.command !== 'string' || !source.command.trim() || source.command.length > 32000) invalid('请填写构建命令，最多 32000 字符。');
    build = { command: source.command, ...(source.cwd === undefined ? {} : { cwd: relative(source.cwd, '构建目录') }) };
  }
  return { kind: 'source', project_id: input.project_id, branch: input.branch.trim(),
    ...(input.commit === undefined ? {} : { commit: (input.commit as string).toLowerCase() }),
    ...(build ? { build } : {}), ...(input.artifact === undefined ? {} : { artifact: relative(input.artifact, '产物路径') }) };
}
export function parseTestingInput(value: unknown): CreateTestingTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请填写测试任务。');
  const input = value as Record<string, unknown>;
  if (typeof input.machine_id !== 'string' || !input.machine_id) invalid('请选择执行机器。');
  if (!['correctness', 'performance', 'both'].includes(String(input.mode))) invalid('请选择正确性、性能或两者都测。');
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 160)) invalid('测试名称最多 160 字。');
  const plan = input.plan as Record<string, unknown> | null;
  if (!plan || ['package_id', 'package_version', 'target_id'].some(key => typeof plan[key] !== 'string' || !plan[key])) invalid('请选择已有测试方案。');
  if (input.mode !== 'correctness' && input.baseline === undefined) invalid('两库性能对比需要同时选择被测库和比较库。');
  for (const key of ['expected_evaluator_digest', 'expected_package_digest']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !/^[a-f0-9]{64}$/.test(input[key] as string))) invalid('测试方案版本无效，请重新读取。');
  }
  return { ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}), machine_id: input.machine_id,
    mode: input.mode as CreateTestingTask['mode'], plan: { package_id: plan.package_id as string, package_version: plan.package_version as string, target_id: plan.target_id as string },
    candidate: subject(input.candidate), ...(input.baseline === undefined ? {} : { baseline: subject(input.baseline) }),
    ...(input.expected_evaluator_digest === undefined ? {} : { expected_evaluator_digest: input.expected_evaluator_digest as string }),
    ...(input.expected_package_digest === undefined ? {} : { expected_package_digest: input.expected_package_digest as string }) };
}
export function testingRequestDigest(input: CreateTestingTask): string { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
