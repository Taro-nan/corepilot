import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseOptimizeCliInput, renderOptimizeCliHelp, OptimizeCliInputError } from './config/optimize-cli-input.js';
import { isBuildConfigured, loadOptimizationConfig, resolveOptimizationApiKey, resolveOptimizationProxy } from './config/optimization-config.js';
import { SqliteTaskStore } from './storage/sqlite-task-store.js';
import { TaskHost } from './core/task-host.js';
import { OptimizationWorkflowService } from './workflow/optimization-workflow-service.js';
import { createHttpServer } from './http/server.js';
import { MockRemoteTransport, AsyncSshTransport } from './testpack/remote-transport.js';
import { ApiClient } from './client/api-client.js';
import { uploadProjectBaseline, uploadProjectBaselineBundle } from './client/upload-baseline.js';
import { BackendManager, managedStatePath, stopManagedBackend } from './backend/backend-manager.js';
import { probeBackend } from './backend/health.js';
import { MANAGED_BACKEND_TOKEN_ENV } from './backend/managed-control.js';
import { renderCliHelp } from './cli-command-spec.js';
import { VERSION } from './version.js';
import type { TargetConfig } from './config/target-config.js';
import { LibraryPackageLoader } from './library-package/loader.js';
import { onboardLibraryRepository } from './onboarding/onboarding-agent.js';
import { createPiModel, createPiModels } from './model/pi-provider.js';
import { createPiRuntimeStream } from './agent/pi-agent-runtime.js';
import { createModelTransport, type ModelTransport } from './model/model-transport.js';
import { executeWorkflowCommand } from './client/workflow-commands.js';
import { checkOptimization } from './workflow/check-optimization.js';
import { ProjectService } from './application/project-service.js';
import { TestingService } from './application/testing-service.js';
import { executeTestingCommand } from './client/testing-commands.js';
import { verifyFrozenEvidenceArchive } from './workspace/frozen-evidence.js';
import { recalculateFrozenEvidenceArchive } from './application/evidence-statistics-recalculation.js';

function fail(message: string): number { console.error(`corepilot: ${message}`); return 1; }
function serverUrl(): string { return process.env.COREPILOT_SERVER_URL ?? 'http://127.0.0.1:4317'; }

function evidenceCommand(args: string[]): number {
  try {
    const parsed = parseArgs({ args, allowPositionals: true, strict: true,
      options: { sha256: { type: 'string' }, json: { type: 'boolean' }, 'recalculate-performance': { type: 'boolean' } } });
    if (parsed.positionals.length !== 2 || parsed.positionals[0] !== 'verify' || !parsed.values.sha256) {
      throw new Error('用法：corepilot evidence verify <归档文件> --sha256 <可信渠道提供的 SHA-256> [--recalculate-performance] [--json]');
    }
    const recalculation = parsed.values['recalculate-performance'] ? recalculateFrozenEvidenceArchive(parsed.positionals[1], parsed.values.sha256) : null;
    const result = recalculation ?? verifyFrozenEvidenceArchive(parsed.positionals[1], parsed.values.sha256);
    const ok = !recalculation || recalculation.performance_recalculation.status === 'MATCH';
    console.log(JSON.stringify({ ok, ...result }, null, 2));
    return ok ? 0 : 2;
  } catch (error) {
    const message = (error as Error).message;
    if (!args.includes('--json')) return fail(message);
    console.error(JSON.stringify({ ok: false, code: 'EVIDENCE_VERIFICATION_FAILED', message }));
    return 1;
  }
}

export function main(argv: string[]): number {
  if (argv[0] === '--help' || argv[0] === '-h') { console.log(renderCliHelp()); return 0; }
  if (argv[0] === '--version' || argv[0] === 'version') { console.log(VERSION); return 0; }
  return 1;
}

