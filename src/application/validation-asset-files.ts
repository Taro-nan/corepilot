import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { evaluatorContentSha256 } from '../evaluator/formal-evaluator.js';

const execute = promisify(execFile);

/** Historical test versions live outside the mutable evaluator/catalog root. */
export function snapshotValidationAssets(root: string, destination: string, digest: string): string {
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(root, destination, { recursive: true, errorOnExist: true, force: false });
  }
  if (evaluatorContentSha256(destination) !== digest) throw new Error('测试方案快照与内容版本不一致');
  return destination;
}

export function validationAssetFiles(root: string) {
  const paths = ['scripts/build-evaluator.sh', 'scripts/run-correctness.sh', 'scripts/run-performance.sh', 'test-plan.json',
    'correctness/cases.json', 'correctness/input-generation.json', 'correctness/quality-plan.json', 'benchmark/workloads.json', 'benchmark/input-generation.json'];
  if (fs.existsSync(path.join(root, 'supporting-files.json'))) paths.push(...JSON.parse(fs.readFileSync(path.join(root, 'supporting-files.json'), 'utf8')) as string[]);
  return { evaluator_digest: evaluatorContentSha256(root), files: paths.filter(relative => fs.existsSync(path.join(root, relative)))
    .map(relative => ({ path: relative, content: fs.readFileSync(path.join(root, relative), 'utf8') })) };
}

export async function archiveValidationAssets(root: string, context: unknown = null): Promise<Buffer> {
  if (!fs.existsSync(path.join(root, 'manifest.json'))) throw new Error('测试方案版本不存在');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-test-download-'));
  try {
    const filename = path.join(temp, 'test-package.tar.gz');
    const packageRoot = path.join(temp, 'package');
    fs.mkdirSync(packageRoot);
    fs.cpSync(root, path.join(packageRoot, 'evaluator'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'context.json'), JSON.stringify({ evaluator_digest: evaluatorContentSha256(root), context }, null, 2) + '\n');
    await execute('tar', ['-czf', filename, '-C', packageRoot, '.'], { windowsHide: true, timeout: 30_000 });
    return fs.readFileSync(filename);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
