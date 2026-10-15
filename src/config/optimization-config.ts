import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readStoredApiKey } from './credentials.js';
import { DEFAULT_WORKSPACE_ROOT, type TargetConfig } from './target-config.js';
import { DEFAULT_BUILD_CWD, DEFAULT_BUILD_TIMEOUT_MS } from './build-config.js';
import type { LibraryPackageSelection } from '../contracts/library-package.js';
import { validateLibraryPackageSelection } from '../library-package/loader.js';

export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type RunnerMode = 'legacy' | 'rpc';

export type RunnerConfig =
  | { mode: 'legacy' }
  | {
      mode: 'rpc';
      endpoint: string;
      token: string;
      request_timeout_ms: number;
      poll_interval_ms: number;
    };

/**
 * 面向 `phyopt optimize` 的最终公开 YAML 契约。
 *
 * 这里故意不包含项目目录、后台服务、授权、补丁或模型循环预算。
 * 这些信息分别由 Git 预检、服务启动参数和 PhyOpt 内部运行状态负责。
 */
export interface OptimizationConfig {
  model: {
    model_id: string;
    api_key?: string;
    endpoint: string;
    proxy?: string;
    reasoning_effort?: ReasoningEffort;
    /** Maximum output budget for one model turn, including provider reasoning tokens. */
    max_output_tokens?: number;
    /** A value of 0 disables the local timeout for one model request. */
    timeout_ms: number;
    /** Maximum silence between model stream events; unlike timeout_ms this is not a total-duration limit. */
    inactivity_timeout_ms?: number;
  };
  target: TargetConfig;
  build: {
    executable: string;
    args: string[];
    cwd: string;
    environment: Record<string, string>;
    timeout_ms: number;
  };
  validation: {
    testpack: string;
    library_package?: LibraryPackageSelection;
    baseline_artifact?: string;
  };
  /** Omitted configuration preserves the pre-runner legacy execution path. */
  runner?: RunnerConfig;
  output_dir: string;
}

export type ResolvedRunnerConfig =
  | { mode: 'legacy' }
  | {
      mode: 'rpc';
      endpoint: string;
      token: string;
      requestTimeoutMs: number;
      pollIntervalMs: number;
    };

export interface LoadedOptimizationConfig {
  config: OptimizationConfig;
  configPath: string;
  configDir: string;
  rawSha256: string;
}

export interface ResolvedModelCredential {
  apiKey: string;
  source: 'cli' | 'env_override' | 'yaml' | 'credentials' | `env:${string}`;
}

const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export class OptimizationConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'OptimizationConfigError';
  }
}

const TOP_LEVEL_KEYS = ['model', 'target', 'build', 'validation', 'runner', 'output_dir'] as const;
const MODEL_KEYS = ['model_id', 'api_key', 'endpoint', 'proxy', 'reasoning_effort', 'max_output_tokens', 'timeout_ms', 'inactivity_timeout_ms'] as const;
const TARGET_KEYS = ['ssh_alias', 'host', 'username', 'port', 'identity_file', 'workspace_root'] as const;
const BUILD_KEYS = ['executable', 'args', 'cwd', 'environment', 'timeout_ms'] as const;
const VALIDATION_KEYS = ['testpack', 'library_package', 'baseline_artifact'] as const;
const RUNNER_KEYS = ['mode', 'endpoint', 'token', 'request_timeout_ms', 'poll_interval_ms'] as const;
const DEFAULT_RUNNER_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RUNNER_POLL_INTERVAL_MS = 250;
const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_MODEL_INACTIVITY_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string, problems: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    problems.push(`${field} must be a mapping`);
    return {};
  }
  return value;
}

function checkUnknown(value: Record<string, unknown>, allowed: readonly string[], field: string, problems: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) problems.push(`${field}.${key} is not supported`);
  }
}

function readRequiredString(value: Record<string, unknown>, key: string, field: string, problems: string[]): string {
  const raw = value[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    problems.push(`${field}.${key} must be a non-empty string`);
    return '';
  }
  return raw.trim();
}

