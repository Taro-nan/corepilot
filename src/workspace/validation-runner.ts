import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { ValidationCommand, ValidationTestpack } from '../contracts/validation-testpack.js';
import type { CommandExecution } from '../contracts/optimization-domain.js';
import type { ExperimentExecutionStep, ExperimentStatusResponse } from '../contracts/runner-rpc.js';
import { candidateEvaluationFeedback } from './candidate-evaluation-feedback.js';
import type { WorkspaceToolResult } from '../agent/workspace-tools.js';
import { exportCandidateSourceArchive, refreshValidationWorkspace, type CandidateWorkspaceState } from './candidate-workspace.js';
import { evaluatorBundleSha256 } from '../evaluator/formal-evaluator.js';
import { validationCaseParameters } from '../testpack/validation-parameters.js';

export interface CommandRunResult {
  command_execution_id?: string;
  resource_context?: Record<string, unknown> | null;
  command: string;
  args: string[];
  cwd: string;
  start_time: string;
  end_time: string;
  timeout_ms: number;
  ok: boolean;
  exit_code: number | null;
  timed_out: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export type CorrectnessCaseStatus = 'PASSED' | 'FAILED' | 'INVALID' | 'NOT_EXECUTED';

export interface CorrectnessCaseResult {
  case_id: string;
  parameters: Record<string, unknown>;
  status: CorrectnessCaseStatus;
  error: string | null;
  command: CommandRunResult | null;
}

export interface CorrectnessCoverage {
  planned: number;
  executed: number;
  passed: number;
  failed: number;
  complete: boolean;
}

export interface ValidationCycleResult {
  runner_status?: ExperimentStatusResponse;
  build: CommandRunResult;
  correctness: CommandRunResult | null;
  correctness_cases: CorrectnessCaseResult[];
  correctness_coverage: CorrectnessCoverage;
  /** False for the legacy aggregate-command compatibility path. */
  formal_correctness_complete: boolean;
  performance: CommandRunResult | null;
  passed: boolean;
}

/** SSH/scp 抽象；真实运行使用 SshTransport，测试可注入无网络实现。 */
export interface RemoteValidationTransport {
  readonly transport_type?: 'ssh' | 'mock';
  runRemote(argv: string[]): { command: string; argv: string[]; stdout: string; stderr: string; exit_code: number } | Promise<{ command: string; argv: string[]; stdout: string; stderr: string; exit_code: number }>;
  uploadFile?(localPath: string, remotePath: string): { exit_code: number; stderr: string } | Promise<{ exit_code: number; stderr: string }>;
}

export interface RemoteValidationSession {
  transport: RemoteValidationTransport;
  remote_workspace: string;
  source_root: string;
  source_archive_sha256: string;
}

export interface StagedRemoteEvaluator {
  remote_workspace: string;
  digest: string;
}

export interface StagedRemoteBaseline {
  remote_artifact: string;
  digest: string;
}

export interface RevalidationCycleResult {
  formal: ValidationCycleResult | null;
  independent: ValidationCycleResult | null;
  performance_gate?: PerformanceGateResult | null;
  passed: boolean;
}

export interface PerformanceCaseMeasurement {
  case_id: string;
  candidate_time?: number;
  comparison_time?: number;
  candidate_samples?: number[];
  baseline_samples?: number[];
  current_time?: number;
  /** 可选的候选/基线比值置信区间下限；没有时由 ratio 本身保守估计。 */
  ci_lower?: number;
}

export interface PerformanceWorkloadResult {
  case_id: string;
  baseline_samples: number[];
  candidate_samples: number[];
  baseline_median: number;
  candidate_median: number;
  speedup: number;
  critical: boolean;
  regression: boolean;
  ci_lower?: number;
}

export interface PerformanceGateResult {
  passed: boolean;
  weighted_geomean: number;
  overall_ci_lower: number;
  key_case_ci_lower: number;
  case_ratios: Record<string, number>;
  workloads: PerformanceWorkloadResult[];
  reason: string;
}

const MAX_OUTPUT = 2 * 1024 * 1024;

function commandResult(
  command: ValidationCommand,
  cwd: string,
  startedAt: string,
  startedMs: number,
  result: Omit<CommandRunResult, 'command' | 'args' | 'cwd' | 'start_time' | 'end_time' | 'timeout_ms' | 'duration_ms'>,
): CommandRunResult {
  return {
    command: command.executable,
    args: [...command.args],
    cwd,
    start_time: startedAt,
    end_time: new Date().toISOString(),
    timeout_ms: command.timeout_ms,
    duration_ms: Date.now() - startedMs,
    ...result,
  };
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > MAX_OUTPUT ? next.slice(0, MAX_OUTPUT) : next;
}

function commandCwd(command: ValidationCommand, workspace: string, testpackDir?: string, sourceRoot?: string): string {
  const root = path.resolve(workspace);
  const configured = path.resolve(command.cwd);
  const base = sourceRoot ? path.resolve(sourceRoot) : (testpackDir ? path.resolve(testpackDir) : configured);
  let relative = sourceRoot ? path.relative(base, configured) : (testpackDir ? path.relative(path.resolve(testpackDir), configured) : '');
  // 允许 testpack/config 位于仓库旁边的兼容布局：无法映射到候选源码时
  // 使用验证树根执行命令；真实源码仓库内的路径仍严格按 sourceRoot 映射。
  if (relative.startsWith('..') || path.isAbsolute(relative)) relative = '';
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`testpack command cwd escapes validation workspace: ${command.cwd}`);
  return resolved;
}

