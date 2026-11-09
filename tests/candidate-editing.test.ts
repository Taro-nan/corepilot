import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createCandidateWorkspace } from '../src/workspace/candidate-workspace.js';
import { exportGitSourceArchive, snapshotEditingSource } from '../src/workspace/git-source-archive.js';
import { RunnerClient } from '../src/client/runner-client.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceToolset } from '../src/agent/workspace-tools.js';

test('development RPC source contains current edits without changing HEAD, and transfer retries preserve staged content', async () => {
  const f = await startWebFixture();
  const runner = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'fixture', dbPath: path.join(f.root, 'snapshot-runner.sqlite'), workspaceRoot: path.join(f.root, 'snapshot-runner') });
  try {
    const workspace = createCandidateWorkspace({ repository: f.repo, baselineCommit: f.git('rev-parse', 'HEAD'), worktreeRoot: path.join(f.root, 'worktrees'), runId: 'snapshot' });
    const originalHead = f.git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(workspace.editing, 'kernel.c'), 'int kernel(void) { return 3; }\n');
    const snapshot = await snapshotEditingSource(workspace);
    const again = await snapshotEditingSource(workspace);
    assert.deepEqual(snapshot, again, 'unchanged edits have a stable snapshot identity');
    assert.equal(f.git('rev-parse', 'HEAD'), originalHead);
    assert.match(fs.readFileSync(path.join(workspace.validation, 'kernel.c'), 'utf8'), /return 1 \+ 1/);
    const archive = await exportGitSourceArchive(f.repo, snapshot.commit, path.join(f.root, 'snapshot.tar.gz'));
    const client = new RunnerClient({ baseUrl: runner.url, token: 'fixture' });
    const input = { filename: archive.path, sha256: archive.sha256, workspacePath: path.join(f.root, 'snapshot-runner', 'development', 'source') };
    const staged = await client.uploadSourceArchive(input);
    assert.match(fs.readFileSync(path.join(staged.workspace_path, 'kernel.c'), 'utf8'), /return 3/);
    assert.deepEqual(await client.uploadSourceArchive(input), staged);
    fs.writeFileSync(path.join(staged.workspace_path, 'kernel.c'), 'changed externally\n');
    await assert.rejects(client.uploadSourceArchive(input), /已有其他内容/);
    assert.equal(fs.readFileSync(path.join(staged.workspace_path, 'kernel.c'), 'utf8'), 'changed externally\n');
  } finally { await runner.close(); await f.close(); }
});
import { ApiClient } from '../src/client/api-client.js';
import { startWebFixture } from './web-fixture.js';
import { runPublicAgentWorkflow } from '../src/workflow/public-agent-workflow.js';
import { loadPublicOptimizationPreflight } from '../src/workflow/public-optimization.js';

test('public Agent finishes delete/recreate editing before a Candidate is checkpointed and tested', async () => {
  const f = await startWebFixture({ execute: true, candidateRewrite: true });
  try {
    const project = f.projects.add({ name: 'Complete rewrite', repository_root: f.repo, config_path: f.configPath });
    const api = new ApiClient(f.url, { token: f.token });
    const start = await api.submitOptimizationWorkflow({ project_id: project.project_id, function_name: 'kernel', enable_performance: false }) as { workflow_id: string };
    const deadline = Date.now() + 20_000;
    while (f.service.activeWorkflowIds().length && Date.now() < deadline) await delay(20);
    const record = f.service.get(start.workflow_id)!;
    assert.equal(record.status, 'WAITING_APPROVAL', record.error ?? record.status);
    assert.match(fs.readFileSync(path.join(record.workspace_validation!, 'kernel.c'), 'utf8'), /return 2/);
    assert.equal(record.candidate_files?.length, 1);
    assert.ok(record.candidate_files![0].before_sha256);
    assert.ok(record.candidate_files![0].after_sha256, 'the completed replacement exists; the intermediate delete was never frozen');
    assert.match(fs.readFileSync(path.join(f.repo, 'kernel.c'), 'utf8'), /return 1 \+ 1/, 'the original checkout is unchanged');
  } finally { await f.close(); }
});

