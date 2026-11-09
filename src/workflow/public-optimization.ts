import { isBuildConfigured, loadOptimizationConfig, redactOptimizationConfig, resolveOptimizationApiKey, resolveOptimizationProxy, resolveRunnerConfig, type LoadedOptimizationConfig, type OptimizationConfig, type ResolvedModelCredential, type ResolvedRunnerConfig } from '../config/optimization-config.js';
import { loadValidationTestpack } from '../testpack/validation-yaml.js';
import { summarizeValidationTestpack } from '../testpack/validation-freeze.js';
import type { LoadedValidationTestpack } from '../contracts/validation-testpack.js';
import type { PublicWorkflowRequest } from '../contracts/public-workflow.js';
import { loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import { assertGeneratedHarnessResolution } from '../evaluator/generated-harness-compatibility.js';
import { packageTaskReference, packageValidationTestpack, resolveLibraryPackageTask, type ResolvedPackageTask } from '../library-package/task-definition.js';
import { resolveSourceBranch } from '../workspace/git-repository.js';
import { isRegisteredRunner } from '../config/runner-config.js';
import type { ResolvedExecutionMachine, ExecutionMachineIdentity } from '../contracts/execution-machine.js';
import type { LibraryPackageLoader } from '../library-package/loader.js';

export interface PublicOptimizationPreflight {
  executionMachine?: ExecutionMachineIdentity;
  request: PublicWorkflowRequest;
  source?: { branch: string; commit: string };
  config: LoadedOptimizationConfig;
  testpack: LoadedValidationTestpack;
  libraryPackage?: ResolvedPackageTask;
  credential: ResolvedModelCredential;
  model_proxy?: string;
  /** In-memory only; the bearer token must never enter workflow/domain records. */
  runner: ResolvedRunnerConfig;
  /** 可写入运行清单的脱敏信息；不包含 API Key 原文。 */
  audit: {
    function_name: string;
    entry_file: string | null;
    config_path: string;
    repository_root: string;
    source_branch?: string;
    source_commit?: string;
    config_sha256: string;
    config: OptimizationConfig;
    testpack: Record<string, unknown>;
  };
}

/** 在模型调用和远端命令之前加载所有公开输入并完成严格校验。 */
export function loadPublicOptimizationPreflight(
  request: PublicWorkflowRequest,
  options: { cliApiKey?: string; env?: NodeJS.ProcessEnv; resolveMachine?: (id: string) => ResolvedExecutionMachine; packageLoader?: LibraryPackageLoader } = {},
): PublicOptimizationPreflight {
  const config = loadOptimizationConfig(request.config_path);
  const machineId = request.machine_id ?? (isRegisteredRunner(config.config.runner) ? config.config.runner.machine_id : undefined);
  const executionMachine = machineId ? options.resolveMachine?.(machineId) : undefined;
  if (machineId && !executionMachine) throw new Error('请通过共享 Control 服务解析已注册的执行机器，例如 corepilot project check <项目 ID>。');
  if (executionMachine) config.config = { ...config.config, runner: executionMachine.runner, target: executionMachine.target };
  const source = request.source_branch === undefined ? undefined : resolveSourceBranch(request.repository_root ?? config.configDir, request.source_branch);
  const libraryPackage = config.config.validation.library_package
    ? resolveLibraryPackageTask(config.config.validation.library_package, { requireQualified: true, loader: options.packageLoader })
    : undefined;
  if (libraryPackage) config.config.build = structuredClone(libraryPackage.build);
  const testpack = libraryPackage
    ? packageValidationTestpack(libraryPackage, config.config.validation.baseline_artifact ?? '')
    : loadValidationTestpack(config.config.validation.testpack);
  if (!isBuildConfigured(config.config.build)) throw new Error('尚未配置构建命令。请在「构建与验证」填写实际构建命令，CLI 用户可使用 /build 配置。');
  const credential = resolveOptimizationApiKey(config.config, options);
  const modelProxy = resolveOptimizationProxy(config.config, options)?.proxy;
  const runner = resolveRunnerConfig(config.config, { env: options.env });
  if (libraryPackage && runner.mode !== 'rpc') throw new Error('library package formal execution requires RPC runner mode');
  if (request.function_name !== testpack.testpack.function_name) {
    throw new Error(`requested function '${request.function_name}' differs from testpack function '${testpack.testpack.function_name}'`);
  }
  if (runner.mode === 'rpc' && !testpack.testpack.evaluator) {
    throw new Error('RPC formal execution requires testpack.evaluator with a verified owner, version, root, and SHA-256 digest.');
  }
  if (testpack.testpack.evaluator) {
    const evaluator = testpack.testpack.evaluator;
    const bundle = loadFormalEvaluatorBundle(evaluator.root, {
      requireQualified: runner.mode === 'rpc',
      expected: { evaluatorId: evaluator.id, version: evaluator.version, digest: evaluator.sha256 },
    });
    assertGeneratedHarnessResolution(bundle);
    if (runner.mode === 'rpc' && bundle.manifest.domain.api !== testpack.testpack.function_name) {
      throw new Error(`evaluator API '${bundle.manifest.domain.api}' differs from testpack function '${testpack.testpack.function_name}'`);
    }
  }
  return {
    ...(executionMachine ? { executionMachine: executionMachine.identity } : {}),
    request,
    ...(source ? { source } : {}),
    config,
    testpack,
    ...(libraryPackage ? { libraryPackage } : {}),
    credential,
    runner,
    ...(modelProxy ? { model_proxy: modelProxy } : {}),
    audit: {
      function_name: request.function_name,
      entry_file: request.entry_file,
      config_path: config.configPath,
      // 直接 HTTP 调用没有 CLI 的 cwd；配置目录是唯一安全的默认根。
      repository_root: request.repository_root ?? config.configDir,
      ...(source ? { source_branch: source.branch, source_commit: source.commit } : {}),
      config_sha256: config.rawSha256,
      config: redactOptimizationConfig(config.config),
      testpack: {
        ...summarizeValidationTestpack(testpack.testpack),
        ...(libraryPackage ? {
          library_package: packageTaskReference(libraryPackage),
          package_qualification: structuredClone(libraryPackage.loaded.manifest.qualification),
        } : {}),
      },
    },
  };
}