function posixRelative(sourceRoot: string, configured: string): string {
  const relative = path.relative(path.resolve(sourceRoot), path.resolve(configured));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`validation command path escapes source root: ${configured}`);
  return relative.split(path.sep).join('/');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function remoteCommandScript(command: ValidationCommand, session: RemoteValidationSession): string {
  const relativeCwd = posixRelative(session.source_root, command.cwd);
  const cwd = path.posix.join(session.remote_workspace.replace(/\\/g, '/'), relativeCwd);
  const env = Object.entries(command.environment).map(([key, value]) => `${shellQuote(`${key}=${value}`)}`).join(' ');
  const executable = shellQuote(command.executable);
  const args = command.args.map(shellQuote).join(' ');
  return `cd -- ${shellQuote(cwd)} && ${env ? `env ${env} ` : ''}${executable}${args ? ` ${args}` : ''}`;
}

async function runRemoteValidationCommand(command: ValidationCommand, session: RemoteValidationSession, signal?: AbortSignal): Promise<CommandRunResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const cwd = path.posix.join(session.remote_workspace.replace(/\\/g, '/'), posixRelative(session.source_root, command.cwd));
  if (signal?.aborted) return commandResult(command, cwd, startedAt, started, { ok: false, exit_code: null, timed_out: false, cancelled: true, stdout: '', stderr: '' });
  try {
    const pending = Promise.resolve(session.transport.runRemote(['bash', '-lc', remoteCommandScript(command, session)]));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CommandRunResult>((resolve) => {
      timer = setTimeout(() => resolve(commandResult(command, cwd, startedAt, started, { ok: false, exit_code: null, timed_out: true, cancelled: false, stdout: '', stderr: `remote command timed out after ${command.timeout_ms}ms` })), command.timeout_ms);
    });
    const cancellation = new Promise<CommandRunResult>((resolve) => {
      signal?.addEventListener('abort', () => resolve(commandResult(command, cwd, startedAt, started, { ok: false, exit_code: null, timed_out: false, cancelled: true, stdout: '', stderr: '' })), { once: true });
    });
    const result = await Promise.race([
      pending.then((remote) => commandResult(command, cwd, startedAt, started, { ok: remote.exit_code === 0, exit_code: remote.exit_code, timed_out: false, cancelled: false, stdout: remote.stdout, stderr: remote.stderr })),
      timeout,
      cancellation,
    ]);
    if (timer) clearTimeout(timer);
    return result;
  } catch (error) {
    return commandResult(command, cwd, startedAt, started, { ok: false, exit_code: null, timed_out: false, cancelled: false, stdout: '', stderr: (error as Error).message });
  }
}

