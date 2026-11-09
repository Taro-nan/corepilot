import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import type { TaskStore } from '../storage/task-store.js';
import type { ProjectRecord, RunnerConnectionCheck } from '../contracts/project.js';
import type { ProjectValidationPlans } from '../contracts/project-setup.js';
import type { PublicWorkflowRequest } from '../contracts/public-workflow.js';
import { loadOptimizationConfig, parseOptimizationConfig, redactOptimizationConfig, resolveOptimizationApiKey, resolveOptimizationProxy, resolveRunnerConfig, stringifyOptimizationConfig, type OptimizationConfig, type RunnerConfig } from '../config/optimization-config.js';
import { checkOptimization, configuredOptimizationFunction } from '../workflow/check-optimization.js';
import { discoverOpenAIModels } from '../model/model-discovery.js';
import { createModelTransport } from '../model/model-transport.js';
import { verifyToolCalling } from '../model/tool-verification.js';
import { LibraryPackageLoader } from '../library-package/loader.js';
import { onboardLibraryRepository } from '../onboarding/onboarding-agent.js';
import { checkSshTarget } from '../testpack/remote-transport.js';
import { inspectRepository, resolveSourceBranch, sourceDirectory } from '../workspace/git-repository.js';
import { normalizeCredentialEndpoint } from '../config/credentials.js';
import { createRpcRunnerConfig, isRegisteredRunner } from '../config/runner-config.js';
import { RunnerClient, RunnerClientError } from '../client/runner-client.js';
import { ExecutionMachineService } from './execution-machine-service.js';
import { ProjectSetupService } from './project-setup-service.js';
import { BuildPlanningService } from './build-planning-service.js';
import { ValidationAssetsService } from './validation-assets-service.js';
import { ValidationTrialService } from './validation-trial-service.js';
import { ValidationReviewService } from './validation-review-service.js';
import { BaselineBundleService } from './baseline-bundle-service.js';
import { commandBuild } from '../config/build-command.js';

const execute = promisify(execFile);

/** Restore masked credentials only for the endpoint they belong to. */
function restoreModelCredentials(config: OptimizationConfig, input: OptimizationConfig['model']): OptimizationConfig['model'] {
  const old = config.model;
  const next = { ...input };
  if (next.api_key === '[redacted]' || next.api_key === '') {
    if (normalizeCredentialEndpoint(next.endpoint ?? '') === normalizeCredentialEndpoint(old.endpoint) && old.api_key) next.api_key = old.api_key;
    else delete next.api_key;
  }
  if (old.proxy && next.proxy === redactOptimizationConfig(config).model.proxy) next.proxy = old.proxy;
  if (next.proxy !== undefined && !next.proxy.trim()) delete next.proxy;
  return next;
}

function restoreRunnerCredentials(old: RunnerConfig | undefined, input: RunnerConfig | undefined): RunnerConfig | undefined {
  if (input?.mode !== 'rpc' || isRegisteredRunner(input)) return input;
  const next = { ...input };
  if (next.token === '[redacted]' || next.token === '') {
    next.token = old?.mode === 'rpc' && !isRegisteredRunner(old) && normalizeCredentialEndpoint(next.endpoint ?? '') === normalizeCredentialEndpoint(old.endpoint) ? old.token : '';
  }
  return next;
}

/** Shared application use cases consumed by the HTTP API, CLI and browser. */
export class ProjectService {
  readonly machines: ExecutionMachineService;
  readonly setup: ProjectSetupService;
  readonly buildPlanning: BuildPlanningService;
  readonly validationAssets: ValidationAssetsService;
  readonly validationTrials: ValidationTrialService;
  readonly validationReview: ValidationReviewService;
  readonly baselineBundles: BaselineBundleService;
  readonly packageLoader: LibraryPackageLoader;
  constructor(private readonly store: TaskStore, readonly dataDir: string) {
    this.machines = new ExecutionMachineService(store);
    this.setup = new ProjectSetupService(dataDir);
    this.buildPlanning = new BuildPlanningService(store, this.machines, this.setup);
    this.validationAssets = new ValidationAssetsService(dataDir, this.machines);
    this.validationTrials = new ValidationTrialService(dataDir, this.machines);
    this.validationReview = new ValidationReviewService(dataDir, this.validationTrials);
    this.baselineBundles = new BaselineBundleService(dataDir, this.machines, this.validationAssets);
    this.packageLoader = new LibraryPackageLoader({ catalogRoot: path.join(dataDir, 'catalog') });
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.migrateManagedConfigurations();
  }

