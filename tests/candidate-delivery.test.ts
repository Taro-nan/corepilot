import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runFixtureDelivery } from './delivery-git-fixture.js';
import { checkpointCandidate, createCandidateWorkspace } from '../src/workspace/candidate-workspace.js';

function fixture(addFile = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-delivery-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(r.status, 0, r.error?.message ?? r.stderr); return r.stdout.trim();
  };
  git('init', '--initial-branch=main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.quotePath', 'true');
  for (const filename of ['kernel.c', 'staged.c', 'unstaged.c']) fs.writeFileSync(path.join(repo, filename), 'int kernel(void) { return 1; }\n');
  git('add', '.'); git('commit', '-m', 'baseline');
  const baseline = git('rev-parse', 'HEAD');
  const workspace = createCandidateWorkspace({ repository: repo, worktreeRoot: path.join(root, 'worktrees'), runId: 'candidate', baselineCommit: baseline, sourceBranch: 'main' });
  fs.writeFileSync(path.join(workspace.editing, 'kernel.c'), 'int kernel(void) { return 2; }\n');
  if (addFile) fs.writeFileSync(path.join(workspace.editing, 'new-kernel.c'), 'int helper(void) { return 2; }\n');
  const checkpoint = checkpointCandidate(workspace);
  return { root, repo, git, baseline, workspace, checkpoint,
    input: { workspace, expectedBaselineCommit: baseline, commitMessage: 'Approved optimization; preserve other local work' },
    close() { for (const name of ['validation', 'editing']) {
      const dir = path.join(root, 'worktrees', 'candidate', name);
      if (fs.existsSync(dir)) git('worktree', 'remove', '--force', dir);
    }
    assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('delivery avoids oversized status output and preserves unrelated staged, unstaged and untracked files', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'staged.c'), 'private staged change\n'); f.git('add', 'staged.c');
    fs.writeFileSync(path.join(f.repo, 'unstaged.c'), 'private unstaged change\n');
    const analysis = path.join(f.repo, 'analysis'); fs.mkdirSync(analysis);
    for (let index = 0; index < 1600; index++) fs.writeFileSync(path.join(analysis, `${'数据'.repeat(30)}-${index}.txt`), `private ${index}`);
    const oldStatus = spawnSync('git', ['-C', f.repo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', windowsHide: true });
    assert.equal((oldStatus.error as NodeJS.ErrnoException)?.code, 'ENOBUFS', 'fixture must reproduce the actual 1 MiB capture failure');
    const stagedBefore = f.git('diff', '--cached', '--binary');
    const localBefore = f.git('diff', '--binary');
    const result = await runFixtureDelivery(f.input, true);
    assert.equal(result.tree, f.checkpoint.tree);
    assert.equal(f.git('rev-parse', 'HEAD'), result.commit);
    assert.equal(f.git('rev-parse', 'HEAD^{tree}'), f.checkpoint.tree);
    assert.equal(f.git('show', '-s', '--format=%P', 'HEAD'), `${f.baseline} ${f.checkpoint.commit}`);
    assert.equal(f.git('diff', '--name-only', f.baseline, 'HEAD'), 'kernel.c');
    assert.equal(f.git('diff', '--cached', '--binary'), stagedBefore);
    assert.equal(f.git('diff', '--binary'), localBefore);
    assert.equal(fs.readdirSync(analysis).length, 1600);
    assert.equal(fs.readFileSync(path.join(f.repo, 'kernel.c'), 'utf8'), 'int kernel(void) { return 2; }\n');
    assert.equal(fs.existsSync(f.workspace.editing), false);
    assert.equal(fs.existsSync(f.workspace.validation), false);
  } finally { f.close(); }
});

test('overlapping local source edits stop delivery without changing the branch, index or candidate workspaces', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'kernel.c'), 'private kernel edit\n');
    fs.writeFileSync(path.join(f.repo, 'staged.c'), 'private staged change\n'); f.git('add', 'staged.c');
    const before = f.git('diff', '--cached', '--binary');
    await assert.rejects(runFixtureDelivery(f.input), /kernel\.c/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
    assert.equal(fs.readFileSync(path.join(f.repo, 'kernel.c'), 'utf8'), 'private kernel edit\n');
    assert.equal(f.git('diff', '--cached', '--binary'), before);
    assert.ok(fs.existsSync(f.workspace.editing));
    assert.ok(fs.existsSync(f.workspace.validation));
    assert.equal(fs.existsSync(path.join(f.repo, '.git', 'MERGE_HEAD')), false);
  } finally { f.close(); }
});

test('delivery protects untracked and ignored files that occupy new candidate paths', async () => {
  const f = fixture(true);
  try {
    const target = path.join(f.repo, 'new-kernel.c'); fs.writeFileSync(target, 'private untracked source\n');
    await assert.rejects(runFixtureDelivery(f.input), /new-kernel\.c/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
    fs.appendFileSync(path.join(f.repo, '.git', 'info', 'exclude'), '\nnew-kernel.c\n');
    await assert.rejects(runFixtureDelivery(f.input), /new-kernel\.c/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
    assert.equal(fs.readFileSync(target, 'utf8'), 'private untracked source\n');
  } finally { f.close(); }
});

test('an unoccupied target branch advances without a delivery checkout or touching the current branch', async () => {
  const f = fixture();
  try {
    f.git('branch', 'feature/delivery'); f.workspace.source_branch = 'feature/delivery';
    fs.writeFileSync(path.join(f.repo, 'kernel.c'), 'private current-branch edit\n');
    const result = await runFixtureDelivery(f.input);
    assert.equal(f.git('rev-parse', 'feature/delivery'), result.commit);
    assert.equal(f.git('rev-parse', 'main'), f.baseline);
    assert.equal(f.git('branch', '--show-current'), 'main');
    assert.equal(fs.readFileSync(path.join(f.repo, 'kernel.c'), 'utf8'), 'private current-branch edit\n');
    assert.equal(fs.existsSync(path.join(path.dirname(f.workspace.editing), 'delivery')), false);
  } finally { f.close(); }
});

test('delivery rejects a mismatched frozen tree and reports process-launch errors with their cause and directory', async () => {
  const f = fixture();
  const savedPath = process.env.PATH;
  try {
    f.workspace.candidate_tree = '0'.repeat(40);
    await assert.rejects(runFixtureDelivery(f.input), /源码树与已验证记录不一致/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
    process.env.PATH = path.join(f.root, 'missing-bin');
    f.workspace.source_branch = undefined;
    await assert.rejects(runFixtureDelivery(f.input), error => error instanceof Error && error.message.includes('ENOENT') && error.message.includes(f.repo));
  } finally { process.env.PATH = savedPath; f.close(); }
});
