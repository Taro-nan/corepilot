import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { TestingAsset, TestingAssetFile } from '../contracts/testing.js';
import { ApiError } from '../core/api-error.js';
import { TestingStore } from '../storage/testing-store.js';
import { bundleRelativePath } from '../runner/baseline-bundle-inspector.js';

async function identity(filename: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of fs.createReadStream(filename)) { hash.update(chunk); bytes += chunk.byteLength; }
  return { sha256: hash.digest('hex'), bytes };
}
function assetPath(value: string): string {
  try { return bundleRelativePath(value); }
  catch { throw new ApiError(400, 'INVALID_TEST_FILE_PATH', '文件路径应位于库包内，不能包含绝对路径或上级目录。'); }
}

/** User-uploaded subjects are immutable after entry selection; no project baseline is modified. */
export class TestingAssetService {
  private readonly busy = new Set<string>();
  constructor(private readonly store: TestingStore) {}

  create(input: { name: string; version?: string }): TestingAsset {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160 ||
      (input.version !== undefined && (typeof input.version !== 'string' || input.version.length > 160))) {
      throw new ApiError(400, 'INVALID_TEST_ASSET', '请填写库文件名称，名称与版本最多 160 字。');
    }
    const record: TestingAsset = { schema_version: 1, asset_id: randomUUID(), name: input.name.trim(), version: input.version?.trim() ?? '',
      state: 'UPLOADING', files: [], entries: [], entry_path: null, sha256: null, created_at: new Date().toISOString(), finalized_at: null };
    this.store.saveAsset(record); return record;
  }
  get(id: string): TestingAsset { return this.store.asset(id); }
  list(): TestingAsset[] { return this.store.assets(); }
  filesRoot(id: string): string { this.get(id); return path.join(this.store.assetRoot(id), 'files'); }

  private requireIdle(id: string): TestingAsset {
    if (this.busy.has(id)) throw new ApiError(409, 'TEST_ASSET_BUSY', '这份文件正在上传或固定，请等待完成。');
    return this.get(id);
  }
  async upload(id: string, relativePath: string, chunks: AsyncIterable<Buffer>): Promise<TestingAssetFile> {
    const record = this.requireIdle(id);
    if (record.state !== 'UPLOADING') throw new ApiError(409, 'TEST_ASSET_FROZEN', '这份库文件已固定，请创建新版本后上传。');
    const relative = assetPath(relativePath);
    if (!/\.(?:so(?:\.[A-Za-z0-9_.+-]+)?|h|hpp|hh)$/.test(relative)) throw new ApiError(400, 'INVALID_TEST_FILE', '请选择 .so 动态库及配套头文件；压缩包请先解包。');
    if (record.files.some(file => file.path === relative)) throw new ApiError(409, 'TEST_FILE_EXISTS', '同名文件已上传，请创建新版本以替换。');
    if (record.files.length >= 256) throw new ApiError(400, 'TEST_ASSET_TOO_LARGE', '一份库包最多 256 个文件。');
    this.busy.add(id);
    const filename = path.join(this.filesRoot(id), ...relative.split('/'));
    const temporary = `${filename}.${randomUUID()}.upload`;
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      const handle = await fs.promises.open(temporary, 'wx', 0o600);
      const hash = createHash('sha256'); let bytes = 0;
      const previousBytes = record.files.reduce((sum, file) => sum + file.bytes, 0);
      try {
        for await (const chunk of chunks) {
          bytes += chunk.byteLength;
          if (bytes > 512 * 1024 * 1024 || bytes + previousBytes > 1024 * 1024 * 1024) throw new ApiError(413, 'TEST_ASSET_TOO_LARGE', '单文件最多 512 MB，整个库包最多 1 GB。');
          hash.update(chunk); let offset = 0;
          while (offset < chunk.byteLength) offset += (await handle.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
        }
      } finally { await handle.close(); }
      if (!bytes) throw new ApiError(400, 'EMPTY_TEST_FILE', '上传文件不能为空。');
      fs.renameSync(temporary, filename);
      const file = { path: relative, sha256: hash.digest('hex'), bytes };
      record.files.push(file); record.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      record.entries = record.files.filter(item => /\.so(?:\..*)?$/.test(item.path)).map(item => item.path);
      this.store.saveAsset(record); return file;
    } finally { fs.rmSync(temporary, { force: true }); this.busy.delete(id); }
  }

  async verify(id: string): Promise<TestingAsset> {
    const record = this.get(id), root = this.filesRoot(id);
    for (const file of record.files) {
      const filename = path.join(root, ...file.path.split('/'));
      const stat = await fs.promises.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ApiError(409, 'TEST_ASSET_CHANGED', '已上传文件不再是普通文件，请重新上传。');
      const actual = await identity(filename);
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new ApiError(409, 'TEST_ASSET_CHANGED', `库文件内容已变化：${file.path}，请重新上传。`);
    }
    return record;
  }
  async finalize(id: string, input: { entry_path: string }): Promise<TestingAsset> {
    const record = this.requireIdle(id);
    if (!input || typeof input.entry_path !== 'string') throw new ApiError(400, 'INVALID_TEST_ENTRY', '请选择需要测试的入口动态库。');
    const entry = assetPath(input.entry_path);
    if (!record.entries.includes(entry)) throw new ApiError(400, 'INVALID_TEST_ENTRY', '入口必须是已上传的 .so 动态库。');
    if (record.state === 'READY') {
      if (record.entry_path !== entry) throw new ApiError(409, 'TEST_ASSET_FROZEN', '这份库包已经固定了其他入口，请创建新版本。');
      return record;
    }
    this.busy.add(id);
    try {
      await this.verify(id);
      const hash = createHash('sha256').update(entry).update('\0');
      for (const file of record.files) hash.update(file.path).update('\0').update(file.sha256).update('\0');
      record.state = 'READY'; record.entry_path = entry; record.sha256 = hash.digest('hex'); record.finalized_at = new Date().toISOString();
      this.store.saveAsset(record); return record;
    } finally { this.busy.delete(id); }
  }
}
