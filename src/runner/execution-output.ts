import fs from 'node:fs';
import path from 'node:path';
import type { RunnerExecutionOutput } from '../contracts/runner-rpc.js';

export function executionOutput(directory: string): RunnerExecutionOutput {
  let truncated = false;
  const readTail = (filename: string) => {
    if (!fs.existsSync(filename)) return '';
    const bytes = fs.statSync(filename).size, size = Math.min(bytes, 24 * 1024);
    if (bytes > size) truncated = true;
    const handle = fs.openSync(filename, 'r');
    try { const buffer = Buffer.alloc(size); fs.readSync(handle, buffer, 0, size, bytes - size); return buffer.toString('utf8'); }
    finally { fs.closeSync(handle); }
  };
  const stdout = path.join(directory, 'stdout.log'), stderr = path.join(directory, 'stderr.log');
  return { stdout: readTail(stdout), stderr: readTail(stderr), stdout_path: stdout, stderr_path: stderr, truncated,
    artifacts: fs.existsSync(path.join(directory, 'artifacts.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'artifacts.json'), 'utf8')) : [] };
}

export function openExecutionOutput(directory: string, heading: string) {
  fs.mkdirSync(directory, { recursive: true });
  const stdout = fs.openSync(path.join(directory, 'stdout.log'), 'a');
  let stderr: number;
  try { stderr = fs.openSync(path.join(directory, 'stderr.log'), 'a'); }
  catch (error) { fs.closeSync(stdout); throw error; }
  let failure: unknown;
  const write = (fd: number, chunk: Buffer | string) => {
    if (failure) return;
    try { fs.writeSync(fd, typeof chunk === 'string' ? Buffer.from(chunk) : chunk); }
    catch (error) { failure = error; }
  };
  write(stdout, `\n${heading}\n`);
  return { onStdout: (chunk: Buffer | string) => write(stdout, chunk), onStderr: (chunk: Buffer | string) => write(stderr, chunk),
    close: () => {
      try { fs.closeSync(stdout); } finally { fs.closeSync(stderr); }
      // Report disk errors through the Experiment failure path, never throw from process data events.
      if (failure) throw failure;
    } };
}
