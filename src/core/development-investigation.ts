import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DevelopmentBenchmarkSummary,
  DevelopmentGateResult,
  DevelopmentPerfStatSummary,
  DevelopmentToolResult,
  PerfCounterSet,
} from '../contracts/development-investigation.js';
import { DEVELOPMENT_ONLY } from '../contracts/development-investigation.js';
import type { DomainIdentity, Experiment, Measurement } from '../contracts/optimization-domain.js';
import { OPTIMIZATION_DOMAIN_SCHEMA_VERSION } from '../contracts/optimization-domain.js';
import type {
  ExperimentExecutionPlan,
  ExperimentExecutionStep,
  ExperimentStatusResponse,
  RunnerMachineInfo,
  StagedCandidateIdentity,
} from '../contracts/runner-rpc.js';
import type { FormalEvaluatorCommandContract, FormalWorkloadDefinition } from '../contracts/formal-evaluator.js';
import type { ValidationCommand } from '../contracts/validation-testpack.js';
import type { ExperimentExecutionBackend } from './experiment-execution-backend.js';
import type { RemoteValidationTransport } from '../workspace/validation-runner.js';
import { evaluatorContentSha256 } from '../evaluator/formal-evaluator.js';
import { expandEvaluatorArguments, formalWorkloadParameters } from '../evaluator/formal-arguments.js';

const PERF_EVENTS = ['cycles', 'instructions', 'branches', 'branch-misses', 'cache-references', 'cache-misses'] as const;
const TERMINAL = new Set<ExperimentStatusResponse['status']>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']);

export interface PreparedDevelopmentWorkspace {
  candidate: StagedCandidateIdentity;
  /** A mutable copy containing development harness sources, never a trusted evaluator path. */
  assetsRoot: string;
}

export interface RunnerDevelopmentInvestigationOptions {
  backend: ExperimentExecutionBackend;
  taskId: string;
  buildCommand: ValidationCommand;
  buildCwdRelative?: string;
  candidateArtifactRelativePath: string;
  baseline: DomainIdentity & { details: { path: string } };
  resources: { cpuSet: string; numaNode: number };
  workloads: readonly FormalWorkloadDefinition[];
  evaluatorSetup: { executable: string; script: string };
  performanceCommand: FormalEvaluatorCommandContract;
  inspectionSymbols?: readonly string[];
  prepareWorkspace(input: { requestId: string; tool: string; signal?: AbortSignal }): Promise<PreparedDevelopmentWorkspace>;
  pollIntervalMs?: number;
  idFactory?: () => string;
}

interface ExecutedDevelopmentPlan {
  experimentId: string;
  status: ExperimentStatusResponse;
  commands: Awaited<ReturnType<ExperimentExecutionBackend['getCommandExecutions']>>['command_executions'];
  measurements: Measurement[];
}

/**
 * Development-only target investigation over the existing Experiment RPC.
 * Each call stages a clean source snapshot and records every target command in
 * Runner SQLite. No returned fact is eligible for Formal acceptance.
 */
export class RunnerDevelopmentInvestigation {
  private readonly pollIntervalMs: number;
  private readonly idFactory: () => string;
  private readonly benchmarkCache = new Map<string, DevelopmentBenchmarkSummary>();

