import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OptimizationReportResponse } from '../contracts/optimization-report.js';

/** Reports contain both human-readable analysis and the complete structured snapshot. */
export async function writeOptimizationReport(directory: string, response: OptimizationReportResponse): Promise<{ markdown: string; json: string }> {
  const root = path.resolve(directory);
  await fs.mkdir(root, { recursive: true });
  const files = { markdown: path.join(root, 'report.md'), json: path.join(root, 'report.json') };
  for (const [destination, content] of [[files.markdown, response.markdown], [files.json, JSON.stringify(response.report, null, 2) + '\n']]) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  return files;
}