  private migrateManagedConfigurations(): void {
    for (const project of this.store.listProjects()) {
      const directory = path.resolve(this.dataDir, 'projects', project.project_id);
      const previous = path.resolve(project.config_path);
      const next = path.join(directory, 'corepilot.yaml');
      if (path.dirname(previous) !== directory || previous === next) continue;
      const previousExists = fs.existsSync(previous), nextExists = fs.existsSync(next);
      if (!previousExists && !nextExists) throw new Error(`项目「${project.name}」的配置文件缺失，请恢复后重新启动。`);
      if (previousExists && nextExists && !fs.readFileSync(previous).equals(fs.readFileSync(next))) {
        throw new Error(`项目「${project.name}」已存在不同的 corepilot.yaml，请先确认应使用的配置。`);
      }
      const moved = previousExists && !nextExists;
      if (moved) fs.renameSync(previous, next);
      try { this.store.migrateProjectConfigPath(project.project_id, project.config_path, next); }
      catch (error) { if (moved) fs.renameSync(next, previous); throw error; }
      if (previousExists && nextExists) fs.unlinkSync(previous);
    }
  }

  list(): ProjectRecord[] { return this.store.listProjects(); }
  get(id: string): ProjectRecord {
    const project = this.store.getProject(id);
    if (!project) throw new Error('project not found');
    return project;
  }

