import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApiClient } from '../../../src/client/api-client.js';
import { IdeTaskClient } from '../../../src/client/ide-task-client.js';
import { assertReportPathWithinProject } from '../../../src/client/report-scope.js';
import { submitExperimentTask, experimentModeLabel, canSubmitExperiment } from '../../../src/client/experiment-submission.js';
import { fetchExperimentResultView, writeExportFile } from '../../../src/client/experiment-result.js';
import { buildModelProvider, generateCandidate, listCandidates, loadCandidate, candidateContentFor } from '../../../src/client/candidate-generation.js';
import { ConfigService } from '../../../src/config/config-service.js';
import { CredentialService } from '../../../src/config/credential-store.js';
import { VscodeSecretStore } from '../../../src/config/vscode-secret-store.js';
import { BackendManager } from '../../../src/backend/backend-manager.js';
import type { ServeSpec } from '../../../src/backend/backend-manager.js';
import { ensureBaselineIdentity } from '../../../src/core/git-baseline-flow.js';
import type { PhyOptConfig } from '../../../src/config/phyopt-config.js';

// ---- module-level state (lazy) ----
let configService: ConfigService | null = null;
let credentials: CredentialService | null = null;
let api: ApiClient | null = null;
let backendManager: BackendManager | null = null;

const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

function getConfigService(): ConfigService {
  if (!configService) configService = new ConfigService();
  return configService;
}

function getCredentials(context: vscode.ExtensionContext): CredentialService {
  if (!credentials) credentials = new CredentialService(new VscodeSecretStore(context.secrets));
  return credentials;
}

/** Resolve the model credential (if any) to inject into a spawned backend. */
async function resolveBackendExtraEnv(context: vscode.ExtensionContext, config: PhyOptConfig): Promise<Record<string, string>> {
  const extra: Record<string, string> = {};
  const ref = config.model?.credential_ref ?? null;
  if (ref) {
    const value = await getCredentials(context).resolve(ref);
    if (value) extra[ref] = value;
  }
  return extra;
}

/**
 * How the managed backend is started. The bundled extension cannot use
 * `import.meta.url` (empty in CJS), so the serve command must come from an
 * explicit source: the `phyopt.serveCommand` setting, or PHYOPT_SERVE_CMD.
 * The resolved credential is injected via env (extraEnv), never argv.
 */
function resolveServeCommand(): string {
  const configured = vscode.workspace.getConfiguration('phyopt').get<string>('serveCommand', '');
  if (configured.trim().length > 0) return configured.trim();
  return process.env.PHYOPT_SERVE_CMD ?? 'corepilot';
}

/** Ensure a backend is reachable (reuse, else start a managed one with the
 * resolved credential injected via environment — never argv/config/logs). */
async function getApi(context: vscode.ExtensionContext): Promise<ApiClient> {
  if (api) return api;
  // Explicit test/dev override: connect as a pure thin client (no spawn; the
  // external backend already owns its environment).
  const overrideUrl = process.env.PHYOPT_SERVER_URL;
  if (overrideUrl) {
    api = new ApiClient(overrideUrl);
    return api;
  }
  const cfg = getConfigService().load();
  const url = `http://${cfg.backend.host}:${cfg.backend.port}`;
  const spec: ServeSpec = {
    host: cfg.backend.host,
    port: cfg.backend.port,
    dbPath: getConfigService().resolvedDbPath(cfg),
    runner: cfg.backend.runner,
    transport: cfg.backend.transport,
    sshAlias: cfg.backend.ssh_alias,
    extraEnv: await resolveBackendExtraEnv(context, cfg),
  };
  process.env.PHYOPT_SERVE_CMD = resolveServeCommand();
  backendManager = new BackendManager({ url, spec, allowSpawn: true });
  const result = await backendManager.ensure();
  api = new ApiClient(result.url);
  return api;
}

function getClientForList(): IdeTaskClient {
  const cfg = getConfigService().load();
  const url = process.env.PHYOPT_SERVER_URL ?? `http://${cfg.backend.host}:${cfg.backend.port}`;
  return new IdeTaskClient(new ApiClient(url));
}