function backendSpec(configPath: string) {
  const loaded = loadOptimizationConfig(configPath);
  const url = new URL(serverUrl());
  const target = loaded.config.target;
  return {
    url: url.toString().replace(/\/$/, ''),
    spec: {
      host: url.hostname,
      port: Number(url.port || 4317),
      dbPath: path.join(loaded.configDir, '.corepilot', 'workflow.sqlite'),
      runner: 'workflow' as const,
      transport: 'ssh' as const,
      sshAlias: 'ssh_alias' in target ? target.ssh_alias : null,
      ...( 'ssh_alias' in target ? {} : {
        sshHost: target.host,
        sshUsername: target.username,
        sshPort: target.port,
        ...(target.identity_file ? { sshIdentityFile: target.identity_file } : {}),
      }),
    },
  };
}

async function optimize(args: string[]): Promise<number> {
  try {
    const input = parseOptimizeCliInput(args);
    if (input.projectId) {
      const api = new ApiClient(serverUrl());
      const submitted = await api.submitOptimizationWorkflow({ project_id: input.projectId, ...(input.budget ? { budget: input.budget } : {}), ...(input.functionName ? { function_name: input.functionName } : {}), ...(input.sourceBranch ? { source_branch: input.sourceBranch } : {}), entry_file: input.entryFile, ...(input.candidateScope ? { candidate_scope: input.candidateScope } : {}), enable_performance: input.enablePerformance, ...(input.verificationMode ? { verification_mode: input.verificationMode } : {}) }, { apiKey: input.apiKey }) as { workflow_id: string };
      console.log(`已提交优化工作流：${submitted.workflow_id}`);
      if (input.watch) return await watchWorkflow(api, ['watch', submitted.workflow_id, ...(input.reportOutput ? ['--output', input.reportOutput] : [])]);
      return 0;
    }
    const loaded = loadOptimizationConfig(input.configPath);
    if (input.verificationMode !== 'source_only' && !loaded.config.validation.library_package && !isBuildConfigured(loaded.config.build)) return fail('请先使用 /build 配置构建命令。');
    const credential = resolveOptimizationApiKey(loaded.config, { cliApiKey: input.apiKey });
    const backend = backendSpec(input.configPath);
    await new BackendManager({ ...backend, allowSpawn: true }).ensure();
    const api = new ApiClient(backend.url);
    const submitted = await api.submitOptimizationWorkflow({
      function_name: input.functionName,
      ...(input.budget ? { budget: input.budget } : {}),
      entry_file: input.entryFile,
      ...(input.candidateScope ? { candidate_scope: input.candidateScope } : {}),
      config_path: input.configPath,
      repository_root: input.repositoryRoot,
      ...(input.sourceBranch ? { source_branch: input.sourceBranch } : {}),
      enable_performance: input.enablePerformance,
      ...(input.verificationMode ? { verification_mode: input.verificationMode } : {}),
    }, credential.apiKey ? { apiKey: credential.apiKey } : {}) as { workflow_id?: string };
    if (!submitted.workflow_id) return fail('后台没有返回 workflow_id');
    console.log(`已提交优化工作流：${submitted.workflow_id}`);
    if (input.watch) return await watchWorkflow(api, ['watch', submitted.workflow_id, ...(input.reportOutput ? ['--output', input.reportOutput] : [])], loaded.config.output_dir);
    console.log(`观察并生成报告：corepilot workflow watch ${submitted.workflow_id} --config "${input.configPath}"`);
    console.log(`导出报告：corepilot workflow report ${submitted.workflow_id} --output ./report --config "${input.configPath}"`);
    return 0;
  } catch (error) {
    if (error instanceof OptimizeCliInputError) return fail(error.message);
    return fail((error as Error).message);
  }
}

