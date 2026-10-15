import path from 'node:path';

export const DEFAULT_BUILD_CWD = '.';
export const DEFAULT_BUILD_TIMEOUT_MS = 600_000;

export interface ParsedBuildCommand {
  executable: string;
  args: string[];
}

export class BuildConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildConfigError';
  }
}

/** Convert a pasted shell command with line continuations to one command line. */
export function normalizeBuildCommandInput(input: string): string {
  return input
    .replace(/\\[ \t]*\r?\n[ \t]*/g, ' ')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/**
 * Parse the simple command form accepted by `/build`.
 * Shell operators are rejected deliberately; users can put complex build
 * sequences in a repository script and enter `bash scripts/build.sh`.
 */
export function parseBuildCommand(input: string): ParsedBuildCommand {
  const source = normalizeBuildCommandInput(input);
  if (!source) throw new BuildConfigError('编译命令不能为空。');

  const tokens: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;
  const push = () => {
    if (token.length > 0) {
      tokens.push(token);
      token = '';
    }
  };

  for (const char of source) {
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaping = true;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = null;
      else token += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      else token += char;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (';&|<>'.includes(char)) {
      throw new BuildConfigError('编译命令包含 shell 运算符；请将复杂命令写入源码仓库脚本后填写脚本命令。');
    }
    token += char;
  }

  if (escaping) token += '\\';
  if (quote !== null) throw new BuildConfigError('编译命令包含未闭合的引号。');
  push();
  if (tokens.length === 0) throw new BuildConfigError('编译命令不能为空。');
  return { executable: tokens[0]!, args: tokens.slice(1) };
}

/** Keep build commands rooted inside the selected source repository. */
export function validateBuildCwd(input: string): string {
  const value = input.trim() || DEFAULT_BUILD_CWD;
  const normalized = value.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    throw new BuildConfigError('执行目录必须是相对于源码根目录的路径。');
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    throw new BuildConfigError('执行目录不能越出源码根目录。');
  }
  return normalized === '.' ? '.' : normalized.replace(/\/+/g, '/').replace(/\/$/, '') || '.';
}

export function validateEnvironmentName(name: string): string {
  const value = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new BuildConfigError('环境变量名称只能包含字母、数字和下划线，且不能以数字开头。');
  }
  return value;
}

export function buildCommandDisplay(build: { executable: string; args: string[] }): string {
  return [build.executable, ...build.args].filter(Boolean).map((item) => /\s/.test(item) ? JSON.stringify(item) : item).join(' ');
}

export function buildTimeoutMinutes(timeoutMs: number): number {
  return Math.max(1, Math.round(timeoutMs / 60_000));
}