interface TaskSummary {
  task_id: string;
  request_id: string;
  status: string;
  target_name: string;
  is_mock: boolean;
  error: string | null;
  report_path: string | null;
}

class TaskItem extends vscode.TreeItem {
  constructor(public readonly summary: TaskSummary) {
    const mockTag = summary.is_mock ? ' [mock]' : ' [experiment]';
    super(summary.task_id + ' - ' + summary.target_name + mockTag, vscode.TreeItemCollapsibleState.None);
    const errText = summary.error ? ': ' + summary.error : '';
    this.description = summary.status + errText;
    this.contextValue = 'phyopt.task';
    this.tooltip = 'request_id: ' + summary.request_id + '\nstatus: ' + summary.status + (summary.error ? '\nerror: ' + summary.error : '');
    this.command = { command: 'phyopt.openReport', title: 'Open Report', arguments: [this] };
  }
}

class TaskTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const mode = experimentModeLabel(getConfigService().load());
    const modeHeader = new vscode.TreeItem(
      mode === 'Experiment' ? '模式：Experiment（真实实验）' : '模式：Mock（模拟，真实实验提交已禁用）',
      vscode.TreeItemCollapsibleState.None,
    );
    modeHeader.contextValue = 'phyopt.mode';
    modeHeader.iconPath = new vscode.ThemeIcon(mode === 'Experiment' ? 'beaker' : 'debug-console');

    // Welcome actions: start optimize / configure / recent tasks.
    const actions = new vscode.TreeItem('开始优化（右键文件，或点这里新建任务）', vscode.TreeItemCollapsibleState.None);
    actions.command = { command: 'phyopt.newExperiment', title: '新建任务' };
    actions.iconPath = new vscode.ThemeIcon('play');
    const config = new vscode.TreeItem('配置模型 / 硬件 / 测试', vscode.TreeItemCollapsibleState.None);
    config.command = { command: 'phyopt.newExperiment', title: '配置' };
    config.iconPath = new vscode.ThemeIcon('settings-gear');

    try {
      const tasks = await getClientForList().listTasks();
      return [modeHeader, actions, config, ...tasks.map((t) => new TaskItem(t))];
    } catch (err) {
      return [modeHeader, actions, config, new TaskItem({ task_id: 'error', request_id: '', status: 'ERROR', target_name: '', is_mock: false, error: (err as Error).message, report_path: null })];
    }
  }
}

// ---- experiment wizard ----

interface WizardPrefill {
  sourceFiles: string[];
  functionName?: string;
}

/**
 * Guided Git baseline preflight over VS Code modals — the SAME decision tree
 * the CLI workbench runs (src/core/git-baseline-flow.ts). Existing repos get
 * their identity read automatically; missing repos offer "初始化为 Git 仓库"
 * vs "取消"; after success the commit + archive SHA are written into the
 * shared config so users never hand-type 40-digit hashes.
 */
async function runBaselinePreflightIde(rootDir: string): Promise<{ ok: boolean; message: string }> {
  const output: string[] = [];
  const result = await ensureBaselineIdentity({
    projectRoot: rootDir,
    io: {
      print: (text: string) => {
        output.push(text);
      },
      confirm: async (question: string) =>
        (await vscode.window.showInformationMessage(question, { modal: true, detail: 'CorePilot 基线（不 push、不改全局 Git 配置）' }, '确认')) === '确认',
      prompt: async (question: string) => (await vscode.window.showInputBox({ prompt: question, ignoreFocusOut: true })) ?? '',
    },
    currentSource: getConfigService().load().source ?? null,
    writeSourceIdentity: (source) => {
      getConfigService().patch({ source });
    },
  });
  for (const note of result.notes) output.push(note);
  if (result.ok) {
    return { ok: true, message: output.join('\n') };
  }
  const lines = ['Git 基线未就绪：', ...result.reasons.map((r) => '  - ' + r)];
  if (result.commands.length > 0) lines.push('可自行执行：', ...result.commands);
  return { ok: false, message: [...output, ...lines].join('\n') };
}

async function input(prompt: string, current?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({ prompt, value: current, ignoreFocusOut: true });
}

