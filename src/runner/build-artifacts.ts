import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { RunnerBuildArtifact } from '../contracts/runner-rpc.js';

/** Inventory only library/executable outputs, never object/dependency/cache files. */
export function buildOutputInventory(root: string): Map<string, string> {
  const result = new Map<string, string>();
  function visit(directory: string) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.name === '.git' || item.name === 'CMakeFiles' || item.isSymbolicLink()) continue;
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) visit(filename);
      else if (item.isFile()) {
        const stat = fs.statSync(filename);
        if (/\.(?:so(?:\.\d+)*|a|dll|dylib|exe)$/.test(item.name) || ((stat.mode & 0o111) !== 0 && !/\.(?:sh|py|pl|rb|cmake|txt)$/.test(item.name))) {
          result.set(filename, `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
        }
      }
    }
  }
  if (fs.existsSync(root)) visit(root);
  return result;
}

export function buildArtifactRoots(sourceRoot: string, buildRoot?: string, artifactRoot?: string) {
  return [{ root: sourceRoot, prefix: buildRoot ? 'source' : '', exported: false },
    ...(buildRoot ? [{ root: buildRoot, prefix: 'build', exported: false }] : []),
    ...(artifactRoot ? [{ root: artifactRoot, prefix: 'artifacts', exported: true }] : [])];
}

export function inventoryBuildRoots(roots: ReturnType<typeof buildArtifactRoots>): Map<string, string> {
  return new Map(roots.flatMap(({ root }) => [...buildOutputInventory(root)]));
}

export async function captureBuildArtifacts(roots: ReturnType<typeof buildArtifactRoots>, outputRoot: string, before: Map<string, string>): Promise<RunnerBuildArtifact[]> {
  const exported: RunnerBuildArtifact[] = [];
  const destination = path.join(path.dirname(outputRoot), 'artifacts');
  fs.mkdirSync(destination, { recursive: true });
  // Snapshot all output locations before copying, so exported files cannot be rediscovered as new outputs.
  const after = roots.map(item => ({ ...item, files: buildOutputInventory(item.root) }));
  for (const { root, prefix, files, exported: alreadyExported } of after) for (const [filename, identity] of files) {
    if (before.get(filename) === identity) continue;
    const relative = path.join(prefix, path.relative(root, filename));
    const target = alreadyExported ? filename : path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!alreadyExported) await fs.promises.copyFile(filename, target);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
    exported.push({ relative_path: relative.split(path.sep).join('/'), source_path: filename, path: target,
      sha256: hash.digest('hex'), bytes: fs.statSync(target).size });
  }
  fs.writeFileSync(path.join(outputRoot, 'artifacts.json'), JSON.stringify(exported, null, 2) + '\n');
  return exported;
}
