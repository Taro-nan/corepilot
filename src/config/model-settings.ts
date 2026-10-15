import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeCredentialEndpoint } from './credentials.js';

interface ModelSettings {
  model_proxies: Record<string, string>;
}

/** User-scoped model connection settings that should survive project changes. */
export function defaultModelSettingsPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.phyopt', 'settings.json');
}

export class ModelSettingsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelSettingsStoreError';
  }
}

export function normalizeModelProxy(proxy: string): string {
  const value = proxy.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ModelSettingsStoreError('代理地址必须是合法的 http、https 或 socks5 URL');
  }
  if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new ModelSettingsStoreError('代理地址必须使用 http、https 或 socks5，并包含主机地址');
  }
  return value.replace(/\/+$/, '');
}

export function redactModelProxy(proxy: string): string {
  try {
    const parsed = new URL(proxy);
    parsed.username = '';
    parsed.password = '';
    const redacted = parsed.toString();
    return parsed.pathname === '/' && !parsed.search && !parsed.hash ? redacted.replace(/\/$/, '') : redacted;
  } catch {
    return '[无效代理地址]';
  }
}

function readSettings(filePath: string): ModelSettings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('根节点必须是对象');
    const rawProxies = (parsed as { model_proxies?: unknown }).model_proxies;
    if (!rawProxies || typeof rawProxies !== 'object' || Array.isArray(rawProxies)) {
      throw new Error('model_proxies 必须是对象');
    }
    const modelProxies: Record<string, string> = {};
    for (const [endpoint, proxy] of Object.entries(rawProxies)) {
      if (typeof proxy !== 'string') throw new Error(`代理 ${endpoint} 必须是字符串`);
      modelProxies[normalizeCredentialEndpoint(endpoint)] = normalizeModelProxy(proxy);
    }
    return { model_proxies: modelProxies };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { model_proxies: {} };
    if (error instanceof ModelSettingsStoreError) {
      throw new ModelSettingsStoreError(`无法读取模型设置 ${filePath}：${error.message}`);
    }
    throw new ModelSettingsStoreError(`无法读取模型设置 ${filePath}：${(error as Error).message}`);
  }
}

function writeSettings(filePath: string, settings: ModelSettings): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(temporaryPath, 0o600);
    if (process.platform === 'win32') {
      fs.copyFileSync(temporaryPath, filePath);
      fs.rmSync(temporaryPath, { force: true });
    } else {
      fs.renameSync(temporaryPath, filePath);
    }
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* preserve the original error */ }
    throw new ModelSettingsStoreError(`无法保存模型设置 ${filePath}：${(error as Error).message}`);
  }
}

export function readStoredModelProxy(endpoint: string, options: { filePath?: string } = {}): string | undefined {
  const settings = readSettings(options.filePath ?? defaultModelSettingsPath());
  return settings.model_proxies[normalizeCredentialEndpoint(endpoint)];
}

export function saveStoredModelProxy(endpoint: string, proxy: string, options: { filePath?: string } = {}): void {
  const filePath = options.filePath ?? defaultModelSettingsPath();
  const settings = readSettings(filePath);
  settings.model_proxies[normalizeCredentialEndpoint(endpoint)] = normalizeModelProxy(proxy);
  writeSettings(filePath, settings);
}

export function removeStoredModelProxy(endpoint: string, options: { filePath?: string } = {}): void {
  const filePath = options.filePath ?? defaultModelSettingsPath();
  const settings = readSettings(filePath);
  const key = normalizeCredentialEndpoint(endpoint);
  if (!(key in settings.model_proxies)) return;
  delete settings.model_proxies[key];
  writeSettings(filePath, settings);
}