async function configureSource(): Promise<void> {
  const rootDir = root();
  const cfg = getConfigService().load();
  if (cfg.source?.commit) {
    const again = await vscode.window.showInformationMessage(
      `当前源码身份：${cfg.source.commit.slice(0, 12)}…（归档 ${cfg.source.archive_sha256.slice(0, 12)}…）。从当前仓库重新读取？`,
      '重新读取',
      '保持',
    );
    if (again !== '重新读取') return;
  }
  if (!rootDir) {
    void vscode.window.showErrorMessage('CorePilot: 未打开工作区文件夹。');
    return;
  }
  const outcome = await runBaselinePreflightIde(rootDir);
  if (outcome.ok) {
    void vscode.window.showInformationMessage('CorePilot: 源码身份已从仓库读取并写入配置（不再需要手工输入哈希）。');
  } else {
    void vscode.window.showErrorMessage('CorePilot: ' + outcome.message);
  }
}

async function configureTarget(): Promise<void> {
  const cfg = getConfigService().load();
  const name = await input('目标硬件名（如 phy-arm）', cfg.target?.name ?? '');
  if (name === undefined) return;
  const arch = await input('架构（如 aarch64，可跳过）', cfg.target?.architecture ?? '');
  const sshAlias = await input('SSH 别名（~/.ssh/config，可跳过）', cfg.target?.ssh_alias ?? '');
  const grantRef = await input('授权文件路径 grant_ref（可跳过，缺省则任务等待授权）', cfg.target?.grant_ref ?? '');
  getConfigService().patch({
    target: {
      name: name || (cfg.target?.name ?? ''),
      architecture: arch || null,
      ssh_alias: sshAlias || null,
      grant_ref: grantRef || null,
    },
  });
}

async function configureModel(context: vscode.ExtensionContext): Promise<void> {
  const cfg = getConfigService().load();
  const provider = await input('模型 provider（如 openai-compatible，可跳过）', cfg.model?.provider ?? '');
  if (provider === undefined) return;
  const providerId = provider || (cfg.model?.provider ?? 'openai-compatible');
  const piProvider = providerId === 'pi'
    ? await input('Pi 底层 provider ID（例如 anthropic、openai、zai；可跳过则使用 PHYOPT_PI_PROVIDER）', cfg.model?.pi_provider ?? process.env.PHYOPT_PI_PROVIDER ?? '')
    : undefined;
  if (providerId === 'pi' && piProvider === undefined) return;
  const name = await input('模型名（可跳过）', cfg.model?.name ?? '');
  const ref = await input('凭据引用名（env 变量名 / SecretStorage 键，可跳过）', cfg.model?.credential_ref ?? '');
  const model = {
    provider: providerId,
    name: name || null,
    ...(providerId === 'pi' ? { pi_provider: piProvider || null } : {}),
    credential_ref: ref || null,
    endpoint_ref: cfg.model?.endpoint_ref ?? null,
    endpoint: cfg.model?.endpoint ?? null,
  };
  getConfigService().patch({ model });
  if (ref) {
    const key = await vscode.window.showInputBox({ prompt: `API Key（存到 SecretStorage 键 ${ref}，留空跳过）`, password: true, ignoreFocusOut: true });
    if (key !== undefined && key !== '') {
      await getCredentials(context).save(ref, key);
      vscode.window.showInformationMessage(`CorePilot: 凭据已保存到 SecretStorage（${getCredentials(context).storeName}）`);
    }
  }
}

async function configureTestAsset(kind: 'correctness' | 'performance'): Promise<void> {
  const cfg = getConfigService().load();
  const existing = cfg.test_assets.find((a) => a.kind === kind);
  const executable = await input(`${kind === 'correctness' ? '正确性测试' : '性能基准'} 可执行文件（可跳过）`, existing?.executable ?? '');
  if (executable === undefined) return;
  const argsStr = await input('参数（空格分隔，可跳过）', existing?.args.join(' ') ?? '');
  const args = (argsStr ?? '').trim().length > 0 ? (argsStr as string).trim().split(/\s+/) : [];
  const next = cfg.test_assets.filter((a) => a.kind !== kind);
  next.push({
    kind,
    label: kind,
    executable: executable || existing?.executable || '',
    args,
    cwd: existing?.cwd ?? null,
    environment: existing?.environment ?? {},
    timeout_ms: existing?.timeout_ms ?? 600_000,
  });
  getConfigService().patch({ test_assets: next });
}

