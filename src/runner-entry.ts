#!/usr/bin/env node
import path from 'node:path';
import { inspectFormalEvaluatorBundle } from './evaluator/formal-evaluator.js';
import { startRunnerHttpServer } from './runner/http-server.js';

interface RunnerCliOptions {
  host: string;
  port: number;
  dbPath: string;
  workspaceRoot: string;
  token: string;
  runnerId?: string;
  resourceEnforcement: 'DISABLED' | 'REQUIRED';
  allowTargetValidatedDigest?: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'qualify-evaluator') {
    runEvaluatorQualification(args.slice(1));
    return;
  }
  const parsed = parseArgs(args);
  if (parsed === null) {
    process.stdout.write('Usage: corepilot-runner [--host 127.0.0.1] [--port 4327] [--db .phyopt/runner.sqlite] [--workspace-root <dir>] [--runner-id <id>] [--token <secret>] [--resource-enforcement disabled|required] [--allow-target-validated-digest <sha256>]\n       corepilot-runner qualify-evaluator --bundle <directory>\n');
    return;
  }
  const server = await startRunnerHttpServer(parsed);
  process.stdout.write(`corepilot-runner ${server.runnerId} listening on ${server.url}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().then(() => { process.exitCode = 0; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function runEvaluatorQualification(args: string[]): void {
  if (args.length !== 2 || args[0] !== '--bundle' || !args[1]) {
    throw new Error('usage: corepilot-runner qualify-evaluator --bundle <directory>');
  }
  const result = inspectFormalEvaluatorBundle(path.resolve(args[1]));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.checks.some((item) => item.scope === 'STATIC' && item.status === 'FAIL')) process.exitCode = 2;
}

function parseArgs(args: string[]): RunnerCliOptions | null {
  if (args.includes('--help') || args.includes('-h')) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid runner argument '${key ?? ''}'`);
    values.set(key, value);
  }
  const port = Number(values.get('--port') ?? '4327');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer in 0..65535');
  const token = values.get('--token') ?? process.env.PHYOPT_RUNNER_TOKEN ?? '';
  if (!token) throw new Error('set PHYOPT_RUNNER_TOKEN or pass --token');
  const resourceValue = values.get('--resource-enforcement') ?? 'disabled';
  if (resourceValue !== 'disabled' && resourceValue !== 'required') throw new Error('--resource-enforcement must be disabled or required');
  const allowTargetValidatedDigest = values.get('--allow-target-validated-digest');
  if (allowTargetValidatedDigest !== undefined && !/^[0-9a-f]{64}$/i.test(allowTargetValidatedDigest)) {
    throw new Error('--allow-target-validated-digest must be a SHA-256 digest');
  }
  const known = new Set(['--host', '--port', '--db', '--workspace-root', '--runner-id', '--token', '--resource-enforcement', '--allow-target-validated-digest']);
  for (const key of values.keys()) if (!known.has(key)) throw new Error(`unknown runner argument '${key}'`);
  return {
    host: values.get('--host') ?? '127.0.0.1',
    port,
    dbPath: path.resolve(values.get('--db') ?? '.phyopt/runner.sqlite'),
    workspaceRoot: path.resolve(values.get('--workspace-root') ?? process.cwd()),
    token,
    resourceEnforcement: resourceValue === 'required' ? 'REQUIRED' : 'DISABLED',
    ...(values.get('--runner-id') ? { runnerId: values.get('--runner-id') } : {}),
    ...(allowTargetValidatedDigest ? { allowTargetValidatedDigest: allowTargetValidatedDigest.toLowerCase() } : {}),
  };
}

void main().catch((error: unknown) => {
  process.stderr.write(`corepilot-runner: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
