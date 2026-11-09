import type http from 'node:http';
import type { ExecutionMachineService } from '../application/execution-machine-service.js';
import { readJson, sendJson } from './json.js';

export async function machineRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL, machines: ExecutionMachineService): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (url.pathname === '/v1/machines') {
    if (method === 'GET') { sendJson(res, 200, { machines: await machines.list() }); return true; }
    if (method === 'POST') {
      const body = await readJson(req);
      const machine = machines.save(body.machine);
      await machines.check(machine.machine_id);
      sendJson(res, 201, { machine: machines.details(machine.machine_id) }); return true;
    }
  }
  const match = url.pathname.match(/^\/v1\/machines\/([^/]+)(?:\/(check|configuration))?$/);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  if (method === 'GET') { sendJson(res, 200, { machine: match[2] === 'configuration' ? machines.details(id) : machines.get(id) }); return true; }
  if (method === 'POST' && match[2] === 'check') { sendJson(res, 200, { machine: await machines.check(id) }); return true; }
  if (method === 'PUT' && !match[2]) {
    const body = await readJson(req);
    machines.save(body.machine, id); await machines.check(id);
    sendJson(res, 200, { machine: machines.details(id) }); return true;
  }
  return false;
}
