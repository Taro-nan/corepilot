import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunnerBundleInspection, RunnerBundleInspectionRequest } from '../contracts/baseline-bundle.js';
import { probeRunnerMachine } from './machine-probe.js';

const execute = promisify(execFile);

export function bundleRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!/^[A-Za-z0-9_./+-]+$/.test(normalized) || normalized.startsWith('/') ||
      normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`invalid bundle file path: ${value}`);
  }
  return normalized;
}

function inside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function sha256(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function output(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ text: string; failed: boolean }> {
  try {
    const result = await execute(command, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...env, LC_ALL: 'C' } });
    return { text: result.stdout + result.stderr, failed: false };
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    return { text: (failed.stdout ?? '') + (failed.stderr ?? '') || failed.message, failed: true };
  }
}

/** Runner reads the exact staged bytes and checks ELF dependencies on its own host. */
export async function inspectRunnerBaselineBundle(input: RunnerBundleInspectionRequest, workspaceRoot: string): Promise<RunnerBundleInspection> {
  if (process.platform !== 'linux') throw new Error('binary bundle inspection requires a Linux Runner');
  const allowedRoot = fs.realpathSync(workspaceRoot);
  const root = fs.realpathSync(input.bundle_root);
  if (!inside(allowedRoot, root)) throw new Error('bundle root must stay inside the Runner workspace');
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 256) throw new Error('bundle requires 1..256 files');
  const entryPath = bundleRelativePath(input.entry_path);
  const seen = new Set<string>();
  const files = new Map<string, { filename: string; sha256: string }>();
  for (const file of input.files) {
    const relative = bundleRelativePath(file.path);
    if (seen.has(relative)) throw new Error(`duplicate bundle path: ${relative}`);
    seen.add(relative);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1) throw new Error(`invalid file identity: ${relative}`);
    const filename = path.resolve(root, ...relative.split('/'));
    if (!inside(root, filename) || fs.lstatSync(filename).isSymbolicLink() || !fs.statSync(filename).isFile() ||
        !inside(root, fs.realpathSync(filename))) throw new Error(`bundle file is not a regular contained file: ${relative}`);
    if (fs.statSync(filename).size !== file.bytes || await sha256(filename) !== file.sha256) throw new Error(`staged bundle file differs from upload: ${relative}`);
    files.set(relative, { filename, sha256: file.sha256 });
  }
  if (!files.has(entryPath) || !/\.so(?:\..*)?$/.test(entryPath)) throw new Error('entry_path must select an uploaded shared library');
  const issues: string[] = [];
  const libraryFiles = [...files].filter(([relative]) => /\.so(?:\..*)?$/.test(relative));
  const parsed: RunnerBundleInspection['libraries'] = [];
  for (const [relative, file] of libraryFiles) {
    const [header, dynamic, notes] = await Promise.all([
      output('readelf', ['-h', file.filename]), output('readelf', ['-d', file.filename]), output('readelf', ['-n', file.filename]),
    ]);
    if (header.failed || dynamic.failed) {
      issues.push(`${relative}: readelf 无法读取 ELF 信息：${(header.failed ? header.text : dynamic.text).trim().slice(0, 300)}`);
      continue;
    }
    const elf = {
      class: header.text.match(/^\s*Class:\s*(.+)$/m)?.[1]?.trim() ?? 'UNKNOWN',
      endian: header.text.match(/^\s*Data:\s*(.+)$/m)?.[1]?.trim() ?? 'UNKNOWN',
      machine: header.text.match(/^\s*Machine:\s*(.+)$/m)?.[1]?.trim() ?? 'UNKNOWN',
      build_id: notes.text.match(/Build ID:\s*([a-fA-F0-9]+)/)?.[1]?.toLowerCase() ?? 'unknown',
    };
    if (elf.class !== 'ELF64' || !elf.machine.toLowerCase().includes(process.arch === 'arm64' ? 'aarch64' : 'x86-64')) {
      issues.push(`${relative}: ELF 架构 ${elf.class}/${elf.machine} 与 Runner ${process.arch} 不匹配`);
    }
    const soname = dynamic.text.match(/\(SONAME\).*\[([^\]]+)\]/)?.[1] ?? path.posix.basename(relative);
    const needed = [...dynamic.text.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(match => match[1]);
    parsed.push({ path: relative, sha256: file.sha256, soname, elf,
      needed: needed.map(name => ({ soname: name, classification: 'MISSING_DEPENDENCY' as const })) });
  }
  const sonames = new Set(parsed.map(item => item.soname));
  const bundledBySoname = new Map(parsed.map(item => [item.soname, item]));
  for (const library of parsed) {
    if (bundledBySoname.get(library.soname)?.sha256 !== library.sha256) {
      issues.push(`${library.soname}: 上传包中同名的库内容不一致，请保留所需版本`);
    }
  }
  const searchPaths = [...new Set(libraryFiles.map(([, file]) => path.dirname(file.filename)))];
  const env = { ...process.env, LD_LIBRARY_PATH: searchPaths.join(':') };
  const resolved = new Map<string, { soname: string; path: string; sha256: string }>();
  for (const library of parsed) {
    const checked = await output('ldd', ['-r', files.get(library.path)!.filename], env);
    for (const match of checked.text.matchAll(/^\s*(\S+)\s+=>\s+(\/\S+)\s+\(/gm)) {
      const filename = fs.realpathSync(match[2]);
      resolved.set(match[1], { soname: match[1], path: filename, sha256: await sha256(filename) });
    }
    // The ELF interpreter is printed by ldd as an absolute path without an '=>' column.
    for (const match of checked.text.matchAll(/^\s*(\/\S+)\s+\(/gm)) {
      const filename = fs.realpathSync(match[1]);
      const soname = path.basename(match[1]);
      resolved.set(soname, { soname, path: filename, sha256: await sha256(filename) });
    }
    for (const match of checked.text.matchAll(/^\s*(\S+)\s+=>\s+not found/mg)) issues.push(`${library.path}: 缺少依赖 ${match[1]}`);
    for (const match of checked.text.matchAll(/undefined symbol:\s*([^\s]+)/g)) issues.push(`${library.path}: 未解析符号 ${match[1]}`);
    if (checked.failed && !/not found|undefined symbol/i.test(checked.text)) issues.push(`${library.path}: ldd 检查失败：${checked.text.trim().slice(-300)}`);
    for (const dependency of library.needed) {
      dependency.classification = sonames.has(dependency.soname) ? 'BUNDLED_DEPENDENCY'
        : resolved.has(dependency.soname) ? 'SYSTEM_DEPENDENCY' : 'MISSING_DEPENDENCY';
      if (dependency.classification === 'MISSING_DEPENDENCY') issues.push(`${library.path}: 缺少依赖 ${dependency.soname}`);
      if (dependency.classification === 'BUNDLED_DEPENDENCY' &&
          resolved.get(dependency.soname)?.sha256 !== bundledBySoname.get(dependency.soname)?.sha256) {
        issues.push(`${library.path}: ${dependency.soname} 未从上传的比较包加载`);
      }
    }
  }
  for (const library of parsed) resolved.set(library.soname, {
    soname: library.soname, path: files.get(library.path)!.filename, sha256: library.sha256,
  });
  return { ok: issues.length === 0 && parsed.some(item => item.path === entryPath),
    machine_identity_sha256: probeRunnerMachine().machine_identity_sha256, checked_at: new Date().toISOString(),
    entry_sha256: files.get(entryPath)!.sha256, libraries: parsed,
    resolved_libraries: [...resolved.values()].sort((a, b) => a.soname.localeCompare(b.soname)), issues: [...new Set(issues)] };
}