async function serve(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, options: { db: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' }, web: { type: 'boolean' }, 'data-dir': { type: 'string' }, transport: { type: 'string' }, 'ssh-alias': { type: 'string' }, 'ssh-host': { type: 'string' }, 'ssh-username': { type: 'string' }, 'ssh-port': { type: 'string' }, 'ssh-identity-file': { type: 'string' } }, allowPositionals: false, strict: true });
  } catch (error) { return fail((error as Error).message); }
  const hostName = typeof parsed.values.host === 'string' ? parsed.values.host : '127.0.0.1';
  const port = typeof parsed.values.port === 'string' ? Number(parsed.values.port) : 4317;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return fail('port 必须是 0..65535 的整数');
  const web = parsed.values.web === true;
  const dataDir = path.resolve(typeof parsed.values['data-dir'] === 'string' ? parsed.values['data-dir'] : web ? path.join(os.homedir(), '.corepilot') : '.corepilot');
  process.env.COREPILOT_CATALOG_DIR ??= path.join(dataDir, 'catalog');
  const dbPath = path.resolve(typeof parsed.values.db === 'string' ? parsed.values.db : path.join(dataDir, 'workflow.sqlite'));
  const accessToken = process.env.COREPILOT_SERVER_TOKEN;
  if (!['localhost', '127.0.0.1', '::1'].includes(hostName) && !accessToken) return fail('非回环地址监听需要设置 COREPILOT_SERVER_TOKEN（网页登录和 CLI 共用）');
  const webRoot = fileURLToPath(new URL('../web/dist', import.meta.url));
  if (web && !fs.existsSync(path.join(webRoot, 'index.html'))) return fail('网页资源不存在，请先运行 npm run build');
  const transportKind = parsed.values.transport === 'mock' ? 'mock' : 'ssh';
  const configuredAlias = typeof parsed.values['ssh-alias'] === 'string' ? parsed.values['ssh-alias'] : null;
  const configuredHost = typeof parsed.values['ssh-host'] === 'string' ? parsed.values['ssh-host'] : null;
  const configuredUsername = typeof parsed.values['ssh-username'] === 'string' ? parsed.values['ssh-username'] : null;
  const configuredPort = typeof parsed.values['ssh-port'] === 'string' ? Number(parsed.values['ssh-port']) : 22;
  const configuredIdentityFile = typeof parsed.values['ssh-identity-file'] === 'string' ? parsed.values['ssh-identity-file'] : null;
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) return fail('ssh-port 必须是 1..65535 的整数');
  if (configuredAlias && (configuredHost || configuredUsername)) return fail('ssh-alias 不能与直接 SSH 地址/用户名同时使用');
  if (configuredAlias && configuredIdentityFile) return fail('ssh-alias 不能与 ssh-identity-file 同时使用');
  if ((configuredHost && !configuredUsername) || (!configuredHost && configuredUsername)) return fail('直接 SSH 连接必须同时提供 ssh-host 和 ssh-username');
  if (configuredIdentityFile && !configuredHost) return fail('ssh-identity-file 只能用于直接 SSH 连接');
  const configuredTarget: TargetConfig | string = configuredAlias
    ? configuredAlias
    : configuredHost && configuredUsername
      ? { host: configuredHost, username: configuredUsername, port: configuredPort, ...(configuredIdentityFile ? { identity_file: configuredIdentityFile } : {}), workspace_root: '/tmp/corepilot' }
      : 'localhost';
  const store = new SqliteTaskStore(dbPath);
  const host = new TaskHost(store);
  await host.start();
  const transport = (target?: TargetConfig | string) => transportKind === 'mock' ? new MockRemoteTransport() : new AsyncSshTransport(target ?? configuredTarget);
  const service = new OptimizationWorkflowService({ store, host, worktreeRoot: path.join(dataDir, 'worktrees'), transportFactory: () => transport(), publicValidationTransportFactory: (target) => transport(target), publicExecution: true });
  let shuttingDown = false;
  let server: ReturnType<typeof createHttpServer>;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void service.stop().finally(() => server.close(() => { void host.stop(); }));
  };
  const token = process.env[MANAGED_BACKEND_TOKEN_ENV];
  const projects = new ProjectService(store, dataDir);
  const testing = new TestingService({ dataDir, projects, catalog: projects.packageLoader, machines: projects.machines });
  server = createHttpServer(host, { host: hostName, port, workflowService: service, projectService: projects, testingService: testing,
    accessToken, ...(web ? { webRoot } : {}), ...(token ? { managedShutdown: { token, requestShutdown: shutdown } } : {}) });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.log(`corepilot server listening on http://${hostName}:${port}`);
  if (web) console.log(`CorePilot 网页与 CLI 共用此 API；数据目录：${dataDir}`);
  await new Promise<void>((resolve) => server.once('close', resolve));
  await host.stop();
  return 0;
}

