import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ValidationCommand } from '../contracts/validation-testpack.js';
import { runValidationCommand, type CommandRunResult } from '../workspace/validation-runner.js';

export type ResourceEnforcementMode = 'DISABLED' | 'REQUIRED';
export type ResourceContextValidity = 'VALID' | 'INVALID' | 'NOT_ENFORCED';

export interface FormalResourceDeclaration {
  cpu_set: string;
  numa_node: number;
  threads: number;
}

export interface FormalResourceContext {
  declared: FormalResourceDeclaration;
  applied: {
    cpu_affinity: { mechanism: 'taskset'; cpu_set: string };
    numa_policy: { mechanism: 'numactl'; policy: 'bind'; cpu_nodes: string; memory_nodes: string };
    thread_configuration: Record<'OMP_NUM_THREADS' | 'OPENBLAS_NUM_THREADS' | 'GOTO_NUM_THREADS', string>;
  } | null;
  observed: {
    cpu_set: string | null;
    child_cpu_set: string | null;
    mems_allowed_list: string | null;
    numa_policy: {
      policy: string | null;
      cpu_nodes: string | null;
      node_bind: string | null;
      memory_nodes: string | null;
    } | null;
    thread_configuration: Record<'OMP_NUM_THREADS' | 'OPENBLAS_NUM_THREADS' | 'GOTO_NUM_THREADS', string | null>;
    max_runtime_threads: number | null;
    runtime_thread_observation: 'OBSERVED' | 'UNKNOWN';
  };
  enforcement: {
    cpu_set: 'ENFORCED' | 'NOT_ENFORCED';
    numa_node: 'ENFORCED' | 'NOT_ENFORCED';
    threads: 'ENFORCED' | 'NOT_ENFORCED';
  };
  validity: ResourceContextValidity;
  errors: string[];
}

export interface FormalResourceCommandResult {
  result: CommandRunResult;
  resourceContext: FormalResourceContext;
}

export type FormalResourceCommandRunner = (
  command: ValidationCommand,
  resources: FormalResourceDeclaration,
  signal?: AbortSignal,
) => Promise<FormalResourceCommandResult>;

