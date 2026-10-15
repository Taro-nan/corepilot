import fs from 'node:fs';
import path from 'node:path';
import { ApiClient } from '../client/api-client.js';
import { BackendManager, type EnsureResult } from '../backend/backend-manager.js';
import { loadOptimizationConfig, type OptimizationConfig } from '../config/optimization-config.js';
import { defaultCredentialsPath } from '../config/credentials.js';
import { defaultModelSettingsPath } from '../config/model-settings.js';
import { defaultTargetProfilesPath } from '../config/target-profiles.js';
import { checkSshTarget, type SshTargetCheck } from '../testpack/remote-transport.js';
import type { BackendHealth } from '../contracts/health.js';
import { createModelTransport, type ModelTransport } from '../model/model-transport.js';

export interface BackendState { url: string; reused: boolean; started: boolean; health: BackendHealth }

export interface WorkbenchConfigView {
  model: OptimizationConfig['model'] | null;
  target: OptimizationConfig['target'] | null;
  project_root: string;
  backend: { runner: 'workflow' };
}

/** 交互式工作台只读取 public YAML，并通过统一 HTTP API 操作工作流和通用任务。 */
export class WorkbenchContext {
  readonly configPath: string;
  readonly credentialsPath: string;
  readonly modelSettingsPath: string;
  readonly targetProfilesPath: string;
  readonly targetChecker: (target: OptimizationConfig['target']) => SshTargetCheck;
  readonly modelTransportFactory: (proxy?: string) => ModelTransport;
  private api: ApiClient | null = null;
  private selectedTask: string | null = null;
  backend: BackendState | null = null;

  constructor(options: { configPath?: string; credentialsPath?: string; modelSettingsPath?: string; targetProfilesPath?: string; targetChecker?: (target: OptimizationConfig['target']) => SshTargetCheck; modelTransportFactory?: (proxy?: string) => ModelTransport } = {}) {
    this.configPath = path.resolve(options.configPath ?? 'phyopt.yaml');
    this.credentialsPath = options.credentialsPath ?? defaultCredentialsPath();
    this.modelSettingsPath = options.modelSettingsPath ?? defaultModelSettingsPath();
    this.targetProfilesPath = options.targetProfilesPath ?? defaultTargetProfilesPath();
    this.targetChecker = options.targetChecker ?? checkSshTarget;
    this.modelTransportFactory = options.modelTransportFactory ?? createModelTransport;
  }

  hasConfig(): boolean {
    return fs.existsSync(this.configPath);
  }

  config(): WorkbenchConfigView {
    if (!fs.existsSync(this.configPath)) return { model: null, target: null, project_root: process.cwd(), backend: { runner: 'workflow' } };
    const loaded = loadOptimizationConfig(this.configPath);
    return { model: loaded.config.model, target: loaded.config.target, project_root: loaded.configDir, backend: { runner: 'workflow' } };
  }

  async ensureBackend(): Promise<BackendState> {
    const loaded = loadOptimizationConfig(this.configPath);
    const url = process.env.PHYOPT_SERVER_URL ?? 'http://127.0.0.1:4317';
    const parsed = new URL(url);
    const port = Number(parsed.port || 4317);
    const manager = new BackendManager({
      url,
      allowSpawn: parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost',
      spec: {
        host: parsed.hostname,
        port,
        dbPath: path.join(loaded.configDir, '.phyopt', 'workflow.sqlite'),
        runner: 'workflow',
        transport: 'ssh',
        sshAlias: 'ssh_alias' in loaded.config.target ? loaded.config.target.ssh_alias : null,
        ...( 'ssh_alias' in loaded.config.target ? {} : {
          sshHost: loaded.config.target.host,
          sshUsername: loaded.config.target.username,
          sshPort: loaded.config.target.port,
          ...(loaded.config.target.identity_file ? { sshIdentityFile: loaded.config.target.identity_file } : {}),
        }),
      },
    });
    const result: EnsureResult = await manager.ensure();
    this.backend = { url: result.url, reused: result.reused, started: result.started, health: result.health };
    return this.backend;
  }

  async getApi(): Promise<ApiClient> {
    if (!this.api) this.api = new ApiClient((await this.ensureBackend()).url);
    return this.api;
  }

  currentTaskId(): string | null { return this.selectedTask; }
  setCurrentTask(taskId: string | null): void { this.selectedTask = taskId; }
}
