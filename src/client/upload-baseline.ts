import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ApiClientError } from './api-client.js';

/** CLI uses the same binary upload route as the browser without loading the file into memory. */
export async function uploadProjectBaseline(baseUrl: string, projectId: string, input: {
  packageId: string; version: string; targetId: string; library: string; libraryVersion: string; file: string;
}, token = process.env.COREPILOT_SERVER_TOKEN): Promise<unknown> {
  const query = new URLSearchParams({ package_id: input.packageId, package_version: input.version,
    target_id: input.targetId, library: input.library, library_version: input.libraryVersion,
    filename: path.basename(input.file) });
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(projectId)}/baseline-upload?${query}`, {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: Readable.toWeb(fs.createReadStream(input.file)) as ReadableStream,
    duplex: 'half', signal: AbortSignal.timeout(600_000),
  } as RequestInit & { duplex: 'half' });
  const body = await response.json() as { error?: { message?: string } };
  if (!response.ok) throw new ApiClientError(response.status, null, body.error?.message ?? `HTTP ${response.status}`);
  return body;
}

/** Directory import follows the same create → file upload → entry selection API as the browser. */
export async function uploadProjectBaselineBundle(baseUrl: string, projectId: string, input: {
  packageId: string; version: string; targetId: string; library: string; libraryVersion: string;
  directory: string; entry: string;
}, token = process.env.COREPILOT_SERVER_TOKEN): Promise<unknown> {
  const root = fs.realpathSync(input.directory);
  if (!fs.statSync(root).isDirectory()) throw new Error('--directory must be an existing folder');
  const base = `${baseUrl.replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(projectId)}/baseline-bundles`;
  const headers = { authorization: token ? `Bearer ${token}` : '' };
  const json = async (url: string, method: string, value?: unknown, timeout = 120_000) => {
    const response = await fetch(url, { method, headers: { ...headers, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
      body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(timeout) });
    const body = await response.json() as { error?: { message?: string }; [key: string]: unknown };
    if (!response.ok) throw new ApiClientError(response.status, null, body.error?.message ?? `HTTP ${response.status}`);
    return body;
  };
  const created = await json(base, 'POST', { package_id: input.packageId, package_version: input.version,
    target_id: input.targetId, library: input.library, library_version: input.libraryVersion });
  const id = String(created.bundle_id);
  const files: string[] = [];
  function visit(directory: string) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) visit(filename);
      else if (item.isFile() && /\.(?:so(?:\.[A-Za-z0-9_.+-]+)?|h|hpp|hh)$/.test(item.name)) files.push(filename);
    }
  }
  visit(root);
  if (!files.length) throw new Error('directory contains no .so or header files; unpack RPM/DEB first');
  for (const filename of files) {
    const relative = path.relative(root, filename).split(path.sep).join('/');
    const response = await fetch(`${base}/${id}/files?path=${encodeURIComponent(relative)}`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: Readable.toWeb(fs.createReadStream(filename)) as ReadableStream,
      duplex: 'half', signal: AbortSignal.timeout(600_000),
    } as RequestInit & { duplex: 'half' });
    const body = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new ApiClientError(response.status, null, body.error?.message ?? `HTTP ${response.status}`);
  }
  return json(`${base}/${id}/finalize`, 'POST', { entry_path: input.entry.replaceAll('\\', '/') }, 900_000);
}