const RESOURCE_LAUNCHER = String.raw`set -u
report="$1"
expected_cpu="$2"
expected_node="$3"
expected_threads="$4"
shift 4
cpu_set="$(awk '/^Cpus_allowed_list:/ {print $2}' /proc/self/status 2>/dev/null || true)"
mems_allowed="$(awk '/^Mems_allowed_list:/ {print $2}' /proc/self/status 2>/dev/null || true)"
set +e
numa_show="$(numactl --show 2>&1)"
numa_status=$?
set -e
numa_field() {
  printf '%s\n' "$numa_show" | sed -n "s/^$1:[[:space:]]*//p" | head -n 1
}
policy="$(numa_field policy)"
cpu_nodes="$(numa_field cpubind | tr -d '[:space:]')"
node_bind="$(numa_field nodebind | tr -d '[:space:]')"
memory_nodes="$(numa_field membind | tr -d '[:space:]')"
tmp="$report.tmp.$$"
{
  printf 'cpu_set=%s\n' "$cpu_set"
  printf 'child_cpu_set=%s\n' "$cpu_set"
  printf 'mems_allowed_list=%s\n' "$mems_allowed"
  printf 'numa_show_status=%s\n' "$numa_status"
  printf 'numa_policy=%s\n' "$policy"
  printf 'numa_cpu_nodes=%s\n' "$cpu_nodes"
  printf 'numa_node_bind=%s\n' "$node_bind"
  printf 'numa_memory_nodes=%s\n' "$memory_nodes"
  printf 'omp_num_threads=%s\n' "$OMP_NUM_THREADS"
  printf 'openblas_num_threads=%s\n' "$OPENBLAS_NUM_THREADS"
  printf 'goto_num_threads=%s\n' "$GOTO_NUM_THREADS"
} >"$tmp"
mv -f -- "$tmp" "$report"
resource_error=""
if [[ "$cpu_set" != "$expected_cpu" ]]; then resource_error="cpu affinity mismatch"; fi
if [[ "$numa_status" -ne 0 || "$policy" != "bind" || "$cpu_nodes" != "$expected_node" || "$node_bind" != "$expected_node" || "$memory_nodes" != "$expected_node" ]]; then
  if [[ -n "$resource_error" ]]; then resource_error="$resource_error; NUMA policy mismatch"; else resource_error="NUMA policy mismatch"; fi
fi
if [[ "$OMP_NUM_THREADS" != "$expected_threads" || "$OPENBLAS_NUM_THREADS" != "$expected_threads" || "$GOTO_NUM_THREADS" != "$expected_threads" ]]; then
  if [[ -n "$resource_error" ]]; then resource_error="$resource_error; thread environment mismatch"; else resource_error="thread environment mismatch"; fi
fi
if [[ -n "$resource_error" ]]; then
  printf 'resource_error=%s\n' "$resource_error" >>"$report"
  exit 78
fi
"$@" &
child=$!
terminate_child() {
  kill -TERM "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
  exit 143
}
trap terminate_child TERM INT
max_threads=0
child_cpu_set=""
while kill -0 "$child" 2>/dev/null; do
  current_threads="$(awk '/^Threads:/ {print $2}' "/proc/$child/status" 2>/dev/null || true)"
  current_cpu_set="$(awk '/^Cpus_allowed_list:/ {print $2}' "/proc/$child/status" 2>/dev/null || true)"
  if [[ "$current_threads" =~ ^[0-9]+$ ]] && (( current_threads > max_threads )); then max_threads=$current_threads; fi
  if [[ -n "$current_cpu_set" ]]; then child_cpu_set="$current_cpu_set"; fi
  sleep 0.002
done
set +e
wait "$child"
child_status=$?
set -e
printf 'max_runtime_threads=%s\n' "$max_threads" >>"$report"
if [[ -n "$child_cpu_set" ]]; then printf 'child_cpu_set=%s\n' "$child_cpu_set" >>"$report"; fi
exit "$child_status"`;

