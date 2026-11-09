import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