  constructor(private readonly options: RunnerDevelopmentInvestigationOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.idFactory = options.idFactory ?? randomUUID;
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) throw new Error('development poll interval must be positive');
    assertRelativePath(options.candidateArtifactRelativePath, 'candidate artifact');
    assertRelativePath(options.buildCwdRelative ?? '.', 'build cwd');
    assertRelativePath(options.evaluatorSetup.script, 'evaluator setup script');
    assertRelativePath(options.performanceCommand.script, 'performance command script');
    if (!path.posix.isAbsolute(options.baseline.details.path)) throw new Error('development Baseline path must be absolute on the target');
    for (const symbol of options.inspectionSymbols ?? []) assertSymbol(symbol);
  }

  async inspectMachine(signal?: AbortSignal): Promise<DevelopmentToolResult<{ machine: RunnerMachineInfo }>> {
    const preflight = await this.options.backend.preflight(signal);
    return {
      classification: DEVELOPMENT_ONLY,
      tool: 'inspect_machine',
      experiment_id: null,
      data: { machine: preflight.machine },
      raw_command_execution_ids: [],
    };
  }

  async inspectBinary(input: { symbol?: string }, signal?: AbortSignal): Promise<DevelopmentToolResult<{ output: string }>> {
    if (input.symbol !== undefined) assertSymbol(input.symbol);
    const prepared = await this.prepare('inspect_binary', signal);
    const library = candidateArtifact(prepared, this.options.candidateArtifactRelativePath);
    const symbols = input.symbol ? [input.symbol] : [...new Set(this.options.inspectionSymbols ?? [])];
    const symbolFilter = symbols.length > 0
      ? symbols.map((symbol) => `printf '\n== symbol ${shellQuoteForDisplay(symbol)} ==\n'; readelf -Ws "$lib" | grep -F -- ${shellQuote(symbol)} || true; nm -D --defined-only "$lib" | grep -F -- ${shellQuote(symbol)} || true`).join('; ')
      : 'printf "\n== exported dynamic symbols (first 400) ==\n"; nm -D --defined-only "$lib" | head -n 400';
    const script = [
      'set -euo pipefail',
      `lib=${shellQuote(library)}`,
      'printf "== identity ==\\n"',
      'sha256sum "$lib"',
      'file "$lib"',
      'printf "\\n== elf ==\\n"',
      'readelf -h -d "$lib"',
      'printf "\\n== dependencies ==\\n"',
      'ldd "$lib"',
      symbolFilter,
    ].join('; ');
    const executed = await this.execute(prepared, 'inspect_binary', [
      this.buildStep(prepared),
      candidateStep('EVALUATOR_SETUP', { executable: 'bash', args: ['-lc', script], cwd: prepared.candidate.workspace_path, environment: {}, timeout_ms: 120_000 }),
    ], signal);
    const output = commandOutput(executed.commands.at(-1));
    return developmentResult('inspect_binary', executed, { output: output.slice(0, 96 * 1024) });
  }

  async disassemble(input: { symbol: string }, signal?: AbortSignal): Promise<DevelopmentToolResult<{ symbol: string; output: string }>> {
    assertSymbol(input.symbol);
    const prepared = await this.prepare('disassemble', signal);
    const library = candidateArtifact(prepared, this.options.candidateArtifactRelativePath);
    const executed = await this.execute(prepared, 'disassemble', [
      this.buildStep(prepared),
      candidateStep('EVALUATOR_SETUP', {
        executable: 'objdump',
        args: ['-d', '--no-show-raw-insn', `--disassemble=${input.symbol}`, library],
        cwd: prepared.candidate.workspace_path,
        environment: {},
        timeout_ms: 120_000,
      }),
    ], signal);
    return developmentResult('disassemble', executed, {
      symbol: input.symbol,
      output: commandOutput(executed.commands.at(-1)).slice(0, 128 * 1024),
    });
  }

  async runDevBenchmark(
    input: { workloadId: string; samples: number },
    signal?: AbortSignal,
  ): Promise<DevelopmentToolResult<DevelopmentBenchmarkSummary>> {
    const workload = this.workload(input.workloadId);
    if (!Number.isInteger(input.samples) || input.samples < 1 || input.samples > 5) throw new Error('development sample count must be in 1..5');
    const prepared = await this.prepare('run_dev_benchmark', signal);
    const runtimeRoot = developmentRuntimeRoot(prepared);
    const candidate = candidateArtifact(prepared, this.options.candidateArtifactRelativePath);
    const baseline = this.options.baseline.details.path;
    const script = benchmarkScript(this.options.performanceCommand, prepared, runtimeRoot, workload, baseline, candidate, input.samples);
    const executed = await this.execute(prepared, 'run_dev_benchmark', [
      this.buildStep(prepared),
      this.evaluatorBuildStep(prepared, runtimeRoot),
      candidateStep('PERFORMANCE', constrainedCommand(script, prepared.candidate.workspace_path, workload.threads, this.options.resources, 300_000), true),
    ], signal);
    const baselineSamples = performanceSamples(executed.measurements, workload.workload_id, 'BASELINE');
    const candidateSamples = performanceSamples(executed.measurements, workload.workload_id, 'CANDIDATE');
    if (baselineSamples.length !== input.samples || candidateSamples.length !== input.samples) {
      throw new Error(`development benchmark retained ${baselineSamples.length}/${candidateSamples.length} Baseline/Candidate samples; expected ${input.samples}/${input.samples}`);
    }
    const baselineMedian = median(baselineSamples);
    const candidateMedian = median(candidateSamples);
    const summary: DevelopmentBenchmarkSummary = {
      workload_id: workload.workload_id,
      sample_count_per_role: input.samples,
      baseline_samples_seconds: baselineSamples,
      candidate_samples_seconds: candidateSamples,
      baseline_median_seconds: baselineMedian,
      candidate_median_seconds: candidateMedian,
      speedup: baselineMedian / candidateMedian,
      resource_context: resourceSummary(workload.threads, this.options.resources),
    };
    this.benchmarkCache.set(workload.workload_id, structuredClone(summary));
    return developmentResult('run_dev_benchmark', executed, summary);
  }

  /** Compare a post-mutation quick run with the pre-mutation run retained in this development session. */
  async runDevelopmentGate(workloadIds: readonly string[], signal?: AbortSignal): Promise<DevelopmentGateResult> {
    const unique = [...new Set(workloadIds)];
    const output: DevelopmentGateResult['workloads'] = [];
    for (const workloadId of unique) {
      const before = this.benchmarkCache.get(workloadId) ?? null;
      const afterResult = await this.runDevBenchmark({ workloadId, samples: before?.sample_count_per_role ?? 3 }, signal);
      const after = afterResult.data;
      // This is only an early rejection heuristic, not an acceptance threshold:
      // call a result obviously worse only when every new sample is slower than
      // the prior median and the new median is slower than the prior slowest sample.
      const obviouslyWorse = before !== null &&
        after.candidate_samples_seconds.every((value) => value > before.candidate_median_seconds) &&
        after.candidate_median_seconds > Math.max(...before.candidate_samples_seconds);
      output.push({
        workload_id: workloadId,
        before_candidate_median_seconds: before?.candidate_median_seconds ?? null,
        after_candidate_median_seconds: after.candidate_median_seconds,
        candidate_ratio_before_over_after: before ? before.candidate_median_seconds / after.candidate_median_seconds : null,
        obviously_worse: obviouslyWorse,
      });
    }
    const failed = output.filter((item) => item.obviously_worse);
    return {
      classification: DEVELOPMENT_ONLY,
      passed: failed.length === 0,
      reason: failed.length === 0
        ? 'no investigated workload was unambiguously worse in the development gate'
        : `development gate found unambiguous regressions: ${failed.map((item) => item.workload_id).join(', ')}`,
      workloads: output,
    };
  }

  async profilePerfStat(
    input: { workloadId: string; repeats: number },
    signal?: AbortSignal,
  ): Promise<DevelopmentToolResult<DevelopmentPerfStatSummary>> {
    const workload = this.workload(input.workloadId);
    if (!Number.isInteger(input.repeats) || input.repeats < 1 || input.repeats > 3) throw new Error('perf stat repeats must be in 1..3');
    const prepared = await this.prepare('profile_perf_stat', signal);
    const runtimeRoot = developmentRuntimeRoot(prepared);
    const candidate = candidateArtifact(prepared, this.options.candidateArtifactRelativePath);
    const script = perfStatScript(this.options.performanceCommand, prepared, runtimeRoot, workload, this.options.baseline.details.path, candidate, input.repeats);
    const executed = await this.execute(prepared, 'profile_perf_stat', [
      this.buildStep(prepared),
      this.evaluatorBuildStep(prepared, runtimeRoot),
      candidateStep('PERFORMANCE', constrainedCommand(script, prepared.candidate.workspace_path, workload.threads, this.options.resources, 300_000), true),
    ], signal);
    const raw = commandOutput(executed.commands.at(-1));
    const parsed = parsePerfStatOutput(raw, workload.workload_id, workload.threads, this.options.resources);
    const baselineSamples = performanceSamples(executed.measurements, workload.workload_id, 'BASELINE');
    const candidateSamples = performanceSamples(executed.measurements, workload.workload_id, 'CANDIDATE');
    parsed.benchmark_timing = {
      baseline_samples_seconds: baselineSamples,
      candidate_samples_seconds: candidateSamples,
      speedup: baselineSamples.length > 0 && candidateSamples.length > 0
        ? median(baselineSamples) / median(candidateSamples)
        : null,
    };
    return developmentResult('profile_perf_stat', executed, parsed);
  }

  private async prepare(tool: string, signal?: AbortSignal): Promise<PreparedDevelopmentWorkspace> {
    signal?.throwIfAborted();
    return this.options.prepareWorkspace({ requestId: this.idFactory(), tool, signal });
  }

  private workload(workloadId: string): FormalWorkloadDefinition {
    const workload = this.options.workloads.find((item) => item.workload_id === workloadId);
    if (!workload) throw new Error(`unknown development workload '${workloadId}'`);
    return workload;
  }

  private buildStep(prepared: PreparedDevelopmentWorkspace): ExperimentExecutionStep {
    const cwd = resolveRemoteRelative(prepared.candidate.workspace_path, this.options.buildCwdRelative ?? '.');
    return candidateStep('BUILD', { ...this.options.buildCommand, cwd, args: [...this.options.buildCommand.args], environment: { ...this.options.buildCommand.environment } });
  }

  private evaluatorBuildStep(prepared: PreparedDevelopmentWorkspace, runtimeRoot: string): ExperimentExecutionStep {
    const script = path.posix.join(prepared.assetsRoot, ...this.options.evaluatorSetup.script.split('/'));
    return candidateStep('EVALUATOR_SETUP', {
      executable: this.options.evaluatorSetup.executable,
      args: [script, runtimeRoot],
      cwd: prepared.candidate.workspace_path,
      environment: {},
      timeout_ms: 120_000,
    });
  }

  private async execute(
    prepared: PreparedDevelopmentWorkspace,
    tool: string,
    steps: ExperimentExecutionStep[],
    signal?: AbortSignal,
  ): Promise<ExecutedDevelopmentPlan> {
    const experimentId = `development:${this.idFactory()}`;
    const now = new Date().toISOString();
    const experiment: Experiment = {
      schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION,
      experiment_id: experimentId,
      task_id: this.options.taskId,
      candidate_id: prepared.candidate.candidate_id,
      type: 'DEVELOPMENT_FEEDBACK',
      status: 'PENDING',
      validity: 'UNKNOWN',
      failure_category: null,
      evaluator: { id: 'development-only' },
      baseline: structuredClone(this.options.baseline),
      declared_context: {
        classification: DEVELOPMENT_ONLY,
        tool,
        resources: {
          cpu_set: this.options.resources.cpuSet,
          numa_node: this.options.resources.numaNode,
        },
      },
      observed_context: null,
      evaluation: null,
      started_at: null,
      ended_at: null,
      created_at: now,
      updated_at: now,
    };
    const plan: ExperimentExecutionPlan = { experiment, candidate: prepared.candidate, steps };
    await this.options.backend.submitExperiment(plan, signal);
    let cancelRequested = false;
    let status: ExperimentStatusResponse;
    while (true) {
      if (signal?.aborted && !cancelRequested) {
        cancelRequested = true;
        await this.options.backend.cancelExperiment(experimentId).catch(() => undefined);
      }
      status = await this.options.backend.getExperiment(experimentId);
      if (TERMINAL.has(status.status)) break;
      await delay(this.pollIntervalMs);
    }
    const [commands, measurements] = await Promise.all([
      this.options.backend.getCommandExecutions(experimentId),
      this.options.backend.getMeasurements(experimentId),
    ]);
    if (status.status !== 'SUCCEEDED') {
      const last = commands.command_executions.at(-1);
      throw new Error(`development ${tool} failed (${status.failure?.code ?? status.status}): ${status.failure?.message ?? commandOutput(last).slice(-4096)}`);
    }
    return { experimentId, status, commands: commands.command_executions, measurements: measurements.measurements };
  }
}

