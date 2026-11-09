import type http from 'node:http';
import type { TestingService } from '../application/testing-service.js';
import type { CreateTestingTask, TestingPlanRef } from '../contracts/testing.js';
import type { ControlIdentity } from '../contracts/control-identity.js';
import { ApiError } from '../core/api-error.js';
import { readJson, sendJson } from './json.js';

function requestKey(req: http.IncomingMessage): string | undefined {
  const value = req.headers['idempotency-key'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 160) throw new ApiError(400, 'INVALID_ARGUMENT', '请提供有效的请求标识。');
  return value;
}

/** Authentication belongs to ServerAccess; all execution decisions belong to TestingService. */
export async function testingRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL, service: TestingService,
  assertOwnership: () => void, controlIdentity?: ControlIdentity, assertControl: () => void = () => {},
  currentControl: () => ControlIdentity = () => { throw new ApiError(503, 'CONTROL_IDENTITY_UNAVAILABLE', '控制端身份不可用。'); }): Promise<boolean> {
  if (!url.pathname.startsWith('/v1/testing-')) return false;
  const method = req.method ?? 'GET';
  const localOnly = () => {
    try { assertOwnership(); return null; }
    catch (error) {
      if (!(error instanceof ApiError) || (error.code !== 'CONTROL_LEASE_LOST' && error.code !== 'CONTROL_LEASE_UNKNOWN')) throw error;
      return { status: 'LOCAL_ONLY' as const, code: error.code, message: error.message + ' 当前仅显示已保存记录，未查询 Runner。' };
    }
  };
  if (url.pathname === '/v1/testing-requests' && method === 'GET') {
    const key = requestKey(req); if (key === undefined) throw new ApiError(400, 'INVALID_REQUEST_ID', '请提供请求标识。');
    sendJson(res, 200, service.requestStatus(key, controlIdentity)); return true;
  }
  if (url.pathname === '/v1/testing-requests/close' && method === 'POST') {
    const key = requestKey(req); if (key === undefined) throw new ApiError(400, 'INVALID_REQUEST_ID', '请提供请求标识。');
    await readJson(req); assertControl(); assertOwnership(); sendJson(res, 200, service.closeRequest(key, controlIdentity)); return true;
  }
  if (url.pathname === '/v1/testing-plans/preview' && method === 'POST') {
    sendJson(res, 200, { plan: service.plan(await readJson(req) as unknown as TestingPlanRef) }); return true;
  }
  if (url.pathname === '/v1/testing-tasks') {
    if (method === 'GET') {
      const observation = localOnly(), tasks = service.list();
      let current: ControlIdentity | undefined;
      if (!observation && tasks.some(task => 'request_control_identity' in task)) { try { current = currentControl(); } catch { /* Bound tasks remain local when identity cannot be checked. */ } }
      const canObserve = (task: (typeof tasks)[number]) => service.canReconcile(task, current);
      const skipped = !observation && tasks.some(task => !canObserve(task));
      if (!observation) service.refreshActive(canObserve);
      sendJson(res, 200, { tasks, ...(observation ? { observation } : {}), ...(skipped ? { identity_notice: '部分测试属于其他控制端或身份暂不可核对，列表仅显示其已保存状态。请连接原控制端查看详情。' } : {}) }); return true;
    }
    if (method === 'POST') {
      const body = await readJson(req);
      assertControl(); assertOwnership();
      const key = requestKey(req);
      if (controlIdentity && !key) throw new ApiError(400, 'INVALID_REQUEST_ID', '受保护的测试创建需要请求标识。');
      const task = await service.start(body as unknown as CreateTestingTask, { requestId: key, controlIdentity });
      sendJson(res, 202, { task }); return true;
    }
  }
  const task = url.pathname.match(/^\/v1\/testing-tasks\/([^/]+)(?:\/(cancel))?$/);
  if (task) {
    const id = decodeURIComponent(task[1]);
    if (!task[2] && method === 'GET') { service.assertRequestControl(id, controlIdentity, currentControl); const observation = localOnly(); sendJson(res, 200, observation ? { ...service.localDetails(id), observation } : await service.get(id)); return true; }
    if (task[2] === 'cancel' && method === 'POST') { await readJson(req); assertOwnership(); sendJson(res, 202, await service.cancel(id)); return true; }
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