function readOptionalString(value: Record<string, unknown>, key: string, field: string, problems: string[]): string | undefined {
  if (!(key in value) || value[key] === undefined) return undefined;
  const raw = value[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    problems.push(`${field}.${key} must be a non-empty string when provided`);
    return undefined;
  }
  return raw.trim();
}

/** Model calls may deliberately be unbounded; 0 is the explicit opt-out. */
function readNonNegativeInteger(value: Record<string, unknown>, key: string, field: string, problems: string[]): number {
  const raw = value[key];
  if (!Number.isInteger(raw) || (raw as number) < 0) {
    problems.push(`${field}.${key} must be a non-negative integer (0 disables the model-call timeout)`);
    return 0;
  }
  return raw as number;
}

function readOptionalPositiveInteger(value: Record<string, unknown>, key: string, field: string, problems: string[], fallback: number): number {
  if (!(key in value) || value[key] === undefined) return fallback;
  const raw = value[key];
  if (!Number.isInteger(raw) || (raw as number) < 1) {
    problems.push(`${field}.${key} must be a positive integer`);
    return fallback;
  }
  return raw as number;
}

function readStringArray(value: Record<string, unknown>, key: string, field: string, problems: string[]): string[] {
  const raw = value[key];
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) {
    problems.push(`${field}.${key} must be a string array`);
    return [];
  }
  return raw.map((item) => (item as string).trim());
}

function readStringMap(value: Record<string, unknown>, key: string, field: string, problems: string[]): Record<string, string> {
  const raw = value[key];
  if (!isRecord(raw)) {
    problems.push(`${field}.${key} must be a string mapping`);
    return {};
  }
  const output: Record<string, string> = {};
  for (const [name, item] of Object.entries(raw)) {
    if (typeof item !== 'string') problems.push(`${field}.${key}.${name} must be a string`);
    else output[name] = item;
  }
  return output;
}

function validateEndpoint(endpoint: string, problems: string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    problems.push('model.endpoint must be a valid http(s) URL');
    return endpoint;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    problems.push('model.endpoint must use http or https');
  }
  if (parsed.pathname.replace(/\/+$/, '').endsWith('/chat/completions')) {
    problems.push('model.endpoint must be the API base URL, not a /chat/completions URL');
  }
  return endpoint.replace(/\/+$/, '');
}

function validateRunnerEndpoint(endpoint: string, problems: string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    problems.push('runner.endpoint must be a valid http(s) URL');
    return endpoint;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') problems.push('runner.endpoint must use http or https');
  if (parsed.username || parsed.password) problems.push('runner.endpoint must not contain credentials');
  return endpoint.replace(/\/+$/, '');
}

function validateProxy(proxy: string, problems: string[]): string {
  if (ENV_REFERENCE.test(proxy)) return proxy;
  let parsed: URL;
  try {
    parsed = new URL(proxy);
  } catch {
    problems.push('model.proxy must be a valid http(s) or socks5 URL');
    return proxy;
  }
  if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol)) {
    problems.push('model.proxy must use http, https, or socks5');
  }
  if (!parsed.hostname) problems.push('model.proxy must include a proxy host');
  return proxy.replace(/\/+$/, '');
}

function validateAbsoluteRemotePath(value: string, field: string, problems: string[]): string {
  // target.workspace_root is normally a POSIX path on the SSH host. Accept
  // Windows absolute paths as well for local/mock target tests.
  const absolute = path.isAbsolute(value) || /^\/[A-Za-z0-9._-]/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
  if (!absolute) problems.push(`${field} must be an absolute path`);
  if (value === '/' || /^[A-Za-z]:[\\/]?$/.test(value)) problems.push(`${field} must not be a filesystem root`);
  return value.replace(/[\\/]$/, '') || value;
}

function validateIdentityFile(value: string, field: string, problems: string[]): string {
  const absolute = path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('~/') || value.startsWith('~\\');
  if (!absolute) problems.push(`${field} must be an absolute local path or a path under ~`);
  return value;
}

