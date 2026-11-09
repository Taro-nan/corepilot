import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CommandIO, CommandOutcome } from './commands.js';
import type { WorkbenchContext } from './context.js';
import { loadOptimizationConfig, parseOptimizationConfig, stringifyOptimizationConfig, type OptimizationConfig } from '../config/optimization-config.js';
import { LibraryPackageLoader } from '../library-package/loader.js';
import { packageValidationTestpack } from '../library-package/task-definition.js';
import { isRegisteredRunner } from '../config/runner-config.js';
import { loadValidationTestpack } from '../testpack/validation-yaml.js';

/** Configure existing contracts; never grant qualification or change an evaluator. */
export async function configureValidation(ctx: WorkbenchContext, io: CommandIO): Promise<CommandOutcome> {
  if (!ctx.hasConfig()) return { ok: false, message: '请先使用 /model 创建配置。' };
  const loaded = loadOptimizationConfig(ctx.configPath);
  const mode = await io.select('选择验证来源', [
    { label: 'Library Package（正式 RPC 优化）', value: 'package' },
    { label: '已有 testpack YAML（兼容配置）', value: 'testpack' },
  ]);
  if (!mode) return { ok: true, message: '已返回，验证配置未修改。' };
  const next: OptimizationConfig = structuredClone(loaded.config);
  if (mode === 'package') {
    const loader = new LibraryPackageLoader();
    const packages = loader.listPackages();
    if (!packages.length) return { ok: false, message: '暂无 Package。先用 corepilot package init 调查源码，再完成人工审阅和 qualification。' };
    const selected = await io.select('选择 Package 版本（不会自动授予资格）', packages.map(p => ({ label: `${p.package_id}@${p.version}  ${p.qualification.state}`, value: p })));
    if (!selected) return { ok: true, message: '已返回，验证配置未修改。' };
    const pkg = loader.loadPackage(selected.package_id, selected.version);
    const target = await io.select('选择优化目标', pkg.manifest.targets.map(t => ({ label: `${t.target_id}  ${pkg.manifest.functions.find(f => f.function_id === t.function_id)?.api ?? ''}`, value: t })));
    if (!target) return { ok: true, message: '已返回，验证配置未修改。' };
    const selection = { package_id: selected.package_id, package_version: selected.version, target_id: target.target_id };
    const resolved = loader.resolveSelection(selection, { requireQualified: true });
    io.print(`Package 审查状态：${pkg.manifest.qualification.state}；Evaluator：${resolved.bundle.qualification.status}。`);
    const baseline = await io.prompt('冻结 baseline 产物在本机的路径（后续上传到目标机）：', { initialValue: loaded.config.validation.baseline_artifact ?? '' });
    if (baseline === null) return { ok: true, message: '已取消，验证配置未修改。' };
    if (!baseline.trim()) throw new Error('baseline 产物路径不能为空');
    const artifact = path.resolve(loaded.configDir, baseline.trim());
    if (!fs.statSync(artifact).isFile()) throw new Error('baseline 必须是可读取的文件');
    packageValidationTestpack(resolved, artifact);
    let runner = loaded.config.runner;
    if (!isRegisteredRunner(runner)) {
      const currentRunner = runner?.mode === 'rpc' ? runner : undefined;
      const endpoint = await io.prompt('Runner HTTP endpoint（可使用 SSH 隧道地址）：', { initialValue: currentRunner?.endpoint ?? '' });
      if (endpoint === null) return { ok: true, message: '已取消，验证配置未修改。' };
      const existingEnv = currentRunner?.token.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
      const tokenEnv = await io.prompt('Runner token 的环境变量名称（不在此输入 token 原文）：', { initialValue: existingEnv ?? 'COREPILOT_RUNNER_TOKEN' });
      if (tokenEnv === null) return { ok: true, message: '已取消，验证配置未修改。' };
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv.trim())) throw new Error('请输入合法环境变量名');
      runner = { mode: 'rpc', endpoint: endpoint.trim(), token: '${' + tokenEnv.trim() + '}', request_timeout_ms: 10_000, poll_interval_ms: 250 };
    }
    next.validation = { testpack: '', library_package: selection, baseline_artifact: artifact };
    next.build = structuredClone(resolved.build);
    next.runner = runner;
  } else {
    const entered = await io.prompt('testpack YAML 路径：', { initialValue: loaded.config.validation.testpack });
    if (entered === null) return { ok: true, message: '已取消，验证配置未修改。' };
    if (!entered.trim()) throw new Error('testpack 路径不能为空');
    const testpack = path.resolve(loaded.configDir, entered.trim());
    const pack = loadValidationTestpack(testpack);
    next.validation = { testpack };
    next.runner = isRegisteredRunner(loaded.config.runner) ? { ...loaded.config.runner } : { mode: 'legacy' };
    io.print(`函数：${pack.testpack.function_name}；正确性用例：${pack.testpack.correctness.cases.length}。${isRegisteredRunner(next.runner) ? '沿用已注册执行机器，正式执行仍需 Qualified Evaluator。' : '兼容路径不等于正式 Package qualification。'}`);
  }
  // Serialize first: the in-memory config materializes Package-owned build and
  // testpack fields, which must be omitted from the public YAML contract.
  const serialized = stringifyOptimizationConfig(next);
  parseOptimizationConfig(parseYaml(serialized), loaded.configDir);
  fs.writeFileSync(ctx.configPath, serialized, 'utf8');
  return { ok: true, message: '验证配置已保存。下一步 /check 检查运行条件，再用 /optimize 启动优化。' };
}
