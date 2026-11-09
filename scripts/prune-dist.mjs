import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** tsc leaves outputs behind when their source is deleted or renamed. */
export function staleCompiledFiles(projectRoot) {
  const sourceRoot = path.resolve(projectRoot, 'src');
  const outputRoot = path.resolve(projectRoot, 'dist');
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) throw new Error('Source directory is missing');
  if (!fs.existsSync(outputRoot)) return [];
  if (fs.lstatSync(outputRoot).isSymbolicLink()) throw new Error('Refusing to prune a linked dist directory');
  const stale = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(filename); continue; }
      if (!entry.isFile() || !/\.js(?:\.map)?$/.test(entry.name)) continue;
      const stem = path.relative(outputRoot, filename).replace(/\.js(?:\.map)?$/, '');
      if (!fs.existsSync(path.join(sourceRoot, `${stem}.ts`)) && !fs.existsSync(path.join(sourceRoot, `${stem}.tsx`))) stale.push(filename);
    }
  }
  visit(outputRoot);
  return stale.sort();
}

export function pruneDist(projectRoot) {
  const outputRoot = path.resolve(projectRoot, 'dist');
  const files = staleCompiledFiles(projectRoot);
  for (const filename of files) {
    const relative = path.relative(outputRoot, filename);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Invalid dist path: ${filename}`);
    fs.unlinkSync(filename);
  }
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const removed = pruneDist(path.resolve(import.meta.dirname, '..'));
  console.log(`[build] removed ${removed.length} obsolete compiled files`);
}