/** Validate an already parsed YAML value against the public contract. */
export function parseOptimizationConfig(value: unknown, configDir = process.cwd()): OptimizationConfig {
  const problems: string[] = [];
  const root = requireRecord(value, 'config', problems);
  checkUnknown(root, TOP_LEVEL_KEYS, 'config', problems);

  const modelValue = requireRecord(root.model, 'model', problems);
  checkUnknown(modelValue, MODEL_KEYS, 'model', problems);
  const modelId = readRequiredString(modelValue, 'model_id', 'model', problems);
  const modelApiKey = readOptionalString(modelValue, 'api_key', 'model', problems);
  const modelEndpointRaw = readRequiredString(modelValue, 'endpoint', 'model', problems);
  const modelEndpoint = modelEndpointRaw ? validateEndpoint(modelEndpointRaw, problems) : '';
  const modelProxyRaw = readOptionalString(modelValue, 'proxy', 'model', problems);
  const modelProxy = modelProxyRaw === undefined ? undefined : validateProxy(modelProxyRaw, problems);
  const modelReasoningRaw = readOptionalString(modelValue, 'reasoning_effort', 'model', problems);
  const modelReasoningEffort = modelReasoningRaw === undefined
    ? undefined
    : REASONING_EFFORTS.includes(modelReasoningRaw as ReasoningEffort)
      ? modelReasoningRaw as ReasoningEffort
      : (problems.push(`model.reasoning_effort must be one of: ${REASONING_EFFORTS.join(', ')}`), undefined);
  const modelMaxOutputTokens = readOptionalPositiveInteger(modelValue, 'max_output_tokens', 'model', problems, DEFAULT_MODEL_MAX_OUTPUT_TOKENS);
  const modelTimeout = readNonNegativeInteger(modelValue, 'timeout_ms', 'model', problems);
  const modelInactivityTimeout = readOptionalPositiveInteger(modelValue, 'inactivity_timeout_ms', 'model', problems, DEFAULT_MODEL_INACTIVITY_TIMEOUT_MS);

  const targetValue = requireRecord(root.target, 'target', problems);
  checkUnknown(targetValue, TARGET_KEYS, 'target', problems);
  const sshAlias = readOptionalString(targetValue, 'ssh_alias', 'target', problems);
  const host = readOptionalString(targetValue, 'host', 'target', problems);
  const username = readOptionalString(targetValue, 'username', 'target', problems);
  const port = readOptionalPositiveInteger(targetValue, 'port', 'target', problems, 22);
  const identityFileRaw = readOptionalString(targetValue, 'identity_file', 'target', problems);
  const identityFile = identityFileRaw === undefined ? undefined : validateIdentityFile(identityFileRaw, 'target.identity_file', problems);
  const workspaceRootRaw = readOptionalString(targetValue, 'workspace_root', 'target', problems);
  const workspaceRoot = validateAbsoluteRemotePath(workspaceRootRaw ?? DEFAULT_WORKSPACE_ROOT, 'target.workspace_root', problems);

  const directFieldsPresent = host !== undefined || username !== undefined || 'port' in targetValue || 'identity_file' in targetValue;
  let target: TargetConfig;
  if (sshAlias !== undefined && directFieldsPresent) {
    problems.push('target must use either ssh_alias or host/username, not both');
    target = { ssh_alias: sshAlias, workspace_root: workspaceRoot };
  } else if (sshAlias !== undefined) {
    target = { ssh_alias: sshAlias, workspace_root: workspaceRoot };
  } else {
    if (host === undefined) problems.push('target.host must be provided when ssh_alias is omitted');
    if (username === undefined) problems.push('target.username must be provided when ssh_alias is omitted');
    target = {
      host: host ?? '',
      username: username ?? '',
      port,
      ...(identityFile === undefined ? {} : { identity_file: identityFile }),
      workspace_root: workspaceRoot,
    };
  }

  const packageSelected = isRecord(root.validation) && root.validation.library_package !== undefined;
  const buildValue = requireRecord(root.build ?? (packageSelected ? { args: [] } : undefined), 'build', problems);
  checkUnknown(buildValue, BUILD_KEYS, 'build', problems);
  const executableRaw = buildValue.executable;
  const executable = executableRaw === undefined
    ? ''
    : typeof executableRaw === 'string'
      ? executableRaw.trim()
      : (problems.push('build.executable must be a string when provided'), '');
  const args = readStringArray(buildValue, 'args', 'build', problems);
  const cwd = 'cwd' in buildValue ? readRequiredString(buildValue, 'cwd', 'build', problems) : DEFAULT_BUILD_CWD;
  const environment = 'environment' in buildValue ? readStringMap(buildValue, 'environment', 'build', problems) : {};
  const buildTimeout = readOptionalPositiveInteger(buildValue, 'timeout_ms', 'build', problems, DEFAULT_BUILD_TIMEOUT_MS);

  const validationValue = requireRecord(root.validation, 'validation', problems);
  checkUnknown(validationValue, VALIDATION_KEYS, 'validation', problems);
  let libraryPackage: LibraryPackageSelection | undefined;
  if (packageSelected) {
    try { libraryPackage = validateLibraryPackageSelection(validationValue.library_package); }
    catch (error) { problems.push((error as Error).message); }
    if ('testpack' in validationValue) problems.push('validation.testpack and library_package are mutually exclusive');
    if (root.build !== undefined) problems.push('build is owned by the selected library package; omit config.build');
  } else if ('baseline_artifact' in validationValue) problems.push('validation.baseline_artifact requires library_package');
  const baselineArtifact = packageSelected ? readRequiredString(validationValue, 'baseline_artifact', 'validation', problems) : undefined;
  const testpackRaw = packageSelected ? '' : readRequiredString(validationValue, 'testpack', 'validation', problems);
  const testpack = testpackRaw && !path.isAbsolute(testpackRaw)
    ? path.resolve(configDir, testpackRaw)
    : testpackRaw;

  let runner: RunnerConfig | undefined;
  if (root.runner !== undefined) {
    const runnerValue = requireRecord(root.runner, 'runner', problems);
    checkUnknown(runnerValue, RUNNER_KEYS, 'runner', problems);
    const mode = readRequiredString(runnerValue, 'mode', 'runner', problems);
    if (mode === 'legacy') {
      for (const field of RUNNER_KEYS.slice(1)) {
        if (field in runnerValue) problems.push(`runner.${field} is not used in legacy mode`);
      }
      runner = { mode: 'legacy' };
    } else if (mode === 'rpc') {
      const endpoint = validateRunnerEndpoint(readRequiredString(runnerValue, 'endpoint', 'runner', problems), problems);
      const token = readRequiredString(runnerValue, 'token', 'runner', problems);
      const requestTimeout = readOptionalPositiveInteger(runnerValue, 'request_timeout_ms', 'runner', problems, DEFAULT_RUNNER_REQUEST_TIMEOUT_MS);
      const pollInterval = readOptionalPositiveInteger(runnerValue, 'poll_interval_ms', 'runner', problems, DEFAULT_RUNNER_POLL_INTERVAL_MS);
      runner = { mode: 'rpc', endpoint, token, request_timeout_ms: requestTimeout, poll_interval_ms: pollInterval };
    } else {
      problems.push('runner.mode must be legacy or rpc');
    }
  }

  const outputRaw = readRequiredString(root, 'output_dir', 'config', problems);
  const outputDir = outputRaw && !path.isAbsolute(outputRaw)
    ? path.resolve(configDir, outputRaw)
    : outputRaw;

  if (problems.length > 0) throw new OptimizationConfigError(problems);
  return {
    model: {
      model_id: modelId,
      ...(modelApiKey === undefined ? {} : { api_key: modelApiKey }),
      endpoint: modelEndpoint,
      ...(modelProxy === undefined ? {} : { proxy: modelProxy }),
      ...(modelReasoningEffort === undefined ? {} : { reasoning_effort: modelReasoningEffort }),
      max_output_tokens: modelMaxOutputTokens,
      timeout_ms: modelTimeout,
      inactivity_timeout_ms: modelInactivityTimeout,
    },
    target,
    build: { executable, args, cwd, environment, timeout_ms: buildTimeout },
    validation: {
      testpack,
      ...(libraryPackage ? { library_package: libraryPackage } : {}),
      ...(baselineArtifact ? { baseline_artifact: path.isAbsolute(baselineArtifact) ? baselineArtifact : path.resolve(configDir, baselineArtifact) } : {}),
    },
    ...(runner ? { runner } : {}),
    output_dir: outputDir,
  };
}

