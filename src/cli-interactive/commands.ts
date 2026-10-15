import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WorkbenchContext } from './context.js';
import { parseOptimizeCliInput } from '../config/optimize-cli-input.js';
import { isBuildConfigured, loadOptimizationConfig, resolveConfiguredApiKey, resolveOptimizationApiKey, resolveOptimizationProxy, stringifyOptimizationConfig, REASONING_EFFORTS, type OptimizationConfig, type ReasoningEffort, type ResolvedModelCredential } from '../config/optimization-config.js';
import { buildCommandDisplay, buildTimeoutMinutes, DEFAULT_BUILD_CWD, DEFAULT_BUILD_TIMEOUT_MS, parseBuildCommand, validateBuildCwd, validateEnvironmentName } from '../config/build-config.js';
import { MODEL_SOURCES, type ModelSource, type ModelSourceId } from '../model/model-sources.js';
import { discoverOpenAIModels, ModelDiscoveryError } from '../model/model-discovery.js';
import { verifyToolCalling } from '../model/tool-verification.js';
import { readStoredApiKey, saveStoredApiKey } from '../config/credentials.js';
import { normalizeModelProxy, readStoredModelProxy, redactModelProxy, removeStoredModelProxy, saveStoredModelProxy } from '../config/model-settings.js';
import type { ModelTransport } from '../model/model-transport.js';
import { DEFAULT_WORKSPACE_ROOT, isAliasTarget, targetAuthDescription, targetDescription, targetLabel, targetConnectionId, type TargetConfig } from '../config/target-config.js';
import { listTargetProfiles, saveTargetProfile } from '../config/target-profiles.js';

export interface CommandIO {
  /** True for the Ink UI; allows prompt cancellation to finish immediately. */
  interactive?: boolean;
  print(text: string): void;
  error(text: string): void;
  prompt(question: string, options?: { secret?: boolean; initialValue?: string }): Promise<string | null>;
  select<T>(question: string, choices: Array<{ label: string; value: T }>): Promise<T | null>;
  confirm(question: string): Promise<boolean>;
}

export interface CommandOutcome { ok: boolean; message: string; exit?: boolean; data?: unknown }

type ApiKeyPromptResult =
  | { kind: 'credential'; credential: ResolvedModelCredential }
  | { kind: 'canceled' }
  | { kind: 'error'; message: string };

async function promptModelApiKey(source: ModelSource, io: CommandIO): Promise<ApiKeyPromptResult> {
  if (source.developerUrl) {
    io.print(`请配置您的 API Key；\n如尚未获取，请前往开发者平台申请：\n${source.developerUrl}`);
  }
  const apiKeyInput = await io.prompt('API Key：', { secret: true });
  if (apiKeyInput === null) return { kind: 'canceled' };
  const enteredApiKey = apiKeyInput.trim();
  if (!enteredApiKey) return { kind: 'error', message: 'API Key 不能为空，请重新执行 /model 配置。' };
  try {
    return { kind: 'credential', credential: resolveConfiguredApiKey(enteredApiKey, { env: process.env }) };
  } catch (error) {
    return { kind: 'error', message: `API Key 不可用：${(error as Error).message}` };
  }
}

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof ModelDiscoveryError && (error.status === 401 || error.status === 403);
}

type ModelProxySelection =
  | { kind: 'proxy'; proxy: string }
  | { kind: 'direct' }
  | { kind: 'canceled' };

async function chooseOpenAiProxy(currentProxy: string | undefined, io: CommandIO): Promise<ModelProxySelection> {
  while (true) {
    const action = await io.select('选择 GPT 连接方式', [
      ...(currentProxy ? [{ label: `使用已保存代理（${redactModelProxy(currentProxy)}）`, value: 'saved' as const }] : []),
      { label: currentProxy ? '输入新的代理地址' : '输入代理地址', value: 'new' as const },
      { label: '直连（不使用代理）', value: 'direct' as const },
    ]);
    if (!action) return { kind: 'canceled' };
    if (action === 'saved' && currentProxy) return { kind: 'proxy', proxy: currentProxy };
    if (action === 'direct') return { kind: 'direct' };

    const entered = await io.prompt('代理地址（如 http://127.0.0.1:17891）：', { initialValue: currentProxy ?? '' });
    if (entered === null) continue;
    if (!entered.trim()) {
      io.print('代理地址不能为空；如不使用代理，请选择“直连”。');
      continue;
    }
    try {
      return { kind: 'proxy', proxy: normalizeModelProxy(entered) };
    } catch (error) {
      io.print(`代理地址无效：${(error as Error).message}`);
    }
  }
}

