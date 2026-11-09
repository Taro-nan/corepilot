import type http from 'node:http';
import { ApiError } from '../core/api-error.js';

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
}

export async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += (chunk as Buffer).byteLength;
    if (length > 1024 * 1024) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!length) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ApiError(400, 'INVALID_JSON', 'request body must be a JSON object'); }
}
