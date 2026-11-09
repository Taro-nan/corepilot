import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';

export async function serveWeb(req: http.IncomingMessage, res: http.ServerResponse, root: string, pathname: string): Promise<boolean> {
  if (!['GET', 'HEAD'].includes(req.method ?? '') || pathname.startsWith('/v1/')) return false;
  let relative: string;
  try { relative = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return false; }
  if (relative.includes('\0') || relative.includes('\\')) return false;
  let file = path.resolve(root, relative || 'index.html');
  if (file !== path.resolve(root) && !file.startsWith(path.resolve(root) + path.sep)) return false;
  let stat = await fs.promises.stat(file).catch(() => null);
  if (!stat?.isFile() && !path.extname(relative)) { file = path.join(root, 'index.html'); stat = await fs.promises.stat(file).catch(() => null); }
  if (!stat?.isFile()) return false;
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'content-length': stat.size,
    'cache-control': path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=86400',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}