async function configureBaseline(): Promise<void> {
  const cfg = getConfigService().load();
  const lib = await input('比较基线库名（如 OpenBLAS，可跳过）', cfg.baseline?.comparison_library ?? '');
  if (lib === undefined) return;
  const hash = await input('基线 SHA-256（冻结身份，可跳过）', cfg.baseline?.comparison_build_hash ?? '');
  const path = await input('基线库绝对路径（冻结身份，可跳过）', cfg.baseline?.comparison_path ?? '');
  getConfigService().patch({
    baseline: {
      comparison_library: lib || (cfg.baseline?.comparison_library ?? ''),
      comparison_version: cfg.baseline?.comparison_version ?? null,
      comparison_build_hash: hash || null,
      comparison_path: path || null,
    },
  });
}

async function configureGates(): Promise<void> {
  const cfg = getConfigService().load();
  const version = await input('正确性测试套件版本（可跳过）', cfg.gates?.correctness.test_suite_version ?? '');
  if (version === undefined) return;
  const digest = await input('测试套件摘要（可跳过）', cfg.gates?.correctness.test_suite_digest ?? '');
  const totalStr = await input('总用例数（可跳过）', cfg.gates ? String(cfg.gates.correctness.total_cases) : '');
  const passStr = await input('需通过用例数（可跳过）', cfg.gates ? String(cfg.gates.correctness.pass_required) : '');
  const wgmStr = await input('性能加权几何均值下限（可跳过）', cfg.gates ? String(cfg.gates.performance.weighted_geomean_min) : '');
  const correctness = cfg.gates?.correctness ?? { test_suite_version: '', test_suite_digest: '', total_cases: 0, pass_required: 0 };
  const performance = cfg.gates?.performance ?? { weighted_geomean_min: 1.0, overall_ci_lower_min: 1.0, key_case_ci_lower_min: 1.0 };
  getConfigService().patch({
    gates: {
      correctness: {
        test_suite_version: version || correctness.test_suite_version,
        test_suite_digest: digest || correctness.test_suite_digest,
        total_cases: totalStr !== undefined && totalStr !== '' ? Number(totalStr) : correctness.total_cases,
        pass_required: passStr !== undefined && passStr !== '' ? Number(passStr) : correctness.pass_required,
      },
      performance: {
        weighted_geomean_min: wgmStr !== undefined && wgmStr !== '' ? Number(wgmStr) : performance.weighted_geomean_min,
        overall_ci_lower_min: performance.overall_ci_lower_min,
        key_case_ci_lower_min: performance.key_case_ci_lower_min,
      },
    },
  });
}

