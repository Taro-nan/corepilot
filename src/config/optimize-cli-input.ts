import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

/** `phyopt optimize` 的用户输入；源码范围仍由 Agent 在整个仓库内调查。 */
export interface OptimizeCliInput {
  configPath: string;
  /** CLI 调用目录对应的算法库根目录；这是内部派生值，不是用户参数。 */
  repositoryRoot: string;
  functionName: string;
  entryFile: string | null;
  apiKey: string | undefined;
  enablePerformance: boolean;
}

/** 已有仓库使用其 Git 根；普通源码目录交给后续工作区层初始化 Git。 */
export function resolveOptimizationRepository(cwd = process.cwd()): string {
  const absolute = path.resolve(cwd);
  const probe = spawnSync('git', ['-C', absolute, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const topLevel = probe.status === 0 ? (probe.stdout ?? '').trim() : '';
  return topLevel ? path.resolve(topLevel) : absolute;
}

export class OptimizeCliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimizeCliInputError';
  }
}

/**
 * 解析公开 optimize 命令。
 *
 * 不接受位置参数：`--file` 是调查入口，不是修改范围；因此不能把一组
 * 位置文件误解为“允许修改的文件清单”。
 */
export function parseOptimizeCliInput(args: readonly string[], cwd = process.cwd()): OptimizeCliInput {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        config: { type: 'string' },
        function: { type: 'string' },
        file: { type: 'string' },
        'api-key': { type: 'string' },
        performance: { type: 'boolean' },
        'no-performance': { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    throw new OptimizeCliInputError((error as Error).message);
  }

  const config = parsed.values.config;
  if (typeof config !== 'string' || config.trim().length === 0) {
    throw new OptimizeCliInputError("optimize requires '--config <path>'");
  }
  const functionName = parsed.values.function;
  if (typeof functionName !== 'string' || functionName.trim().length === 0) {
    throw new OptimizeCliInputError("optimize requires '--function <name>'");
  }
  const entry = parsed.values.file;
  if (entry !== undefined && (typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new OptimizeCliInputError("'--file' must be a non-empty path when present");
  }

  const entryFile = typeof entry === 'string' ? entry.trim().split(path.sep).join('/') : null;
  if (parsed.values.performance === true && parsed.values['no-performance'] === true) {
    throw new OptimizeCliInputError("'--performance' and '--no-performance' cannot be used together");
  }
  return {
    configPath: path.resolve(cwd, config.trim()),
    repositoryRoot: resolveOptimizationRepository(cwd),
    functionName: functionName.trim(),
    entryFile,
    apiKey: typeof parsed.values['api-key'] === 'string' ? parsed.values['api-key'] : undefined,
    enablePerformance: parsed.values.performance === true,
  };
}

export function renderOptimizeCliHelp(): string {
  return [
    '用法：',
    '  corepilot optimize --config <path> --function <name> [--file <entry-file>] [--performance] [--api-key <key>]',
    '',
    '说明：--file 只是 Agent 调查入口，不限制整个算法库的读取或修改范围。',
  ].join('\n');
}
