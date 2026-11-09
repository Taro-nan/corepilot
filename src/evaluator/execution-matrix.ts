import type { FormalCaseDefinition, FormalWorkloadDefinition, FormalEvaluatorManifest } from '../contracts/formal-evaluator.js';
import type { ValidationTestPlan } from '../contracts/validation-assets.js';
import { expandCpuSet, formatCpuSet } from '../config/cpu-set.js';

type Entry = FormalCaseDefinition | FormalWorkloadDefinition;

/** Domain inputs remain separate from Runner-owned resource configuration. */
export function validationInputRows<T extends Entry>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.flatMap(entry => {
    if (!entry.execution) return [entry];
    const id = entry.execution.input_id;
    if (seen.has(id)) return [];
    seen.add(id);
    const { execution: _execution, ...rest } = entry;
    return [{ ...rest, ...('case_id' in entry ? { case_id: id } : { workload_id: id }) } as T];
  });
}

export function expandValidationInputs<T extends Entry>(entries: T[], plan: ValidationTestPlan): T[] {
  if (!plan.execution_matrix) return entries;
  const { profiles, thread_counts } = plan.execution_matrix;
  const expanded = entries.flatMap(entry => profiles.flatMap(profile => thread_counts.map(threads => ({ ...entry,
    ...('case_id' in entry ? { case_id: `${entry.case_id}--${profile.id}-t${threads}` } : { workload_id: `${entry.workload_id}--${profile.id}-t${threads}` }),
    threads, execution: { input_id: 'case_id' in entry ? entry.case_id : entry.workload_id, profile_id: profile.id },
  }))));
  if (expanded.length > 200) throw new Error('输入 × 线程 × 运行配置超过 200 组，请减少组合');
  return expanded;
}

export function entryResources(entry: Entry, plan: ValidationTestPlan, manifest: FormalEvaluatorManifest) {
  if (!entry.execution) return { threads: entry.threads, cpu_set: manifest.resource_requirements.cpu_set, numa_node: manifest.resource_requirements.numa_node };
  const profile = plan.execution_matrix?.profiles.find(item => item.id === entry.execution!.profile_id);
  if (!profile || !plan.execution_matrix!.thread_counts.includes(entry.threads)) throw new Error(`运行配置与用例 ${entry.execution.input_id} 不匹配`);
  const pool = expandCpuSet(profile.cpu_set);
  if (entry.threads > pool.length) throw new Error('线程数超过运行配置的 CPU 数');
  return { threads: entry.threads, cpu_set: formatCpuSet(profile.cpu_allocation === 'per_thread' ? pool.slice(0, entry.threads) : pool),
    numa_node: profile.numa_node, omp_proc_bind: profile.omp_proc_bind };
}