async function workflow(args: string[]): Promise<number> {
  try {
    // Extract --config without consuming the shared command's other options.
    const forwarded: string[] = [];
    let configPath: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--config') {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--config requires a path');
        configPath = args[++i];
      } else if (args[i].startsWith('--config=')) configPath = args[i].slice(9);
      else forwarded.push(args[i]);
    }
    let api = new ApiClient(serverUrl());
    let reportRoot: string | undefined;
    if (configPath) {
      const backend = backendSpec(path.resolve(configPath));
      await new BackendManager({ ...backend, allowSpawn: true }).ensure();
      api = new ApiClient(backend.url);
      reportRoot = loadOptimizationConfig(path.resolve(configPath)).config.output_dir;
    }
    return await watchWorkflow(api, forwarded, reportRoot);
  } catch (error) { return fail((error as Error).message); }
}

async function watchWorkflow(api: ApiClient, args: string[], reportRoot?: string): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  try {
    const result = await executeWorkflowCommand(api, args, { print: console.log, signal: controller.signal, reportRoot });
    console.log(result.message);
    return result.ok ? 0 : 1;
  } finally { process.off('SIGINT', interrupt); }
}

async function check(args: string[]): Promise<number> {
  try {
    const parsed = parseArgs({ args, strict: true, options: { config: { type: 'string' }, function: { type: 'string' }, 'source-only': { type: 'boolean' }, branch: { type: 'string' }, allow: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true } } });
    const result = await checkOptimization(path.resolve(parsed.values.config ?? 'corepilot.yaml'), parsed.values.function,
      { ...(parsed.values['source-only'] ? { verificationMode: 'source_only' as const, candidateScope: { include: parsed.values.allow ?? [], exclude: parsed.values.exclude ?? [] } } : {}), repositoryRoot: process.cwd(), sourceBranch: parsed.values.branch });
    console.log(result.message);
    return 0;
  } catch (error) { return fail(`运行条件检查失败：${(error as Error).message}`); }
}

