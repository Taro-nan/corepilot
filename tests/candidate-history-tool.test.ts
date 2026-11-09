import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { candidateHistoryTool } from '../src/agent/candidate-history-tool.js';
import type { OptimizationReasoningHistory } from '../src/contracts/optimization-hypothesis.js';
import { checkpointCandidate, createCandidateWorkspace, removeCandidateWorkspace } from '../src/workspace/candidate-workspace.js';
import { snapshotEditingTree } from '../src/workspace/git-source-archive.js';

function git(cwd: string, ...args: string[]): string {
  const output = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(output.status, 0, output.stderr); return output.stdout.trim();
}

test('history inspection previews the exact checkpoint tree without editing the actual index or source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-tree-history-'));
  const repository = path.join(root, 'repo'); fs.mkdirSync(repository);
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repository, 'kernel.c'), 'baseline\n');
  fs.writeFileSync(path.join(repository, 'renamed.c'), 'rename\n');
  fs.writeFileSync(path.join(repository, 'deleted.c'), 'delete\n');
  fs.writeFileSync(path.join(repository, '.gitignore'), 'ignored.tmp\n');
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'baseline');
  const workspace = createCandidateWorkspace({ repository, worktreeRoot: path.join(root, 'worktrees'), runId: 'test' });
  const temporary = path.join(root, 'temp'); fs.mkdirSync(temporary);
  const oldTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = temporary; process.env.TMP = temporary; process.env.TMPDIR = temporary;
  const noTemporaryIndex = () => assert.deepEqual(fs.readdirSync(temporary).filter(name => name.startsWith('corepilot-source-index-')), []);
  try {
    fs.writeFileSync(path.join(workspace.editing, 'kernel.c'), 'first\n');
    fs.renameSync(path.join(workspace.editing, 'renamed.c'), path.join(workspace.editing, 'new name.c'));
    fs.unlinkSync(path.join(workspace.editing, 'deleted.c'));
    // This sorts first in git's NUL-delimited list; trimming stdout would rename it.
    fs.writeFileSync(path.join(workspace.editing, ' leading.c'), 'leading whitespace\n');
    fs.writeFileSync(path.join(workspace.editing, 'new.c'), 'added\n');
    fs.writeFileSync(path.join(workspace.editing, 'ignored.tmp'), 'explicitly staged\n');
    fs.writeFileSync(path.join(workspace.editing, 'build.o'), 'build product\n');
    git(workspace.editing, 'add', '-f', 'ignored.tmp');
    const listing = spawnSync('git', ['-C', workspace.editing, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', windowsHide: true });
    assert.equal(listing.status, 0, listing.stderr); assert.equal(listing.stdout.split('\0')[0], ' leading.c');
    const index = git(workspace.editing, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const indexBefore = fs.readFileSync(index);
    const statusBefore = git(workspace.editing, 'status', '--porcelain');
    const headBefore = git(workspace.editing, 'rev-parse', 'HEAD');
    const preview = await snapshotEditingTree(workspace);
    noTemporaryIndex();
    assert.deepEqual(fs.readFileSync(index), indexBefore);
    assert.equal(git(workspace.editing, 'status', '--porcelain'), statusBefore);
    assert.equal(git(workspace.editing, 'rev-parse', 'HEAD'), headBefore);
    const first = checkpointCandidate(workspace, 'first');
    assert.equal(first.tree, preview);
    assert.match(git(workspace.editing, 'ls-tree', '-r', '--name-only', first.commit), /ignored\.tmp/);
    assert.equal(fs.existsSync(path.join(workspace.validation, ' leading.c')), true);
    assert.doesNotMatch(git(workspace.editing, 'ls-tree', '-r', '--name-only', first.commit), /build\.o/);

    fs.writeFileSync(path.join(workspace.editing, 'kernel.c'), 'second\n');
    const second = checkpointCandidate(workspace, 'second');
    fs.writeFileSync(path.join(workspace.editing, 'kernel.c'), 'first\n');
    const history = { task_id: 'task-1', hypotheses: [{ candidates: [
      { candidate_id: 'candidate-1', hypothesis_id: 'hypothesis-1', source: { tree: first.tree, commit: first.commit } },
      { candidate_id: 'candidate-2', hypothesis_id: 'hypothesis-1', source: { tree: second.tree, commit: second.commit } },
    ], experiments: [
      { candidate_id: 'candidate-1', experiment_id: 'experiment-1', type: 'FORMAL_EVALUATION', status: 'SUCCEEDED', validity: 'VALID',
        failure_category: null, evaluation: { build: 'PASSED', correctness: 'FAILED', performance: 'NOT_EXECUTED' } },
      { candidate_id: 'candidate-2', experiment_id: 'experiment-2', type: 'FORMAL_EVALUATION', status: 'FAILED', validity: 'UNKNOWN',
        failure_category: 'EXECUTION', evaluation: null },
    ] }] } as unknown as OptimizationReasoningHistory;
    const inspect = candidateHistoryTool(workspace, () => history);
    const parse = async () => JSON.parse((await inspect.execute('inspect', {}, new AbortController().signal)).content[0].text);
    const match = await parse();
    assert.equal(match.status, 'MATCH'); assert.equal(match.tree, first.tree);
    assert.equal(match.match_count, 1); assert.equal(match.candidates[0].candidate_id, 'candidate-1');
    assert.equal(match.candidates[0].experiments[0].experiment_id, 'experiment-1');
    assert.equal(match.candidates[0].experiments[0].evaluation.correctness, 'FAILED');
    assert.match(match.notice, /do not reuse/i); assert.match(match.notice, /revalidation remains allowed/i);

    fs.writeFileSync(`${index}.lock`, 'another writer');
    try { assert.equal((await parse()).status, 'UNKNOWN'); noTemporaryIndex(); }
    finally { fs.unlinkSync(`${index}.lock`); }
    workspace.candidate_commit = first.commit;
    try { assert.equal((await parse()).status, 'UNKNOWN'); }
    finally { workspace.candidate_commit = second.commit; }
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(inspect.execute('cancelled', {}, cancelled.signal));
    noTemporaryIndex();

    // The advisory does not prevent deliberately creating another Candidate.
    const third = checkpointCandidate(workspace, 'third');
    assert.equal(third.tree, first.tree); assert.notEqual(third.commit, first.commit);
    fs.writeFileSync(path.join(workspace.editing, 'kernel.c'), 'unseen\n');
    assert.equal((await parse()).status, 'NO_RECORDED_MATCH');
    const unknown = candidateHistoryTool(workspace, () => { throw new Error('database unavailable'); });
    const response = await unknown.execute('unknown', {}, new AbortController().signal);
    assert.equal(JSON.parse(response.content[0].text).status, 'UNKNOWN');
    const incomplete = structuredClone(history);
    incomplete.hypotheses[0].candidates[1].source.tree = '';
    const incompleteResponse = await candidateHistoryTool(workspace, () => incomplete).execute('incomplete', {}, new AbortController().signal);
    assert.equal(JSON.parse(incompleteResponse.content[0].text).status, 'UNKNOWN');
    const noHistory = candidateHistoryTool({ ...workspace, editing: path.join(root, 'missing-worktree') },
      () => ({ task_id: 'task-1', hypotheses: [] }));
    const emptyResponse = await noHistory.execute('empty', {}, new AbortController().signal);
    assert.equal(JSON.parse(emptyResponse.content[0].text).status, 'NO_RECORDED_CANDIDATES');
  } finally {
    for (const [key, value] of Object.entries(oldTemp)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    removeCandidateWorkspace(workspace);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