/** Resolve the runner secret only at execution time; callers must not persist this value. */
export function resolveRunnerConfig(
  config: OptimizationConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): ResolvedRunnerConfig {
  const runner = config.runner;
  if (!runner || runner.mode === 'legacy') return { mode: 'legacy' };
  const env = options.env ?? process.env;
  const reference = runner.token.match(ENV_REFERENCE);
  const token = reference ? env[reference[1]]?.trim() : runner.token.trim();
  if (!token) {
    throw new OptimizationConfigError([
      reference
        ? `runner.token references ${reference[1]}, but that environment variable is missing or empty`
        : 'runner.token is empty',
    ]);
  }
  return {
    mode: 'rpc',
    endpoint: runner.endpoint,
    token,
    requestTimeoutMs: runner.request_timeout_ms,
    pollIntervalMs: runner.poll_interval_ms,
  };
}

/** The default YAML has an empty command until the user completes `/build`. */
export function isBuildConfigured(build: OptimizationConfig['build']): boolean {
  return build.executable.trim().length > 0;
}

/** Load and validate the public YAML file. */
export function loadOptimizationConfig(configPath: string): LoadedOptimizationConfig {
  const absolutePath = path.resolve(configPath);
  let raw: string;
  try {
    raw = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new OptimizationConfigError([`cannot read config ${absolutePath}: ${(error as Error).message}`]);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new OptimizationConfigError([`invalid YAML in ${absolutePath}: ${(error as Error).message}`]);
  }
  const config = parseOptimizationConfig(parsed, path.dirname(absolutePath));
  // The hash is an internal provenance value; raw YAML is never written to a
  // run report because it may contain a direct API key.
  return {
    config,
    configPath: absolutePath,
    configDir: path.dirname(absolutePath),
    rawSha256: createHash('sha256').update(raw).digest('hex'),
  };
}