function persistOpenAiProxy(ctx: WorkbenchContext, endpoint: string, proxy: string | undefined): void {
  if (proxy) saveStoredModelProxy(endpoint, proxy, { filePath: ctx.modelSettingsPath });
  else removeStoredModelProxy(endpoint, { filePath: ctx.modelSettingsPath });
}

function modelEndpointResponded(error: unknown): boolean {
  return error instanceof ModelDiscoveryError && error.status !== undefined && error.status !== 407;
}

function isProxyConnectionFailure(error: unknown): boolean {
  return error instanceof ModelDiscoveryError && (error.status === undefined || error.status === 407);
}

async function optimize(ctx: WorkbenchContext, args: string[]): Promise<CommandOutcome> {
  const effective = args.some((arg) => arg === '--config' || arg.startsWith('--config=')) ? args : ['--config', ctx.configPath, ...args];
  const input = parseOptimizeCliInput(effective);
  const loaded = loadOptimizationConfig(input.configPath);
  if (!loaded.config.validation.library_package && !isBuildConfigured(loaded.config.build)) return { ok: false, message: '请先使用 /build 配置构建命令。' };
  const credential = resolveOptimizationApiKey(loaded.config, { cliApiKey: input.apiKey });
  const api = await ctx.getApi();
  const result = await api.submitOptimizationWorkflow({ function_name: input.functionName, entry_file: input.entryFile, config_path: input.configPath, repository_root: input.repositoryRoot, enable_performance: input.enablePerformance }, credential.apiKey ? { apiKey: credential.apiKey } : {}) as { workflow_id?: string };
  if (!result.workflow_id) return { ok: false, message: '后台没有返回 workflow_id。' };
  return { ok: true, message: `已提交优化工作流：${result.workflow_id}\n使用 /workflow status ${result.workflow_id} 查看进度。`, data: result };
}

async function workflow(ctx: WorkbenchContext, args: string[]): Promise<CommandOutcome> {
  const [action, workflowId, ...rest] = args;
  if (!workflowId) return { ok: false, message: '用法：/workflow status|cancel|approve <workflow-id>' };
  const api = await ctx.getApi();
  if (action === 'status' && rest.length === 0) {
    const result = await api.getOptimizationWorkflow(workflowId) as { workflow?: Record<string, unknown> };
    const record = result.workflow ?? {};
    return { ok: true, message: [`工作流 ${workflowId}`, `状态：${String(record.status ?? 'UNKNOWN')}`, `阶段：${String((record.progress as { phase?: unknown } | undefined)?.phase ?? '-')}`, ...(record.error ? [`错误：${String(record.error)}`] : [])].join('\n'), data: result };
  }
  if (action === 'cancel' && rest.length === 0) {
    const result = await api.cancelOptimizationWorkflow(workflowId) as { status?: string; message?: string };
    return { ok: true, message: `${result.status ?? 'CANCEL_REQUESTED'}${result.message ? `：${result.message}` : ''}`, data: result };
  }
  if (action === 'approve') {
    const messageIndex = rest.indexOf('--commit-message');
    const commitMessage = messageIndex >= 0 ? rest[messageIndex + 1] : rest.join(' ');
    if (!commitMessage) return { ok: false, message: '用法：/workflow approve <workflow-id> --commit-message <说明>' };
    const result = await api.requestWorkflowApprove(workflowId, { commit_message: commitMessage }) as { commit?: string };
    return { ok: true, message: `已审批并合入：${result.commit ?? workflowId}`, data: result };
  }
  return { ok: false, message: '用法：/workflow status|cancel|approve <workflow-id>' };
}