async function runExperimentWizard(context: vscode.ExtensionContext, prefill: WizardPrefill): Promise<void> {
  const rootDir = root();
  if (!rootDir) {
    void vscode.window.showErrorMessage('CorePilot: no workspace folder open');
    return;
  }
  // Ensure the shared config points at this workspace so worktree_path is correct.
  getConfigService().patch({ project_root: rootDir });

  const cfg = getConfigService().load();
  if (!canSubmitExperiment(cfg)) {
    const choice = await vscode.window.showWarningMessage(
      `CorePilot: 当前为 Mock 模式，真实实验提交不可用（不会静默转成 Mock）。可将 backend.runner 切换为 experiment 后重试。`,
      '切换到 Experiment',
      '取消',
    );
    if (choice === '切换到 Experiment') {
      getConfigService().patch({ backend: { runner: 'experiment' } });
      void vscode.window.showInformationMessage('CorePilot: 已切换为 Experiment 模式，请重新打开新建任务。');
    }
    return;
  }

  type Section = 'source' | 'target' | 'model' | 'correctness' | 'performance' | 'baseline' | 'gates' | 'submit';
  const sectionItems: { label: string; detail: string; section: Section }[] = [
    { label: '$(git-commit) 源码身份', detail: 'commit + archive_sha256', section: 'source' },
    { label: '$(server) 目标硬件', detail: 'name / arch / ssh_alias / grant_ref', section: 'target' },
    { label: '$(key) 模型与凭据', detail: 'provider / name / credential_ref（存 SecretStorage）', section: 'model' },
    { label: '$(beaker) 正确性测试', detail: 'executable + args', section: 'correctness' },
    { label: '$(dashboard) 性能基准', detail: 'executable + args', section: 'performance' },
    { label: '$(database) 比较基线', detail: 'library / build_hash / path', section: 'baseline' },
    { label: '$(checklist) 门禁阈值', detail: 'correctness 用例数 + performance 下限', section: 'gates' },
    { label: '$(play) 提交任务', detail: '校验配置 → 创建 ExperimentContext → 提交 → 打开任务详情', section: 'submit' },
  ];

  for (;;) {
    const picked = await vscode.window.showQuickPick(sectionItems, {
      title: `CorePilot 新建任务（模式：${experimentModeLabel(getConfigService().load())}）${prefill.sourceFiles.length ? ' · 来源已预填: ' + prefill.sourceFiles.join(', ') : ''}`,
      placeHolder: '选择要配置的项，或提交任务',
      ignoreFocusOut: true,
    });
    if (!picked) return;
    switch (picked.section) {
      case 'source':
        await configureSource();
        break;
      case 'target':
        await configureTarget();
        break;
      case 'model':
        await configureModel(context);
        break;
      case 'correctness':
        await configureTestAsset('correctness');
        break;
      case 'performance':
        await configureTestAsset('performance');
        break;
      case 'baseline':
        await configureBaseline();
        break;
      case 'gates':
        await configureGates();
        break;
      case 'submit':
        await doSubmit(context, prefill);
        return;
    }
  }
}

async function doSubmit(context: vscode.ExtensionContext, prefill: WizardPrefill): Promise<void> {
  const mode = await vscode.window.showQuickPick(
    [
      { label: '正确性测试', detail: '对冻结源码版本跑正确性测试', value: 'test' as const },
      { label: '性能基准', detail: '对冻结源码版本跑性能基准（需性能门禁）', value: 'benchmark' as const },
    ],
    { title: 'CorePilot 提交类型', ignoreFocusOut: true },
  );
  if (!mode) return;

  const cfg = getConfigService().load();
  // 与 CLI 一致：真实实验（experiment runner）提交前必须通过 Git 基线预检。
  if (cfg.backend.runner === 'experiment') {
    const projectDir = root() || cfg.project_root || process.cwd();
    const preflight = await runBaselinePreflightIde(projectDir);
    if (!preflight.ok) {
      void vscode.window.showErrorMessage('CorePilot: ' + preflight.message);
      return;
    }
  }
  try {
    const apiClient = await getApi(context);
    const result = await submitExperimentTask(apiClient, {
      config: cfg,
      mode: mode.value,
      requestId: `ide:${Date.now()}:${prefill.sourceFiles.join(',')}`,
      functionName: prefill.functionName,
      sourceFiles: prefill.sourceFiles,
    });
    if (!result.ok) {
      void vscode.window.showErrorMessage('CorePilot: 无法提交实验：\n' + result.problems.map((p) => `  - ${p}`).join('\n'));
      return;
    }
    getConfigService().setCurrentTask(result.taskId);
    treeProvider.refresh();
    void vscode.window.showInformationMessage(`CorePilot: 已提交实验任务 ${result.taskId}（${experimentModeLabel(cfg)}，transport=${result.transport}${result.grantConfigured ? '' : '，无授权 → 等待资源'}）`);
    void vscode.commands.executeCommand('phyopt.tasks.focus');
  } catch (err) {
    void vscode.window.showErrorMessage('CorePilot: ' + (err as Error).message);
  }
}

let treeProvider: TaskTreeProvider;

