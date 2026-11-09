import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ApiClient, ApiClientError } from './api-client.js';
import type { TestingAsset } from '../contracts/testing.js';

/** Stream a library directory through the same asset API used by the workbench. */
export async function uploadTestingAsset(baseUrl: string, input: { directory: string; entry: string; name: string; version?: string }, token = process.env.COREPILOT_SERVER_TOKEN): Promise<TestingAsset> {
  const root = fs.realpathSync(input.directory);
  if (!fs.statSync(root).isDirectory()) throw new Error('--directory 应是已解压的库包目录。');
  const entry = input.entry.replaceAll('\\', '/');
  if (path.isAbsolute(entry) || entry.split('/').includes('..') || !/\.so(?:\.[A-Za-z0-9_.+-]+)?$/.test(entry) || !fs.statSync(path.join(root, entry)).isFile()) throw new Error('--entry 应是库包目录内的 .so 入口文件。');
  const files: Array<{ relative: string; filename: string }> = [];
  function visit(directory: string) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) visit(filename);
      else if (item.isFile() || item.isSymbolicLink()) {
        if (!/\.(?:so(?:\.[A-Za-z0-9_.+-]+)?|h|hpp|hh)$/.test(item.name)) continue;
        const resolved = fs.realpathSync(filename);
        const relativeTarget = path.relative(root, resolved);
        if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) throw new Error(`库包链接指向目录外：${path.relative(root, filename)}`);
        if (fs.statSync(resolved).isFile()) files.push({ relative: path.relative(root, filename).split(path.sep).join('/'), filename: resolved });
      }
    }
  }
  visit(root);
  if (!files.length) throw new Error('库包目录中没有 .so 动态库或头文件。');
  const api = new ApiClient(baseUrl, { token });
  const { asset } = await api.testing.createAsset({ name: input.name, ...(input.version ? { version: input.version } : {}) });
  for (const file of files) {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/testing-assets/${encodeURIComponent(asset.asset_id)}/files?path=${encodeURIComponent(file.relative)}`, {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: Readable.toWeb(fs.createReadStream(file.filename)) as ReadableStream,
      duplex: 'half', signal: AbortSignal.timeout(600_000),
    } as RequestInit & { duplex: 'half' });
    const result = await response.json() as { error?: { code?: string; message?: string } };
    if (!response.ok) throw new ApiClientError(response.status, result.error?.code ?? 'UPLOAD_FAILED', result.error?.message ?? `HTTP ${response.status}`);
  }
  return (await api.testing.finalizeAsset(asset.asset_id, entry)).asset;
}