async function task(ctx: WorkbenchContext, args: string[]): Promise<CommandOutcome> {
  const [action, taskId = ctx.currentTaskId() ?? ''] = args;
  const api = await ctx.getApi();
  if (action === 'list') {
    const result = await api.listTasks() as { tasks?: Array<{ task_id: string; status: string; target?: { name?: string } }> };
    const tasks = result.tasks ?? [];
    return { ok: true, message: tasks.length ? tasks.map((item, index) => `${index + 1}. ${item.task_id} ${item.status} ${item.target?.name ?? ''}`).join('\n') : '暂无任务。', data: result };
  }
  if (!taskId) return { ok: false, message: '请提供 task-id。' };
  if (action === 'status') {
    const result = await api.getTask(taskId) as { task?: { status?: string } };
    ctx.setCurrentTask(taskId);
    return { ok: true, message: `任务 ${taskId}：${result.task?.status ?? 'UNKNOWN'}`, data: result };
  }
  if (action === 'cancel' || action === 'retry' || action === 'resume') {
    const result = await api[action](taskId, `workbench:${action}:${randomUUID()}`);
    return { ok: true, message: `任务 ${taskId} 已提交 ${action}。`, data: result };
  }
  return { ok: false, message: '用法：/task list | /task status|cancel|retry|resume <task-id>' };
}

