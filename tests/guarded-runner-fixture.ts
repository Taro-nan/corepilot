import type { IncomingMessage, ServerResponse } from 'node:http';
import { RUNNER_STORE_ROUTE } from '../src/contracts/runner-rpc.js';

export const fixtureRunnerStoreId = '11111111-1111-4111-8111-111111111111';

/** Reject unbound operations just as the store-specific Runner route does. */
export function guardFixtureRunnerRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.url === '/health') return true;
  const prefix = `${RUNNER_STORE_ROUTE}${fixtureRunnerStoreId}`;
  if (req.url?.startsWith(`${prefix}/`)) {
    req.url = req.url.slice(prefix.length);
    return true;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'fixture requires the original Runner store' } }));
  return false;
}
