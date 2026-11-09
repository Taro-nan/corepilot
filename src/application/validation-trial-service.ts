import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ProjectRecord } from '../contracts/project.js';
import type { Experiment } from '../contracts/optimization-domain.js';
import { OPTIMIZATION_DOMAIN_SCHEMA_VERSION } from '../contracts/optimization-domain.js';
import type { ExperimentExecutionPlan, ExperimentExecutionStep } from '../contracts/runner-rpc.js';
import type { ValidationTestPlan } from '../contracts/validation-assets.js';
import { loadOptimizationConfig, resolveRunnerConfig } from '../config/optimization-config.js';
import { commandBuild, isolatedWorkspaceBuild, isolatedCmakeArtifact } from '../config/build-command.js';
import { ApiError } from '../core/api-error.js';
import { isRegisteredRunner } from '../config/runner-config.js';
import { LibraryPackageLoader } from '../library-package/loader.js';
import { RunnerClient, RunnerClientError } from '../client/runner-client.js';
import { AsyncSshTransport } from '../testpack/remote-transport.js';
import type { TargetConfig } from '../config/target-config.js';
import type { RemoteValidationTransport } from '../workspace/validation-runner.js';
import { stageRemoteBaseline, type StagedRemoteBaseline } from '../workspace/validation-runner.js';
import { exportGitSourceArchive, gitSourceVersion } from '../workspace/git-source-archive.js';
import { remoteRunLayout } from '../workspace/remote-run-layout.js';
import type { ValidationCommand } from '../contracts/validation-testpack.js';
import { stageRemoteDevelopmentAssets } from '../core/development-investigation.js';
import type { ExecutionMachineService } from './execution-machine-service.js';
import { readValidationTestPlan, expandCpuSet } from '../evaluator/validation-test-plan.js';
import { entryResources } from '../evaluator/execution-matrix.js';
import { createFormalEvaluatorSteps } from '../evaluator/formal-plan.js';
import { snapshotValidationAssets, archiveValidationAssets, validationAssetFiles } from './validation-asset-files.js';
import { packageBaselineBinding } from '../library-package/task-definition.js';
import { stageVerifiedBinaryBaseline } from '../workspace/baseline-bundle-staging.js';
import { readValidationQuality, qualityProbeSteps } from '../evaluator/validation-quality.js';
import type { ValidationQualityPlan } from '../contracts/validation-quality.js';
import type { ValidationCase } from '../contracts/validation-testpack.js';
import { trialSummary } from './validation-trial-summary.js';

interface TrialRecord {
  schema_version: 1;
  trial_id: string;
  purpose: 'VALIDATION_DRAFT' | 'BASELINE_BUILD';
  project_id: string;
  package_id: string;
  package_version: string;
  target_id: string;
  evaluator_digest: string;
  source_commit: string;
  source_branch: string | null;
  machine_id: string | null;
  case_ids: string[];
  workload_ids: string[];
  artifact_path: string;
  created_at: string;
  mode?: 'correctness' | 'comparison' | 'smoke' | 'calibration';
  test_plan?: ValidationTestPlan;
  baseline_digest?: string;
  baseline?: { id: string; library: string; version: string; sha256: string };
  machine_name?: string;
  remote_workspace?: ReturnType<typeof remoteRunLayout>;
  build?: ValidationCommand;
  build_definition?: ValidationCommand;
  requested_build_definition?: ValidationCommand;
  source_archive?: { sha256: string; bytes: number };
  source_sha256?: string;
  workload_conditions?: Array<{ workload_id: string; input_id: string; profile_name: string; threads: number; cpu_set: string; numa_node: number; omp_proc_bind?: 'close' | 'spread' }>;
  preparation?: { state: 'PREPARING' | 'READY' | 'FAILED' | 'UNKNOWN'; message: string | null; phase?: string };
  quality?: ValidationQualityPlan;
  correctness_inputs?: Array<{ input_id: string }>;
  workload_specs?: ValidationCase[];
}

/** Draft smoke runs use the existing Runner DEVELOPMENT_FEEDBACK experiment protocol. */
export class ValidationTrialService {
  private readonly catalog: LibraryPackageLoader;
  private readonly preparing = new Set<string>();
  constructor(private readonly dataDir: string, private readonly machines: ExecutionMachineService,
    private readonly transportFactory: (target: TargetConfig) => RemoteValidationTransport = target => new AsyncSshTransport(target)) {
    this.catalog = new LibraryPackageLoader({ catalogRoot: path.join(dataDir, 'catalog') });
  }