async function configureModel(ctx: WorkbenchContext, io: CommandIO): Promise<CommandOutcome> {
  const loaded = ctx.hasConfig() ? loadOptimizationConfig(ctx.configPath) : null;

  modelSourceLoop: while (true) {
    const source = await io.select('选择模型来源', MODEL_SOURCES.map((item) => ({ label: item.label, value: item })));
    if (!source) return { ok: false, message: '已取消模型配置。' };
    const endpointInput = source.endpoint ?? await io.prompt('Endpoint（必填，基础地址，不要包含 /chat/completions）');
    if (endpointInput === null) continue;
    const endpoint = endpointInput.trim();
    if (!endpoint) return { ok: false, message: 'Endpoint 不能为空。' };

    let modelProxy: string | undefined;
    let reusableProxy: string | undefined;
    if (source.id === 'openai') {
      const storedProxy = readStoredModelProxy(endpoint, { filePath: ctx.modelSettingsPath });
      const configuredProxy = loaded ? resolveOptimizationProxy(loaded.config)?.proxy : process.env.PHYOPT_MODEL_PROXY?.trim();
      reusableProxy = storedProxy ?? (configuredProxy ? normalizeModelProxy(configuredProxy) : undefined);
    }

    let credential: ResolvedModelCredential | undefined;
    let models: Awaited<ReturnType<typeof discoverOpenAIModels>> | undefined;

    modelConnectionLoop: while (true) {
      if (source.id === 'openai') {
        const proxySelection = await chooseOpenAiProxy(reusableProxy, io);
        if (proxySelection.kind === 'canceled') continue modelSourceLoop;
        modelProxy = proxySelection.kind === 'proxy' ? proxySelection.proxy : undefined;
      }

      if (!credential) {
        const storedApiKey = readStoredApiKey(endpoint, { filePath: ctx.credentialsPath });
        if (storedApiKey) {
          credential = { apiKey: storedApiKey, source: 'credentials' as const };
          io.print('已使用保存的 API Key。');
        } else {
          const prompted = await promptModelApiKey(source, io);
          if (prompted.kind === 'canceled') {
            if (io.interactive) return { ok: false, message: '已取消模型配置。' };
            continue modelSourceLoop;
          }
          if (prompted.kind === 'error') return { ok: false, message: prompted.message };
          credential = prompted.credential;
        }
      }

      while (true) {
        let discoveryTransport: ModelTransport | undefined;
        try {
          discoveryTransport = ctx.modelTransportFactory(modelProxy);
          models = await discoverOpenAIModels(endpoint, credential.apiKey, { fetchImpl: discoveryTransport.fetch });
        } catch (error) {
          if (source.id === 'openai' && modelEndpointResponded(error)) {
            try {
              persistOpenAiProxy(ctx, endpoint, modelProxy);
              reusableProxy = modelProxy;
            } catch (saveError) {
              return { ok: false, message: `代理连接已验证，但保存失败：${(saveError as Error).message}` };
            }
          }
          if (credential.source === 'credentials' && isAuthenticationFailure(error)) {
            io.print('已保存的 API Key 已失效，请重新配置。');
            const prompted = await promptModelApiKey(source, io);
            if (prompted.kind === 'canceled') {
              if (io.interactive) return { ok: false, message: '已取消模型配置。' };
              continue modelSourceLoop;
            }
            if (prompted.kind === 'error') return { ok: false, message: prompted.message };
            credential = prompted.credential;
            continue;
          }
          if (source.id === 'openai' && isProxyConnectionFailure(error)) {
            io.print(`当前${modelProxy ? '代理' : '直连'}无法连接 OpenAI，请重新选择连接方式。`);
            continue modelConnectionLoop;
          }
          return { ok: false, message: `读取模型列表失败：${(error as Error).message}。请检查 endpoint、API Key、代理地址和服务是否支持 GET /models。` };
        } finally {
          await discoveryTransport?.close();
        }

        try {
          if (source.id === 'openai') {
            persistOpenAiProxy(ctx, endpoint, modelProxy);
            reusableProxy = modelProxy;
          }
          saveStoredApiKey(endpoint, credential.apiKey, { filePath: ctx.credentialsPath });
        } catch (error) {
          return { ok: false, message: `模型连接已通过验证，但用户设置保存失败：${(error as Error).message}` };
        }
        break modelConnectionLoop;
      }
    }

    if (!credential || !models) return { ok: false, message: '模型连接未完成。' };
    const selected = await io.select('选择模型', models.map((item) => ({ label: item.label === item.id ? item.id : `${item.label} (${item.id})`, value: item })));
    if (!selected) continue;

    const selectedReasoningEffort = source.id === 'openai'
      ? await io.select<ReasoningEffort | 'default'>('选择思考强度', [
          { label: '默认（不指定）', value: 'default' },
          ...REASONING_EFFORTS.map((effort) => ({ label: `${({ minimal: '最小', low: '低', medium: '中', high: '高' } as const)[effort]}（${effort}）`, value: effort })),
        ])
      : undefined;
    if (source.id === 'openai' && selectedReasoningEffort === null) continue;
    const reasoningEffort = selectedReasoningEffort && selectedReasoningEffort !== 'default' ? selectedReasoningEffort : undefined;

    const verificationTransport = ctx.modelTransportFactory(modelProxy);
    try {
      const verification = await verifyToolCalling(
        { endpoint, modelId: selected.id, apiKey: credential.apiKey, reasoningEffort },
        { timeoutMs: loaded?.config.model.timeout_ms ?? 1_200_000, fetch: verificationTransport.fetch },
      );
      if (!verification.ok) return { ok: false, message: `模型未通过 tool call 能力验证：${verification.error ?? '未知错误'}` };
    } finally {
      await verificationTransport.close();
    }

    const nextConfig: OptimizationConfig = loaded?.config
      ? {
          ...loaded.config,
          model: {
            model_id: selected.id,
            endpoint: endpoint.replace(/\/+$/, ''),
            ...(modelProxy ? { proxy: modelProxy.replace(/\/+$/, '') } : {}),
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
            ...(loaded.config.model.max_output_tokens === undefined ? {} : { max_output_tokens: loaded.config.model.max_output_tokens }),
            timeout_ms: loaded.config.model.timeout_ms,
            ...(loaded.config.model.inactivity_timeout_ms === undefined ? {} : { inactivity_timeout_ms: loaded.config.model.inactivity_timeout_ms }),
          },
        }
      : {
          model: {
            model_id: selected.id,
            endpoint: endpoint.replace(/\/+$/, ''),
            ...(modelProxy ? { proxy: modelProxy.replace(/\/+$/, '') } : {}),
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
            max_output_tokens: 16_384,
            timeout_ms: 1_200_000,
            inactivity_timeout_ms: 120_000,
          },
          target: { ssh_alias: 'localhost', workspace_root: '/tmp/phyopt' },
          build: { executable: '', args: [], cwd: DEFAULT_BUILD_CWD, environment: {}, timeout_ms: DEFAULT_BUILD_TIMEOUT_MS },
          validation: { testpack: './testpacks/domain.yaml' },
          output_dir: './.phyopt/runs',
        };
    delete nextConfig.model.api_key;
    fs.writeFileSync(ctx.configPath, stringifyOptimizationConfig(nextConfig), 'utf8');
    return { ok: true, message: `模型配置已验证并写入 ${ctx.configPath}\n模型：${selected.id}\nEndpoint：${endpoint}\n工具调用：通过`, data: { source: source.id as ModelSourceId, model_id: selected.id, endpoint } };
  }
}

