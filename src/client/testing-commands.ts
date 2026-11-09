import fs from 'node:fs';
import { parseArgs } from 'node:util';
import type { CreateTestingTask, TestingPlanRef } from '../contracts/testing.js';
import { ApiClient } from './api-client.js';
import { uploadTestingAsset } from './upload-testing-asset.js';

const usage = [
  'corepilot test list | status <id> | cancel <id>',
  'corepilot test start --file <测试请求.json> [--request-id <幂等标识>]',
  'corepilot test plan --file <测试方案引用.json>',
  'corepilot test assets | import --directory <解压目录> --entry <相对入口> --name <库名> [--version <版本>]',
  '测试请求固定两端、机器和方案；测试不创建优化候选、批准或交付。',
].join('\n');

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请提供 --${name}。`);
  return value;
}

/** CLI parses input only; all execution and result semantics live behind the shared API. */
export async function executeTestingCommand(args: string[], options: { baseUrl: string; token?: string }): Promise<{ value: unknown; exitCode: number }> {
  const [action, ...rest] = args;
  if (!action || action === '--help' || action === '-h') return { value: usage, exitCode: 0 };
  const parsed = parseArgs({ args: rest, options: { file: { type: 'string' }, 'request-id': { type: 'string' },
    directory: { type: 'string' }, entry: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' }, json: { type: 'boolean' } },
    strict: true, allowPositionals: true });
  const api = new ApiClient(options.baseUrl, { token: options.token });
  const noArguments = () => { if (parsed.positionals.length) throw new Error(usage); };
  if (action === 'list' || action === 'assets') { noArguments(); return { value: action === 'list' ? await api.testing.list() : await api.testing.listAssets(), exitCode: 0 }; }
  if (action === 'status' || action === 'cancel') {
    if (parsed.positionals.length !== 1) throw new Error(usage);
    return { value: action === 'status' ? await api.testing.get(parsed.positionals[0]) : await api.testing.cancel(parsed.positionals[0]), exitCode: 0 };
  }
  noArguments();
  if (action === 'import') {
    return { value: { asset: await uploadTestingAsset(options.baseUrl, { directory: requireText(parsed.values.directory, 'directory'),
      entry: requireText(parsed.values.entry, 'entry'), name: requireText(parsed.values.name, 'name'),
      ...(typeof parsed.values.version === 'string' ? { version: parsed.values.version } : {}) }, options.token) }, exitCode: 0 };
  }
  if (action === 'start' || action === 'plan') {
    const input: unknown = JSON.parse(fs.readFileSync(requireText(parsed.values.file, 'file'), 'utf8'));
    return { value: action === 'start' ? await api.testing.start(input as CreateTestingTask, typeof parsed.values['request-id'] === 'string' ? parsed.values['request-id'] : undefined)
      : await api.testing.preview(input as TestingPlanRef), exitCode: 0 };
  }
  throw new Error(usage);
}