export async function runLinuxResourceConstrainedCommand(
  command: ValidationCommand,
  declaration: FormalResourceDeclaration,
  signal?: AbortSignal,
): Promise<FormalResourceCommandResult> {
  const declaredCpuSet = canonicalCpuSet(declaration.cpu_set);
  const errors: string[] = [];
  if (process.platform !== 'linux') errors.push(`resource enforcement requires Linux, observed ${process.platform}`);
  if (declaredCpuSet === null) errors.push(`invalid declared CPU set '${declaration.cpu_set}'`);
  if (!Number.isInteger(declaration.numa_node) || declaration.numa_node < 0) errors.push('declared NUMA node must be a non-negative integer');
  if (!Number.isInteger(declaration.threads) || declaration.threads < 1) errors.push('declared thread count must be positive');
  if (errors.length > 0) return failedBeforeLaunch(command, declaration, errors);

  const cpuSet = declaredCpuSet as string;
  const node = String(declaration.numa_node);
  const threads = String(declaration.threads);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-resource-'));
  const reportPath = path.join(tempRoot, 'resource-context.env');
  const environment = {
    ...command.environment,
    OMP_NUM_THREADS: threads,
    OPENBLAS_NUM_THREADS: threads,
    GOTO_NUM_THREADS: threads,
    OMP_DYNAMIC: 'FALSE',
    OMP_PLACES: command.environment.OMP_PLACES ?? 'cores',
    OMP_PROC_BIND: command.environment.OMP_PROC_BIND ?? 'spread',
    PHYOPT_DECLARED_CPU_SET: cpuSet,
    PHYOPT_DECLARED_NUMA_NODE: node,
    PHYOPT_RESOURCE_ENFORCEMENT: 'ENFORCED',
  };
  const wrapped: ValidationCommand = {
    executable: 'numactl',
    args: [
      `--cpunodebind=${node}`,
      `--membind=${node}`,
      'taskset', '--cpu-list', cpuSet,
      'bash', '-c', RESOURCE_LAUNCHER, 'phyopt-resource-launcher',
      reportPath, cpuSet, node, threads,
      command.executable, ...command.args,
    ],
    cwd: command.cwd,
    environment,
    timeout_ms: command.timeout_ms,
  };

  try {
    const wrappedResult = await runValidationCommand(wrapped, wrapped.cwd, { signal });
    const report = fs.existsSync(reportPath) ? parseResourceReport(fs.readFileSync(reportPath, 'utf8')) : new Map<string, string>();
    const context = contextFromReport(declaration, cpuSet, report, wrappedResult.stderr);
    return {
      result: { ...wrappedResult, command: command.executable, args: [...command.args], cwd: command.cwd },
      resourceContext: context,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function unenforcedResourceContext(declaration: FormalResourceDeclaration): FormalResourceContext {
  return {
    declared: { ...declaration },
    applied: null,
    observed: {
      cpu_set: null,
      child_cpu_set: null,
      mems_allowed_list: null,
      numa_policy: null,
      thread_configuration: { OMP_NUM_THREADS: null, OPENBLAS_NUM_THREADS: null, GOTO_NUM_THREADS: null },
      max_runtime_threads: null,
      runtime_thread_observation: 'UNKNOWN',
    },
    enforcement: { cpu_set: 'NOT_ENFORCED', numa_node: 'NOT_ENFORCED', threads: 'NOT_ENFORCED' },
    validity: 'NOT_ENFORCED',
    errors: [],
  };
}

export function canonicalCpuSet(value: string): string | null {
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) return null;
  const cpus = new Set<number>();
  for (const segment of value.split(',')) {
    const [firstText, lastText = firstText] = segment.split('-');
    const first = Number(firstText);
    const last = Number(lastText);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first || last > 1_000_000) return null;
    for (let cpu = first; cpu <= last; cpu += 1) cpus.add(cpu);
  }
  const ordered = [...cpus].sort((left, right) => left - right);
  const output: string[] = [];
  for (let index = 0; index < ordered.length;) {
    const first = ordered[index];
    let last = first;
    while (index + 1 < ordered.length && ordered[index + 1] === last + 1) {
      index += 1;
      last = ordered[index];
    }
    output.push(first === last ? String(first) : `${first}-${last}`);
    index += 1;
  }
  return output.join(',');
}

export function parseResourceReport(value: string): Map<string, string> {
  const output = new Map<string, string>();
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    output.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return output;
}

function contextFromReport(
  declaration: FormalResourceDeclaration,
  cpuSet: string,
  report: Map<string, string>,
  stderr: string,
): FormalResourceContext {
  const node = String(declaration.numa_node);
  const threads = String(declaration.threads);
  const observedCpuSet = nullableCanonicalCpuSet(report.get('cpu_set'));
  const childCpuSet = nullableCanonicalCpuSet(report.get('child_cpu_set'));
  const policy = nullable(report.get('numa_policy'));
  const cpuNodes = compact(report.get('numa_cpu_nodes'));
  const nodeBind = compact(report.get('numa_node_bind'));
  const memoryNodes = compact(report.get('numa_memory_nodes'));
  const threadConfiguration = {
    OMP_NUM_THREADS: nullable(report.get('omp_num_threads')),
    OPENBLAS_NUM_THREADS: nullable(report.get('openblas_num_threads')),
    GOTO_NUM_THREADS: nullable(report.get('goto_num_threads')),
  };
  const maxRuntimeThreads = positiveIntegerOrNull(report.get('max_runtime_threads'));
  const errors: string[] = [];
  if (report.size === 0) errors.push(`resource observation was unavailable${stderr.trim() ? `: ${stderr.trim().slice(0, 512)}` : ''}`);
  if (observedCpuSet !== cpuSet) errors.push(`observed CPU set ${observedCpuSet ?? 'UNKNOWN'} differs from declared ${cpuSet}`);
  // taskset establishes the outer allowed CPU envelope. OpenMP/BLAS runtimes
  // may legitimately narrow individual process/thread masks inside that
  // envelope (for example, the main thread becomes CPU 0 under proc bind).
  // Treat only an escape outside the declared envelope as a violation.
  if (childCpuSet !== null && !cpuSetIsSubset(childCpuSet, cpuSet)) {
    errors.push(`observed child CPU set ${childCpuSet} escapes declared CPU set ${cpuSet}`);
  }
  if (report.get('numa_show_status') !== '0' || policy !== 'bind' || cpuNodes !== node || nodeBind !== node || memoryNodes !== node) {
    errors.push(`observed NUMA policy does not bind CPU and memory to node ${node}`);
  }
  if (Object.values(threadConfiguration).some((value) => value !== threads)) {
    errors.push(`observed thread environment differs from declared ${threads}`);
  }
  if (maxRuntimeThreads !== null && maxRuntimeThreads > declaration.threads) {
    errors.push(`observed ${maxRuntimeThreads} runtime threads exceeds declared ${declaration.threads}`);
  }
  if (report.get('resource_error')) errors.push(report.get('resource_error') as string);
  return {
    declared: { ...declaration, cpu_set: cpuSet },
    applied: {
      cpu_affinity: { mechanism: 'taskset', cpu_set: cpuSet },
      numa_policy: { mechanism: 'numactl', policy: 'bind', cpu_nodes: node, memory_nodes: node },
      thread_configuration: { OMP_NUM_THREADS: threads, OPENBLAS_NUM_THREADS: threads, GOTO_NUM_THREADS: threads },
    },
    observed: {
      cpu_set: observedCpuSet,
      child_cpu_set: childCpuSet,
      mems_allowed_list: nullable(report.get('mems_allowed_list')),
      numa_policy: { policy, cpu_nodes: cpuNodes, node_bind: nodeBind, memory_nodes: memoryNodes },
      thread_configuration: threadConfiguration,
      max_runtime_threads: maxRuntimeThreads,
      runtime_thread_observation: maxRuntimeThreads === null ? 'UNKNOWN' : 'OBSERVED',
    },
    enforcement: {
      cpu_set: errors.some((item) => item.includes('CPU set')) ? 'NOT_ENFORCED' : 'ENFORCED',
      numa_node: errors.some((item) => item.includes('NUMA')) ? 'NOT_ENFORCED' : 'ENFORCED',
      threads: errors.some((item) => item.includes('thread')) ? 'NOT_ENFORCED' : 'ENFORCED',
    },
    validity: errors.length === 0 ? 'VALID' : 'INVALID',
    errors,
  };
}

function failedBeforeLaunch(
  command: ValidationCommand,
  declaration: FormalResourceDeclaration,
  errors: string[],
): FormalResourceCommandResult {
  const timestamp = new Date().toISOString();
  return {
    result: {
      command: command.executable,
      args: [...command.args],
      cwd: command.cwd,
      start_time: timestamp,
      end_time: timestamp,
      timeout_ms: command.timeout_ms,
      ok: false,
      exit_code: null,
      timed_out: false,
      cancelled: false,
      stdout: '',
      stderr: errors.join('; '),
      duration_ms: 0,
    },
    resourceContext: {
      ...unenforcedResourceContext(declaration),
      validity: 'INVALID',
      errors: [...errors],
    },
  };
}

function nullable(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

function compact(value: string | undefined): string | null {
  return nullable(value?.replace(/\s+/g, ''));
}

function nullableCanonicalCpuSet(value: string | undefined): string | null {
  return value ? canonicalCpuSet(value) : null;
}

function positiveIntegerOrNull(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function cpuSetIsSubset(observed: string, declared: string): boolean {
  const declaredCpus = new Set(expandCanonicalCpuSet(declared));
  return expandCanonicalCpuSet(observed).every((cpu) => declaredCpus.has(cpu));
}

function expandCanonicalCpuSet(value: string): number[] {
  const output: number[] = [];
  for (const segment of value.split(',')) {
    const [firstText, lastText = firstText] = segment.split('-');
    const first = Number(firstText);
    const last = Number(lastText);
    for (let cpu = first; cpu <= last; cpu += 1) output.push(cpu);
  }
  return output;
}
