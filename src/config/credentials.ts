import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** User-scoped API key storage. It deliberately lives outside a project. */
export function defaultCredentialsPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.phyopt', 'credentials.json');
}

export function normalizeCredentialEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

export class CredentialsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsStoreError';
  }
}

function readStore(filePath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('根节点必须是对象');
    }
    const result: Record<string, string> = {};
    for (const [endpoint, value] of Object.entries(parsed)) {
      if (typeof value !== 'string' || !value.trim()) throw new Error(`凭据 ${endpoint} 必须是非空字符串`);
      result[normalizeCredentialEndpoint(endpoint)] = value.trim();
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof CredentialsStoreError) throw error;
    throw new CredentialsStoreError(`无法读取用户凭据文件 ${filePath}：${(error as Error).message}`);
  }
}

function writeStore(filePath: string, store: Record<string, string>): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, filePath);
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* preserve the original error */ }
    throw new CredentialsStoreError(`无法保存用户凭据文件 ${filePath}：${(error as Error).message}`);
  }
}

export function readStoredApiKey(endpoint: string, options: { filePath?: string } = {}): string | undefined {
  const store = readStore(options.filePath ?? defaultCredentialsPath());
  return store[normalizeCredentialEndpoint(endpoint)];
}

export function saveStoredApiKey(endpoint: string, apiKey: string, options: { filePath?: string } = {}): void {
  const key = apiKey.trim();
  if (!key) throw new CredentialsStoreError('API Key 不能为空');
  const filePath = options.filePath ?? defaultCredentialsPath();
  const store = readStore(filePath);
  store[normalizeCredentialEndpoint(endpoint)] = key;
  writeStore(filePath, store);
}
