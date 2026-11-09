import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { resolveOptimizationBudget, type OptimizationSessionBudget } from '../contracts/optimization-session.js';
import { parseSourceScope } from '../contracts/source-scope.js';
import type { CandidateSourceScope } from '../contracts/library-package.js';

/** `corepilot optimize` 的用户输入；源码范围仍由 Agent 在整个仓库内调查。 */
export interface OptimizeCliInput {
  verificationMode?: 'source_only';
  budget?: OptimizationSessionBudget;
  configPath: string;
  /** CLI 调用目录对应的算法库根目录；这是内部派生值，不是用户参数。 */
  repositoryRoot: string;
  functionName: string;
  entryFile: string | null;
  candidateScope?: CandidateSourceScope;
  apiKey: string | undefined;
  enablePerformance: boolean;
  watch: boolean;
  reportOutput?: string;
  projectId?: string;
  sourceBranch?: string;
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
        'budget-minutes': { type: 'string' },
        'max-candidates': { type: 'string' },
        performance: { type: 'boolean' },
        'source-only': { type: 'boolean' },
        allow: { type: 'string', multiple: true },
        exclude: { type: 'string', multiple: true },
        'no-performance': { type: 'boolean' },
        watch: { type: 'boolean' },
        output: { type: 'string' },
        project: { type: 'string' },
        branch: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    throw new OptimizeCliInputError((error as Error).message);
  }

  const config = parsed.values.config;
  const branch = parsed.values.branch;
  if (branch !== undefined && (typeof branch !== 'string' || !branch.trim())) throw new OptimizeCliInputError("'--branch' must be a non-empty local Git branch");
  const project = parsed.values.project;
  const remoteProject = typeof project === 'string' && project.trim().length > 0;
  if (project !== undefined && !remoteProject) throw new OptimizeCliInputError("'--project' must be a non-empty project ID");
  if (remoteProject && config !== undefined) throw new OptimizeCliInputError("'--project' and '--config' cannot be used together");
  if (!remoteProject && (typeof config !== 'string' || config.trim().length === 0)) {
    throw new OptimizeCliInputError("optimize requires '--config <path>'");
  }
  const functionName = parsed.values.function;
  if (!remoteProject && (typeof functionName !== 'string' || functionName.trim().length === 0)) {
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
  if (parsed.values['source-only'] && parsed.values.performance) throw new OptimizeCliInputError('--source-only 不能与 --performance 同时使用。仅源码优化不执行测试。');
  let candidateScope: CandidateSourceScope | undefined;
  if (parsed.values.allow !== undefined || parsed.values.exclude !== undefined || parsed.values['source-only']) {
    if (!parsed.values['source-only']) throw new OptimizeCliInputError('--allow/--exclude 仅用于 --source-only；正式优化的修改范围由测试方案确定。');
    try { candidateScope = parseSourceScope({ include: parsed.values.allow ?? [], exclude: parsed.values.exclude ?? [] }); }
    catch (error) { throw new OptimizeCliInputError(`${(error as Error).message} 请使用 --allow <文件或目录/> 指定允许修改的范围。`); }
  }
  const output = parsed.values.output;
  let budget: OptimizationSessionBudget | undefined;
  if (parsed.values['budget-minutes'] !== undefined || parsed.values['max-candidates'] !== undefined) {
    try { budget = resolveOptimizationBudget({
      ...(parsed.values['budget-minutes'] === undefined ? {} : { time_limit_ms: Math.round(Number(parsed.values['budget-minutes']) * 60_000) }),
      ...(parsed.values['max-candidates'] === undefined ? {} : { max_candidates: Number(parsed.values['max-candidates']) }),
    }); } catch (error) { throw new OptimizeCliInputError((error as Error).message); }
  }
  if (output !== undefined && (typeof output !== 'string' || !output.trim() || !parsed.values.watch)) throw new OptimizeCliInputError('--output requires --watch and a non-empty directory');
  return {
    ...(parsed.values['source-only'] ? { verificationMode: 'source_only' as const } : {}),
    ...(budget ? { budget } : {}),
    configPath: path.resolve(cwd, typeof config === 'string' ? config.trim() : 'corepilot.yaml'),
    repositoryRoot: remoteProject ? path.resolve(cwd) : resolveOptimizationRepository(cwd),
    functionName: typeof functionName === 'string' ? functionName.trim() : '',
    entryFile,
    ...(candidateScope ? { candidateScope } : {}),
    apiKey: typeof parsed.values['api-key'] === 'string' ? parsed.values['api-key'] : undefined,
    enablePerformance: parsed.values.performance === true,
    watch: parsed.values.watch === true,
    ...(typeof branch === 'string' ? { sourceBranch: branch.trim() } : {}),
    ...(typeof output === 'string' ? { reportOutput: path.resolve(cwd, output) } : {}),
    ...(remoteProject ? { projectId: (project as string).trim() } : {}),
  };
}

export function renderOptimizeCliHelp(): string {
  return [
    '用法：',
    '  corepilot optimize --config <path> --function <name> [--file <entry-file>] [--performance] [--api-key <key>]',
    '  corepilot optimize --project <id> [--function <name>] [--performance] [--watch]',
    '  探索预算：[--budget-minutes <分钟>] [--max-candidates <候选数>]；默认 60 分钟 / 8 个候选，可继续原会话。',
    '',
    '说明：--source-only --allow <文件或目录/> 仅生成优化代码；可重复 --allow 和 --exclude。',
    '--file 只是调查入口；修改范围须使用 --allow 明确授权。正确性与性能未验证。',
  ].join('\n');
}
