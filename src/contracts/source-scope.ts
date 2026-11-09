import type { CandidateSourceScope } from './library-package.js';

/** Runtime and Git metadata are never candidate source, even in nested repositories. */
export function isProtectedWorkspacePath(filename: string): boolean {
  return filename.replace(/\\/g, '/').split('/').some(part => ['.git', '.corepilot', 'node_modules'].includes(part.toLowerCase()));
}

/** Parse a user-selected scope. A trailing slash grants the directory's descendants. */
export function parseSourceScope(value: unknown): CandidateSourceScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请选择允许修改的源码文件或目录。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'include' && key !== 'exclude')) throw new Error('源码修改范围包含未知字段。');
  const entries = (value: unknown, field: string, required: boolean): string[] => {
    if (!Array.isArray(value) || value.length > 64 || required && !value.length) throw new Error(`${field} 需要 1–64 个仓库相对路径。`);
    const paths = value.map(item => {
      if (typeof item !== 'string' || !item.trim() || item.length > 1024) throw new Error(`${field} 包含无效路径。`);
      const normalized = item.trim().replace(/\\/g, '/');
      const parts = normalized.replace(/\/$/, '').split('/');
      if (normalized.startsWith('/') || /[:*?\0]/.test(normalized) || parts.some(part => !part || part === '.' || part === '..') ||
          isProtectedWorkspacePath(normalized) || ['packages', 'evaluators'].includes(parts[0].toLowerCase())) {
        throw new Error(`${field} 路径必须是允许的仓库相对文件或目录：${item}`);
      }
      return normalized;
    });
    return [...new Set(paths)].sort();
  };
  return { include: entries(input.include, '允许修改', true), exclude: entries(input.exclude ?? [], '排除', false) };
}
