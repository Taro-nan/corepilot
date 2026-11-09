import type http from 'node:http';
import type { TestingService } from '../application/testing-service.js';
import type { CreateTestingTask, TestingPlanRef } from '../contracts/testing.js';
import { ApiError } from '../core/api-error.js';
import { readJson, sendJson } from './json.js';

function requestKey(req: http.IncomingMessage): string | undefined {
  const value = req.headers['idempotency-key'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new ApiError(400, 'INVALID_ARGUMENT', '请提供有效的请求标识。');
  return value;
}

/** Authentication belongs to ServerAccess; all execution decisions belong to TestingService. */
export async function testingRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL, service: TestingService): Promise<boolean> {
  if (!url.pathname.startsWith('/v1/testing-')) return false;
  const method = req.method ?? 'GET';
  if (url.pathname === '/v1/testing-plans/preview' && method === 'POST') {
    sendJson(res, 200, { plan: service.plan(await readJson(req) as unknown as TestingPlanRef) }); return true;
  }
  if (url.pathname === '/v1/testing-tasks') {
    if (method === 'GET') { service.refreshActive(); sendJson(res, 200, { tasks: service.list() }); return true; }
    if (method === 'POST') {
      const task = await service.start(await readJson(req) as unknown as CreateTestingTask, { requestId: requestKey(req) });
      sendJson(res, 202, { task }); return true;
    }
  }
  const task = url.pathname.match(/^\/v1\/testing-tasks\/([^/]+)(?:\/(cancel))?$/);
  if (task) {
    const id = decodeURIComponent(task[1]);
    if (!task[2] && method === 'GET') { sendJson(res, 200, await service.get(id)); return true; }
    if (task[2] === 'cancel' && method === 'POST') { await readJson(req); sendJson(res, 202, await service.cancel(id)); return true; }
  }
  if (url.pathname === '/v1/testing-assets') {
    if (method === 'GET') { sendJson(res, 200, { assets: service.assets.list() }); return true; }
    if (method === 'POST') {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || body.version !== undefined && typeof body.version !== 'string') throw new ApiError(400, 'INVALID_ARGUMENT', '请填写库包名称，版本为可选文本。');
      sendJson(res, 201, { asset: service.assets.create({ name: body.name, ...(body.version === undefined ? {} : { version: body.version }) }) }); return true;
    }
  }
  const asset = url.pathname.match(/^\/v1\/testing-assets\/([^/]+)(?:\/(files|finalize))?$/);
  if (asset) {
    const id = decodeURIComponent(asset[1]);
    if (!asset[2] && method === 'GET') { sendJson(res, 200, { asset: service.assets.get(id) }); return true; }
    if (asset[2] === 'files' && method === 'PUT') {
      sendJson(res, 200, { file: await service.assets.upload(id, url.searchParams.get('path') ?? '', req) }); return true;
    }
    if (asset[2] === 'finalize' && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.entry_path !== 'string') throw new ApiError(400, 'INVALID_ARGUMENT', '请选择库包的入口文件。');
      sendJson(res, 200, { asset: await service.assets.finalize(id, { entry_path: body.entry_path }) }); return true;
    }
  }
  return false;
}