test('repair can restore a file removed by a failed checkpoint from the immutable source baseline', async () => {
  const f = await startWebFixture();
  try {
    const baseline = f.git('rev-parse', 'HEAD');
    const tools = new WorkspaceToolset(f.repo, { baselineCommit: baseline, candidateSubmission: true });
    const signal = new AbortController().signal;
    assert.equal((await tools.execute('submit_candidate', { summary: 'No change' }, signal)).isError, true);
    await tools.execute('delete_file', { path: 'kernel.c' }, signal);
    f.git('commit', '-am', 'Failed Candidate deletes source');
    assert.equal(fs.existsSync(path.join(f.repo, 'kernel.c')), false);
    const restore = await tools.execute('revert_file', { path: 'kernel.c' }, signal);
    assert.equal(restore.isError, false, restore.text);
    assert.match(fs.readFileSync(path.join(f.repo, 'kernel.c'), 'utf8'), /return 1 \+ 1/);
    assert.equal((await tools.execute('submit_candidate', { summary: 'Restored source for repair' }, signal)).isError, false);
  } finally { await f.close(); }
});

test('a failed development build feeds its command and deleted paths into the next Candidate repair', async () => {
  const f = await startWebFixture();
  try {
    const preflight = loadPublicOptimizationPreflight({ function_name: 'kernel', entry_file: null, config_path: f.configPath, repository_root: f.repo });
    let round = 0, gates = 0, failedCommit = '';
    const result = await runPublicAgentWorkflow({ preflight, repository: f.repo, worktreeRoot: path.join(f.root, 'repair-trees'), runId: 'repair', maxRounds: 2,
      createDevelopmentInvestigation: () => ({ toolOptions: { inspectMachine: async () => ({ isError: false, text: '{}' }) },
        async runGate() {
          gates++;
          return gates === 1 ? { classification: 'DEVELOPMENT_ONLY' as const, passed: false, reason: 'Cannot find source file: kernel.c', workloads: [],
            failure: { experiment_id: 'development:failed-build', tool: 'run_dev_benchmark' as const, status: 'FAILED' as const, step: 'BUILD' as const,
              code: 'COMMAND_FAILED', message: 'Cannot find source file: kernel.c', failure_origin: 'CANDIDATE' as const,
              raw_command_execution_ids: ['command:failed-build'], command_output: 'CMake Error: kernel.c was removed' } }
            : { classification: 'DEVELOPMENT_ONLY' as const, passed: true, reason: 'Repaired source builds', workloads: [] };
        } }),
      onProgress: progress => { if (progress.phase === 'DEVELOPMENT_BUILD_FAILED') failedCommit = progress.checkpoint!.commit; },
      runAgent: async (tools, prompt, signal) => {
        round++;
        async function call(name: string, args: Record<string, unknown>) {
          const output = await tools.find(tool => tool.name === name)!.execute(`call-${round}-${name}`, args, signal);
          assert.notEqual(output.isError, true, JSON.stringify(output));
        }
        await call('record_development_findings', { observations: ['Inspect the function source'], suspected_bottleneck: 'Constant expression',
          supporting_measurements: [{ tool: 'run_dev_benchmark', subject_id: 'p1', summary: 'Offline fixture workload diagnosis' }], chosen_transformation: 'Replace the complete function', rejected_alternatives: [] });
        if (round === 1) await call('delete_file', { path: 'kernel.c' });
        else {
          assert.ok(prompt.includes('Cannot find source file'), 'repair receives the build error');
          assert.ok(prompt.includes('development:failed-build'), 'repair receives the failed experiment identity');
          assert.ok(prompt.includes('after_sha256'), 'repair receives the deleted source paths');
          await call('revert_file', { path: 'kernel.c' });
          await call('replace_text', { path: 'kernel.c', old_text: 'return 1 + 1', new_text: 'return 2' });
        }
        return { ok: true, text: 'Candidate edit finished', hypothesis: 'Replace the complete function', development_findings: null,
          no_source_mutation: false, turns: 1, tool_calls: 2, messages: [], error: null };
      } });
    assert.equal(result.status, 'WAITING_APPROVAL', result.error ?? result.status);
    assert.equal(round, 2); assert.equal(gates, 2); assert.ok(failedCommit);
    assert.equal(f.git('ls-tree', failedCommit, '--', 'kernel.c'), '', 'the failed Candidate is retained with its original deletion');
    assert.match(fs.readFileSync(path.join(result.workspace.validation, 'kernel.c'), 'utf8'), /return 2/);
  } finally { await f.close(); }
});
