import { loadOptimizationConfig } from '../config/optimization-config.js';
import { loadValidationTestpack } from '../testpack/validation-yaml.js';
import { resolveLibraryPackageTask } from '../library-package/task-definition.js';
import { loadPublicOptimizationPreflight } from './public-optimization.js';
import { RunnerClient } from '../client/runner-client.js';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ResolvedExecutionMachine } from '../contracts/execution-machine.js';
import type { LibraryPackageLoader } from '../library-package/loader.js';

export function configuredOptimizationFunction(configPath: string, packageLoader?: LibraryPackageLoader): string {
  const loaded = loadOptimizationConfig(configPath);
  return loaded.config.validation.library_package
    ? resolveLibraryPackageTask(loaded.config.validation.library_package, { loader: packageLoader }).functionDefinition.api
    : loadValidationTestpack(loaded.config.validation.testpack).testpack.function_name;
}

/** Validate the same inputs as submission without creating a task or calling a model. */
export async function checkOptimization(configPath: string, functionName?: string, options: { resolveMachine?: (id: string) => ResolvedExecutionMachine; packageLoader?: LibraryPackageLoader; machineId?: string } = {}): Promise<{ message: string; function_name: string }> {
  const targetFunction = functionName ?? configuredOptimizationFunction(configPath, options.packageLoader);
  const preflight = loadPublicOptimizationPreflight({ config_path: configPath, function_name: targetFunction, entry_file: null,
    ...(options.machineId ? { machine_id: options.machineId } : {}) }, options);
  const lines = [`配置：${configPath}`, `函数：${targetFunction}`, `模型：${preflight.config.config.model.model_id}（凭据已解析；未调用模型）`,
    `验证：${preflight.libraryPackage ? `${preflight.libraryPackage.loaded.manifest.package_id}@${preflight.libraryPackage.loaded.manifest.version}` : preflight.testpack.testpack.testpack_id}`,
    `正确性用例：${preflight.testpack.testpack.correctness.cases.length}；性能 workload：${preflight.testpack.testpack.performance.cases.length}`];
  if (preflight.executionMachine) lines.push(`执行机器：${preflight.executionMachine.name}（${preflight.executionMachine.machine_id}，配置版本 ${preflight.executionMachine.revision}）`);
  if (preflight.libraryPackage) {
    const baseline = preflight.testpack.testpack.performance.baselines.comparison;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(baseline.path)) hash.update(chunk);
    if (hash.digest('hex') !== baseline.sha256.toLowerCase()) throw new Error('baseline 文件 SHA-256 与 Package 声明不一致');
    lines.push(`Package 审查状态：${preflight.libraryPackage.loaded.manifest.qualification.state}；Evaluator：${preflight.libraryPackage.bundle.qualification.status}；baseline SHA-256：已核验`);
  }
  if (preflight.runner.mode === 'rpc') {
    const runner = new RunnerClient({ baseUrl: preflight.runner.endpoint, token: preflight.runner.token, requestTimeoutMs: preflight.runner.requestTimeoutMs });
    const { health, machine } = await runner.probe();
    if (health.resource_enforcement !== 'REQUIRED') throw new Error('正式实验需要 Runner 开启 resource enforcement');
    lines.push(`Runner：${health.runner_id} / READY；机器：${machine.architecture} / ${machine.cpu_count} CPU`);
  } else lines.push('执行：兼容 testpack 路径；此检查未执行 SSH、构建或测量，不能作为正式 Package qualification。');
  lines.push('输入检查通过。源码基线、构建产物、目标资源和测量有效性仍由实际实验核验。');
  return { message: lines.join('\n'), function_name: targetFunction };
}