export async function stageRemoteDevelopmentAssets(input: {
  evaluatorRoot: string;
  transport: RemoteValidationTransport;
  remoteWorkspace: string;
  signal?: AbortSignal;
}): Promise<{ remote_workspace: string; digest: string }> {
  input.signal?.throwIfAborted();
  const evaluatorRoot = path.resolve(input.evaluatorRoot);
  if (!fs.existsSync(path.join(evaluatorRoot, 'manifest.json'))) throw new Error('development evaluator asset root is missing manifest.json');
  const remoteWorkspace = input.remoteWorkspace.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!path.posix.isAbsolute(remoteWorkspace) || !remoteWorkspace.split('/').includes('development')) {
    throw new Error('development asset workspace must be an absolute path under a development directory');
  }
  const digest = evaluatorContentSha256(evaluatorRoot);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-development-assets-'));
  const archive = path.join(tempRoot, 'assets.tar');
  try {
    const packed = spawnSync('tar', ['-cf', archive, '-C', evaluatorRoot, '.'], { encoding: 'utf8', windowsHide: true });
    if (packed.status !== 0) throw new Error(`cannot archive development assets: ${(packed.stderr ?? '').trim()}`);
    const clear = await Promise.resolve(input.transport.runRemote(['bash', '-lc', `rm -rf -- ${shellQuote(remoteWorkspace)} && mkdir -p -- ${shellQuote(remoteWorkspace)}`]));
    if (clear.exit_code !== 0) throw new Error(clear.stderr || 'cannot create remote development asset workspace');
    const remoteArchive = `${remoteWorkspace}/assets.tar`;
    if (!input.transport.uploadFile) throw new Error('development transport does not support asset upload');
    const uploaded = await Promise.resolve(input.transport.uploadFile(archive, remoteArchive));
    if (uploaded.exit_code !== 0) throw new Error(uploaded.stderr || 'development asset upload failed');
    const extracted = await Promise.resolve(input.transport.runRemote(['bash', '-lc', `tar -xf ${shellQuote(remoteArchive)} -C ${shellQuote(remoteWorkspace)} && rm -f -- ${shellQuote(remoteArchive)}`]));
    if (extracted.exit_code !== 0) throw new Error(extracted.stderr || 'development asset extraction failed');
    return { remote_workspace: remoteWorkspace, digest };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function candidateStep(step: ExperimentExecutionStep['step'], command: ValidationCommand, measurements = false): ExperimentExecutionStep {
  return { step, execution_domain: 'CANDIDATE', command, ...(measurements ? { measurements_from_stdout: true } : {}) };
}

function constrainedCommand(
  script: string,
  cwd: string,
  threads: number,
  resources: RunnerDevelopmentInvestigationOptions['resources'],
  timeoutMs: number,
): ValidationCommand {
  return {
    executable: 'numactl',
    args: [`--cpunodebind=${resources.numaNode}`, `--membind=${resources.numaNode}`, 'taskset', '-c', resources.cpuSet, 'bash', '-lc', script],
    cwd,
    environment: {
      OMP_NUM_THREADS: String(threads),
      OPENBLAS_NUM_THREADS: String(threads),
      GOTO_NUM_THREADS: String(threads),
      OMP_DYNAMIC: 'FALSE',
      OMP_PLACES: 'cores',
      OMP_PROC_BIND: 'spread',
      OMP_WAIT_POLICY: 'ACTIVE',
    },
    timeout_ms: timeoutMs,
  };
}

function benchmarkScript(
  contract: FormalEvaluatorCommandContract,
  prepared: PreparedDevelopmentWorkspace,
  runtimeRoot: string,
  workload: FormalWorkloadDefinition,
  baseline: string,
  candidate: string,
  samples: number,
): string {
  const commands = [
    'set -euo pipefail',
    performanceInvocation(contract, prepared, runtimeRoot, workload, 'warmup', 'BASELINE', baseline, 0),
    performanceInvocation(contract, prepared, runtimeRoot, workload, 'warmup', 'CANDIDATE', candidate, 0),
  ];
  for (let index = 0; index < samples; index += 1) {
    const roles = index % 2 === 0
      ? [['BASELINE', baseline], ['CANDIDATE', candidate]] as const
      : [['CANDIDATE', candidate], ['BASELINE', baseline]] as const;
    for (const [role, artifact] of roles) {
      commands.push(performanceInvocation(contract, prepared, runtimeRoot, workload, 'sample', role, artifact, index));
    }
  }
  return commands.join('; ');
}

function perfStatScript(
  contract: FormalEvaluatorCommandContract,
  prepared: PreparedDevelopmentWorkspace,
  runtimeRoot: string,
  workload: FormalWorkloadDefinition,
  baseline: string,
  candidate: string,
  repeats: number,
): string {
  const commands = [
    'set -uo pipefail',
    'supported=()',
    'unavailable=()',
    `for event in ${PERF_EVENTS.join(' ')}; do probe=$(perf stat -x ';' -e "$event" -- true 2>&1); probe_status=$?; if (( probe_status == 0 )) && ! grep -Eqi '<not supported>|<not counted>|no permission|not available|unknown event' <<<"$probe"; then supported+=("$event"); else unavailable+=("$event"); fi; done`,
    'printf "PHYOPT_PERF_SUPPORTED %s\\n" "${supported[*]}"',
    'printf "PHYOPT_PERF_UNAVAILABLE %s\\n" "${unavailable[*]}"',
    'if (( ${#supported[@]} == 0 )); then printf "PHYOPT_PERF_WARNING no permitted requested PMU events\\n"; exit 0; fi',
    'events=$(IFS=,; echo "${supported[*]}")',
    performanceInvocation(contract, prepared, runtimeRoot, workload, 'warmup', 'BASELINE', baseline, 0),
    performanceInvocation(contract, prepared, runtimeRoot, workload, 'warmup', 'CANDIDATE', candidate, 0),
  ];
  for (let index = 0; index < repeats; index += 1) {
    for (const [role, artifact] of [['BASELINE', baseline], ['CANDIDATE', candidate]] as const) {
      const invocation = performanceInvocation(contract, prepared, runtimeRoot, workload, 'sample', role, artifact, index);
      commands.push(`printf "PHYOPT_PERF_BEGIN ${role} ${index}\\n"; perf stat -x ';' -e "$events" -- ${invocation} 2>&1; status=$?; printf "PHYOPT_PERF_END ${role} ${index} %s\\n" "$status"`);
    }
  }
  return commands.join('; ');
}

function performanceInvocation(
  contract: FormalEvaluatorCommandContract,
  prepared: PreparedDevelopmentWorkspace,
  runtimeRoot: string,
  workload: FormalWorkloadDefinition,
  phase: 'warmup' | 'sample',
  role: 'BASELINE' | 'CANDIDATE',
  artifact: string,
  index: number,
): string {
  const script = path.posix.join(prepared.assetsRoot, ...contract.script.split('/'));
  const args = expandEvaluatorArguments(contract.arguments, {
    ...formalWorkloadParameters(workload),
    phase,
    role,
    workload_id: workload.workload_id,
    artifact_path: artifact,
    iteration_index: index,
    runtime_root: runtimeRoot,
  }, `development workload '${workload.workload_id}'`);
  return [contract.executable, script, ...args].map(shellQuote).join(' ');
}

export function parsePerfStatOutput(
  raw: string,
  workloadId: string,
  threads: number,
  resources: RunnerDevelopmentInvestigationOptions['resources'],
): DevelopmentPerfStatSummary {
  const supported = markerWords(raw, 'PHYOPT_PERF_SUPPORTED');
  const unavailable = markerWords(raw, 'PHYOPT_PERF_UNAVAILABLE');
  const values: Record<'BASELINE' | 'CANDIDATE', Record<string, number[]>> = { BASELINE: {}, CANDIDATE: {} };
  const warnings = raw.split(/\r?\n/).filter((line) => line.startsWith('PHYOPT_PERF_WARNING ')).map((line) => line.slice('PHYOPT_PERF_WARNING '.length));
  let role: 'BASELINE' | 'CANDIDATE' | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const begin = line.match(/^PHYOPT_PERF_BEGIN (BASELINE|CANDIDATE) \d+$/);
    if (begin) { role = begin[1] as 'BASELINE' | 'CANDIDATE'; continue; }
    if (line.startsWith('PHYOPT_PERF_END ')) { role = null; continue; }
    if (!role || !line.includes(';')) continue;
    const fields = line.split(';').map((item) => item.trim());
    const event = supported.find((item) => fields.some((field) => normalizePerfEvent(field) === item));
    if (!event) continue;
    const numeric = Number(fields[0]?.replace(/,/g, ''));
    if (!Number.isFinite(numeric)) continue;
    (values[role][event] ??= []).push(numeric);
  }
  const counters = (name: 'BASELINE' | 'CANDIDATE'): PerfCounterSet => {
    const output: PerfCounterSet = {};
    const assign = (event: string, field: keyof PerfCounterSet) => {
      const samples = values[name][event];
      if (samples?.length) output[field] = median(samples);
    };
    assign('cycles', 'cycles'); assign('instructions', 'instructions'); assign('branches', 'branches');
    assign('branch-misses', 'branch_misses'); assign('cache-references', 'cache_references'); assign('cache-misses', 'cache_misses');
    if (output.cycles && output.instructions !== undefined) output.ipc = output.instructions / output.cycles;
    if (output.branches && output.branch_misses !== undefined) output.branch_miss_rate = output.branch_misses / output.branches;
    if (output.cache_references && output.cache_misses !== undefined) output.cache_miss_rate = output.cache_misses / output.cache_references;
    return output;
  };
  if (supported.length > 0 && Object.keys(values.BASELINE).length === 0) warnings.push('perf output contained no parseable Baseline counters');
  if (supported.length > 0 && Object.keys(values.CANDIDATE).length === 0) warnings.push('perf output contained no parseable Candidate counters');
  return {
    workload_id: workloadId,
    supported_events: supported,
    unavailable_events: unavailable,
    baseline: counters('BASELINE'),
    candidate: counters('CANDIDATE'),
    benchmark_timing: { baseline_samples_seconds: [], candidate_samples_seconds: [], speedup: null },
    resource_context: resourceSummary(threads, resources),
    warnings,
  };
}