function saveBuildConfig(ctx: WorkbenchContext, build: OptimizationConfig['build']): void {
  const loaded = loadOptimizationConfig(ctx.configPath);
  const nextConfig: OptimizationConfig = { ...loaded.config, build: { ...build, environment: { ...build.environment } } };
  fs.writeFileSync(ctx.configPath, stringifyOptimizationConfig(nextConfig), 'utf8');
}

function buildSummary(build: OptimizationConfig['build']): string {
  const environment = Object.keys(build.environment).length > 0
    ? Object.entries(build.environment).map(([name, value]) => `${name}=${value}`).join(', ')
    : '未设置';
  return [
    '当前构建配置',
    `  编译命令：${isBuildConfigured(build) ? buildCommandDisplay(build) : '未配置'}`,
    `  执行目录：${build.cwd === '.' ? '源码根目录（.）' : build.cwd}`,
    `  超时时间：${buildTimeoutMinutes(build.timeout_ms)} 分钟`,
    `  环境变量：${environment}`,
  ].join('\n');
}

async function editBuildCommand(ctx: WorkbenchContext, io: CommandIO, build: OptimizationConfig['build']): Promise<CommandOutcome> {
  const entered = await io.prompt('编译命令：', { initialValue: isBuildConfigured(build) ? buildCommandDisplay(build) : '' });
  if (entered === null) return { ok: false, message: '已返回构建配置。' };
  try {
    const parsed = parseBuildCommand(entered);
    saveBuildConfig(ctx, { ...build, ...parsed });
    return { ok: true, message: '编译命令已更新。' };
  } catch (error) {
    return { ok: false, message: `编译命令未保存：${(error as Error).message}` };
  }
}

async function editBuildCwd(ctx: WorkbenchContext, io: CommandIO, build: OptimizationConfig['build']): Promise<CommandOutcome> {
  const entered = await io.prompt('执行目录（相对于源码根目录，回车使用 .）：', { initialValue: build.cwd });
  if (entered === null) return { ok: false, message: '已返回构建配置。' };
  try {
    const cwd = validateBuildCwd(entered);
    saveBuildConfig(ctx, { ...build, cwd });
    return { ok: true, message: '执行目录已更新。' };
  } catch (error) {
    return { ok: false, message: `执行目录未保存：${(error as Error).message}` };
  }
}

async function editBuildTimeout(ctx: WorkbenchContext, io: CommandIO, build: OptimizationConfig['build']): Promise<CommandOutcome> {
  const entered = await io.prompt('构建超时时间（分钟）：', { initialValue: String(buildTimeoutMinutes(build.timeout_ms)) });
  if (entered === null) return { ok: false, message: '已返回高级设置。' };
  const minutes = Number(entered.trim());
  if (!Number.isInteger(minutes) || minutes < 1) return { ok: false, message: '超时时间必须是大于等于 1 的整数分钟，未保存。' };
  saveBuildConfig(ctx, { ...build, timeout_ms: minutes * 60_000 });
  return { ok: true, message: '构建超时时间已更新。' };
}

