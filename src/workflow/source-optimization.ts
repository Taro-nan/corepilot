import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadOptimizationConfig, resolveOptimizationApiKey, resolveOptimizationProxy, type LoadedOptimizationConfig, type ResolvedModelCredential } from '../config/optimization-config.js';
import type { PublicWorkflowRequest } from '../contracts/public-workflow.js';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';
import type { CreateOptimizationTaskInput } from '../core/optimization-runtime.js';
import { resolveSourceBranch, sourceDirectory } from '../workspace/git-repository.js';
import { initialOptimizationWorkflowRecord } from './optimization-workflow.js';
import { resolveOptimizationBudget } from '../contracts/optimization-session.js';
import { isRegisteredRunner } from '../config/runner-config.js';
import type { ExecutionMachineIdentity, ExecutionMachineRecord } from '../contracts/execution-machine.js';
import type { TargetConfig } from '../config/target-config.js';
import type { RunnerMachineInfo } from '../contracts/runner-rpc.js';

export type SourceOptimizationTarget =
  | { kind: 'registered'; identity: ExecutionMachineIdentity; configuration: TargetConfig | null;
      cached_hardware: { source: 'REGISTRY_CACHE'; observed_at: string; machine: RunnerMachineInfo } | null }
  | { kind: 'unresolved'; machine_id: string }
  | { kind: 'unspecified'; configuration: TargetConfig };

export interface SourceOptimizationPreflightOptions {
  cliApiKey?: string;
  env?: NodeJS.ProcessEnv;
  readMachine?: (id: string) => ExecutionMachineRecord | null;
}

export interface SourceOptimizationPreflight {
  request: PublicWorkflowRequest;
  config: LoadedOptimizationConfig;
  repository: string;
  source?: { branch: string; commit: string };
  credential: ResolvedModelCredential;
  model_proxy?: string;
  targetContext: SourceOptimizationTarget;
}

/** Source preparation never loads a testpack, qualifies an evaluator or contacts a Runner. */
export function loadSourceOptimizationPreflight(request: PublicWorkflowRequest, options: SourceOptimizationPreflightOptions = {}): SourceOptimizationPreflight {
  if (request.verification_mode !== 'source_only') throw new Error('源码优化预检只接受 source_only 模式。');
  if (request.enable_performance) throw new Error('仅优化源码不执行性能测试，请选择优化并验证。');
  const config = loadOptimizationConfig(request.config_path);
  const machineId = request.machine_id ?? (isRegisteredRunner(config.config.runner) ? config.config.runner.machine_id : undefined);
  const machine = machineId ? options.readMachine?.(machineId) : undefined;
  if (machineId && options.readMachine && !machine) throw new Error('选择的目标机器不存在，请重新选择已注册机器，或清除机器选择后进行源码优化。');
  const targetContext: SourceOptimizationTarget = machine ? {
    kind: 'registered', identity: { machine_id: machine.machine_id, name: machine.name, revision: machine.revision },
    configuration: machine.target ? structuredClone(machine.target) : null,
    cached_hardware: machine.last_success ? { source: 'REGISTRY_CACHE', observed_at: machine.last_success.checked_at, machine: structuredClone(machine.last_success.machine) } : null,
  } : machineId ? { kind: 'unresolved', machine_id: machineId }
    : { kind: 'unspecified', configuration: structuredClone(config.config.target) };
  const repository = sourceDirectory(request.repository_root ?? config.configDir);
  const source = request.source_branch === undefined ? undefined : resolveSourceBranch(repository, request.source_branch);
  const credential = resolveOptimizationApiKey(config.config, options);
  const modelProxy = resolveOptimizationProxy(config.config, options)?.proxy;
  return { request, config, repository, credential, targetContext, ...(source ? { source } : {}), ...(modelProxy ? { model_proxy: modelProxy } : {}) };
}

/** Credentials/model versions may change on continuation; the source task's meaning may not. */
export function sourceOptimizationContractDigest(preflight: SourceOptimizationPreflight): string {
  return createHash('sha256').update(JSON.stringify({
    verification_mode: 'source_only', function_name: preflight.request.function_name,
    entry_file: preflight.request.entry_file, repository: path.resolve(preflight.repository),
    target: preflight.targetContext.kind === 'registered'
      ? { kind: 'registered', identity: preflight.targetContext.identity, configuration: preflight.targetContext.configuration }
      : preflight.targetContext,
    build: preflight.config.config.build,
  })).digest('hex');
}

export function sourceOptimizationIntake(workflowId: string, preflight: SourceOptimizationPreflight): { record: OptimizationWorkflowRecord; task: CreateOptimizationTaskInput } {
  const { request, config, repository, source } = preflight;
  const record = initialOptimizationWorkflowRecord(workflowId, {
    functionName: request.function_name, entryFile: request.entry_file,
    configPath: config.configPath, repositoryRoot: repository, configFileSha256: config.rawSha256,
    enablePerformance: false,
  });
  record.verification_mode = 'source_only';
  record.session_budget = resolveOptimizationBudget(request.budget);
  record.execution_contract_digest = sourceOptimizationContractDigest(preflight);
  if (preflight.targetContext.kind === 'registered') record.execution_machine = { ...preflight.targetContext.identity };
  if (source) { record.source_branch = source.branch; record.baseline_commit = source.commit; }
  record.progress = { phase: 'PUBLIC_INTAKE_VALIDATED', last_event: '源码优化输入已检查；本任务仅生成候选补丁。' };
  return { record, task: {
    workflowId,
    target: { kind: 'software_function', name: request.function_name, scope: {
      verification_mode: 'source_only', repository_root: repository, entry_file: request.entry_file,
      ...(source ? { source_branch: source.branch } : {}),
    } },
    sourceBaseline: source ? { id: `git:${source.commit}`, digest: source.commit, details: { repository, source_branch: source.branch } }
      : { id: `repository:${repository}`, details: { state: 'UNRESOLVED' } },
    evaluator: null, performanceBaseline: null,
    declaredContext: {
      verification_mode: 'source_only', target: structuredClone(preflight.targetContext),
      ...(preflight.targetContext.kind === 'registered' ? { requested_machine_id: preflight.targetContext.identity.machine_id }
        : preflight.targetContext.kind === 'unresolved' ? { requested_machine_id: preflight.targetContext.machine_id } : {}),
      validation: { build: 'NOT_EXECUTED', correctness: 'NOT_EXECUTED', performance: 'NOT_EXECUTED' },
    },
  } };
}
