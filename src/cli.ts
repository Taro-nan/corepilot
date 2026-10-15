import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseOptimizeCliInput, OptimizeCliInputError } from './config/optimize-cli-input.js';
import { isBuildConfigured, loadOptimizationConfig, resolveOptimizationApiKey, resolveOptimizationProxy } from './config/optimization-config.js';
import { SqliteTaskStore } from './storage/sqlite-task-store.js';
import { TaskHost } from './core/task-host.js';
import { OptimizationWorkflowService } from './workflow/optimization-workflow-service.js';
import { createHttpServer } from './http/server.js';
import { MockRemoteTransport, SshTransport } from './testpack/remote-transport.js';
import { ApiClient } from './client/api-client.js';
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

function fail(message: string): number { console.error(`corepilot: ${message}`); return 1; }
function serverUrl(): string { return process.env.PHYOPT_SERVER_URL ?? 'http://127.0.0.1:4317'; }

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
      dbPath: path.join(loaded.configDir, '.phyopt', 'workflow.sqlite'),
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
    const loaded = loadOptimizationConfig(input.configPath);
    if (!loaded.config.validation.library_package && !isBuildConfigured(loaded.config.build)) return fail('请先使用 /build 配置构建命令。');
    const credential = resolveOptimizationApiKey(loaded.config, { cliApiKey: input.apiKey });
    const backend = backendSpec(input.configPath);
    await new BackendManager({ ...backend, allowSpawn: true }).ensure();
    const submitted = await new ApiClient(backend.url).submitOptimizationWorkflow({
      function_name: input.functionName,
      entry_file: input.entryFile,
      config_path: input.configPath,
      repository_root: input.repositoryRoot,
      enable_performance: input.enablePerformance,
    }, credential.apiKey ? { apiKey: credential.apiKey } : {}) as { workflow_id?: string };
    if (!submitted.workflow_id) return fail('后台没有返回 workflow_id');
    console.log(`已提交优化工作流：${submitted.workflow_id}`);
    console.log(`查询进度：corepilot workflow status ${submitted.workflow_id}`);
    return 0;
  } catch (error) {
    if (error instanceof OptimizeCliInputError) return fail(error.message);
    return fail((error as Error).message);
  }
}

async function serve(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, options: { db: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' }, transport: { type: 'string' }, 'ssh-alias': { type: 'string' }, 'ssh-host': { type: 'string' }, 'ssh-username': { type: 'string' }, 'ssh-port': { type: 'string' }, 'ssh-identity-file': { type: 'string' } }, allowPositionals: false, strict: true });
  } catch (error) { return fail((error as Error).message); }
  const hostName = typeof parsed.values.host === 'string' ? parsed.values.host : '127.0.0.1';
  const port = typeof parsed.values.port === 'string' ? Number(parsed.values.port) : 4317;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return fail('port 必须是 0..65535 的整数');
  const dbPath = path.resolve(typeof parsed.values.db === 'string' ? parsed.values.db : path.join('.phyopt', 'workflow.sqlite'));
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
      ? { host: configuredHost, username: configuredUsername, port: configuredPort, ...(configuredIdentityFile ? { identity_file: configuredIdentityFile } : {}), workspace_root: '/tmp/phyopt' }
      : 'localhost';
  const store = new SqliteTaskStore(dbPath);
  const host = new TaskHost(store);
  await host.start();
  const transport = (target?: TargetConfig | string) => transportKind === 'mock' ? new MockRemoteTransport() : new SshTransport(target ?? configuredTarget);
  const service = new OptimizationWorkflowService({ store, host, transportFactory: () => transport(), publicValidationTransportFactory: (target) => transport(target), publicExecution: true });
  let shuttingDown = false;
  let server: ReturnType<typeof createHttpServer>;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    service.stop();
    server.close(() => { void host.stop(); });
  };
  const token = process.env[MANAGED_BACKEND_TOKEN_ENV];
  server = createHttpServer(host, { host: hostName, port, workflowService: service, ...(token ? { managedShutdown: { token, requestShutdown: shutdown } } : {}) });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.log(`corepilot server listening on http://${hostName}:${port}`);
  await new Promise<void>((resolve) => server.once('close', resolve));
  await host.stop();
  return 0;
}

async function workflow(args: string[]): Promise<number> {
  const [action, workflowId, ...rest] = args;
  if (!action || !workflowId) return fail('用法：corepilot workflow status|cancel|approve <workflow-id>');
  const api = new ApiClient(serverUrl());
  try {
    if (action === 'status' && rest.length === 0) {
      const result = await api.getOptimizationWorkflow(workflowId) as { workflow?: { status?: string; progress?: { phase?: string }; error?: string | null } };
      console.log(`工作流：${workflowId}`);
      console.log(`状态：${result.workflow?.status ?? 'UNKNOWN'}`);
      console.log(`阶段：${result.workflow?.progress?.phase ?? '-'}`);
      if (result.workflow?.error) console.log(`错误：${result.workflow.error}`);
      return 0;
    }
    if (action === 'cancel' && rest.length === 0) {
      const result = await api.cancelOptimizationWorkflow(workflowId) as { status?: string; message?: string };
      console.log(`${result.status ?? 'CANCEL_REQUESTED'}${result.message ? `：${result.message}` : ''}`);
      return 0;
    }
    if (action === 'approve') {
      const parsed = parseArgs({ args: rest, options: { 'commit-message': { type: 'string' }, 'expected-baseline-commit': { type: 'string' } }, allowPositionals: false, strict: true });
      const message = parsed.values['commit-message'];
      if (typeof message !== 'string' || !message.trim()) return fail("workflow approve 需要 '--commit-message <说明>'");
      const result = await api.requestWorkflowApprove(workflowId, { commit_message: message, ...(parsed.values['expected-baseline-commit'] ? { expected_baseline_commit: parsed.values['expected-baseline-commit'] } : {}) }) as { commit?: string };
      console.log(`已审批并合入：${result.commit ?? workflowId}`);
      return 0;
    }
    return fail('用法：corepilot workflow status|cancel|approve <workflow-id>');
  } catch (error) { return fail((error as Error).message); }
}

async function backend(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === 'serve') return serve(rest);
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs({ args: rest, options: { config: { type: 'string' } }, allowPositionals: false, strict: true }); }
  catch (error) { return fail((error as Error).message); }
  const configPath = path.resolve(typeof parsed.values.config === 'string' ? parsed.values.config : 'phyopt.yaml');
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
      if (parsed.positionals.length !== 1) return fail('usage: corepilot package init <repo-path> [--id <id>] [--target <symbol>] [--config <phyopt.yaml>] [--output-root <path>]');
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
  if (!command) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return fail('交互式工作台需要终端；使用 corepilot --help 查看命令');
    const { startInteractive } = await import('./cli-interactive/start.js');
    await startInteractive();
    return 0;
  }
  if (command === 'optimize') return optimize(args);
  if (command === 'workflow') return workflow(args);
  if (command === 'backend') return backend(args);
  if (command === 'serve') return serve(args);
  if (command === 'package') return libraryPackageCommand(args);
  if (command === '--help' || command === '-h' || command === '--version' || command === 'version') return main(argv);
  return fail(`未知命令 '${command}'`);
}