async function editBuildEnvironment(ctx: WorkbenchContext, io: CommandIO, build: OptimizationConfig['build']): Promise<CommandOutcome> {
  while (true) {
    const names = Object.keys(build.environment).sort();
    const choices: Array<{ label: string; value: 'add' | 'delete' | { edit: string } }> = [
      { label: '添加环境变量', value: 'add' },
      ...names.map((name) => ({ label: `修改 ${name}=${build.environment[name]}`, value: { edit: name } })),
      ...(names.length > 0 ? [{ label: '删除环境变量', value: 'delete' as const }] : []),
    ];
    const selected = await io.select(`环境变量：${names.length > 0 ? names.join(', ') : '未设置'}`, choices);
    if (!selected) return { ok: false, message: '已返回高级设置。' };

    if (selected === 'delete') {
      const deleted = await io.select('选择要删除的环境变量', names.map((name) => ({ label: name, value: name })));
      if (!deleted) continue;
      const nextEnvironment = { ...build.environment };
      delete nextEnvironment[deleted];
      build = { ...build, environment: nextEnvironment };
      saveBuildConfig(ctx, build);
      io.print(`环境变量 ${deleted} 已删除。`);
      continue;
    }

    const editing = typeof selected === 'object' ? selected.edit : undefined;
    const nameInput = editing ?? await io.prompt('环境变量名称：');
    if (nameInput === null) continue;
    let name: string;
    try {
      name = validateEnvironmentName(nameInput);
    } catch (error) {
      io.error((error as Error).message);
      continue;
    }
    const value = await io.prompt(`环境变量 ${name} 的值：`, { initialValue: build.environment[name] ?? '' });
    if (value === null) continue;
    build = { ...build, environment: { ...build.environment, [name]: value } };
    saveBuildConfig(ctx, build);
    io.print(`环境变量 ${name} 已更新。`);
  }
}

async function configureBuild(ctx: WorkbenchContext, io: CommandIO): Promise<CommandOutcome> {
  if (!ctx.hasConfig()) return { ok: false, message: '请先使用 /model 创建优化配置，然后再配置构建命令。' };
  let loaded = loadOptimizationConfig(ctx.configPath);
  if (loaded.config.validation.library_package) return { ok: false, message: '构建定义由 Library Package 提供，不能使用 /build 覆盖。' };
  let build = loaded.config.build;

  if (!isBuildConfigured(build)) {
    const command = await io.prompt('请输入构建命令：');
    if (command === null) return { ok: false, message: '已取消构建配置。' };
    let parsed: ReturnType<typeof parseBuildCommand>;
    try {
      parsed = parseBuildCommand(command);
    } catch (error) {
      return { ok: false, message: `构建命令未保存：${(error as Error).message}` };
    }
    const cwdInput = await io.prompt('执行目录（相对于源码根目录，回车使用 .）：', { initialValue: DEFAULT_BUILD_CWD });
    if (cwdInput === null) return { ok: false, message: '已取消构建配置。' };
    try {
      const cwd = validateBuildCwd(cwdInput);
      build = { ...build, ...parsed, cwd };
      saveBuildConfig(ctx, build);
      return { ok: true, message: '构建配置已保存。' };
    } catch (error) {
      return { ok: false, message: `构建配置未保存：${(error as Error).message}` };
    }
  }

  while (true) {
    loaded = loadOptimizationConfig(ctx.configPath);
    build = loaded.config.build;
    io.print(buildSummary(build));
    const selected = await io.select('构建配置', [
      { label: '修改编译命令', value: 'command' as const },
      { label: '修改执行目录', value: 'cwd' as const },
      { label: '高级设置', value: 'advanced' as const },
    ]);
    if (!selected) return { ok: false, message: '已返回。' };
    if (selected === 'command') {
      const outcome = await editBuildCommand(ctx, io, build);
      if (outcome.ok) io.print(outcome.message);
      else if (outcome.message !== '已返回构建配置。') io.error(outcome.message);
      continue;
    }
    if (selected === 'cwd') {
      const outcome = await editBuildCwd(ctx, io, build);
      if (outcome.ok) io.print(outcome.message);
      else if (outcome.message !== '已返回构建配置。') io.error(outcome.message);
      continue;
    }
    while (true) {
      const advanced = await io.select('高级设置', [
        { label: '环境变量', value: 'environment' as const },
        { label: '超时时间', value: 'timeout' as const },
      ]);
      if (!advanced) break;
      const current = loadOptimizationConfig(ctx.configPath).config.build;
      if (advanced === 'environment') await editBuildEnvironment(ctx, io, current);
      else {
        const outcome = await editBuildTimeout(ctx, io, current);
        if (outcome.ok) io.print(outcome.message);
        else if (outcome.message !== '已返回高级设置。') io.error(outcome.message);
      }
    }
  }
}