  private trialPath(project: ProjectRecord, trialId: string) {
    if (!/^validation:[a-f0-9-]{36}$/.test(trialId)) throw new Error('invalid validation trial id');
    return path.join(this.dataDir, 'projects', project.project_id, 'validation-trials', `${trialId.slice('validation:'.length)}.json`);
  }

  private connection(project: ProjectRecord, machineId?: string | null) {
    const config = loadOptimizationConfig(project.config_path).config;
    const id = machineId === undefined ? (isRegisteredRunner(config.runner) ? config.runner.machine_id : null) : machineId;
    const machine = id ? this.machines.resolve(id) : null;
    const effective = machine ? { ...config, runner: machine.runner, target: machine.target } : config;
    const runner = resolveRunnerConfig(effective);
    if (runner.mode !== 'rpc') throw new Error('请先选择可用的 Runner RPC 执行机器');
    return { target: effective.target, runner, machineId: id, config, machineName: machine?.identity.name };
  }

  async start(project: ProjectRecord, packageId: string, version: string, targetId: string, branch?: string,
    purpose: TrialRecord['purpose'] = 'VALIDATION_DRAFT', options: { mode?: 'correctness' | 'comparison' | 'smoke' | 'calibration'; expected_digest?: string;
      build?: unknown; expected_package_digest?: unknown } = {}) {
    if (packageId !== `project-${project.project_id.slice(0, 8)}`) throw new Error('只能试跑本项目生成的验证草稿');
    const resolved = this.catalog.resolveSelection({ package_id: packageId, package_version: version, target_id: targetId });
    if (!['DRAFT', 'REVIEWED'].includes(resolved.loaded.manifest.qualification.state) || resolved.bundle.qualification.status !== 'DRAFT') throw new Error('试跑仅适用于尚未获资格的验证草稿');
    if (options.expected_package_digest !== undefined && options.expected_package_digest !== resolved.loaded.content_digest) {
      throw new ApiError(409, 'BUILD_SETTINGS_CHANGED', '接入方案的构建设置已变化，请重新读取后构建');
    }
    let buildDefinition = resolved.build;
    if (options.build !== undefined) {
      if (purpose !== 'BASELINE_BUILD') throw new ApiError(400, 'INVALID_BUILD_OVERRIDE', '单次构建设置只适用于分支基线构建');
      const input = options.build as Record<string, unknown> | null;
      if (!input || typeof input.command !== 'string' || !input.command.trim() || input.command.length > 32000) throw new ApiError(400, 'INVALID_BUILD_COMMAND', '请填写基线构建命令');
      if (typeof input.cwd !== 'string' || !input.cwd.trim() || /^(?:\/|\\|[A-Za-z]:)/.test(input.cwd) || input.cwd.split(/[\\/]/).includes('..')) throw new ApiError(400, 'INVALID_BUILD_DIRECTORY', '构建工作目录应为源码内相对路径');
      buildDefinition = commandBuild(input.command, { ...resolved.build, cwd: input.cwd.replaceAll('\\', '/') });
    }
    const requestedBuild = buildDefinition;
    buildDefinition = isolatedWorkspaceBuild(buildDefinition);
    const connection = this.connection(project);
    const client = new RunnerClient({ baseUrl: connection.runner.endpoint, token: connection.runner.token,
      requestTimeoutMs: connection.runner.requestTimeoutMs });
    const probe = await client.probe();
    if (probe.health.capabilities?.source_archive_upload !== 1) throw new Error('请更新执行机器的 Runner：此版本需要支持源码归档上传，在目标机直接解包和构建');
    const mode = options.mode ?? 'smoke';
    const testPlan = readValidationTestPlan(resolved.bundle.root, resolved.bundle.manifest, resolved.functionDefinition.api);
    if (mode === 'calibration' && (!testPlan.statistics || testPlan.sampling.sample_count < testPlan.statistics.min_samples)) throw new Error('A/A 校准需要固定统计方案；请在测试条件选择「重复测量」并保存，样本数需满足统计最少样本要求');
    const comparison = purpose !== 'BASELINE_BUILD' && mode === 'comparison';
    const config = connection.config;
    const baselinePath = config.validation.baseline_artifact ?? '';
    const binding = comparison ? packageBaselineBinding(resolved, baselinePath) : null;
    if (purpose !== 'BASELINE_BUILD') {
      if (options.expected_digest && options.expected_digest !== resolved.bundle.content_digest) throw new Error('测试方案已变化，请重新读取后试跑');
      if (!testPlan.execution_matrix && !testPlan.resources.cpu_set) throw new Error('请先在测试条件中设置并保存 CPU 集合');
      if (testPlan.execution_matrix && probe.health.capabilities?.resource_matrix !== 1) throw new Error('请更新执行机器 Runner，以支持多线程和绑核配置矩阵');
      if (probe.health.resource_enforcement !== 'REQUIRED') throw new Error('执行机器尚未启用资源约束，请由维护者启用 Runner resource-enforcement');
      if (probe.health.capabilities?.controlled_validation !== 1) throw new Error('执行机器的 Runner 需要更新，当前版本尚不支持受控测试条件与测量核验');
      const online = probe.machine.cpu_topology?.online_cpus;
      const available = online ? new Set(expandCpuSet(online)) : null;
      const nodes = probe.machine.cpu_topology?.node_cpu_lists;
      for (const resources of testPlan.execution_matrix?.profiles ?? [testPlan.resources]) {
      if (available && expandCpuSet(resources.cpu_set).some(cpu => !available.has(cpu))) throw new Error('CPU 集合包含目标机器未上线的 CPU');
      if (nodes && Object.keys(nodes).length) {
        const node = nodes[`node${resources.numa_node}`] ?? nodes[String(resources.numa_node)];
        if (!node) throw new Error('所选 NUMA 节点不存在');
        const allowed = new Set(expandCpuSet(node));
        if (expandCpuSet(resources.cpu_set).some(cpu => !allowed.has(cpu))) throw new Error('CPU 集合需属于所选 NUMA 节点；当前策略同时绑定 CPU 和内存');
      }
      }
      if (comparison && (!baselinePath || /^0+$/.test(binding!.artifactDigest))) throw new Error('请先准备并保存比较基线');
    }
    const sourceBranch = branch ?? project.source_branch ?? null;
    if (purpose === 'BASELINE_BUILD' && !branch) throw new Error('请选择要作为比较基线的本地 Git 分支');
    const identity = await gitSourceVersion(project.repository_root, sourceBranch ? `refs/heads/${sourceBranch}` : 'HEAD');
    const trialId = `validation:${randomUUID()}`;
    const runId = trialId.slice('validation:'.length);
    const transport = this.transportFactory(connection.target);
    const runnerRoot = connection.target.workspace_root.replace(/\\/g, '/').replace(/\/+$/, '');
    const now = new Date().toISOString();
    const layout = remoteRunLayout({ workspaceRoot: runnerRoot, projectName: project.name, projectId: project.project_id,
      branch: sourceBranch ?? 'HEAD', commit: identity.commit, runId, purpose, createdAt: now });
    const candidateRoot = layout.source_root;
    const assetsRoot = path.posix.join(layout.run_root, 'development', 'assets');
    const relativeArtifact = resolved.target.artifacts.candidate.relative_path;
    const isolatedArtifact = buildDefinition !== requestedBuild ? isolatedCmakeArtifact(requestedBuild, relativeArtifact) : null;
    const artifact = isolatedArtifact ? path.posix.join(layout.build_root, isolatedArtifact) : path.posix.join(candidateRoot, relativeArtifact);
    const build = { ...buildDefinition, environment: { ...buildDefinition.environment, COREPILOT_SOURCE_ROOT: layout.source_root,
      COREPILOT_BUILD_ROOT: layout.build_root, COREPILOT_ARTIFACT_ROOT: layout.artifacts_root } };
    const buildCwd = path.posix.join(candidateRoot, build.cwd);
    const cases = resolved.bundle.correctness.cases;
    const workloads = resolved.bundle.workloads.workloads;
    const steps: ExperimentExecutionStep[] = [{ step: 'BUILD', execution_domain: 'CANDIDATE', command: { ...build, cwd: buildCwd } }];
    const experiment: Experiment = { schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION, experiment_id: trialId,
      task_id: `validation-trial:${project.project_id}`, candidate_id: `source:${identity.commit}`, type: 'DEVELOPMENT_FEEDBACK',
      status: 'PENDING', validity: 'UNKNOWN', failure_category: null, evaluator: { id: resolved.bundle.manifest.evaluator_id,
        version, digest: resolved.bundle.content_digest }, baseline: comparison ? { id: resolved.target.artifacts.baseline.id, digest: binding!.artifactDigest } : { id: 'none' },
      declared_context: { classification: 'DEVELOPMENT_ONLY', purpose,
        project_id: project.project_id, source_commit: identity.commit, evaluator_digest: resolved.bundle.content_digest,
        test_plan: testPlan, machine_identity_sha256: probe.machine.machine_identity_sha256, comparison, calibration: mode === 'calibration' ? 'AA_SAME_ARTIFACT' : null,
        project_name: project.name, source_branch: sourceBranch, workspace: layout },
      observed_context: null, evaluation: null, started_at: null, ended_at: null, created_at: now, updated_at: now };
    const record: TrialRecord = { schema_version: 1, trial_id: trialId, purpose, project_id: project.project_id,
      package_id: packageId, package_version: version, target_id: targetId, evaluator_digest: resolved.bundle.content_digest,
      source_commit: identity.commit, source_branch: sourceBranch, machine_id: connection.machineId,
      case_ids: purpose === 'BASELINE_BUILD' ? [] : cases.map(item => item.case_id),
      workload_ids: purpose === 'BASELINE_BUILD' ? [] : workloads.map(item => item.workload_id),
      artifact_path: artifact, created_at: now, machine_name: connection.machineName ?? probe.machine.hostname,
      remote_workspace: layout, build: { ...build, cwd: buildCwd }, build_definition: buildDefinition,
      ...(requestedBuild !== buildDefinition ? { requested_build_definition: requestedBuild } : {}),
      preparation: { state: 'PREPARING', phase: 'ARCHIVING', message: '正在按选定 commit 导出源码归档，无需在本机检出文件' } };
    record.mode = mode;
    record.test_plan = testPlan;
    record.quality = readValidationQuality(resolved.bundle.root, cases);
    record.correctness_inputs = cases.map(item => ({ input_id: item.execution?.input_id ?? item.case_id }));
    record.workload_specs = workloads.map(item => ({ case_id: item.workload_id, parameters: item.parameters, threads: item.threads, critical: item.critical, weight: item.weight }));
    record.workload_conditions = workloads.map(item => ({ workload_id: item.workload_id, input_id: item.execution?.input_id ?? item.workload_id,
      profile_name: testPlan.execution_matrix?.profiles.find(profile => profile.id === item.execution?.profile_id)?.name ?? '原有配置',
      ...entryResources(item, testPlan, resolved.bundle.manifest) }));
    if (mode === 'correctness') record.workload_ids = [];
    if (comparison) { record.baseline_digest = binding!.artifactDigest; const baseline = resolved.target.artifacts.baseline;
      record.baseline = { id: baseline.id, library: baseline.library, version: baseline.version, sha256: binding!.artifactDigest }; }
    const filename = this.trialPath(project, trialId);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const saveRecord = () => { const temporary = filename + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, filename); };
    saveRecord();
    // Only small evaluator files are snapshotted on Control; the source is never checked out here.
    const localAssets = snapshotValidationAssets(resolved.bundle.root, filename.replace(/\.json$/, '.assets'), resolved.bundle.content_digest);
    this.preparing.add(trialId);
    // The response owns only the stable ID. Preparing/transport and Runner execution outlive the browser request.
    const prepare = async () => {
      let submitting = false;
      const archiveFile = filename.replace(/\.json$/, '.source.tar.gz');
      try {
        const archive = await exportGitSourceArchive(project.repository_root, identity.commit, archiveFile);
        record.source_archive = { sha256: archive.sha256, bytes: archive.bytes };
        record.preparation = { state: 'PREPARING', phase: 'UPLOADING', message: `正在通过 Runner RPC 上传并核验源码归档（${(archive.bytes / 1024 ** 2).toFixed(1)} MB）` }; saveRecord();
        const staged = await client.uploadSourceArchive({ filename: archive.path, sha256: archive.sha256, workspacePath: candidateRoot });
        if (staged.archive_sha256 !== archive.sha256 || staged.workspace_path.replaceAll('\\', '/') !== candidateRoot) throw new Error('Runner 返回的源码归档或工作目录与本次构建不一致');
        record.source_sha256 = staged.source_sha256;
        experiment.declared_context = { ...experiment.declared_context, source_archive_sha256: archive.sha256, source_sha256: staged.source_sha256 };
        record.preparation = { state: 'PREPARING', phase: 'STAGED', message: '源码已在执行机器解包并核验' }; saveRecord();
        if (purpose !== 'BASELINE_BUILD') {
          record.preparation = { state: 'PREPARING', phase: 'STAGING_TESTS', message: '正在上传本次固定版本的测试代码与输入清单' }; saveRecord();
          await stageRemoteDevelopmentAssets({ evaluatorRoot: localAssets, transport, remoteWorkspace: assetsRoot });
        }
        let baseline: StagedRemoteBaseline | null = null;
        if (comparison) {
          record.preparation = { state: 'PREPARING', phase: 'STAGING_BASELINE', message: '正在上传并核验已固定的比较基线' }; saveRecord();
          const remoteRoot = path.posix.join(layout.run_root, 'baselines');
          baseline = binding!.bundle && binding!.bundleRoot && binding!.entryPath
            ? await stageVerifiedBinaryBaseline({ bundle: binding!.bundle, bundleRoot: binding!.bundleRoot, entryPath: binding!.entryPath,
              expectedDigest: binding!.artifactDigest, remoteRoot, target: connection.target, runner: connection.runner })
            : await stageRemoteBaseline({ sourceArtifact: baselinePath, sourceLocation: 'control', expectedDigest: binding!.artifactDigest,
              transport, remoteWorkspace: remoteRoot });
        }
        if (purpose !== 'BASELINE_BUILD') {
          const expanded = createFormalEvaluatorSteps({ bundle: { ...resolved.bundle, root: localAssets }, stagedEvaluatorRoot: assetsRoot,
            candidateSourceRoot: candidateRoot,
            runtimeRoot: path.posix.join(layout.run_root, 'development', 'runtime'),
            candidateArtifact: { artifactId: experiment.candidate_id, path: artifact, sha256: null },
            baselineArtifact: { artifactId: resolved.target.artifacts.baseline.id, path: baseline?.remote_artifact ?? artifact,
              sha256: baseline?.digest ?? null, ...(baseline?.dependencies ? { dependencies: baseline.dependencies } : {}) },
            ...(baseline?.library_paths ? { baselineLibraryPaths: baseline.library_paths } : {}),
            correctnessTimeoutMs: 120_000, performanceTimeoutMs: 120_000, includePerformance: mode !== 'correctness' });
          const probes = qualityProbeSteps(record.quality, cases, expanded, path.posix.join(layout.run_root, 'development', 'runtime'));
          if (expanded.length + probes.length > 2047) throw new Error('错误实现检验与测试组合超过 2048 条命令，请减少输入或运行矩阵');
          const performanceStart = expanded.findIndex(step => step.formal_context?.phase === 'PERFORMANCE_WARMUP' || step.formal_context?.phase === 'PERFORMANCE_SAMPLE');
          expanded.splice(performanceStart < 0 ? expanded.length : performanceStart, 0, ...probes);
          steps.push(...expanded.filter(step => mode !== 'smoke' || step.formal_context?.role !== 'BASELINE')
            .map(step => ({ ...step, execution_domain: 'CANDIDATE' as const, command: { ...step.command, cwd: candidateRoot } })));
        }
        const plan: ExperimentExecutionPlan = { experiment, candidate: { candidate_id: experiment.candidate_id,
          commit: identity.commit, tree: identity.tree, source_sha256: staged.source_sha256, workspace_path: candidateRoot },
          steps, output_directory: layout.logs_root, build_directory: layout.build_root };
        record.preparation = { state: 'PREPARING', phase: 'SUBMITTING', message: '正在向 Runner 提交构建与测试计划' }; saveRecord();
        submitting = true;
        await client.submitExperiment(plan);
        record.preparation = { state: 'READY', phase: 'SUBMITTED', message: null };
      } catch (error) {
        const unknown = submitting && !(error instanceof RunnerClientError && error.status !== null);
        record.preparation = { state: unknown ? 'UNKNOWN' : 'FAILED',
          message: `${unknown ? 'Runner 提交结果未知，请查询原试跑 ID。' : '试跑准备或提交失败：'}${(error as Error).message}` };
      } finally {
        saveRecord();
        this.preparing.delete(trialId);
        fs.rmSync(archiveFile, { force: true });
      }
    };
    void prepare().catch(() => { this.preparing.delete(trialId); });
    return { trial_id: trialId, status: 'PREPARING', source_commit: identity.commit, evaluator_digest: record.evaluator_digest,
      remote_workspace: layout, machine_name: record.machine_name, build: record.build };
  }

  list(project: ProjectRecord) {
    const root = path.join(this.dataDir, 'projects', project.project_id, 'validation-trials');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(filename => /^[a-f0-9-]{36}\.json$/.test(filename))
      .map(filename => JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8')) as TrialRecord)
      .filter(record => record.project_id === project.project_id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
  }

  async download(project: ProjectRecord, trialId: string) {
    const filename = this.trialPath(project, trialId);
    const record = JSON.parse(fs.readFileSync(filename, 'utf8')) as TrialRecord;
    if (record.project_id !== project.project_id) throw new Error('validation trial identity mismatch');
    return archiveValidationAssets(filename.replace(/\.json$/, '.assets'), record);
  }

  files(project: ProjectRecord, trialId: string) {
    const filename = this.trialPath(project, trialId);
    const record = JSON.parse(fs.readFileSync(filename, 'utf8')) as TrialRecord;
    if (record.project_id !== project.project_id) throw new Error('validation trial identity mismatch');
    return validationAssetFiles(filename.replace(/\.json$/, '.assets'));
  }

  async status(project: ProjectRecord, trialId: string) {
    const filename = this.trialPath(project, trialId);
    const record = JSON.parse(fs.readFileSync(filename, 'utf8')) as TrialRecord;
    if (record.project_id !== project.project_id || record.trial_id !== trialId) throw new Error('validation trial identity mismatch');
    const preparation = record.preparation;
    if (preparation && preparation.state !== 'READY' && preparation.state !== 'UNKNOWN') {
      const status = preparation.state === 'PREPARING' && !this.preparing.has(trialId) ? 'UNKNOWN' : preparation.state;
      return { trial: record, status: { status, failure: status === 'PREPARING' ? null : {
        message: status === 'UNKNOWN' ? 'Control 服务在准备期间中断，请核对原试跑 ID；系统不会自动重复提交。' : preparation.message } },
        commands: [], measurements: [], summary: trialSummary(record, []), passed: false, formal_evidence: false };
    }
    const connection = this.connection(project, record.machine_id);
    const client = new RunnerClient({ baseUrl: connection.runner.endpoint, token: connection.runner.token,
      requestTimeoutMs: connection.runner.requestTimeoutMs });
    const status = await client.getExperiment(trialId);
    const [commandResult, measurementResult, output] = await Promise.all([
      client.getCommandExecutions(trialId), client.getMeasurements(trialId),
      record.remote_workspace ? client.getExecutionOutput(trialId).catch(() => null) : Promise.resolve(null),
    ]);
    const commands = commandResult.command_executions;
    const measurements = measurementResult.measurements;
    const summary = trialSummary(record, measurements);
    return { trial: record, status, commands, measurements, summary, output,
      passed: status.status === 'SUCCEEDED' && summary.correctness.passed === summary.correctness.planned &&
        summary.performance.measured === summary.performance.planned && summary.issues.length === 0 &&
        ['NOT_CONFIGURED', 'PASSED'].includes(summary.quality.status),
      formal_evidence: false };
  }

  async freezeBranchArtifact(project: ProjectRecord, trialId: string, artifactRelativePath?: string) {
    const record = JSON.parse(fs.readFileSync(this.trialPath(project, trialId), 'utf8')) as TrialRecord;
    if (record.project_id !== project.project_id || record.purpose !== 'BASELINE_BUILD' || !record.source_branch) {
      throw new Error('只有本项目成功完成的分支构建才能固定为比较基线');
    }
    const resolved = this.catalog.resolveSelection({ package_id: record.package_id,
      package_version: record.package_version, target_id: record.target_id });
    if (resolved.bundle.content_digest !== record.evaluator_digest) throw new Error('验证草稿在构建后发生变化，请重新构建该分支基线');
    const result = await this.status(project, trialId);
    if (result.status.status !== 'SUCCEEDED') throw new Error(`分支构建尚未成功：${result.status.status}`);
    const root = path.join(this.dataDir, 'projects', project.project_id, 'baselines', trialId.slice('validation:'.length));
    fs.mkdirSync(root, { recursive: true });
    const artifact = path.join(root, 'artifact.so');
    const frozenPath = path.join(root, 'frozen.json');
    const artifacts = 'output' in result ? result.output?.artifacts ?? [] : [];
    if (record.remote_workspace && artifacts.length === 0) throw new Error('这次构建没有收集到新产物；请检查构建目标和输出目录，系统不会使用源码中已有的旧二进制');
    const selected = artifactRelativePath ? artifacts.find(item => item.relative_path === artifactRelativePath)
      : artifacts.find(item => item.source_path === record.artifact_path) ?? (artifacts.length === 1 ? artifacts[0] : null);
    if (artifactRelativePath && !selected) throw new Error('所选产物不属于这次构建，请重新读取构建结果');
    if (artifacts.length > 1 && !selected) throw new Error('这次构建生成多个产物，请选择用作比较基线的库文件');
    const remoteArtifact = selected?.path ?? record.artifact_path;
    const digestFile = async (filename: string) => {
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
      return hash.digest('hex');
    };
    if (fs.existsSync(frozenPath)) {
      const frozen = JSON.parse(fs.readFileSync(frozenPath, 'utf8')) as { sha256: string; remote_artifact?: string };
      if (artifactRelativePath && frozen.remote_artifact && frozen.remote_artifact !== remoteArtifact) throw new Error('此构建已固定另一产物，请新建构建来更换基线');
      if (await digestFile(artifact) !== frozen.sha256) throw new Error('已固定的分支基线副本发生变化，请重新构建');
      return { ...frozen, artifact_path: artifact, source_commit: record.source_commit,
        source_branch: record.source_branch, package_id: record.package_id, package_version: record.package_version,
        target_id: record.target_id, machine_id: record.machine_id, trial_id: record.trial_id };
    }
    const connection = this.connection(project, record.machine_id);
    const transport = this.transportFactory(connection.target);
    const remoteHash = await transport.runRemote(['sha256sum', '--', remoteArtifact]);
    const remoteDigest = remoteHash.stdout.match(/^([a-f0-9]{64})\s/i)?.[1]?.toLowerCase();
    if (remoteHash.exit_code !== 0 || !remoteDigest) throw new Error(remoteHash.stderr || '无法核验目标机分支产物 SHA-256');
    if (selected && selected.sha256 !== remoteDigest) throw new Error('这次构建的产物在构建后发生变化，请重新构建后固定基线');
    if (!fs.existsSync(artifact)) {
      const temporary = artifact + '.' + randomUUID() + '.tmp';
      if (!transport.downloadFile) throw new Error('执行机器传输层不支持读取构建产物');
      try {
        const downloaded = await Promise.resolve(transport.downloadFile(remoteArtifact, temporary));
        if (downloaded.exit_code !== 0) throw new Error(downloaded.stderr || '无法从执行机器读取分支构建产物');
        if (!fs.statSync(temporary).isFile()) throw new Error('下载的比较基线不是文件');
        if (await digestFile(temporary) !== remoteDigest) throw new Error('下载的分支产物与目标机 SHA-256 不一致');
        fs.renameSync(temporary, artifact);
      } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
    }
    const digest = await digestFile(artifact);
    if (digest !== remoteDigest) throw new Error('分支基线副本与目标机 SHA-256 不一致');
    fs.writeFileSync(frozenPath, JSON.stringify({ sha256: digest, remote_artifact: remoteArtifact }) + '\n', { mode: 0o600 });
    return { artifact_path: artifact, sha256: digest, source_commit: record.source_commit,
      source_branch: record.source_branch, package_id: record.package_id, package_version: record.package_version,
      target_id: record.target_id, machine_id: record.machine_id, trial_id: record.trial_id };
  }
}
