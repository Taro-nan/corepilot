import path from 'node:path';

/** HTTP 层公开 optimize 请求；配置正文由 config_path 指向的 YAML 解析。 */
export interface PublicWorkflowRequest {
  function_name: string;
  entry_file: string | null;
  config_path: string;
  /** CLI 从调用目录派生出的算法库根目录；直接调用 HTTP 时可省略。 */
  repository_root?: string;
  /** 可选性能闭环开关；未提供时默认只做构建和正确性。 */
  enable_performance?: boolean;
}

/** 可选的单次模型凭据请求头；服务端只在内存中使用，不持久化。 */
export const PHYOPT_MODEL_API_KEY_HEADER = 'x-phyopt-model-api-key';

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
  return {
    function_name: functionName,
    entry_file: entryFile,
    config_path: configPath,
    ...(repositoryRoot === undefined ? {} : { repository_root: path.resolve(repositoryRoot) }),
    ...(body.enable_performance === undefined ? {} : { enable_performance: body.enable_performance }),
  };
}