async function projectCommand(args: string[]): Promise<number> {
  try {
    const parsed = parseArgs({ args, allowPositionals: true, options: { root: { type: 'string' }, name: { type: 'string' }, config: { type: 'string' }, branch: { type: 'string' }, function: { type: 'string' }, inspect: { type: 'boolean' }, file: { type: 'string' }, directory: { type: 'string' }, entry: { type: 'string' }, generate: { type: 'boolean' }, propose: { type: 'boolean' }, 'accept-plan': { type: 'string' }, scope: { type: 'string' }, prompt: { type: 'string' }, download: { type: 'string' }, compare: { type: 'boolean' }, calibrate: { type: 'boolean' }, 'library-name': { type: 'string' }, 'library-version': { type: 'string' }, 'build-script': { type: 'string' }, 'build-cwd': { type: 'string' }, artifact: { type: 'string' } } });
    const [action, id] = parsed.positionals;
    if (parsed.values.prompt !== undefined && !(action === 'validation' && (parsed.values.generate || parsed.values.propose))) return fail('--prompt 只能与 project validation --generate 或 --propose 一起使用');
    const api = new ApiClient(serverUrl());
    let result: unknown;
    if (action === 'list') result = await api.listProjects();
    else if (action === 'add' && parsed.values.root && parsed.values.name) result = await api.addProject({ name: parsed.values.name, repository_root: parsed.values.root, config_path: parsed.values.config, source_branch: parsed.values.branch });
    else if (action === 'inspect' && id) result = await api.projectAction(id);
    else if (action === 'check' && id) result = await api.projectAction(id, 'check', {});
    else if (action === 'setup' && id) result = parsed.values.inspect ? await api.projectAction(id, 'source-inspection', {}) : await api.projectAction(id, 'setup');
    else if (action === 'validation-plans' && id && parsed.values.function?.trim()) result = await api.projectAction(id, `validation-plans?function_name=${encodeURIComponent(parsed.values.function.trim())}`);
    else if (action === 'build-options' && id) result = await api.projectAction(id, `build-options${parsed.positionals[2] ? `?machine_id=${encodeURIComponent(parsed.positionals[2])}` : ''}`);
    else if (action === 'machine' && id && parsed.positionals[2]) result = await api.projectAction(id, 'machine', { machine_id: parsed.positionals[2] }, 'PUT');
    else if (action === 'validation-review' && id && parsed.positionals.length === 5) {
      const [, , packageId, version, targetId] = parsed.positionals;
      const endpoint = `validation-assets/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}/${encodeURIComponent(targetId)}/review`;
      if (parsed.values.file) {
        const input = JSON.parse(fs.readFileSync(path.resolve(parsed.values.file), 'utf8'));
        result = await api.projectAction(id, endpoint, { expected_digest: input.expected_digest ?? input.evaluator_digest,
          expected_package_digest: input.expected_package_digest ?? input.package_digest, trial_id: input.trial_id ?? input.trial?.trial_id,
          reviewer: input.reviewer, confirm: input.confirm }, 'POST');
      } else result = await api.projectAction(id, endpoint);
    }
    else if (action === 'validation-review') return fail('project validation-review <project-id> <package-id> <version> <target-id> [--file <人工确认.json>]');
    else if (action === 'validation' && id && parsed.positionals.length === 5) {
      const [, , packageId, version, targetId] = parsed.positionals;
      const endpoint = `validation-assets/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}/${encodeURIComponent(targetId)}`;
      if ([parsed.values.file, parsed.values.generate, parsed.values.download, parsed.values.propose, parsed.values['accept-plan']].filter(Boolean).length > 1) return fail('validation 的 --file、--generate、--download、--propose、--accept-plan 不能同时使用');
      if (parsed.values.propose) {
        result = await api.projectAction(id, endpoint + '/generate', { purpose: 'CORRECTNESS_PLAN', instructions: parsed.values.prompt }, 'POST');
      } else if (parsed.values['accept-plan']) {
        const current = await api.projectAction(id, endpoint) as { evaluator_digest: string };
        result = await api.projectAction(id, endpoint + '/generations/' + encodeURIComponent(parsed.values['accept-plan']) + '/adopt', { expected_digest: current.evaluator_digest }, 'POST');
      } else if (parsed.values.download) {
        const filename = path.resolve(parsed.values.download);
        fs.writeFileSync(filename, await api.downloadProjectTests(id, endpoint + '/download'));
        result = { path: filename };
      } else if (parsed.values.file) {
        const input = JSON.parse(fs.readFileSync(path.resolve(parsed.values.file), 'utf8')) as Record<string, unknown>;
        result = await api.projectAction(id, endpoint, { ...input, expected_digest: input.expected_digest ?? input.evaluator_digest }, 'PUT');
      } else result = parsed.values.generate
        ? await api.projectAction(id, endpoint + '/generate', { scope: parsed.values.scope ?? 'correctness', instructions: parsed.values.prompt }, 'POST')
        : await api.projectAction(id, endpoint);
    }
    else if (action === 'trial' && id && parsed.positionals.length === 5) {
      if (parsed.values.compare && parsed.values.calibrate) throw new Error('--compare 与 --calibrate 不能同时使用');
      const [, , packageId, version, targetId] = parsed.positionals;
      result = await api.projectAction(id, 'validation-trials', { package_id: packageId, package_version: version,
        target_id: targetId, mode: parsed.values.calibrate ? 'calibration' : parsed.values.compare ? 'comparison' : 'correctness', ...(parsed.values.branch ? { source_branch: parsed.values.branch } : {}) });
    }
    else if (action === 'trial-status' && id && parsed.positionals.length === 3) {
      result = await api.projectAction(id, `validation-trials/${encodeURIComponent(parsed.positionals[2])}`);
    }
    else if (action === 'baseline-branch' && id && parsed.positionals.length === 5 && parsed.values.branch) {
      const [, , packageId, version, targetId] = parsed.positionals;
      result = await api.projectAction(id, 'validation-trials', { package_id: packageId, package_version: version,
        target_id: targetId, source_branch: parsed.values.branch, purpose: 'BASELINE_BUILD',
        ...(parsed.values['build-script'] ? { build: { command: fs.readFileSync(path.resolve(parsed.values['build-script']), 'utf8'), cwd: parsed.values['build-cwd'] ?? '.' } } : {}) });
    }
    else if (action === 'baseline-freeze' && id && parsed.positionals.length === 3) {
      result = await api.projectAction(id, `validation-trials/${encodeURIComponent(parsed.positionals[2])}/freeze-baseline`,
        parsed.values.artifact ? { artifact_relative_path: parsed.values.artifact } : {});
    }
    else if (action === 'baseline-upload' && id && parsed.positionals.length === 5 && parsed.values.file && parsed.values['library-name'] && parsed.values['library-version']) {
      const [, , packageId, version, targetId] = parsed.positionals;
      result = await uploadProjectBaseline(serverUrl(), id, { packageId, version, targetId, library: parsed.values['library-name'],
        libraryVersion: parsed.values['library-version'], file: path.resolve(parsed.values.file) });
    }
    else if (action === 'baseline-bundle' && id && parsed.positionals.length === 5 && parsed.values.directory && parsed.values.entry && parsed.values['library-name'] && parsed.values['library-version']) {
      const [, , packageId, version, targetId] = parsed.positionals;
      result = await uploadProjectBaselineBundle(serverUrl(), id, { packageId, version, targetId,
        library: parsed.values['library-name'], libraryVersion: parsed.values['library-version'],
        directory: path.resolve(parsed.values.directory), entry: parsed.values.entry });
    }
    else return fail('project list | project add --name <名称> --root <服务器绝对路径> [--config <服务器配置路径>] [--branch <本地分支>] | project inspect|check <id> | project setup <id> [--inspect] | project build-options <id> [machine-id] | project machine <项目 ID> <机器 ID> | project validation <项目 ID> <Package ID> <版本> <目标 ID> [--propose | --accept-plan <生成记录 ID> | --generate --scope correctness|performance|both | --file <草稿.json> | --download <测试包.tar.gz>] | project trial <项目 ID> <Package ID> <版本> <目标 ID> [--compare | --calibrate] [--branch <分支>] | project trial-status <项目 ID> <试跑 ID> | project baseline-branch <项目 ID> <Package ID> <版本> <目标 ID> --branch <分支> | project baseline-freeze <项目 ID> <试跑 ID> | project baseline-upload <项目 ID> <Package ID> <版本> <目标 ID> --file <产物> --library-name <名称> --library-version <版本> | project baseline-bundle <项目 ID> <Package ID> <版本> <目标 ID> --directory <已解包目录> --entry <入口库相对路径> --library-name <名称> --library-version <版本>');
    console.log(JSON.stringify(result, null, 2)); return ['baseline-bundle', 'baseline-upload'].includes(action ?? '') && (result as { ok?: boolean }).ok === false ? 1 : 0;
  } catch (error) { return fail((error as Error).message); }
}