function targetWorkspace(value: string | null, current = DEFAULT_WORKSPACE_ROOT): string | null {
  if (value === null) return null;
  const entered = value.trim();
  const workspace = entered || current || DEFAULT_WORKSPACE_ROOT;
  if (!path.isAbsolute(workspace) && !/^\/[A-Za-z0-9._-]/.test(workspace) && !/^[A-Za-z]:[\\/]/.test(workspace)) return null;
  if (workspace === '/' || /^[A-Za-z]:[\\/]?$/.test(workspace)) return null;
  return workspace.replace(/[\\/]$/, '') || workspace;
}

function discoverIdentityFiles(): string[] {
  const sshDirectory = path.join(os.homedir(), '.ssh');
  try {
    return fs.readdirSync(sshDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^id_[^/\\]+$/.test(entry.name) && !entry.name.endsWith('.pub'))
      .map((entry) => path.join(sshDirectory, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function chooseIdentityFile(io: CommandIO): Promise<string | undefined> {
  const choices: Array<{ label: string; value: string }> = discoverIdentityFiles().map((filePath) => ({ label: filePath, value: filePath }));
  choices.push({ label: '手动输入私钥路径', value: '__manual__' });
  const selected = await io.select('请选择私钥文件', choices);
  if (!selected) return undefined;
  if (selected !== '__manual__') return selected;
  const entered = (await io.prompt('私钥文件路径：'))?.trim();
  return entered || undefined;
}

async function writeTargetConfig(ctx: WorkbenchContext, target: TargetConfig): Promise<void> {
  const loaded = loadOptimizationConfig(ctx.configPath);
  const nextConfig: OptimizationConfig = { ...loaded.config, target: { ...target } };
  fs.writeFileSync(ctx.configPath, stringifyOptimizationConfig(nextConfig), 'utf8');
  saveTargetProfile(target, { filePath: ctx.targetProfilesPath });
}

async function configureTarget(ctx: WorkbenchContext, io: CommandIO): Promise<CommandOutcome> {
  if (!ctx.hasConfig()) return { ok: false, message: '请先使用 /model 创建优化配置，然后再配置目标机器。' };
  const loaded = loadOptimizationConfig(ctx.configPath);
  const current = loaded.config.target;

  while (true) {
    const profiles = listTargetProfiles({ filePath: ctx.targetProfilesPath });
    const currentId = targetConnectionId(current);
    const profileTargets = new Map(profiles.map((profile) => [profile.id, profile]));
    if (!profileTargets.has(currentId)) {
      profileTargets.set(currentId, { id: currentId, name: targetLabel(current), target: current, updated_at: '' });
    }
    const choices: Array<{ label: string; value: { kind: 'profile'; target: TargetConfig } | { kind: 'new' } }> = [...profileTargets.values()].map((profile) => ({
      label: `${profile.name}  ${targetDescription(profile.target)}  ${targetAuthDescription(profile.target)}${profile.id === currentId ? '  当前使用' : ''}`,
      value: { kind: 'profile', target: profile.target },
    }));
    choices.push({ label: '＋ 配置新的目标机器', value: { kind: 'new' } });
    const selected = await io.select('请选择目标机器', choices);
    if (!selected) return { ok: false, message: '已返回。' };

    let target: TargetConfig | null = null;
    if (selected.kind === 'profile') {
      const workspaceInput = await io.prompt(`远端工作目录（回车使用 ${selected.target.workspace_root || DEFAULT_WORKSPACE_ROOT}）：`);
      const workspace = targetWorkspace(workspaceInput, selected.target.workspace_root || DEFAULT_WORKSPACE_ROOT);
      if (workspaceInput === null) continue;
      if (!workspace) return { ok: false, message: '远端工作目录必须是绝对路径，且不能是文件系统根目录。' };
      target = { ...selected.target, workspace_root: workspace };
    } else {
      connectionMethodLoop: while (true) {
        const method = await io.select('请选择连接方式', [
          { label: '直接填写服务器信息（推荐）', value: 'direct' as const },
          { label: '使用已有 SSH Alias（高级用户）', value: 'alias' as const },
        ]);
        if (!method) break;
        if (method === 'direct') {
          const host = (await io.prompt('服务器地址（IP 或域名）：'))?.trim();
          if (!host) continue;
          const username = (await io.prompt('SSH 用户名：'))?.trim();
          if (!username) continue;
          const portInput = (await io.prompt('SSH 端口（回车使用 22）：'))?.trim() ?? '';
          const port = portInput ? Number(portInput) : 22;
          if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: 'SSH 端口必须是 1..65535 的整数。' };
          let identityFile: string | undefined;
          while (true) {
            const auth = await io.select('请选择 SSH 认证方式', [
              { label: '使用 SSH Agent / OpenSSH 默认密钥', value: 'agent' as const },
              { label: '指定已有私钥文件', value: 'identity' as const },
            ]);
            if (!auth) continue connectionMethodLoop;
            if (auth === 'agent') break;
            identityFile = await chooseIdentityFile(io);
            if (identityFile) break;
          }
          target = { host, username, port, ...(identityFile ? { identity_file: identityFile } : {}), workspace_root: DEFAULT_WORKSPACE_ROOT };
        } else {
          const alias = (await io.prompt('SSH Alias：'))?.trim();
          if (!alias) continue;
          target = { ssh_alias: alias, workspace_root: DEFAULT_WORKSPACE_ROOT };
        }
        const workspaceInput = await io.prompt(`远端工作目录（回车使用默认值 ${DEFAULT_WORKSPACE_ROOT}）：`);
        const workspace = targetWorkspace(workspaceInput, DEFAULT_WORKSPACE_ROOT);
        if (workspaceInput === null) continue;
        if (!workspace) return { ok: false, message: '远端工作目录必须是绝对路径，且不能是文件系统根目录。' };
        target = { ...target, workspace_root: workspace };
        break;
      }
      if (!target) continue;
    }

    const check = ctx.targetChecker(target);
    if (!check.ok) return { ok: false, message: `目标机器连接验证失败：${check.message}` };
    await writeTargetConfig(ctx, target);
    const mode = isAliasTarget(target) ? `SSH Alias ${target.ssh_alias}` : `${target.username}@${target.host}:${target.port}`;
    return { ok: true, message: `目标机器配置已保存：${mode}\n认证：${targetAuthDescription(target)}\n远端目录：${target.workspace_root}\n架构：${check.architecture ?? '-'}\n连接用户：${check.username ?? '-'}` };
  }
}

export async function runCommandArgs(ctx: WorkbenchContext, name: string, args: string[], io: CommandIO): Promise<CommandOutcome> {
  try {
    if (name === '/optimize') return await optimize(ctx, args);
    if (name === '/workflow') return await workflow(ctx, args);
    if (name === '/task') return await task(ctx, args);
    if (name === '/model') return await configureModel(ctx, io);
    if (name === '/build') return await configureBuild(ctx, io);
    if (name === '/target') return configureTarget(ctx, io);
    if (name === '/config') {
      try {
        const content = fs.readFileSync(ctx.configPath, 'utf8');
        return { ok: true, message: content || '配置文件为空。' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ok: false, message: `配置文件不存在：${ctx.configPath}` };
        }
        throw error;
      }
    }
    if (name === '/exit') return { ok: true, message: '再见。', exit: true };
    return { ok: false, message: `未知命令 '${name}'。输入 / 查看命令列表。` };
  } catch (error) {
    return { ok: false, message: `${name} 执行失败：${(error as Error).message}` };
  }
}

export async function runCommand(ctx: WorkbenchContext, line: string, io: CommandIO): Promise<CommandOutcome> {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return { ok: false, message: '请输入以 / 开头的命令。' };
  const [name, ...args] = trimmed.split(/\s+/);
  return runCommandArgs(ctx, name, args, io);
}
