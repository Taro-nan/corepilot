import path from 'node:path';
import { resolveOptimizationBudget, type OptimizationSessionBudget } from './optimization-session.js';

export type OptimizationVerificationMode = 'verified' | 'source_only';

/** HTTP 层公开 optimize 请求；配置正文由 config_path 指向的 YAML 解析。 */
export interface PublicWorkflowRequest {
  /** Source-only freezes a proposed patch without claiming test or performance results. */
  verification_mode?: OptimizationVerificationMode;
  budget?: OptimizationSessionBudget;
  function_name: string;
  entry_file: string | null;
  config_path: string;
  /** CLI 从调用目录派生出的算法库根目录；直接调用 HTTP 时可省略。 */
  repository_root?: string;
  /** Exact local branch, resolved to a frozen commit at submission. */
  source_branch?: string;
  /** Registered execution machine selected for this submission. */
  machine_id?: string;
  /** 可选性能闭环开关；未提供时默认只做构建和正确性。 */
  enable_performance?: boolean;
}

/** 可选的单次模型凭据请求头；服务端只在内存中使用，不持久化。 */
export const COREPILOT_MODEL_API_KEY_HEADER = 'x-corepilot-model-api-key';

export class PublicWorkflowRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicWorkflowRequestError';
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new PublicWorkflowRequestError(`${field} is required and must be a string`);
  return value.trim();
}

/** 解析 HTTP 工作流入口；不接受 source_files 作为修改范围。 */
export function parsePublicWorkflowRequest(value: unknown): PublicWorkflowRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PublicWorkflowRequestError('request body must be an object');
  const body = value as Record<string, unknown>;
  const functionName = requiredString(body.function_name, 'function_name');
  const configPath = requiredString(body.config_path, 'config_path');
  const repositoryRoot = body.repository_root === undefined
    ? undefined
    : requiredString(body.repository_root, 'repository_root');
  if (repositoryRoot !== undefined && !path.isAbsolute(repositoryRoot)) throw new PublicWorkflowRequestError('repository_root must be an absolute path');
  const entryFile = body.entry_file === undefined || body.entry_file === null ? null : requiredString(body.entry_file, 'entry_file');
  if (body.enable_performance !== undefined && typeof body.enable_performance !== 'boolean') {
    throw new PublicWorkflowRequestError('enable_performance must be boolean when present');
  }
  if (body.verification_mode !== undefined && body.verification_mode !== 'verified' && body.verification_mode !== 'source_only') {
    throw new PublicWorkflowRequestError('verification_mode must be verified or source_only');
  }
  if (body.verification_mode === 'source_only' && body.enable_performance === true) {
    throw new PublicWorkflowRequestError('仅优化源码不执行性能测试，请关闭性能测量或选择优化并验证。');
  }
  let budget: OptimizationSessionBudget | undefined;
  if (body.budget !== undefined) {
    if (!body.budget || typeof body.budget !== 'object' || Array.isArray(body.budget)) throw new PublicWorkflowRequestError('budget must be an object');
    const input = body.budget as Record<string, unknown>;
    if (Object.keys(input).some(key => !['time_limit_ms', 'max_candidates'].includes(key))) throw new PublicWorkflowRequestError('unknown optimization budget field');
    try { budget = resolveOptimizationBudget(input); }
    catch (error) { throw new PublicWorkflowRequestError((error as Error).message); }
  }
  return {
    function_name: functionName,
    entry_file: entryFile,
    config_path: configPath,
    ...(body.verification_mode === undefined ? {} : { verification_mode: body.verification_mode }),
    ...(budget ? { budget } : {}),
    ...(repositoryRoot === undefined ? {} : { repository_root: path.resolve(repositoryRoot) }),
    ...(body.source_branch === undefined ? {} : { source_branch: requiredString(body.source_branch, 'source_branch') }),
    ...(body.machine_id === undefined ? {} : { machine_id: requiredString(body.machine_id, 'machine_id') }),
    ...(body.enable_performance === undefined ? {} : { enable_performance: body.enable_performance }),
  };
}