async function machineCommand(args: string[]): Promise<number> {
  try {
    const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { file: { type: 'string' } } });
    const [action, id] = parsed.positionals;
    const api = new ApiClient(serverUrl());
    let result: unknown;
    if (action === 'list') result = await api.listExecutionMachines();
    else if (action === 'inspect' && id) result = await api.machineAction(id, 'configuration');
    else if (action === 'check' && id) result = await api.machineAction(id, 'check', {});
    else if ((action === 'add' || action === 'update' && id) && parsed.values.file) {
      const machine = JSON.parse(fs.readFileSync(path.resolve(parsed.values.file), 'utf8'));
      result = await api.machineAction(action === 'add' ? '' : id, '', { machine }, action === 'add' ? 'POST' : 'PUT');
    } else return fail('machine list | machine inspect|check <id> | machine add --file <JSON> | machine update <id> --file <JSON>');
    console.log(JSON.stringify(result, null, 2));
    return action === 'check' && (result as { machine: { status: string } }).machine.status !== 'ONLINE' ? 1 : 0;
  } catch (error) { return fail((error as Error).message); }
}

async function backend(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === 'serve') return serve(rest);
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs({ args: rest, options: { config: { type: 'string' } }, allowPositionals: false, strict: true }); }
  catch (error) { return fail((error as Error).message); }
  const configPath = path.resolve(typeof parsed.values.config === 'string' ? parsed.values.config : 'corepilot.yaml');
  try {
    const spec = backendSpec(configPath);
    if (action === 'start') {
      const result = await new BackendManager({ ...spec, allowSpawn: true }).ensure();
      console.log(`${result.reused ? '复用' : '启动'}后台：${result.url}`);
      return 0;
    }
    if (action === 'status') {
      const result = await probeBackend(spec.url);
      console.log(result.kind === 'ok' ? `后台正常：${spec.url}` : `后台状态：${result.kind}`);
      return result.kind === 'ok' ? 0 : 1;
    }
    if (action === 'stop') {
      const result = await stopManagedBackend({ url: spec.url, statePath: managedStatePath(spec.spec.dbPath) });
      console.log(result.reason);
      return result.stopped ? 0 : 1;
    }
    return fail('用法：corepilot backend start|serve|status|stop [--config <path>]');
  } catch (error) { return fail((error as Error).message); }
}

