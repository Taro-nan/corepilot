import fs from 'node:fs';
import path from 'node:path';
import type { ValidationTestPlan } from '../contracts/validation-assets.js';
import type { FormalEvaluatorManifest } from '../contracts/formal-evaluator.js';
import { expandCpuSet, formatCpuSet } from '../config/cpu-set.js';
import { parseStatisticsPolicy } from './performance-statistics.js';
export { expandCpuSet } from '../config/cpu-set.js';

export const TEST_PLAN_FILE = 'test-plan.json';

export function readValidationTestPlan(root: string, manifest: FormalEvaluatorManifest, api = ''): ValidationTestPlan {
  const filename = path.join(root, TEST_PLAN_FILE);
  if (fs.existsSync(filename)) return parseValidationTestPlan(JSON.parse(fs.readFileSync(filename, 'utf8')));
  return { schema_version: 1,
    resources: { cpu_set: manifest.resource_requirements.cpu_set === 'UNKNOWN_REVIEW_REQUIRED' ? '' : manifest.resource_requirements.cpu_set,
      numa_node: manifest.resource_requirements.numa_node },
    sampling: { warmup_count: manifest.performance.sampling.warmup_count, sample_count: manifest.performance.sampling.sample_count, order: 'paired' },
    seed: 0, inner_iterations: 1, timing_scope: 'kernel', candidate_api: api, baseline_api: api };
}

export function parseValidationTestPlan(value: unknown): ValidationTestPlan {
  const item = value as ValidationTestPlan | null;
  if (!item || item.schema_version !== 1 || !item.resources || !item.sampling) throw new Error('测试条件格式不正确');
  const { cpu_set, numa_node } = item.resources;
  if (typeof cpu_set !== 'string' || (cpu_set !== '' && !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(cpu_set))) throw new Error('CPU 集合请填写如 0 或 0-3,8-11');
  if (cpu_set) expandCpuSet(cpu_set);
  const integer = (n: unknown, min: number, max: number, name: string) => {
    if (!Number.isSafeInteger(n) || (n as number) < min || (n as number) > max) throw new Error(`${name}应为 ${min}..${max} 的整数`);
    return n as number;
  };
  const order = item.sampling.order;
  if (order !== 'paired' && order !== 'alternating') throw new Error('测量顺序不正确');
  if (item.timing_scope !== 'kernel' && item.timing_scope !== 'end-to-end') throw new Error('请选择计时范围');
  if (typeof item.candidate_api !== 'string' || typeof item.baseline_api !== 'string' || item.candidate_api.length > 500 || item.baseline_api.length > 500) throw new Error('请填写两端 API 名称');
  let matrix: ValidationTestPlan['execution_matrix'];
  if (item.execution_matrix !== undefined) {
    const raw = item.execution_matrix;
    if (!raw || !Array.isArray(raw.thread_counts) || !raw.thread_counts.length || raw.thread_counts.length > 16 || new Set(raw.thread_counts).size !== raw.thread_counts.length) throw new Error('请选择 1..16 个不重复的线程数');
    if (!Array.isArray(raw.profiles) || !raw.profiles.length || raw.profiles.length > 8) throw new Error('请配置 1..8 组绑核方案');
    const ids = new Set<string>();
    matrix = { thread_counts: raw.thread_counts.map(n => integer(n, 1, 65536, '线程数')).sort((a, b) => a - b),
      profiles: raw.profiles.map(profile => {
        if (!profile || typeof profile.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(profile.id) || ids.has(profile.id)) throw new Error('运行配置需要唯一 ID');
        ids.add(profile.id);
        if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 120) throw new Error('请填写运行配置名称');
        if (typeof profile.cpu_set !== 'string' || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(profile.cpu_set)) throw new Error('每组运行配置需要明确的 CPU 集合');
        const cpus = expandCpuSet(profile.cpu_set);
        if (Math.max(...raw.thread_counts) > cpus.length) throw new Error(`运行配置“${profile.name}”的 CPU 数不足以运行所选线程数`);
        if (!['per_thread', 'shared'].includes(profile.cpu_allocation) || !['close', 'spread'].includes(profile.omp_proc_bind)) throw new Error('绑核或 OpenMP 放置方式不正确');
        return { id: profile.id, name: profile.name.trim(), cpu_set: formatCpuSet(cpus), numa_node: integer(profile.numa_node, 0, 4095, 'NUMA 节点'),
          cpu_allocation: profile.cpu_allocation, omp_proc_bind: profile.omp_proc_bind };
      }) };
  }
  return { schema_version: 1, resources: { cpu_set, numa_node: integer(numa_node, 0, 4095, 'NUMA 节点') },
    sampling: { warmup_count: integer(item.sampling.warmup_count, 0, 100, '预热次数'),
      sample_count: integer(item.sampling.sample_count, 1, 100, '采样次数'), order },
    seed: integer(item.seed, 0, 2 ** 32 - 1, '随机种子'), inner_iterations: integer(item.inner_iterations, 1, 1_000_000_000, '每样本调用次数'),
    timing_scope: item.timing_scope, candidate_api: item.candidate_api.trim(), baseline_api: item.baseline_api.trim(),
    ...(matrix ? { execution_matrix: matrix } : {}), ...(item.statistics ? { statistics: parseStatisticsPolicy(item.statistics) } : {}) };
}

export function testPlanEnvironment(plan: ValidationTestPlan): Record<string, string> {
  return { COREPILOT_TEST_SEED: String(plan.seed), COREPILOT_INNER_ITERATIONS: String(plan.inner_iterations),
    COREPILOT_TIMING_SCOPE: plan.timing_scope };
}

export function performanceRoles(order: ValidationTestPlan['sampling']['order'], index: number): readonly ['BASELINE', 'CANDIDATE'] | readonly ['CANDIDATE', 'BASELINE'] {
  return order === 'alternating' && index % 2 === 1 ? ['CANDIDATE', 'BASELINE'] : ['BASELINE', 'CANDIDATE'];
}
