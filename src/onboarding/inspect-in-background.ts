import { Worker } from 'node:worker_threads';
import type { RepositoryInspection } from './repository-inspector.js';

/** Keep synchronous Git/file inspection and symbol indexing off the Control event loop. */
export async function inspectInBackground(repositoryRoot: string): Promise<RepositoryInspection> {
  const moduleUrl = new URL(import.meta.url.endsWith('.ts') ? './repository-inspector.ts' : './repository-inspector.js', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.moduleUrl).then(({ RepositoryInspector }) => {
      const inspector = new RepositoryInspector(workerData.repositoryRoot);
      const inspection = inspector.inspect();
      inspector.assertUnchanged();
      parentPort.postMessage(inspection);
    }).catch(error => { throw error; });
  `, { eval: true, workerData: { moduleUrl, repositoryRoot } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<RepositoryInspection>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('源码识别超过两分钟，请缩小源码目录范围后重试。')), 120000);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`源码识别进程提前结束（${code}），请重新识别。`)));
    });
  } finally { clearTimeout(timer); await worker.terminate(); }
}
