import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../core/api-error.js';

/** A request key is scoped to one project and never appears in a filename. */
export function trialRequestIdentity(projectId: string, requestId: string) {
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) {
    throw new ApiError(400, 'INVALID_REQUEST_ID', '请求标识应为 1 到 200 个字符。');
  }
  const keyDigest = createHash('sha256').update('corepilot-trial-request-v1\0').update(projectId).update('\0').update(requestId).digest('hex');
  const variant = ((Number.parseInt(keyDigest[16], 16) & 3) | 8).toString(16);
  const uuid = `${keyDigest.slice(0, 8)}-${keyDigest.slice(8, 12)}-8${keyDigest.slice(13, 16)}-${variant}${keyDigest.slice(17, 20)}-${keyDigest.slice(20, 32)}`;
  return { keyDigest, trialId: `validation:${uuid}` };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function trialRequestDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Publish complete bytes exactly once. Unsupported filesystems fail closed. */
export function publishTrialRecord(filename: string, value: unknown): boolean {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try {
      fs.linkSync(temporary, filename);
      if (process.platform !== 'win32') {
        const directory = fs.openSync(path.dirname(filename), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
      return true;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw new ApiError(503, 'TRIAL_ATOMIC_STORAGE_UNAVAILABLE', '无法确认试跑请求是否原子保存；请检查数据目录权限与文件系统是否支持硬链接，并核对原请求。');
    }
  } finally { fs.rmSync(temporary, { force: true }); }
}
