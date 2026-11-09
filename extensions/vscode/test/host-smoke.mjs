import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

if (process.platform !== 'win32') {
  console.log('SKIPPED: VSIX Extension Host validation requires the Windows isolated-desktop runner; this platform was not tested.');
  process.exit(0);
}
const codeCommand = process.env.COREPILOT_VSCODE_PATH ?? execFileSync('where.exe', ['code'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0];
const code = codeCommand.toLowerCase().endsWith('.exe') ? codeCommand : path.join(path.dirname(path.dirname(codeCommand)), 'Code.exe');
assert.ok(fs.existsSync(code), 'VS Code executable not found; set COREPILOT_VSCODE_PATH');
const extensionDir = path.resolve('extensions/vscode');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));
const vsix = path.join(extensionDir, `${manifest.name}-${manifest.version}.vsix`);
assert.ok(fs.existsSync(vsix), 'Build the VSIX before running the Extension Host smoke test');
const tempParent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempParent, 'corepilot-vscode-host-'));
try {
  const userData = path.join(root, 'user-data'), extensions = path.join(root, 'extensions'), workspace = path.join(root, 'workspace');
  const extract = path.join(root, 'package'), installed = path.join(extensions, `${manifest.publisher}.${manifest.name}-${manifest.version}`);
  const tests = path.join(root, 'host-runner.cjs'), resultFile = path.join(root, 'result.json');
  for (const dir of [path.join(userData, 'User'), extensions, workspace, extract]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'corepilot.serverUrl': 'http://127.0.0.1:1', 'workbench.startupEditor': 'none' }));
  execFileSync('python', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', vsix, extract], { windowsHide: true });
  fs.cpSync(path.join(extract, 'extension'), installed, { recursive: true });
  await build({ entryPoints: [path.join(extensionDir, 'test', 'host-runner.ts')], outfile: tests, bundle: true,
    platform: 'node', format: 'cjs', external: ['vscode'] });
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(extensionDir, 'test', 'host-hidden.ps1'),
    '-CodePath', code, '-ExtensionPath', installed, '-TestsPath', tests, '-UserData', userData,
    '-ExtensionsDir', extensions, '-Workspace', workspace, '-ResultFile', resultFile],
  { windowsHide: true, encoding: 'utf8', timeout: 80000, stdio: 'pipe' });
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.ok, true, result.error); assert.equal(result.version, manifest.version); assert.equal(result.commands, 14);
  console.log(`Isolated VSIX Extension Host OK: ${result.commands} commands, version ${result.version}`);
} finally {
  const realRoot = fs.realpathSync(root);
  if (path.dirname(realRoot) !== tempParent || !path.basename(realRoot).startsWith('corepilot-vscode-host-')) throw new Error('Unsafe temporary test path');
  fs.rmSync(realRoot, { recursive: true, force: true });
}