export function activate(context: vscode.ExtensionContext): void {
  treeProvider = new TaskTreeProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('phyopt.tasks', treeProvider));

  context.subscriptions.push(vscode.commands.registerCommand('phyopt.refreshTasks', () => treeProvider.refresh()));

  // 新建实验任务：右键文件 / 右键选区 / 命令面板均进入同一向导，预填来源。
  context.subscriptions.push(
    vscode.commands.registerCommand('phyopt.newExperiment', async (uri?: vscode.Uri) => {
      const rootDir = root();
      const prefill: WizardPrefill = { sourceFiles: [] };
      const file = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (file && rootDir) {
        const rel = vscode.workspace.asRelativePath(file.fsPath, false);
        if (rel && !rel.startsWith('..')) prefill.sourceFiles = [rel.split('\\').join('/')];
      }
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        const firstLine = editor.document.getText(editor.selection).trim().split(/\r?\n/)[0];
        if (firstLine) prefill.functionName = firstLine.slice(0, 80);
      }
      await runExperimentWizard(context, prefill);
    }),
  );

  // 旧命令保留为别名：同样进入真实实验向导（不再静默提交 mock）。
  context.subscriptions.push(
    vscode.commands.registerCommand('phyopt.initTask', async (uri?: vscode.Uri) => {
      void vscode.commands.executeCommand('phyopt.newExperiment', uri);
    }),
  );

  // 开始优化：复用已有模型候选生成器 + 门禁，接入真实 provider 接线。
  context.subscriptions.push(
    vscode.commands.registerCommand('phyopt.optimize', async (uri?: vscode.Uri) => {
      const rootDir = root();
      if (!rootDir) {
        void vscode.window.showErrorMessage('CorePilot: 未打开工作区文件夹。');
        return;
      }
      const cfg = getConfigService().load();
      if (!cfg.project_root) getConfigService().patch({ project_root: rootDir });
      // Git 基线预检：无仓库时引导初始化，伪造/过期 commit 会被识别并要求重建基线。
      const preflight = await runBaselinePreflightIde(rootDir);
      if (!preflight.ok) {
        void vscode.window.showErrorMessage('CorePilot: ' + preflight.message);
        return;
      }
      // 来源文件：右键文件或活动编辑器。
      const file = uri ?? vscode.window.activeTextEditor?.document.uri;
      const rel = file ? vscode.workspace.asRelativePath(file.fsPath, false) : '';
      if (!rel || rel.startsWith('..')) {
        void vscode.window.showErrorMessage('CorePilot: 请先右键选择要优化的文件，或打开目标文件。');
        return;
      }
      const goal = await vscode.window.showInputBox({ prompt: '优化目标（自然语言，如“减少单线程宽矩阵的停顿”）', ignoreFocusOut: true });
      if (!goal || !goal.trim()) return;

      const built = await buildModelProvider(getConfigService().load(), (ref) => getCredentials(context).resolve(ref));
      if (!built.ok) {
        void vscode.window.showErrorMessage('CorePilot: ' + built.problem);
        return;
      }
      void vscode.window.showInformationMessage(`CorePilot: 本次发送文件：${rel}；预算：最多 1 个候选、0 自动重试。`);

      const candidatesDir = path.join(rootDir, '.phyopt', 'candidates');
      const result = await generateCandidate({
        project_root: rootDir,
        goal,
        source_files: [rel.split('\\').join('/')],
        provider: built.provider,
        candidates_dir: candidatesDir,
      });
      if (!result.ok) {
        void vscode.window.showErrorMessage('CorePilot: 候选生成失败：\n' + result.problems.map((p) => '  - ' + p).join('\n'));
        return;
      }
      const c = result.candidate;
      treeProvider.refresh();
      void vscode.window.showInformationMessage(`CorePilot: 候选已生成，待验证（${c.candidate_id}${c.simulated ? '，模拟来源' : ''}）。`);
      void vscode.commands.executeCommand('phyopt.showCandidateDiff');
    }),
  );

  // 查看候选变更：VS Code 原生 diff（左=冻结源码，右=候选源码）。
  context.subscriptions.push(
    vscode.commands.registerCommand('phyopt.showCandidateDiff', async () => {
      const rootDir = root();
      if (!rootDir) {
        void vscode.window.showErrorMessage('CorePilot: 未打开工作区文件夹。');
        return;
      }
      const candidates = listCandidates(path.join(rootDir, '.phyopt', 'candidates'));
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage('CorePilot: 尚无已生成候选。请先用「开始优化」生成候选。');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        candidates.map((c) => ({ label: `${c.candidate_id}（${c.simulated ? '模拟' : '模型'}，${c.generated_at}）`, value: c.candidate_id })),
        { title: 'CorePilot 查看候选变更', placeHolder: '选择候选' },
      );
      if (!picked) return;
      const bundle = loadCandidate(path.join(rootDir, '.phyopt', 'candidates'), picked.value);
      if (!bundle) {
        void vscode.window.showErrorMessage('CorePilot: 候选不存在。');
        return;
      }
      // 多文件候选逐文件选择。
      const files = bundle.hypothesis.affected_files;
      let chosenFile: string;
      if (files.length === 1) {
        chosenFile = files[0];
      } else {
        const fp = await vscode.window.showQuickPick(files.map((f) => ({ label: f, value: f })), { title: '选择要查看的文件' });
        if (!fp) return;
        chosenFile = fp.value;
      }
      const original = bundle.source_files.find((f) => f.path === chosenFile);
      const candidateContent = candidateContentFor(bundle, chosenFile);
      if (!original || candidateContent === null) {
        void vscode.window.showErrorMessage('CorePilot: 无法还原该文件的候选内容。');
        return;
      }
      // 写临时文件，用原生 diff 展示；不改用户工作文件。
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-ide-diff-'));
      const leftUri = vscode.Uri.file(path.join(scratch, 'original-' + path.basename(chosenFile)));
      const rightUri = vscode.Uri.file(path.join(scratch, 'candidate-' + path.basename(chosenFile)));
      fs.writeFileSync(leftUri.fsPath, original.content);
      fs.writeFileSync(rightUri.fsPath, candidateContent);
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `CorePilot 候选变更：${chosenFile}（左=冻结源码，右=候选）`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('phyopt.showTasks', () => {
      void vscode.commands.executeCommand('phyopt.refreshTasks');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('phyopt.cancelTask', async (item?: TaskItem) => {
      const taskId = item?.summary.task_id ?? (await vscode.window.showInputBox({ prompt: 'Task ID to cancel' }));
      if (!taskId) return;
      await getClientForList().cancelTask(taskId, 'ide-cancel:' + Date.now());
      treeProvider.refresh();
    }),
  );

  // 导出报告：markdown/json 写入 .phyopt/exports/。
  context.subscriptions.push(
    vscode.commands.registerCommand('phyopt.exportTask', async (item?: TaskItem) => {
      const taskId = item?.summary.task_id ?? getConfigService().load().current.task_id ?? (await vscode.window.showInputBox({ prompt: 'Task ID to export' }));
      if (!taskId) {
        void vscode.window.showInformationMessage('CorePilot: 无任务可导出（先提交一个任务，或从任务列表选择）。');
        return;
      }
      try {
        const apiClient = await getApi(context);
        const read = await fetchExperimentResultView(apiClient, taskId);
        if (!read.ok || !read.view) {
          void vscode.window.showErrorMessage('CorePilot: ' + read.problems.join('; '));
          return;
        }
        const baseDir = root() || getConfigService().load().project_root || process.cwd();
        const out = writeExportFile(read.view, baseDir, 'markdown');
        if (!out.ok || !out.path) {
          void vscode.window.showErrorMessage('CorePilot: ' + out.problems.join('; '));
          return;
        }
        void vscode.window.showInformationMessage('CorePilot: 已导出报告 ' + out.path);
      } catch (err) {
        void vscode.window.showErrorMessage('CorePilot: ' + (err as Error).message);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('phyopt.openReport', async (item?: TaskItem) => {
      const taskId = item?.summary.task_id ?? (await vscode.window.showInputBox({ prompt: 'Task ID' }));
      if (!taskId) return;
      const reportPath = await getClientForList().getReportPath(taskId);
      const rootDir = root();
      const scope = assertReportPathWithinProject(rootDir, reportPath ?? '');
      if (!scope.ok) {
        void vscode.window.showWarningMessage('CorePilot: ' + scope.problems.join('; '));
        return;
      }
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(reportPath!));
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(reportPath!));
        await vscode.window.showTextDocument(doc);
      } catch {
        void vscode.window.showWarningMessage('CorePilot: report file missing: ' + reportPath);
      }
    }),
  );
}

export function deactivate(): void {
  // Disconnect only; never cancel backend tasks or kill an unknown process.
  api = null;
  configService = null;
  credentials = null;
  backendManager = null;
}
