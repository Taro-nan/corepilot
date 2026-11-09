import { randomUUID } from 'node:crypto';
import type { TaskStore } from '../storage/task-store.js';
import type { ExecutionMachineRecord, ExecutionMachineSummary, ExecutionMachineDetails, ResolvedExecutionMachine } from '../contracts/execution-machine.js';
import { parseRunnerSettings, parseExecutionTarget, resolveRunnerConfig } from '../config/optimization-config.js';
import { isRegisteredRunner, redactRpcRunner } from '../config/runner-config.js';
import { normalizeCredentialEndpoint } from '../config/credentials.js';
import { RunnerClient, RunnerClientError } from '../client/runner-client.js';

const CHECK_INTERVAL_MS = 30_000;

/** Shared machine registry; project configuration stores only stable references. */
export class ExecutionMachineService {
  private readonly checks = new Map<string, Promise<ExecutionMachineSummary>>();
  constructor(private readonly store: TaskStore) {}

  private record(id: string): ExecutionMachineRecord {
    const record = this.store.getExecutionMachine(id);
    if (!record) throw new Error('执行机器不存在，请重新选择已注册机器。');
    return record;
  }

  private summary(record: ExecutionMachineRecord): ExecutionMachineSummary {
    const check = record.last_check;
    return { machine_id: record.machine_id, name: record.name, revision: record.revision, enabled: record.enabled,
      status: !record.enabled ? 'DISABLED' : !check ? 'UNKNOWN' : Date.now() - Date.parse(check.checked_at) > CHECK_INTERVAL_MS * 2 ? 'STALE' : check.status,
      setup_complete: record.target !== null, last_checked_at: check?.checked_at ?? null,
      last_online_at: record.last_success?.checked_at ?? null, health: record.last_success?.health ?? null,
      hardware: record.last_success?.machine ?? null, error: check?.error ?? null };
  }

  get(id: string): ExecutionMachineSummary { return this.summary(this.record(id)); }
  details(id: string): ExecutionMachineDetails {
    const record = this.record(id);
    return { ...this.summary(record), runner: redactRpcRunner(record.runner), target: record.target };
  }

  async list(): Promise<ExecutionMachineSummary[]> {
    const due = this.store.listExecutionMachines().filter(record => record.enabled && (!record.last_check || Date.now() - Date.parse(record.last_check.checked_at) >= CHECK_INTERVAL_MS));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, due.length) }, async () => {
      while (next < due.length) { const record = due[next++]; await this.check(record.machine_id); }
    }));
    return this.store.listExecutionMachines().map(record => this.summary(record)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  save(input: unknown, id?: string): ExecutionMachineDetails {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('machine must be an object');
    const value = input as Record<string, unknown>;
    const old = id ? this.record(id) : undefined;
    if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('请填写执行机器名称。');
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean');
    if (value.expected_revision !== undefined && value.expected_revision !== old?.revision) throw new Error('机器配置已更新，请重新读取后保存。');
    const runner = parseRunnerSettings(value.runner);
    if (runner.mode !== 'rpc' || isRegisteredRunner(runner)) throw new Error('注册机器需要填写实际 Runner RPC 地址和凭据。');
    if (runner.token === '[redacted]' || !runner.token) {
      runner.token = old && normalizeCredentialEndpoint(old.runner.endpoint) === normalizeCredentialEndpoint(runner.endpoint) ? old.runner.token : '';
    }
    if (!runner.endpoint || !runner.token) throw new Error('请填写 Runner RPC 地址和凭据；修改地址后需提供对应凭据。');
    const target = value.target === undefined ? old?.target ?? null : value.target === null ? null : parseExecutionTarget(value.target);
    const now = new Date().toISOString();
    const record: ExecutionMachineRecord = { machine_id: old?.machine_id ?? randomUUID(), name: value.name.trim(), runner, target,
      enabled: (value.enabled as boolean | undefined) ?? old?.enabled ?? true, revision: (old?.revision ?? 0) + 1,
      created_at: old?.created_at ?? now, updated_at: now, last_check: null, last_success: null };
    if (!this.store.saveExecutionMachine(record, old?.revision)) throw new Error('机器配置已更新，请重新读取后保存。');
    return this.details(record.machine_id);
  }

  resolve(id: string): ResolvedExecutionMachine {
    const record = this.record(id);
    if (!record.enabled) throw new Error(`执行机器「${record.name}」已停用，请选择其他机器。`);
    if (!record.target) throw new Error(`执行机器「${record.name}」尚未完成部署环境配置，请联系维护者。`);
    return { identity: { machine_id: record.machine_id, name: record.name, revision: record.revision }, runner: { ...record.runner }, target: { ...record.target } };
  }

  async check(id: string): Promise<ExecutionMachineSummary> {
    const record = this.record(id);
    if (!record.enabled) return this.summary(record);
    const key = `${id}:${record.revision}`;
    const pending = this.checks.get(key);
    if (pending) return pending;
    const check = this.probe(record).finally(() => { this.checks.delete(key); });
    this.checks.set(key, check);
    return check;
  }

  private async probe(record: ExecutionMachineRecord): Promise<ExecutionMachineSummary> {
    const checkedAt = new Date().toISOString();
    let token = record.runner.token;
    let lastSuccess = record.last_success;
    let error: string | null = null;
    try {
      const connection = resolveRunnerConfig({ runner: record.runner });
      if (connection.mode !== 'rpc') throw new Error('Runner RPC 配置无效');
      token = connection.token;
      const facts = await new RunnerClient({ baseUrl: connection.endpoint, token, requestTimeoutMs: connection.requestTimeoutMs }).probe();
      lastSuccess = { checked_at: checkedAt, ...facts };
    } catch (cause) {
      error = cause instanceof RunnerClientError && (cause.status === 401 || cause.status === 403) ? 'Runner 认证失败，请由维护者检查凭据。'
        : cause instanceof RunnerClientError && cause.code === 'CONNECTION_FAILED' ? '无法连接 Runner，请检查服务与网络。'
        : cause instanceof RunnerClientError && cause.code === 'REQUEST_TIMEOUT' ? 'Runner 连接超时。' : (cause as Error).message;
      if (token) error = error.split(token).join('[redacted]');
      if (record.runner.token) error = error.split(record.runner.token).join('[redacted]');
    }
    // A probe of an old endpoint must never overwrite a newly edited configuration.
    const current = this.record(record.machine_id);
    if (current.revision === record.revision) this.store.saveExecutionMachine({ ...current, last_check: { status: error ? 'OFFLINE' : 'ONLINE', checked_at: checkedAt, error }, last_success: lastSuccess }, record.revision);
    return this.get(record.machine_id);
  }
}
