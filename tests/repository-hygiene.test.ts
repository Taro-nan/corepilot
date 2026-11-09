import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pruneDist, staleCompiledFiles } from '../scripts/prune-dist.mjs';

function removeFixture(directory: string) {
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('corepilot-dist-')) throw new Error('Unexpected fixture cleanup path');
  fs.rmSync(target, { recursive: true, force: true });
}

test('removed source cannot survive in a rebuilt package, while current TS/TSX output and non-code assets stay intact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-dist-hygiene-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'dist'));
    for (const file of ['entry.ts', 'view.tsx']) fs.writeFileSync(path.join(root, 'src', file), '');
    for (const file of ['entry.js', 'entry.js.map', 'view.js', 'view.js.map', 'deleted.js', 'deleted.js.map', 'manifest.json']) fs.writeFileSync(path.join(root, 'dist', file), file);
    assert.deepEqual(staleCompiledFiles(root).map(file => path.basename(file)), ['deleted.js', 'deleted.js.map']);
    assert.equal(fs.existsSync(path.join(root, 'dist', 'deleted.js')), true, 'inspection must not mutate output');
    assert.equal(pruneDist(root).length, 2);
    assert.deepEqual(fs.readdirSync(path.join(root, 'dist')).sort(), ['entry.js', 'entry.js.map', 'manifest.json', 'view.js', 'view.js.map']);
    assert.equal(pruneDist(root).length, 0);
  } finally { removeFixture(root); }
});

test('build pruning refuses a linked output directory and leaves the external directory intact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-dist-link-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(root, 'outside', 'keep.js'), 'keep');
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => pruneDist(root), /linked dist directory/);
    assert.equal(fs.readFileSync(path.join(root, 'outside', 'keep.js'), 'utf8'), 'keep');
  } finally { removeFixture(root); }
});

test('repository check rejects tracked local configuration even when Git ignores it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-dist-repository-check-'));
  try {
    for (const directory of ['scripts', 'src/core', 'src/report', 'src/application', 'src/evaluator', 'src/http', 'tests', '.tmp-model-test']) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    for (const file of ['check-repository.mjs', 'prune-dist.mjs']) fs.copyFileSync(path.resolve('scripts', file), path.join(root, 'scripts', file));
    fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const fixture: Record<string, string> = {
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
      '.gitignore': '/corepilot.yaml\n/.tmp-model-test/\n/node_modules/\n',
      'src/entry.ts': "import './report/customer-summary.js'; import './application/workflow-delivery-service.js'; import './application/workflow-approval-service.js'; import './core/rpc-experiment-transition-adapter.js'; import './application/testing-results.js'; import './http/testing-routes.js';",
      'src/core/candidate-verification.ts': 'export {};',
      'src/report/customer-summary.ts': "import '../core/candidate-verification.js';",
      'src/application/workflow-delivery-service.ts': "import '../core/candidate-verification.js';",
      'src/application/workflow-approval-service.ts': "import '../evaluator/testpack-compatibility.js';",
      'src/core/rpc-experiment-transition-adapter.ts': "import '../evaluator/testpack-compatibility.js';",
      'src/application/testing-results.ts': "import '../evaluator/performance-statistics.js'; import '../evaluator/runner-artifact-path-check.js';",
      'src/evaluator/performance-statistics.ts': 'export {};',
      'src/evaluator/runner-artifact-path-check.ts': "import 'node:path';",
      'src/evaluator/testpack-compatibility.ts': 'export {};',
      'src/http/testing-routes.ts': 'export {};',
      'tests/fixture.ts': 'export {};',
      'corepilot.yaml': 'local: configuration\n',
      '.tmp-model-test/config.json': '{}',
    };
    for (const [file, content] of Object.entries(fixture)) fs.writeFileSync(path.join(root, file), content);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-f', 'corepilot.yaml', '.tmp-model-test/config.json'], { cwd: root });
    const check = () => spawnSync(process.execPath, [path.join(root, 'scripts/check-repository.mjs')], { cwd: root, encoding: 'utf8' });
    const rejected = check();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Machine-specific configuration or runtime data must not be tracked: corepilot\.yaml/);
    assert.match(rejected.stderr, /Machine-specific configuration or runtime data must not be tracked: \.tmp-model-test\/config\.json/);
    execFileSync('git', ['rm', '--cached', '-q', '--', 'corepilot.yaml', '.tmp-model-test/config.json'], { cwd: root });
    assert.equal(check().status, 0);
    assert.equal(fs.existsSync(path.join(root, 'corepilot.yaml')), true);
    assert.equal(fs.existsSync(path.join(root, '.tmp-model-test/config.json')), true);
    const pathCheck = path.join(root, 'src/evaluator/runner-artifact-path-check.ts');
    fs.writeFileSync(pathCheck, "import 'node:fs';\n");
    const impure = check();
    assert.equal(impure.status, 1);
    assert.match(impure.stderr, /Artifact identity checks must remain free of I\/O: node:fs/);
    fs.writeFileSync(pathCheck, "import 'node:path';\n");
    fs.writeFileSync(path.join(root, 'src/core/candidate-verification.ts'), 'export {};  \n<<<<<<< HEAD\n');
    const malformed = check();
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /Trailing whitespace: src\/core\/candidate-verification\.ts:1/);
    assert.match(malformed.stderr, /Unresolved merge marker: src\/core\/candidate-verification\.ts:2/);
  } finally { removeFixture(root); }
});