function normalizePerfEvent(value: string): string {
  return value.replace(/:[ukhp]+$/i, '');
}

function performanceSamples(measurements: readonly Measurement[], subject: string, role: 'BASELINE' | 'CANDIDATE'): number[] {
  return measurements
    .filter((item) => item.kind === 'PERFORMANCE_SAMPLE' && item.subject_id === subject && item.role === role && typeof item.value === 'number')
    .sort((left, right) => (left.sample_index ?? -1) - (right.sample_index ?? -1))
    .map((item) => item.value as number);
}

function developmentResult<T>(tool: DevelopmentToolResult<T>['tool'], executed: ExecutedDevelopmentPlan, data: T): DevelopmentToolResult<T> {
  return {
    classification: DEVELOPMENT_ONLY,
    tool,
    experiment_id: executed.experimentId,
    data,
    raw_command_execution_ids: executed.commands.map((item) => item.command_execution_id),
  };
}

function candidateArtifact(prepared: PreparedDevelopmentWorkspace, relative: string): string {
  return resolveRemoteRelative(prepared.candidate.workspace_path, relative);
}

function developmentRuntimeRoot(prepared: PreparedDevelopmentWorkspace): string {
  return path.posix.join(prepared.candidate.workspace_path, '.phyopt-development', 'evaluator-runtime');
}