/** Resolve a credential without exposing its value in returned metadata. */
export function resolveOptimizationApiKey(
  config: OptimizationConfig,
  options: { cliApiKey?: string; env?: NodeJS.ProcessEnv; credentialsPath?: string } = {},
): ResolvedModelCredential {
  const env = options.env ?? process.env;
  if (options.cliApiKey !== undefined) {
    if (!options.cliApiKey.trim()) throw new OptimizationConfigError(['CLI model API key is empty']);
    return { apiKey: options.cliApiKey.trim(), source: 'cli' };
  }
  if (env.PHYOPT_MODEL_API_KEY !== undefined) {
    if (!env.PHYOPT_MODEL_API_KEY.trim()) throw new OptimizationConfigError(['PHYOPT_MODEL_API_KEY is empty']);
    return { apiKey: env.PHYOPT_MODEL_API_KEY.trim(), source: 'env_override' };
  }
  if (config.model.api_key?.trim()) return resolveConfiguredApiKey(config.model.api_key, { env });
  const stored = readStoredApiKey(config.model.endpoint, { filePath: options.credentialsPath });
  if (stored) return { apiKey: stored, source: 'credentials' };
  throw new OptimizationConfigError(['未找到模型 API Key；请在 YAML 中配置 model.api_key、设置环境变量，或先执行 /model']);
}

