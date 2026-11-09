import type http from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../core/api-error.js';
import { readJson, sendJson } from './json.js';

const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** Browser sessions and CLI Bearer tokens authorize the very same API routes. */
export class ServerAccess {
  constructor(private readonly token?: string) {}

  private signature(expiry: string) { return createHmac('sha256', this.token ?? '').update(`corepilot-session:${expiry}`).digest('base64url'); }
  authenticated(req: http.IncomingMessage): boolean {
    if (!this.token) return true;
    const bearer = req.headers.authorization?.replace(/^Bearer /i, '');
    if (bearer && same(bearer, this.token)) return true;
    const cookie = (req.headers.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith('corepilot_session='))?.slice(18);
    if (!cookie) return false;
    const [expiry, signature] = cookie.split('.');
    return /^\d+$/.test(expiry ?? '') && Number(expiry) > Date.now() && !!signature && same(signature, this.signature(expiry));
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET') && req.headers.origin) {
      let origin: URL;
      try { origin = new URL(req.headers.origin); } catch { throw new ApiError(403, 'INVALID_ORIGIN', 'invalid request origin'); }
      if (origin.host !== req.headers.host) throw new ApiError(403, 'INVALID_ORIGIN', 'cross-origin mutation is not allowed');
    }
    if (pathname === '/v1/session') {
      if (req.method === 'GET') { sendJson(res, 200, { authenticated: this.authenticated(req), authentication_required: !!this.token }); return true; }
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (this.token && (typeof body.token !== 'string' || !same(body.token, this.token))) throw new ApiError(401, 'UNAUTHORIZED', '登录凭据不正确');
        const expiry = String(Date.now() + 86400_000);
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.setHeader('set-cookie', `corepilot_session=${expiry}.${this.signature(expiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure}`);
        sendJson(res, 200, { authenticated: true }); return true;
      }
      if (req.method === 'DELETE') { res.setHeader('set-cookie', 'corepilot_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); sendJson(res, 200, { authenticated: false }); return true; }
    }
    if (pathname.startsWith('/v1/') && pathname !== '/v1/health' && !this.authenticated(req)) throw new ApiError(401, 'UNAUTHORIZED', '请登录，或为 CLI 设置 COREPILOT_SERVER_TOKEN');
    return false;
  }
}