function resolveRemoteRelative(root: string, relative: string): string {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const resolved = path.posix.resolve(normalizedRoot, relative.replace(/\\/g, '/'));
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}/`)) throw new Error(`path escapes staged Candidate: ${relative}`);
  return resolved;
}

function assertRelativePath(value: string, field: string): void {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || path.posix.isAbsolute(normalized) || path.posix.resolve('/', normalized).startsWith('/../')) throw new Error(`${field} must be relative`);
  if (normalized.split('/').includes('..')) throw new Error(`${field} escapes the Candidate root`);
}

function assertSymbol(value: string): void {
  if (!/^[A-Za-z_.$][A-Za-z0-9_.$@]{0,255}$/.test(value)) throw new Error('symbol contains unsupported characters');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shellQuoteForDisplay(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

function commandOutput(command: ExecutedDevelopmentPlan['commands'][number] | undefined): string {
  if (!command) return '';
  return [command.stdout, command.stderr].filter(Boolean).join('\n');
}

function markerWords(raw: string, marker: string): string[] {
  const line = raw.split(/\r?\n/).find((item) => item.startsWith(`${marker} `));
  return line ? line.slice(marker.length + 1).trim().split(/\s+/).filter(Boolean) : [];
}

function resourceSummary(threads: number, resources: RunnerDevelopmentInvestigationOptions['resources']) {
  return { cpu_set: resources.cpuSet, numa_node: resources.numaNode, threads };
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('cannot compute median of an empty sample set');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2 : sorted[middle] as number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
