import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// 1. bundle the extension with its core client code (self-contained, only
//    `vscode` stays external). No credentials/DB/evidence/archives are pulled in
//    because they are not part of the import graph.
await build({
  entryPoints: ['extensions/vscode/src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'extensions/vscode/dist/extension.js',
  external: ['vscode'],
});

// 2. package the VSIX (no publish/login/upload). vsce's out/main.js exports a
//    function expecting the full argv (commander slices argv[2:]); invoke it via
//    node -e so the .cmd shim and shell:true PATH issues are avoided.
const vsceMain = path.resolve('node_modules', '@vscode', 'vsce', 'out', 'main.js');
const r = spawnSync(
  process.execPath,
  ['-e', `require(${JSON.stringify(vsceMain)})([process.execPath, 'vsce', 'package', '--allow-missing-repository'])`],
  { cwd: path.resolve('extensions/vscode'), encoding: 'utf8', stdio: 'inherit' },
);
process.exit(r.status ?? 1);
