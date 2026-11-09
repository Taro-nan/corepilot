import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerToolchain } from '../contracts/build-planning.js';

const execute = promisify(execFile);
/** Read-only capability observations; no build or experiment is performed. */
export async function probeRunnerToolchain(runnerId: string): Promise<RunnerToolchain> {
  const names = ['cmake', 'gcc', 'g++', 'clang', 'clang++', 'make', 'ninja', 'meson', 'cargo', 'rustc', 'go', 'python3', 'bash'];
  const entries = await Promise.all(names.map(async name => {
    try {
      const { stdout, stderr } = await execute(name, [name === 'go' ? 'version' : '--version'], { windowsHide: true, timeout: 3000, maxBuffer: 32768 });
      return [name, { status: 'AVAILABLE' as const, version: (stdout || stderr).split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 300) ?? null }] as const;
    } catch (error) {
      return [name, { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' as const : 'ERROR' as const, version: null }] as const;
    }
  }));
  return { runner_id: runnerId, checked_at: new Date().toISOString(), architecture: os.arch(), platform: os.platform(),
    available_parallelism: os.availableParallelism(), cpu_count: os.cpus().length, memory_total_bytes: os.totalmem(), tools: Object.fromEntries(entries) };
}
