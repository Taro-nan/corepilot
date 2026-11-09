import fs from 'node:fs';
import path from 'node:path';
import type { ProjectRecord } from '../contracts/project.js';
import type { ResolvedExecutionMachine } from '../contracts/execution-machine.js';
import type { TestingPreparedSubject, TestingSubject } from '../contracts/testing.js';
import type { ExperimentExecutionStep } from '../contracts/runner-rpc.js';
import type { TargetConfig } from '../config/target-config.js';
import { loadOptimizationConfig, resolveRunnerConfig } from '../config/optimization-config.js';
import { commandBuild, isolatedCmakeArtifact, isolatedWorkspaceBuild } from '../config/build-command.js';
import { gitSourceVersion, exportGitSourceArchive } from '../workspace/git-source-archive.js';
import { stageAndInspectBaselineBundle } from '../workspace/baseline-bundle-staging.js';
import type { TestingAssetService } from './testing-assets.js';
import type { ResolvedTestingPlan } from './testing-plan.js';
import type { RunnerClient } from '../client/runner-client.js';

export type TestingRunner = Pick<RunnerClient, 'probe' | 'submitExperiment' | 'getExperiment' | 'cancelExperiment' |
  'getCommandExecutions' | 'getMeasurements' | 'getExecutionOutput' | 'uploadSourceArchive'>;
export type TestingBinaryStager = typeof stageAndInspectBaselineBundle;
export interface TestingSubjectContext {
  projects: { get(id: string): ProjectRecord };
  resolved: ResolvedTestingPlan;
  assets: TestingAssetService;
  machine: ResolvedExecutionMachine;
  runner: TestingRunner;
  stageBinary: TestingBinaryStager;
  localRoot: string;
  remoteRoot: string;
  machineDigest: string;
  signal: AbortSignal;
}

/** Fix source versions and build settings before staging. Never check out or edit the user's branch. */
export async function freezeSourceSubject(subject: Extract<TestingSubject, { kind: 'source' }>, context: Pick<TestingSubjectContext, 'projects' | 'resolved' | 'remoteRoot'>): Promise<TestingPreparedSubject> {
  const project = context.projects.get(subject.project_id);
  const identity = await gitSourceVersion(project.repository_root, subject.commit ?? `refs/heads/${subject.branch}`);
  const config = loadOptimizationConfig(project.config_path).config;
  const previous = config.build.executable ? config.build : context.resolved.build;
  const requested = subject.build ? commandBuild(subject.build.command, { ...previous, cwd: subject.build.cwd ?? previous.cwd }) : previous;
  const build = isolatedWorkspaceBuild(requested);
  const sourceRoot = path.posix.join(context.remoteRoot, 'source'), buildRoot = path.posix.join(context.remoteRoot, 'build');
  const relativeArtifact = subject.artifact ?? context.resolved.target.artifacts.candidate.relative_path;
  const isolatedArtifact = build !== requested ? isolatedCmakeArtifact(requested, relativeArtifact) : null;
  const artifact = isolatedArtifact ? path.posix.join(buildRoot, isolatedArtifact) : path.posix.join(sourceRoot, relativeArtifact);
  return { kind: 'source', name: project.name, version: identity.commit, artifact_path: artifact, artifact_sha256: null,
    library_paths: [path.posix.dirname(artifact)], dependencies: [], source: { project_id: project.project_id,
      branch: subject.branch, commit: identity.commit, tree: identity.tree, workspace: sourceRoot, build_root: buildRoot,
      build: { ...build, cwd: path.posix.join(sourceRoot, build.cwd), environment: { ...build.environment,
        COREPILOT_SOURCE_ROOT: sourceRoot, COREPILOT_BUILD_ROOT: buildRoot, COREPILOT_ARTIFACT_ROOT: path.posix.join(context.remoteRoot, 'artifacts') } } } };
}

export async function stageSourceSubject(subject: TestingPreparedSubject, context: TestingSubjectContext): Promise<ExperimentExecutionStep> {
  const source = subject.source!;
  const project = context.projects.get(source.project_id);
  const archiveFile = path.join(context.localRoot, 'source.tar.gz');
  try {
    context.signal.throwIfAborted();
    const archive = await exportGitSourceArchive(project.repository_root, source.commit, archiveFile);
    const staged = await context.runner.uploadSourceArchive({ filename: archive.path, sha256: archive.sha256, workspacePath: source.workspace }, context.signal);
    if (staged.archive_sha256 !== archive.sha256 || staged.workspace_path.replaceAll('\\', '/') !== source.workspace) throw new Error('Runner 返回的源码归档身份或目录与本次测试不一致。');
    source.archive_sha256 = archive.sha256; source.source_sha256 = staged.source_sha256;
    return { step: 'BUILD', command: source.build };
  } finally { fs.rmSync(archiveFile, { force: true }); }
}

export async function stageBinarySubject(subject: Extract<TestingSubject, { kind: 'binary' }>, context: TestingSubjectContext): Promise<TestingPreparedSubject> {
  context.signal.throwIfAborted();
  const asset = await context.assets.verify(subject.asset_id);
  if (asset.state !== 'READY' || !asset.entry_path || !asset.sha256) throw new Error('请先为上传的库文件选择入口并固定版本。');
  const runner = resolveRunnerConfig({ runner: context.machine.runner });
  if (runner.mode !== 'rpc') throw new Error('测试需要 Runner RPC 执行机器。');
  const inspection = await context.stageBinary({ localRoot: context.assets.filesRoot(asset.asset_id), remoteRoot: context.remoteRoot,
    entryPath: asset.entry_path, files: asset.files, target: context.machine.target as TargetConfig,
    runner: { endpoint: runner.endpoint, token: runner.token, requestTimeoutMs: runner.requestTimeoutMs } });
  context.signal.throwIfAborted();
  if (!inspection.ok) throw new Error(`库文件依赖检查失败：${inspection.issues.join('；')}`);
  if (inspection.machine_identity_sha256 !== context.machineDigest) throw new Error('库文件检查返回了另一台执行机器，请核对机器连接。');
  const entry = asset.files.find(file => file.path === asset.entry_path)!;
  if (inspection.entry_sha256 !== entry.sha256) throw new Error('Runner 库入口身份与本次上传版本不一致。');
  const libraries = asset.files.filter(file => /\.so(?:\..*)?$/.test(file.path));
  const dependencies = [...libraries.filter(file => file.path !== asset.entry_path).map(file => ({
    path: path.posix.join(context.remoteRoot, file.path), sha256: file.sha256 })),
    ...inspection.resolved_libraries.filter(file => !file.path.startsWith(context.remoteRoot + '/')).map(file => ({ path: file.path, sha256: file.sha256 }))];
  return { kind: 'binary', name: asset.name, version: asset.version || asset.sha256, asset_id: asset.asset_id,
    artifact_path: path.posix.join(context.remoteRoot, asset.entry_path), artifact_sha256: entry.sha256,
    library_paths: [...new Set(libraries.map(file => path.posix.dirname(path.posix.join(context.remoteRoot, file.path))))],
    dependencies: [...new Map(dependencies.map(file => [file.path, file])).values()] };
}