export interface ResolvedModelProxy {
  proxy: string;
  source: 'env_override' | 'yaml' | `env:${string}`;
}

/** Resolve an optional model transport proxy without changing unrelated HTTP calls. */
export function resolveOptimizationProxy(
  config: OptimizationConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): ResolvedModelProxy | undefined {
  const env = options.env ?? process.env;
  const override = env.PHYOPT_MODEL_PROXY?.trim();
  if (override) return { proxy: validateResolvedProxy(override), source: 'env_override' };
  const configured = config.model.proxy?.trim();
  if (!configured) return undefined;
  const reference = configured.match(ENV_REFERENCE);
  if (reference) {
    const name = reference[1];
    const value = env[name];
    if (!value?.trim()) throw new OptimizationConfigError([`model.proxy references ${name}, but that environment variable is missing or empty`]);
    return { proxy: validateResolvedProxy(value.trim()), source: `env:${name}` };
  }
  return { proxy: validateResolvedProxy(configured), source: 'yaml' };
}

function validateResolvedProxy(proxy: string): string {
  let parsed: URL;
  try {
    parsed = new URL(proxy);
  } catch {
    throw new OptimizationConfigError(['model.proxy must be a valid http(s) or socks5 URL']);
  }
  if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new OptimizationConfigError(['model.proxy must use http, https, or socks5 and include a host']);
  }
  return proxy.replace(/\/+$/, '');
}

/** Resolve a direct API key or a ${ENV_VAR} reference. */
export function resolveConfiguredApiKey(
  configuredValue: string | undefined,
  options: { env?: NodeJS.ProcessEnv } = {},
): ResolvedModelCredential {
  const env = options.env ?? process.env;
  const configured = configuredValue?.trim() ?? '';
  const reference = configured.match(ENV_REFERENCE);
  if (reference) {
    const name = reference[1];
    const value = env[name];
    if (!value?.trim()) throw new OptimizationConfigError([`model.api_key references ${name}, but that environment variable is missing or empty`]);
    return { apiKey: value.trim(), source: `env:${name}` };
  }
  if (!configured) {
    throw new OptimizationConfigError(['model.api_key is empty; provide a direct key or ${ENV_VAR}']);
  }
  return { apiKey: configured, source: 'yaml' };
}

/** Return a display/persistence-safe copy of the configuration. */
export function redactOptimizationConfig(config: OptimizationConfig): OptimizationConfig {
  return {
    ...config,
    model: {
      ...config.model,
      ...(config.model.api_key === undefined
        ? {}
        : { api_key: ENV_REFERENCE.test(config.model.api_key.trim()) ? config.model.api_key.trim() : '[redacted]' }),
      ...(config.model.proxy === undefined ? {} : { proxy: redactProxy(config.model.proxy) }),
    },
    build: { ...config.build, environment: { ...config.build.environment } },
    target: { ...config.target },
    validation: { ...config.validation },
    ...(config.runner ? {
      runner: config.runner.mode === 'legacy'
        ? { mode: 'legacy' }
        : {
            ...config.runner,
            token: ENV_REFERENCE.test(config.runner.token.trim()) ? config.runner.token.trim() : '[redacted]',
          },
    } : {}),
  };
}

function redactProxy(proxy: string): string {
  if (ENV_REFERENCE.test(proxy.trim())) return proxy.trim();
  try {
    const parsed = new URL(proxy);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
  } catch {
    return '[redacted]';
  }
  return proxy;
}

export function stringifyOptimizationConfig(config: OptimizationConfig): string {
  if (config.validation.library_package) {
    const output = { ...config, validation: { ...config.validation } } as Partial<OptimizationConfig>;
    delete output.build;
    delete (output.validation as Partial<OptimizationConfig['validation']>).testpack;
    return stringifyYaml(output, { indent: 2, lineWidth: 120 });
  }
  return stringifyYaml(config, { indent: 2, lineWidth: 120 });
}