  add(input: { name: string; repository_root: string; config_path?: string; source_branch?: string }): ProjectRecord {
    if (!input.name?.trim()) throw new Error('请填写项目名称');
    const root = sourceDirectory(input.repository_root);
    const source = input.source_branch === undefined ? undefined : resolveSourceBranch(root, input.source_branch);
    const existing = this.list().find(p => p.repository_root === root);
    if (existing) return existing;
    const id = randomUUID();
    const configPath = input.config_path ? path.resolve(root, input.config_path) : path.join(this.dataDir, 'projects', id, 'corepilot.yaml');
    if (input.config_path) loadOptimizationConfig(configPath);
    else {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, stringifyOptimizationConfig({
        model: { model_id: 'configure-model', endpoint: 'https://api.example.com/v1', timeout_ms: 1200000 },
        target: { ssh_alias: 'localhost', workspace_root: '/tmp/corepilot' },
        build: { executable: '', args: [], cwd: '.', environment: {}, timeout_ms: 600000 },
        validation: { testpack: '' },
        runner: createRpcRunnerConfig(),
        output_dir: path.join(this.dataDir, 'reports', id),
      }), { mode: 0o600 });
    }
    const now = new Date().toISOString();
    const project: ProjectRecord = { project_id: id, name: input.name.trim(), repository_root: root, config_path: configPath,
      ...(source ? { source_branch: source.branch } : {}), created_at: now, updated_at: now };
    this.store.saveProject(project);
    return project;
  }

  config(id: string): OptimizationConfig { return redactOptimizationConfig(loadOptimizationConfig(this.get(id).config_path).config); }

  updateDefaults(id: string, input: { source_branch?: string; function_name?: string }): ProjectRecord {
    const project = this.get(id);
    const branch = input.source_branch === undefined ? undefined : resolveSourceBranch(project.repository_root, input.source_branch).branch;
    const fn = input.function_name?.trim();
    if (input.function_name !== undefined && !fn) throw new Error('请填写目标函数。');
    if (branch === undefined && fn === undefined) throw new Error('请选择要更新的项目默认条件。');
    const updated = { ...project, ...(branch === undefined ? {} : { source_branch: branch }),
      ...(fn === undefined ? {} : { default_function: fn }), updated_at: new Date().toISOString() };
    this.store.saveProject(updated);
    return updated;
  }

  saveConfig(id: string, input: unknown): OptimizationConfig {
    const project = this.get(id);
    const old = loadOptimizationConfig(project.config_path).config;
    if (!input || typeof input !== 'object') throw new Error('config must be an object');
    const next = structuredClone(input) as OptimizationConfig;
    if (!next.model) throw new Error('model is required');
    next.model = restoreModelCredentials(old, next.model);
    next.runner = restoreRunnerCredentials(old.runner, next.runner);
    if (isRegisteredRunner(next.runner)) this.machines.get(next.runner.machine_id);
    const serialized = stringifyOptimizationConfig(next);
    parseOptimizationConfig(parseYaml(serialized), path.dirname(project.config_path));
    fs.writeFileSync(project.config_path, serialized, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(project.config_path, 0o600);
    this.store.saveProject({ ...project, updated_at: new Date().toISOString() });
    return this.config(id);
  }

  request(id: string, input: { function_name?: string; entry_file?: string | null; candidate_scope?: PublicWorkflowRequest['candidate_scope']; enable_performance?: boolean; verification_mode?: PublicWorkflowRequest['verification_mode']; source_branch?: string; machine_id?: string; budget?: import('../contracts/optimization-session.js').OptimizationSessionBudget }): PublicWorkflowRequest {
    const project = this.get(id);
    const runner = loadOptimizationConfig(project.config_path).config.runner;
    const machineId = input.machine_id ?? (isRegisteredRunner(runner) ? runner.machine_id : undefined);
    return { config_path: project.config_path, repository_root: project.repository_root,
      function_name: input.function_name?.trim() || project.default_function || configuredOptimizationFunction(project.config_path, this.packageLoader), entry_file: input.entry_file ?? null,
      ...(input.candidate_scope === undefined ? {} : { candidate_scope: input.candidate_scope }),
      enable_performance: input.enable_performance ?? input.verification_mode !== 'source_only',
      ...(input.verification_mode === undefined ? {} : { verification_mode: input.verification_mode }),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      ...(machineId === undefined ? {} : { machine_id: machineId }),
      ...((input.source_branch ?? project.source_branch) === undefined ? {} : { source_branch: input.source_branch ?? project.source_branch }) };
  }

  async check(id: string, functionName?: string, branch?: string, machineId?: string, verificationMode?: PublicWorkflowRequest['verification_mode'], candidateScope?: PublicWorkflowRequest['candidate_scope']) {
    const project = this.get(id);
    const name = branch ?? project.source_branch;
    const source = name === undefined ? undefined : resolveSourceBranch(project.repository_root, name);
    const result = await checkOptimization(project.config_path, functionName?.trim() || project.default_function || undefined, { resolveMachine: id => this.machines.resolve(id), packageLoader: this.packageLoader, machineId,
      verificationMode, candidateScope, repositoryRoot: project.repository_root, sourceBranch: name, readMachine: id => this.store.getExecutionMachine(id) });
    return source ? { ...result, source_branch: source.branch, baseline_commit: source.commit,
      message: `源码分支：${source.branch}\n源码 commit：${source.commit}\n${result.message}` } : result;
  }

  async setupStatus(id: string) {
    const project = this.get(id), config = this.config(id);
    const setup = await this.setup.status(project, config);
    const selection = config.validation.library_package;
    if (setup.validation && selection?.package_id === `project-${id.slice(0, 8)}`) {
      try {
        const review = await this.validationReview.preview(project, selection.package_id, selection.package_version, selection.target_id);
        setup.validation.review = review;
        if (review.state === 'READY_FOR_REVIEW') {
          for (const check of setup.checks) if (['correctness', 'performance', 'evaluator'].includes(check.id)) {
            check.message = check.id === 'correctness' ? `目标机试跑 ${review.trial!.correctness_passed}/${review.trial!.correctness_planned} 通过。`
              : check.id === 'performance' ? `两库已取得 ${review.trial!.performance_measured}/${review.trial!.performance_planned} 个有效样本。`
              : '这版测试方案已通过目标机试跑，下一步请审阅并确认用于正式优化。';
          }
          setup.next_steps = ['审阅已通过试跑的测试方案，确认后即可运行前检查并开始优化。'];
        }
      } catch (error) { setup.validation.review_error = `读取试跑与审阅状态失败：${(error as Error).message}`; }
    }
    return setup;
  }

  /** Only project-owned plans and the package explicitly bound to this project are discoverable here. */
  async validationPlans(id: string, functionName: string): Promise<ProjectValidationPlans> {
    const project = this.get(id), config = this.config(id), name = functionName.trim();
    if (!name || name.length > 512) throw new Error('请输入有效的目标函数名称。');
    const selected = config.validation.library_package;
    const ownId = `project-${project.project_id.slice(0, 8)}`;
    const plans: ProjectValidationPlans['plans'] = [], warnings: string[] = [];
    for (const entry of this.packageLoader.listPackages()) {
      if (entry.package_id !== ownId && !(entry.package_id === selected?.package_id && entry.version === selected.package_version)) continue;
      try {
        const loaded = this.packageLoader.loadPackage(entry.package_id, entry.version);
        for (const target of loaded.manifest.targets) {
          if (loaded.manifest.functions.find(item => item.function_id === target.function_id)?.api !== name) continue;
          const selection = { package_id: entry.package_id, package_version: entry.version, target_id: target.target_id };
          const resolved = this.packageLoader.resolveSelection(selection);
          const current = selected?.package_id === entry.package_id && selected.package_version === entry.version && selected.target_id === target.target_id;
          const source = target.domain_payload.baseline_source;
          const binding = source && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, unknown> : {};
          let artifact = current ? config.validation.baseline_artifact ?? '' : '';
          if (!artifact && typeof binding.artifact_path === 'string' && path.isAbsolute(binding.artifact_path)) artifact = binding.artifact_path;
          const bundle = loaded.binary_baselines[target.target_id];
          if (!artifact && bundle && typeof binding.bundle_root === 'string' && path.isAbsolute(binding.bundle_root) && typeof binding.entry_path === 'string'
              && bundle.libraries.some(item => item.role === 'ENTRY' && item.path === binding.entry_path)) {
            artifact = path.resolve(binding.bundle_root, ...binding.entry_path.split('/'));
          }
          plans.push({ function_name: name, selection, current, package_state: loaded.manifest.qualification.state,
            evaluator_state: resolved.bundle.qualification.status, baseline: { library: target.artifacts.baseline.library,
              version: target.artifacts.baseline.version, source: typeof binding.kind === 'string' ? binding.kind : null, artifact_path: artifact } });
        }
      } catch (error) { warnings.push(`${entry.package_id}@${entry.version} 无法读取：${(error as Error).message}`); }
    }
    const setup = config.validation.testpack.trim() ? await this.setup.status(project, config) : null;
    const testpack = setup?.validation?.function_name === name ? { function_name: name, evaluator_state: setup.validation.evaluator_status } : null;
    if (config.validation.testpack.trim() && !setup?.validation) warnings.push('当前测试方案文件无法读取，请在任务准备中检查。');
    plans.sort((a, b) => Number(b.current) - Number(a.current) || b.selection.package_version.localeCompare(a.selection.package_version));
    return { function_name: name, plans, current_testpack: testpack, warnings };
  }

  inspectRepository(directory: string) { return inspectRepository(directory); }

  async discoverModels(id: string, input?: unknown) {
    const loaded = loadOptimizationConfig(this.get(id).config_path);
    let config = loaded.config;
    if (input !== undefined) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('model must be an object');
      const connection = input as Record<string, unknown>;
      for (const [key, value] of Object.entries(connection)) {
        if (!['endpoint', 'api_key', 'proxy'].includes(key)) throw new Error(`unsupported model discovery field: ${key}`);
        if (typeof value !== 'string') throw new Error(`model.${key} must be a string`);
      }
      // Discovery uses only connection drafts, without saving or validating other form edits.
      const model = restoreModelCredentials(loaded.config, { ...loaded.config.model, ...connection, api_key: (connection.api_key as string | undefined) ?? '' });
      config = parseOptimizationConfig(parseYaml(stringifyOptimizationConfig({ ...loaded.config, model })), loaded.configDir);
    }
    const key = resolveOptimizationApiKey(config).apiKey;
    const transport = createModelTransport(resolveOptimizationProxy(config)?.proxy);
    try {
      return { models: await discoverOpenAIModels(config.model.endpoint, key, { fetchImpl: transport.fetch, signal: AbortSignal.timeout(15000) }) };
    } finally { await transport.close(); }
  }

  async modelTest(id: string) {
    const loaded = loadOptimizationConfig(this.get(id).config_path);
    const key = resolveOptimizationApiKey(loaded.config).apiKey;
    const transport = createModelTransport(resolveOptimizationProxy(loaded.config)?.proxy);
    try {
      return await verifyToolCalling({ endpoint: loaded.config.model.endpoint, modelId: loaded.config.model.model_id, apiKey: key,
          reasoningEffort: loaded.config.model.reasoning_effort, maxOutputTokens: loaded.config.model.max_output_tokens }, { fetch: transport.fetch, timeoutMs: loaded.config.model.timeout_ms });
    } finally { await transport.close(); }
  }

  targetTest(id: string) { return checkSshTarget(loadOptimizationConfig(this.get(id).config_path).config.target); }

  bindMachine(id: string, machineId: string): OptimizationConfig {
    const machine = this.machines.get(machineId);
    if (!machine.enabled) throw new Error('执行机器已停用，请选择其他机器。');
    return this.saveConfig(id, { ...this.config(id), runner: { mode: 'rpc', machine_id: machineId } });
  }

  async runnerTest(id: string, input?: unknown): Promise<RunnerConnectionCheck> {
    const loaded = loadOptimizationConfig(this.get(id).config_path);
    let config = loaded.config;
    if (input !== undefined) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('runner must be an object');
      const runner = restoreRunnerCredentials(config.runner, input as RunnerConfig);
      config = parseOptimizationConfig({ ...config, runner }, loaded.configDir);
    }
    if (isRegisteredRunner(config.runner)) {
      const machine = await this.machines.check(config.runner.machine_id);
      if (machine.status !== 'ONLINE' || !machine.health || !machine.hardware) throw new Error(machine.error ?? '执行机器当前不可用，请联系维护者。');
      return { ok: true, message: `执行机器「${machine.name}」连接通过`, checked_at: machine.last_checked_at!, health: machine.health, machine: machine.hardware };
    }
    const resolved = resolveRunnerConfig(config);
    if (resolved.mode !== 'rpc') throw new Error('当前项目仍使用历史兼容执行配置，请先填写 Runner RPC 地址与凭据。');
    const client = new RunnerClient({ baseUrl: resolved.endpoint, token: resolved.token, requestTimeoutMs: resolved.requestTimeoutMs });
    try {
      const facts = await client.probe();
      return { ok: true, message: 'Runner RPC 连接通过', checked_at: new Date().toISOString(), ...facts };
    } catch (error) {
      if (error instanceof RunnerClientError) {
        if (error.status === 401 || error.status === 403) throw new Error('Runner 认证失败，请检查 Runner Token 或服务端环境变量引用。');
        if (error.code === 'CONNECTION_FAILED') throw new Error('无法连接 Runner，请检查 RPC 地址及 Runner 服务是否运行。');
        if (error.code === 'REQUEST_TIMEOUT') throw new Error('Runner 连接超时，请检查 RPC 地址和服务器网络。');
      }
      throw error;
    }
  }

  catalog() {
    const loader = new LibraryPackageLoader({ catalogRoot: path.join(this.dataDir, 'catalog') });
    return loader.listPackages().map(p => {
      const loaded = loader.loadPackage(p.package_id, p.version);
      return { ...p, library_name: loaded.manifest.library.name, functions: loaded.manifest.functions, targets: loaded.manifest.targets.map(t => ({ target_id: t.target_id, function_id: t.function_id,
        evaluator: { ...t.evaluator, qualification: loader.resolveSelection({ package_id: p.package_id, package_version: p.version, target_id: t.target_id }).bundle.qualification.status }, candidate_scope: t.candidate_scope })) };
    });
  }

  async discover(id: string, symbol?: string, build?: { command: string; cwd: string }, symbols?: string[]) {
    const p = this.get(id);
    const catalog = path.join(this.dataDir, 'catalog');
    const result = await onboardLibraryRepository({ repositoryRoot: p.repository_root, packagesRoot: path.join(catalog, 'packages'), evaluatorsRoot: path.join(catalog, 'evaluators'),
      packageId: `project-${id.slice(0, 8)}`, version: `0.1.${Date.now()}`,
      ...(symbols !== undefined ? { targetSymbols: symbols } : symbol?.trim() ? { targetSymbol: symbol.trim() } : {}),
      ...(build ? { buildDefinition: commandBuild(build.command, { executable: '', args: [], cwd: build.cwd, environment: {}, timeout_ms: 600000 }) } : {}) });
    return { inspection: result.inspection, evidence: result.evidence, package_path: result.packagePath,
      evaluator_path: result.evaluatorPath, evaluator_paths: result.evaluatorPaths,
      targets: result.targets.map(target => ({ symbol: target.symbol, target_id: target.targetId, evaluator_path: target.evaluatorPath })),
      state: 'DRAFT' };
  }

  async freezeBranchBaseline(id: string, trialId: string, artifactRelativePath?: string) {
    const project = this.get(id);
    const built = await this.validationTrials.freezeBranchArtifact(project, trialId, artifactRelativePath);
    const packageInfo = this.packageLoader.loadPackage(built.package_id, built.package_version);
    const binding = await this.validationAssets.bindSingleBaseline(project, built.package_id, built.package_version, built.target_id, {
      artifactPath: built.artifact_path, sha256: built.sha256, library: packageInfo.manifest.library.name,
      versionLabel: `git:${built.source_commit.slice(0, 12)}`,
      source: { kind: 'branch', detail: built.source_branch, sourceCommit: built.source_commit,
        machineId: built.machine_id, trialId: built.trial_id },
    });
    const config = this.config(id);
    this.saveConfig(id, { ...config, validation: { testpack: '',
      library_package: { package_id: built.package_id, package_version: built.package_version, target_id: built.target_id },
      baseline_artifact: binding.artifact_path } });
    return { ...binding, source_branch: built.source_branch, source_commit: built.source_commit };
  }

  async uploadSingleBaseline(id: string, input: {
    packageId: string; version: string; targetId: string; library: string; versionLabel: string; filename: string;
  }, chunks: AsyncIterable<Buffer>) {
    const project = this.get(id);
    const created = this.baselineBundles.create(project, { ...input, libraryVersion: input.versionLabel });
    const uploaded = await this.baselineBundles.upload(project, created.bundle_id, path.basename(input.filename), chunks);
    const result = await this.finalizeBundleBaseline(id, created.bundle_id, uploaded.path);
    return { ...result, bytes: uploaded.bytes, source: 'uploaded-single-artifact' };
  }

  async bindBundleBaseline(id: string, bundleId: string, entryPath: string) {
    const result = await this.baselineBundles.bind(this.get(id), bundleId, entryPath);
    return this.persistBundleSelection(id, bundleId, result);
  }

  async finalizeBundleBaseline(id: string, bundleId: string, entryPath: string) {
    const result = await this.baselineBundles.finalize(this.get(id), bundleId, entryPath) as {
      ok: boolean; artifact_path?: string; baseline?: { sha256: string };
      bundle_id: string; inspection: unknown;
    };
    return this.persistBundleSelection(id, bundleId, result);
  }

  private async persistBundleSelection(id: string, bundleId: string, result: {
    ok: boolean; artifact_path?: string; baseline?: { sha256: string }; bundle_id: string; inspection: unknown;
  }) {
    if (result.ok && result.artifact_path) {
      const session = await this.baselineBundles.status(this.get(id), bundleId);
      const selected = this.packageLoader.resolveSelection({ package_id: session.package_id,
        package_version: session.package_version, target_id: session.target_id });
      if (selected.target.artifacts.baseline.sha256 !== result.baseline?.sha256) {
        throw new Error('该目标的比较基线已经被替换，请重新上传后再绑定');
      }
      const config = this.config(id);
      this.saveConfig(id, { ...config, validation: { testpack: '',
        library_package: { package_id: session.package_id, package_version: session.package_version, target_id: session.target_id },
        baseline_artifact: result.artifact_path } });
    }
    return result;
  }

  async directories(root: string) {
    const absolute = sourceDirectory(root || process.cwd());
    const volumeRoot = path.parse(absolute).root;
    const candidates = process.platform === 'win32' ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`) : ['/'];
    const volumes = await Promise.all(candidates.map(async directory => {
      try { return (await fs.promises.stat(directory)).isDirectory() ? { name: directory, path: directory } : null; }
      catch { return null; }
    }));
    const roots = [...volumes.filter((item): item is { name: string; path: string } => item !== null).map(volume => ({ ...volume, kind: 'drive' as const })),
      { name: '用户目录', path: os.homedir(), kind: 'home' as const }, { name: '项目目录', path: process.cwd(), kind: 'workspace' as const }];
    const breadcrumbs = [{ name: volumeRoot, path: volumeRoot }];
    for (const segment of path.relative(volumeRoot, absolute).split(path.sep).filter(Boolean)) {
      breadcrumbs.push({ name: segment, path: path.join(breadcrumbs.at(-1)!.path, segment) });
    }
    const entries = await fs.promises.readdir(absolute, { withFileTypes: true });
    return { path: absolute, parent: path.dirname(absolute), roots, breadcrumbs,
      directories: entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })).map(e => ({ name: e.name, path: path.join(absolute, e.name) })) };
  }

  async diff(repository: string, baseline: string, candidate: string): Promise<string> {
    if (![baseline, candidate].every(value => /^[a-f0-9]{40,64}$/i.test(value))) throw new Error('source commit identity unavailable');
    const { stdout } = await execute('git', ['-C', repository, 'diff', '--no-ext-diff', '--no-color', `${baseline}...${candidate}`, '--'], { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return stdout;
  }
}
