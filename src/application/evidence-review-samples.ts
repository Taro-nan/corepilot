import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Experiment, Measurement } from '../contracts/optimization-domain.js';
import type { ValidationTestpack } from '../contracts/validation-testpack.js';
import { inspectVerifiedEvidenceArchive } from '../workspace/frozen-evidence.js';
import { writeNewPrivateFile } from '../workspace/private-output.js';
import { recalculateEvidenceStatistics } from './evidence-statistics-recalculation.js';
import { createReviewSamples, verifyReviewSamplesBytes } from './review-samples.js';
import { assertPerformanceEvidenceConsistent } from './workflow-evidence-performance.js';

const MAX_BYTES = 16 * 1024 * 1024;
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const notice = '仅供人工审阅；数值仍可能敏感。核验不证明来源、转换真实性、真机执行、正确性、环境、批准或交付。';

function readFileBounded(filename: string): Buffer {
  const fd = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('待审阅包不是普通文件或超过 16 MiB 上限。');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('待审阅包读取时发生变化。');
      offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length)) throw new Error('待审阅包读取时发生变化。');
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** The original archive is read and verified once; no contents from it are executed or published. */
export function exportReviewSamples(archivePath: string, trustedSha256: string, outputPath: string) {
  let archive: ReturnType<typeof inspectVerifiedEvidenceArchive>;
  try { archive = inspectVerifiedEvidenceArchive(archivePath, trustedSha256, {}, true); }
  catch { throw new Error('无法核验原冻结包；请检查文件、可信 SHA-256 与离线大小限制。'); }
  const { selected, records } = archive;
  const check = recalculateEvidenceStatistics(selected, records);
  if (check.status !== 'MATCH' || check.formal?.status !== 'MATCH' || check.revalidation?.status !== 'MATCH') {
    throw new Error(`原冻结包两轮未能完成统计核对（${check.status}）；未生成待审阅包。当前仅支持两轮性能均通过的批准准备冻结包。`);
  }
  let document: ReturnType<typeof createReviewSamples>;
  try {
    const testpack = (JSON.parse(selected.get('testpack.json')!.toString('utf8')) as { testpack: ValidationTestpack }).testpack;
    const calculateRound = (name: 'formal' | 'revalidation') => assertPerformanceEvidenceConsistent(records[name] as unknown as Experiment,
      JSON.parse(selected.get(`${name}/measurements.json`)!.toString('utf8')) as Measurement[], testpack);
    document = createReviewSamples(testpack, calculateRound('formal'), calculateRound('revalidation'));
  } catch { throw new Error('原始样本无法按白名单投影或与两轮统计一致；未生成待审阅包。'); }
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  if (bytes.length > MAX_BYTES) throw new Error('待审阅包超过 16 MiB 上限；未生成文件。');
  writeNewPrivateFile(outputPath, bytes);
  return { format: document.format, review: document.review, sha256: digest(bytes), notice };
}

/** A separately obtained expected hash authenticates bytes only, not the claimed origin. */
export function verifyReviewSamples(filename: string, trustedSha256: string) {
  if (!/^[0-9a-f]{64}$/i.test(trustedSha256)) throw new Error('必须提供通过可信渠道取得的待审阅包 SHA-256。');
  let bytes: Buffer;
  try { bytes = readFileBounded(filename); }
  catch { throw new Error('无法读取待审阅包；请检查文件及 16 MiB 大小限制。'); }
  const sha256 = digest(bytes);
  if (sha256 !== trustedSha256.toLowerCase()) throw new Error('待审阅包 SHA-256 不匹配。');
  const result = verifyReviewSamplesBytes(bytes);
  return { format: result.format, review: result.review, sha256, formal: result.formal.result,
    revalidation: result.revalidation.result, notice };
}