/** 在指定 worktree 执行一个有超时、可取消且截断输出的命令。 */
export function runValidationCommand(command: ValidationCommand, workspace: string, options: { testpackDir?: string; sourceRoot?: string; signal?: AbortSignal; remote?: RemoteValidationSession } = {}): Promise<CommandRunResult> {
  if (options.remote) return runRemoteValidationCommand(command, options.remote, options.signal);
  const cwd = commandCwd(command, workspace, options.testpackDir, options.sourceRoot);
  return new Promise((resolve) => {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    if (options.signal?.aborted) {
      resolve(commandResult(command, cwd, startedAt, started, { ok: false, exit_code: null, timed_out: false, cancelled: true, stdout: '', stderr: '' }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(command.executable, command.args, {
      cwd,
      env: { ...process.env, ...command.environment },
      windowsHide: true,
      shell: false,
    });
    const finish = (result: CommandRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      cancelled = true;
      child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, command.timeout_ms);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    child.on('error', (error) => {
      stderr = appendBounded(stderr, error.message);
      finish(commandResult(command, cwd, startedAt, started, { ok: false, exit_code: null, timed_out: timedOut, cancelled, stdout, stderr }));
    });
    child.on('close', (code) => {
      finish(commandResult(command, cwd, startedAt, started, { ok: !timedOut && !cancelled && code === 0, exit_code: code, timed_out: timedOut, cancelled, stdout, stderr }));
    });
  });
}

function caseParameters(testCase: ValidationTestpack['correctness']['cases'][number]): Record<string, unknown> {
  return {
    ...validationCaseParameters(testCase),
    critical: testCase.critical,
    weight: testCase.weight,
  };
}

function parseStructuredCorrectness(
  stdout: string,
  cases: ValidationTestpack['correctness']['cases'],
): CorrectnessCaseResult[] {
  const values: unknown[] = [];
  try {
    const parsed = JSON.parse(stdout) as unknown;
    values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  } catch {
    for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const payload = line.startsWith('PHYOPT_MEASUREMENT ') ? line.slice('PHYOPT_MEASUREMENT '.length) : line;
      try { values.push(JSON.parse(payload) as unknown); } catch { /* raw output remains on the command record */ }
    }
  }
  const byId = new Map(cases.map((testCase) => [testCase.case_id, testCase]));
  const seen = new Set<string>();
  const output: CorrectnessCaseResult[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const caseId = typeof item.case_id === 'string' ? item.case_id : typeof item.subject_id === 'string' ? item.subject_id : null;
    if (caseId === null || seen.has(caseId)) continue;
    const declared = byId.get(caseId);
    if (!declared) continue;
    const passed = item.passed === true || item.status === 'PASS' || item.status === 'PASSED' || item.value === 'PASS';
    const failed = item.passed === false || item.status === 'FAIL' || item.status === 'FAILED' || item.value === 'FAIL';
    if (!passed && !failed) continue;
    seen.add(caseId);
    const payload = item.domain_payload && typeof item.domain_payload === 'object' && !Array.isArray(item.domain_payload)
      ? item.domain_payload as Record<string, unknown>
      : {};
    output.push({
      case_id: caseId,
      parameters: caseParameters(declared),
      status: passed ? 'PASSED' : 'FAILED',
      error: typeof item.error === 'string' ? item.error : typeof payload.error_reason === 'string' ? payload.error_reason : null,
      command: null,
    });
  }
  return output;
}

function coverage(planned: number, results: readonly CorrectnessCaseResult[]): CorrectnessCoverage {
  const executed = results.filter((item) => item.status !== 'NOT_EXECUTED').length;
  const passed = results.filter((item) => item.status === 'PASSED').length;
  const failed = results.filter((item) => item.status === 'FAILED' || item.status === 'INVALID').length;
  return { planned, executed, passed, failed, complete: executed === planned };
}

function aggregateCaseCommands(commands: readonly CommandRunResult[], fallback: ValidationCommand, cwd: string): CommandRunResult | null {
  if (commands.length === 0) return null;
  return {
    command: fallback.executable,
    args: [...fallback.args],
    cwd,
    start_time: commands[0].start_time,
    end_time: commands[commands.length - 1].end_time,
    timeout_ms: fallback.timeout_ms,
    ok: commands.every((item) => item.ok),
    exit_code: commands.every((item) => item.ok) ? 0 : commands.find((item) => !item.ok)?.exit_code ?? null,
    timed_out: commands.some((item) => item.timed_out),
    cancelled: commands.some((item) => item.cancelled),
    stdout: commands.map((item) => item.stdout).join('\n'),
    stderr: commands.map((item) => item.stderr).filter(Boolean).join('\n'),
    duration_ms: commands.reduce((sum, item) => sum + item.duration_ms, 0),
  };
}

async function runCorrectnessCases(input: {
  workspace: string;
  testpack: ValidationTestpack;
  options: { testpackDir?: string; sourceRoot?: string; remote?: RemoteValidationSession; signal?: AbortSignal };
}): Promise<{ command: CommandRunResult; cases: CorrectnessCaseResult[]; coverage: CorrectnessCoverage; formalComplete: boolean; passed: boolean }> {
  const declared = input.testpack.correctness.cases;
  const base = input.testpack.correctness.command;
  if (declared.every((item) => item.args !== undefined)) {
    const results: CorrectnessCaseResult[] = [];
    const commands: CommandRunResult[] = [];
    for (const testCase of declared) {
      const command = { ...base, args: [...base.args, ...(testCase.args ?? [])] };
      const result = await runValidationCommand(command, input.workspace, input.options);
      commands.push(result);
      results.push({
        case_id: testCase.case_id,
        parameters: caseParameters(testCase),
        status: result.ok ? 'PASSED' : (result.cancelled || result.timed_out || result.exit_code === null ? 'INVALID' : 'FAILED'),
        error: result.ok ? null : (result.stderr.trim() || `command exited with ${result.exit_code ?? 'unknown status'}`),
        command: result,
      });
      if (result.cancelled) break;
    }
    const summary = coverage(declared.length, results);
    const aggregate = aggregateCaseCommands(commands, base, commands[0]?.cwd ?? input.workspace);
    if (!aggregate) throw new Error('correctness case inventory is empty');
    return {
      command: aggregate,
      cases: results,
      coverage: summary,
      formalComplete: summary.complete,
      passed: summary.complete && summary.passed >= input.testpack.correctness.pass_required && summary.failed === 0,
    };
  }

  // Compatibility for existing aggregate scripts. Structured per-case JSON can
  // qualify the result; an exit code alone remains usable for the old workflow
  // but is explicitly marked incomplete and cannot form formal Evidence.
  const command = await runValidationCommand(base, input.workspace, input.options);
  const results = parseStructuredCorrectness(command.stdout, declared).map(item => ({ ...item, command }));
  const summary = coverage(declared.length, results);
  const formalComplete = summary.complete;
  return {
    command,
    cases: results,
    coverage: summary,
    formalComplete,
    passed: formalComplete
      ? command.ok && summary.passed >= input.testpack.correctness.pass_required && summary.failed === 0
      : command.ok,
  };
}

/** 按固定顺序运行 BUILD、CORRECTNESS 和可选 PERFORMANCE。 */
export async function runValidationCycle(input: {
  workspace: string;
  testpack: ValidationTestpack;
  build: ValidationCommand;
  testpackDir?: string;
  sourceRoot?: string;
  remote?: RemoteValidationSession;
  includePerformance: boolean;
  signal?: AbortSignal;
}): Promise<ValidationCycleResult> {
  const options = { testpackDir: input.testpackDir, sourceRoot: input.sourceRoot, remote: input.remote, signal: input.signal };
  const build = await runValidationCommand(input.build, input.workspace, options);
  const notRunCoverage = { planned: input.testpack.correctness.cases.length, executed: 0, passed: 0, failed: 0, complete: false };
  if (!build.ok) return { build, correctness: null, correctness_cases: [], correctness_coverage: notRunCoverage, formal_correctness_complete: false, performance: null, passed: false };
  const correctness = await runCorrectnessCases({ workspace: input.workspace, testpack: input.testpack, options });
  if (!correctness.passed || !input.includePerformance) return { build, correctness: correctness.command, correctness_cases: correctness.cases, correctness_coverage: correctness.coverage, formal_correctness_complete: correctness.formalComplete, performance: null, passed: correctness.passed };
  const performance = await runValidationCommand(input.testpack.performance.command, input.workspace, options);
  return { build, correctness: correctness.command, correctness_cases: correctness.cases, correctness_coverage: correctness.coverage, formal_correctness_complete: correctness.formalComplete, performance, passed: performance.ok };
}

/** 将候选 commit 以完整源码 tar 上传到远端隔离目录，不上传 patch。 */
/** Rebuild the existing workflow view from runner-owned command facts. */
export function validationCycleFromCommandExecutions(input: {
  testpack: ValidationTestpack;
  commands: readonly CommandExecution[];
  includePerformance: boolean;
  steps?: readonly ExperimentExecutionStep[];
}): ValidationCycleResult {
  const ordered = [...input.commands].sort((left, right) => left.sequence - right.sequence);
  const buildFact = ordered.find((item) => item.step === 'BUILD');
  if (!buildFact) throw new Error('runner did not produce a BUILD command fact');
  const build = commandExecutionResult(buildFact);
  const notRunCoverage = { planned: input.testpack.correctness.cases.length, executed: 0, passed: 0, failed: 0, complete: false };
  if (!build.ok) {
    return { build, correctness: null, correctness_cases: [], correctness_coverage: notRunCoverage, formal_correctness_complete: false, performance: null, passed: false };
  }

  const correctnessFacts = ordered.filter((item) => item.step === 'CORRECTNESS');
  if (correctnessFacts.length === 0) {
    return { build, correctness: null, correctness_cases: [], correctness_coverage: notRunCoverage, formal_correctness_complete: false, performance: null, passed: false };
  }
  const correctnessCommands = correctnessFacts.map(commandExecutionResult);
  let correctness: CommandRunResult;
  let correctnessCases: CorrectnessCaseResult[];
  let correctnessCoverage: CorrectnessCoverage;
  let formalComplete: boolean;
  let correctnessPassed: boolean;
  const formalCases = input.steps?.filter(item => item.formal_context?.phase === 'CORRECTNESS_CASE');
  if (formalCases?.length || input.testpack.correctness.cases.every((item) => item.args !== undefined)) {
    correctnessCases = correctnessCommands.map((result, index) => {
      const context = formalCases?.[index]?.formal_context;
      const declared = context ? input.testpack.correctness.cases.find(item => item.case_id === context.subject_id) : input.testpack.correctness.cases[index];
      return {
        case_id: context?.subject_id ?? declared?.case_id ?? `undeclared-case-${index}`,
        parameters: context ? { ...context.parameters } : declared ? caseParameters(declared) : {},
        status: result.ok ? 'PASSED' : (result.cancelled || result.timed_out || result.exit_code === null ? 'INVALID' : 'FAILED'),
        error: result.ok ? null : (result.stderr.trim() || `command exited with ${result.exit_code ?? 'unknown status'}`),
        command: result,
      };
    });
    correctnessCoverage = coverage(input.testpack.correctness.cases.length, correctnessCases);
    formalComplete = correctnessCoverage.complete;
    correctnessPassed = formalComplete && correctnessCoverage.passed >= input.testpack.correctness.pass_required && correctnessCoverage.failed === 0;
    correctness = aggregateCaseCommands(correctnessCommands, input.testpack.correctness.command, correctnessCommands[0].cwd) as CommandRunResult;
  } else {
    correctness = correctnessCommands.length === 1
      ? correctnessCommands[0]
      : aggregateCaseCommands(correctnessCommands, input.testpack.correctness.command, correctnessCommands[0].cwd) as CommandRunResult;
    correctnessCases = correctnessCommands.flatMap(command => parseStructuredCorrectness(command.stdout, input.testpack.correctness.cases).map(item => ({ ...item, command })));
    correctnessCoverage = coverage(input.testpack.correctness.cases.length, correctnessCases);
    formalComplete = correctnessCoverage.complete;
    correctnessPassed = formalComplete
      ? correctness.ok && correctnessCoverage.passed >= input.testpack.correctness.pass_required && correctnessCoverage.failed === 0
      : correctness.ok;
  }
  const performanceFacts = ordered.filter((item) => item.step === 'PERFORMANCE');
  const performanceCommands = performanceFacts.map(commandExecutionResult);
  const performance = performanceCommands.length === 0
    ? null
    : performanceCommands.length === 1
      ? performanceCommands[0]
      : aggregateCaseCommands(performanceCommands, input.testpack.performance.command, performanceCommands[0].cwd);
  return {
    build,
    correctness,
    correctness_cases: correctnessCases,
    correctness_coverage: correctnessCoverage,
    formal_correctness_complete: formalComplete,
    performance,
    passed: correctnessPassed && (!input.includePerformance || performance?.ok === true),
  };
}

/** Lossless adapter from the shared command fact to the existing workflow view. */
export function commandExecutionResult(execution: CommandExecution): CommandRunResult {
  return {
    command_execution_id: execution.command_execution_id,
    resource_context: execution.resource_context ?? null,
    command: execution.command,
    args: [...execution.args],
    cwd: execution.cwd,
    start_time: execution.start_time,
    end_time: execution.end_time,
    timeout_ms: execution.timeout_ms,
    ok: !execution.timed_out && !execution.cancelled && execution.exit_code === 0,
    exit_code: execution.exit_code,
    timed_out: execution.timed_out,
    cancelled: execution.cancelled,
    stdout: execution.stdout,
    stderr: execution.stderr,
    duration_ms: execution.duration_ms,
  };
}

export async function stageRemoteCandidate(input: {
  workspace: CandidateWorkspaceState;
  transport: RemoteValidationTransport;
  remoteWorkspace: string;
  signal?: AbortSignal;
}): Promise<RemoteValidationSession> {
  input.signal?.throwIfAborted();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-source-'));
  const archive = path.join(tempRoot, 'candidate.tar');
  try {
    const exported = exportCandidateSourceArchive(input.workspace, archive);
    const remoteWorkspace = input.remoteWorkspace.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!remoteWorkspace.startsWith('/')) throw new Error('remote validation workspace must be absolute');
    const clear = await Promise.resolve(input.transport.runRemote(['bash', '-lc', `rm -rf -- ${shellQuote(remoteWorkspace)} && mkdir -p -- ${shellQuote(remoteWorkspace)}`]));
    if (clear.exit_code !== 0) throw new Error(clear.stderr || 'cannot create remote validation workspace');
    const remoteArchive = `${remoteWorkspace}/candidate.tar`;
    if (!input.transport.uploadFile) throw new Error('validation transport does not support full-source upload');
    const uploaded = await Promise.resolve(input.transport.uploadFile(archive, remoteArchive));
    if (uploaded.exit_code !== 0) throw new Error(uploaded.stderr || 'candidate source upload failed');
    const extracted = await Promise.resolve(input.transport.runRemote(['bash', '-lc', `tar -xf ${shellQuote(remoteArchive)} -C ${shellQuote(remoteWorkspace)} && rm -f -- ${shellQuote(remoteArchive)}`]));
    if (extracted.exit_code !== 0) throw new Error(extracted.stderr || 'candidate source extraction failed');
    return { transport: input.transport, remote_workspace: remoteWorkspace, source_root: input.workspace.repository, source_archive_sha256: exported.sha256 };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Stage a verified evaluator bundle outside the Candidate tree. The Runner
 * independently hashes this directory before and after every evaluator step.
 */
export async function stageRemoteEvaluator(input: {
  evaluatorRoot: string;
  expectedDigest: string;
  transport: RemoteValidationTransport;
  remoteWorkspace: string;
  signal?: AbortSignal;
}): Promise<StagedRemoteEvaluator> {
  input.signal?.throwIfAborted();
  const evaluatorRoot = path.resolve(input.evaluatorRoot);
  const observed = evaluatorBundleSha256(evaluatorRoot);
  if (observed.toLowerCase() !== input.expectedDigest.toLowerCase()) {
    throw new Error(`evaluator bundle digest mismatch before staging (expected ${input.expectedDigest}, observed ${observed})`);
  }
  const remoteWorkspace = input.remoteWorkspace.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!remoteWorkspace.startsWith('/')) throw new Error('remote evaluator workspace must be absolute');
  if (!input.transport.uploadFile) throw new Error('validation transport does not support evaluator upload');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-evaluator-'));
  const archive = path.join(tempRoot, 'evaluator.tar');
  try {
    const packed = spawnSync('tar', ['-cf', archive, '-C', evaluatorRoot, '.'], { encoding: 'utf8', windowsHide: true });
    if (packed.status !== 0) throw new Error(`cannot archive evaluator bundle: ${(packed.stderr ?? '').trim()}`);
    const clear = await Promise.resolve(input.transport.runRemote(['bash', '-lc', `rm -rf -- ${shellQuote(remoteWorkspace)} && mkdir -p -- ${shellQuote(remoteWorkspace)}`]));
    if (clear.exit_code !== 0) throw new Error(clear.stderr || 'cannot create remote evaluator workspace');
    const remoteArchive = `${remoteWorkspace}/evaluator.tar`;
    const uploaded = await Promise.resolve(input.transport.uploadFile(archive, remoteArchive));
    if (uploaded.exit_code !== 0) throw new Error(uploaded.stderr || 'evaluator bundle upload failed');
    const extracted = await Promise.resolve(input.transport.runRemote(['bash', '-lc', `tar -xf ${shellQuote(remoteArchive)} -C ${shellQuote(remoteWorkspace)} && rm -f -- ${shellQuote(remoteArchive)}`]));
    if (extracted.exit_code !== 0) throw new Error(extracted.stderr || 'evaluator bundle extraction failed');
    return { remote_workspace: remoteWorkspace, digest: observed };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Copy a declared, known Baseline into a Runner-owned directory that is
 * separate from both the Candidate and evaluator trees. Both the source and
 * staged copy must match the frozen artifact identity.
 */
export async function stageRemoteBaseline(input: {
  sourceArtifact: string;
  expectedDigest: string;
  transport: RemoteValidationTransport;
  remoteWorkspace: string;
  signal?: AbortSignal;
}): Promise<StagedRemoteBaseline> {
  input.signal?.throwIfAborted();
  const sourceArtifact = input.sourceArtifact.replace(/\\/g, '/');
  const remoteWorkspace = input.remoteWorkspace.replace(/\\/g, '/').replace(/\/+$/, '');
  const expectedDigest = input.expectedDigest.toLowerCase();
  if (!sourceArtifact.startsWith('/')) throw new Error('remote baseline source artifact must be absolute');
  if (!remoteWorkspace.startsWith('/')) throw new Error('remote baseline workspace must be absolute');
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) throw new Error('remote baseline digest must be a SHA-256 identity');

  const remoteSha256 = async (artifact: string, description: string): Promise<string> => {
    input.signal?.throwIfAborted();
    const result = await Promise.resolve(input.transport.runRemote(['bash', '-lc', `sha256sum -- ${shellQuote(artifact)}`]));
    if (result.exit_code !== 0) throw new Error(result.stderr || `cannot hash ${description}`);
    const digest = result.stdout.trim().match(/^([0-9a-fA-F]{64})(?:\s|$)/)?.[1]?.toLowerCase();
    if (!digest) throw new Error(`cannot parse SHA-256 identity for ${description}`);
    return digest;
  };

  const sourceDigest = await remoteSha256(sourceArtifact, 'remote baseline source artifact');
  if (sourceDigest !== expectedDigest) {
    throw new Error(`baseline source digest mismatch (expected ${expectedDigest}, observed ${sourceDigest})`);
  }

  input.signal?.throwIfAborted();
  const remoteArtifact = `${remoteWorkspace}/artifact.so`;
  const temporaryArtifact = `${remoteArtifact}.tmp`;
  if (sourceArtifact === remoteArtifact || sourceArtifact.startsWith(`${remoteWorkspace}/`)) {
    throw new Error('remote baseline source artifact must be outside its staging workspace');
  }
  const staged = await Promise.resolve(input.transport.runRemote([
    'bash',
    '-lc',
    `mkdir -p -- ${shellQuote(remoteWorkspace)} && rm -f -- ${shellQuote(temporaryArtifact)} ${shellQuote(remoteArtifact)} && cp -- ${shellQuote(sourceArtifact)} ${shellQuote(temporaryArtifact)} && mv -f -- ${shellQuote(temporaryArtifact)} ${shellQuote(remoteArtifact)}`,
  ]));
  if (staged.exit_code !== 0) throw new Error(staged.stderr || 'cannot stage remote baseline artifact');
  const stagedDigest = await remoteSha256(remoteArtifact, 'staged baseline artifact');
  if (stagedDigest !== expectedDigest) {
    throw new Error(`staged baseline digest mismatch (expected ${expectedDigest}, observed ${stagedDigest})`);
  }
  return { remote_artifact: remoteArtifact, digest: stagedDigest };
}

/** 在同一候选 tree 上执行正式和独立复验；每次复验前重建干净 worktree。 */
export async function runRevalidationCycle(input: {
  workspace: CandidateWorkspaceState;
  testpack: ValidationTestpack;
  build: ValidationCommand;
  testpackDir?: string;
  sourceRoot?: string;
  remote?: RemoteValidationSession;
  signal?: AbortSignal;
}): Promise<RevalidationCycleResult> {
  let remoteSession = input.remote;
  const runOne = async (requirement: ValidationTestpack['revalidation']['formal']): Promise<ValidationCycleResult | null> => {
    if (!requirement.required) return null;
    refreshValidationWorkspace(input.workspace);
    // 每次远端复验也重新展开同一候选源码，清除上一轮构建产物和缓存。
    if (remoteSession) {
      remoteSession = await stageRemoteCandidate({ workspace: input.workspace, transport: remoteSession.transport, remoteWorkspace: remoteSession.remote_workspace, signal: input.signal });
    }
    const build = await runValidationCommand({ ...input.build, timeout_ms: requirement.timeout_ms }, input.workspace.validation, { testpackDir: input.testpackDir, sourceRoot: input.sourceRoot, remote: remoteSession, signal: input.signal });
    const notRunCoverage = { planned: input.testpack.correctness.cases.length, executed: 0, passed: 0, failed: 0, complete: false };
    if (!build.ok) return { build, correctness: null, correctness_cases: [], correctness_coverage: notRunCoverage, formal_correctness_complete: false, performance: null, passed: false };
    const check = await runValidationCommand({ ...requirement.command, timeout_ms: requirement.timeout_ms }, input.workspace.validation, { testpackDir: input.testpackDir, sourceRoot: input.sourceRoot, remote: remoteSession, signal: input.signal });
    return { build, correctness: check, correctness_cases: [], correctness_coverage: notRunCoverage, formal_correctness_complete: false, performance: null, passed: check.ok };
  };
  const formal = await runOne(input.testpack.revalidation.formal);
  if (formal && !formal.passed) return { formal, independent: null, passed: false };
  const independent = await runOne(input.testpack.revalidation.independent);
  // Keep the persisted validation path clean for later approval and archive identity.
  refreshValidationWorkspace(input.workspace);
  return { formal, independent, passed: (formal?.passed ?? true) && (independent?.passed ?? true) };
}

/** 从性能命令的 JSON 数组或逐行 JSON 中读取逐测例证据。 */
export function parsePerformanceMeasurements(stdout: string): PerformanceCaseMeasurement[] {
  const candidates: unknown[] = [];
  try { candidates.push(JSON.parse(stdout)); } catch { /* try line-delimited JSON */ }
  if (candidates.length === 0) {
    for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const payload = line.startsWith('PHYOPT_MEASUREMENT ') ? line.slice('PHYOPT_MEASUREMENT '.length) : line;
      try { candidates.push(JSON.parse(payload)); } catch { /* raw output remains on the command fact */ }
    }
  }
  const values = candidates.flatMap((value) => Array.isArray(value) ? value : [value]);
  const grouped = new Map<string, { baseline: Array<{ index: number; value: number }>; candidate: Array<{ index: number; value: number }> }>();
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    if (item.kind !== 'PERFORMANCE_SAMPLE' || typeof item.subject_id !== 'string' ||
        (item.role !== 'BASELINE' && item.role !== 'CANDIDATE') || !Number.isInteger(item.sample_index) ||
        typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value <= 0) continue;
    const entry = grouped.get(item.subject_id) ?? { baseline: [], candidate: [] };
    entry[item.role === 'BASELINE' ? 'baseline' : 'candidate'].push({ index: item.sample_index as number, value: item.value });
    grouped.set(item.subject_id, entry);
  }
  if (grouped.size > 0) {
    return [...grouped].map(([case_id, samples]) => ({
      case_id,
      baseline_samples: samples.baseline.sort((left, right) => left.index - right.index).map((item) => item.value),
      candidate_samples: samples.candidate.sort((left, right) => left.index - right.index).map((item) => item.value),
    }));
  }
  return values.filter((value): value is PerformanceCaseMeasurement => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    const legacy = typeof item.candidate_time === 'number' && typeof item.comparison_time === 'number';
    const raw = Array.isArray(item.candidate_samples) && Array.isArray(item.baseline_samples) &&
      item.candidate_samples.every((sample) => typeof sample === 'number') && item.baseline_samples.every((sample) => typeof sample === 'number');
    return typeof item.case_id === 'string' && (legacy || raw);
  }).map((value) => ({
    case_id: value.case_id,
    ...(typeof value.candidate_time === 'number' ? { candidate_time: value.candidate_time } : {}),
    ...(typeof value.comparison_time === 'number' ? { comparison_time: value.comparison_time } : {}),
    ...(Array.isArray(value.candidate_samples) ? { candidate_samples: [...value.candidate_samples] } : {}),
    ...(Array.isArray(value.baseline_samples) ? { baseline_samples: [...value.baseline_samples] } : {}),
    ...(typeof value.current_time === 'number' ? { current_time: value.current_time } : {}),
    ...(typeof value.ci_lower === 'number' ? { ci_lower: value.ci_lower } : {}),
  }));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

/** 计算性能停止线；候选必须同时满足整体和关键测例的下限。 */
export function evaluatePerformanceGate(testpack: ValidationTestpack, measurements: readonly PerformanceCaseMeasurement[]): PerformanceGateResult {
  const ratios: Record<string, number> = {};
  const weighted: Array<{ ratio: number; weight: number }> = [];
  const workloads: PerformanceWorkloadResult[] = [];
  for (const measurement of measurements) {
    const candidateSamples = measurement.candidate_samples?.filter((value) => Number.isFinite(value) && value > 0) ?? (typeof measurement.candidate_time === 'number' ? [measurement.candidate_time] : []);
    const baselineSamples = measurement.baseline_samples?.filter((value) => Number.isFinite(value) && value > 0) ?? (typeof measurement.comparison_time === 'number' ? [measurement.comparison_time] : []);
    const candidateMedian = median(candidateSamples);
    const baselineMedian = median(baselineSamples);
    if (!(candidateMedian > 0) || !(baselineMedian > 0)) continue;
    const ratio = baselineMedian / candidateMedian;
    ratios[measurement.case_id] = ratio;
    const declared = testpack.performance.cases.find((item) => item.case_id === measurement.case_id);
    const weight = declared?.weight ?? 0;
    if (weight > 0) weighted.push({ ratio, weight });
    const critical = declared?.critical ?? testpack.performance.key_cases.includes(measurement.case_id);
    workloads.push({
      case_id: measurement.case_id,
      baseline_samples: [...baselineSamples],
      candidate_samples: [...candidateSamples],
      baseline_median: baselineMedian,
      candidate_median: candidateMedian,
      speedup: ratio,
      critical,
      regression: critical && (measurement.ci_lower ?? ratio) < testpack.performance.thresholds.key_case_ci_lower_min,
      ...(typeof measurement.ci_lower === 'number' ? { ci_lower: measurement.ci_lower } : {}),
    });
  }
  const weightTotal = weighted.reduce((sum, item) => sum + item.weight, 0);
  const weightedGeomean = weightTotal > 0 ? Math.exp(weighted.reduce((sum, item) => sum + item.weight * Math.log(item.ratio), 0) / weightTotal) : 0;
  const lowerBounds = measurements.map((item) => item.ci_lower ?? ratios[item.case_id] ?? 0).filter((value) => value > 0);
  const overall = lowerBounds.length > 0 ? Math.min(...lowerBounds) : 0;
  const key = testpack.performance.key_cases.map((id) => measurements.find((item) => item.case_id === id)?.ci_lower ?? ratios[id] ?? 0);
  const keyLower = key.length > 0 ? Math.min(...key) : 0;
  const thresholds = testpack.performance.thresholds;
  const passed = weightedGeomean >= thresholds.weighted_geomean_min && overall >= thresholds.overall_ci_lower_min && keyLower >= thresholds.key_case_ci_lower_min;
  return {
    passed,
    weighted_geomean: weightedGeomean,
    overall_ci_lower: overall,
    key_case_ci_lower: keyLower,
    case_ratios: ratios,
    workloads,
    reason: passed ? 'performance thresholds satisfied' : `performance thresholds not satisfied (weighted=${weightedGeomean}, overall=${overall}, key=${keyLower})`,
  };
}

function failureSummary(result: CommandRunResult | null): string | null {
  if (!result || result.ok) return null;
  const text = (result.stderr.trim() || result.stdout.trim() || `command exited with ${result.exit_code ?? 'unknown status'}`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('\n');
  return text.slice(0, 4000);
}

/** Bounded structured feedback for the next Agent turn; raw output stays in the Experiment store. */
export function structuredAgentFeedback(result: ValidationCycleResult, performance: PerformanceGateResult | null = null): Record<string, unknown> {
  const evaluation = candidateEvaluationFeedback({ validation: result, performance });
  return {
    candidate_evaluation: evaluation,
    build: { passed: result.build.ok, exit_code: result.build.exit_code, summary: failureSummary(result.build) },
    correctness: {
      passed: result.correctness?.ok === true && result.correctness_coverage.failed === 0,
      formal_complete: result.formal_correctness_complete,
      coverage: result.correctness_coverage,
      failed_cases: evaluation.failed_cases,
      summary: failureSummary(result.correctness),
    },
    performance: performance ? {
      passed: performance.passed,
      reason: performance.reason,
      workloads: performance.workloads.map((item) => ({ workload_id: item.case_id, baseline_median: item.baseline_median, candidate_median: item.candidate_median, speedup: item.speedup, critical: item.critical, regression: item.regression })),
    } : result.performance ? { passed: result.performance.ok, summary: failureSummary(result.performance) } : { status: 'NOT_EXECUTED' },
  };
}

/** 将验证结果适配为 Agent 工具文本，不写入任何 API 凭据。 */
export function validationResultToolText(result_: ValidationCycleResult): WorkspaceToolResult {
  return { isError: !result_.passed, text: JSON.stringify(structuredAgentFeedback(result_)) };
}