async function libraryPackageCommand(args: string[]): Promise<number> {
  try {
    const [action, packageId, packageVersion, ...extra] = args;
    const loader = new LibraryPackageLoader();
    if (action === 'init') {
      const parsed = parseArgs({
        args: args.slice(1), allowPositionals: true, strict: true,
        options: {
          id: { type: 'string' }, version: { type: 'string' }, target: { type: 'string' },
          config: { type: 'string' }, 'api-key': { type: 'string' }, 'output-root': { type: 'string' },
        },
      });
      if (parsed.positionals.length !== 1) return fail('usage: corepilot package init <repo-path> [--id <id>] [--target <symbol>] [--config <corepilot.yaml>] [--output-root <path>]');
      const outputRoot = parsed.values['output-root'] ? path.resolve(parsed.values['output-root']) : path.dirname(loader.packagesRoot);
      let pi: Parameters<typeof onboardLibraryRepository>[0]['pi'];
      let modelTransport: ModelTransport | undefined;
      if (parsed.values.config) {
        const loaded = loadOptimizationConfig(path.resolve(parsed.values.config));
        const credential = resolveOptimizationApiKey(loaded.config, { cliApiKey: parsed.values['api-key'] });
        const modelConfig = {
          modelId: loaded.config.model.model_id, endpoint: loaded.config.model.endpoint, apiKey: credential.apiKey,
          reasoningEffort: loaded.config.model.reasoning_effort, maxOutputTokens: loaded.config.model.max_output_tokens,
        };
        modelTransport = createModelTransport(resolveOptimizationProxy(loaded.config)?.proxy);
        pi = {
          model: createPiModel(modelConfig),
          streamFn: createPiRuntimeStream(createPiModels(modelConfig), { fetch: modelTransport.fetch, timeoutMs: loaded.config.model.timeout_ms }),
        };
      } else if (parsed.values['api-key']) return fail('--api-key requires --config');
      let draft: Awaited<ReturnType<typeof onboardLibraryRepository>>;
      try {
        draft = await onboardLibraryRepository({
          repositoryRoot: path.resolve(parsed.positionals[0]), packagesRoot: path.join(outputRoot, 'packages'), evaluatorsRoot: path.join(outputRoot, 'evaluators'),
          ...(parsed.values.id ? { packageId: parsed.values.id } : {}),
          ...(parsed.values.version ? { version: parsed.values.version } : {}),
          ...(parsed.values.target ? { targetSymbol: parsed.values.target } : {}),
          ...(pi ? { pi } : {}),
        });
      } finally {
        await modelTransport?.close();
      }
      console.log(JSON.stringify({
        repository_summary: draft.inspection.repository,
        build_proposal: draft.inspection.build_candidates.map((item) => ({
          ...item, evidence_count: item.evidence.length, evidence: item.evidence.slice(0, 10),
        })),
        functions: {
          count: draft.inspection.functions.length,
          candidates: draft.inspection.functions.slice(0, 20).map((item) => ({
            ...item,
            implementation_count: item.implementation_files.length,
            implementation_files: item.implementation_files.slice(0, 5),
            architecture_count: item.architecture_files.length,
            architecture_files: item.architecture_files.slice(0, 5),
            call_path: item.call_path.slice(0, 5),
          })),
        },
        candidate_scope: {
          include: draft.evidence.candidate_scope_proposal.include,
          exclude_count: draft.evidence.candidate_scope_proposal.exclude.length,
          exclude: draft.evidence.candidate_scope_proposal.exclude.slice(0, 20),
        },
        existing_tests: { count: draft.evidence.test_evidence.length, assets: draft.evidence.test_evidence.slice(0, 20) },
        existing_benchmarks: { count: draft.evidence.benchmark_evidence.length, assets: draft.evidence.benchmark_evidence.slice(0, 20) },
        dependencies: {
          ...draft.evidence.dependency_evidence,
          version_clues: draft.evidence.dependency_evidence.version_clues.slice(0, 10),
        },
        evaluator_draft: draft.evaluatorPath,
        package_draft: draft.packagePath,
        known_unknowns: draft.evidence.unknowns,
        risks: draft.evidence.risks,
        human_review: draft.evidence.human_decisions,
        qualification: { package: 'DRAFT', evaluator: 'DRAFT' },
      }, null, 2));
      return 0;
    }
    if (action === 'list' && !packageId) {
      console.log(JSON.stringify(loader.listPackages(), null, 2));
      return 0;
    }
    if (action === 'inspect' && packageId && extra.length === 0) {
      const matches = loader.listPackages().filter((item) => item.package_id === packageId);
      if (!packageVersion && matches.length !== 1) throw new Error('select an exact package version when zero or multiple versions exist');
      const loaded = loader.loadPackage(packageId, packageVersion ?? matches[0].version);
      console.log(JSON.stringify({
        manifest: loaded.manifest,
        content_digest: loaded.content_digest,
        builds: loaded.builds,
        evaluators: loaded.manifest.formal_evaluators.map((item) => {
          const bundle = loader.resolveEvaluator(loaded, item.evaluator_id, item.version);
          return { evaluator_id: item.evaluator_id, version: item.version, digest: bundle.content_digest, qualification: bundle.qualification.status };
        }),
      }, null, 2));
      return 0;
    }
    return fail('usage: corepilot package list | corepilot package inspect <id> [version] | corepilot package init <repo-path>');
  } catch (error) { return fail((error as Error).message); }
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'optimize' && (args.includes('--help') || args.includes('-h'))) { console.log(renderOptimizeCliHelp()); return 0; }
  if (command === 'workflow' && (args.includes('--help') || args.includes('-h'))) { console.log(renderCliHelp()); return 0; }
  if (!command) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return fail('交互式工作台需要终端；使用 corepilot --help 查看命令');
    const { startInteractive } = await import('./cli-interactive/start.js');
    await startInteractive();
    return 0;
  }
  if (command === 'optimize') return optimize(args);
  if (command === 'test') {
    try {
      const result = await executeTestingCommand(args, { baseUrl: serverUrl() });
      console.log(typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2));
      return result.exitCode;
    } catch (error) { return fail((error as Error).message); }
  }
  if (command === 'evidence') return evidenceCommand(args);
  if (command === 'workflow') return workflow(args);
  if (command === 'check') return check(args);
  if (command === 'backend') return backend(args);
  if (command === 'serve') return serve(args);
  if (command === 'web') return serve(['--web', ...args]);
  if (command === 'project') return projectCommand(args);
  if (command === 'machine') return machineCommand(args);
  if (command === 'package') return libraryPackageCommand(args);
  if (command === '--help' || command === '-h' || command === '--version' || command === 'version') return main(argv);
  return fail(`未知命令 '${command}'`);
}
