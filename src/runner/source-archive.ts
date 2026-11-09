import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError } from '../core/api-error.js';
import { sourceTreeSha256Async } from '../core/source-identity.js';
import type { StagedSourceArchive } from '../contracts/runner-rpc.js';

const execute = promisify(execFile);

export function containedRunnerPath(root: string, target: string): string {
  const absolute = path.resolve(target), base = path.resolve(root);
  if (!path.isAbsolute(target) || absolute === base || !absolute.startsWith(base + path.sep)) throw new ApiError(400, 'INVALID_WORKSPACE', '工作目录必须位于 Runner 授权根目录内');
  let current = absolute;
  while (current !== base) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new ApiError(400, 'INVALID_WORKSPACE', '工作目录不能经过符号链接');
    current = path.dirname(current);
  }
  return absolute;
}

/** Authenticated byte staging. Extraction and source hashing occur only on execution hardware. */
export async function stageRunnerSourceArchive(body: AsyncIterable<Buffer>, root: string, destination: string, digest: string): Promise<StagedSourceArchive> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new ApiError(400, 'INVALID_SOURCE_DIGEST', '需要源码归档 SHA-256');
  const source = containedRunnerPath(root, destination);
  const runRoot = path.dirname(source);
  if (path.basename(source) !== 'source' || runRoot === path.resolve(root)) throw new ApiError(400, 'INVALID_WORKSPACE', '源码必须位于独立运行目录的 source/ 下');
  fs.mkdirSync(runRoot, { recursive: true });
  const lock = path.join(runRoot, '.source-upload.lock');
  let lockFd: number;
  try { lockFd = fs.openSync(lock, 'wx'); }
  catch { throw new ApiError(409, 'SOURCE_UPLOAD_BUSY', '此源码目录已有上传，请查询原构建记录'); }
  const temporary = path.join(runRoot, `.source-${randomUUID()}.tar.gz`);
  const unpacked = path.join(runRoot, `.source-${randomUUID()}.unpacked`);
  try {
    const file = await fs.promises.open(temporary, 'wx');
    const hash = createHash('sha256'); let bytes = 0;
    try { for await (const chunk of body) { bytes += chunk.length; if (bytes > 2 * 1024 ** 3) throw new ApiError(413, 'SOURCE_TOO_LARGE', '源码压缩归档不能超过 2 GB'); hash.update(chunk); await file.write(chunk); } }
    finally { await file.close(); }
    if (hash.digest('hex') !== digest) throw new ApiError(400, 'SOURCE_DIGEST_MISMATCH', '源码归档传输后的 SHA-256 不一致');
    if (fs.existsSync(source)) {
      const metadata = path.join(runRoot, 'source.json');
      if (fs.existsSync(metadata)) {
        const previous = JSON.parse(await fs.promises.readFile(metadata, 'utf8')) as StagedSourceArchive;
        if (previous.workspace_path === source && previous.archive_sha256 === digest && previous.source_sha256 === await sourceTreeSha256Async(source)) return previous;
      }
      throw new ApiError(409, 'SOURCE_ALREADY_STAGED', '此源码目录已有其他内容；新构建应使用新的运行 ID');
    }
    const listing = await execute('tar', ['-tf', temporary], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
    for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) {
      if (entry.startsWith('/') || entry.includes('\\') || /^[A-Za-z]:/.test(entry) || entry.split('/').includes('..')) throw new ApiError(400, 'INVALID_SOURCE_ARCHIVE', '源码归档含有目录外路径');
    }
    fs.mkdirSync(unpacked);
    await execute('tar', ['-xf', temporary, '-C', unpacked], { windowsHide: true, timeout: 600_000, maxBuffer: 1024 * 1024 });
    const sourceDigest = await sourceTreeSha256Async(unpacked);
    fs.renameSync(unpacked, source);
    fs.renameSync(temporary, path.join(runRoot, 'source.tar.gz'));
    const result = { workspace_path: source, source_sha256: sourceDigest, archive_sha256: digest, archive_bytes: bytes };
    fs.writeFileSync(path.join(runRoot, 'source.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    fs.closeSync(lockFd); fs.rmSync(lock, { force: true });
    fs.rmSync(temporary, { force: true });
    // Both paths are explicit children of the checked runRoot.
    if (fs.existsSync(unpacked)) fs.rmSync(unpacked, { recursive: true, force: true });
  }
}
