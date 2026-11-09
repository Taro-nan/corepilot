import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { freezeEvidenceFiles } from '../src/workspace/freeze-evidence.js';
import type { CommandExecution, Measurement } from '../src/contracts/optimization-domain.js';
import { seedApprovalFacts, seedLegacyApprovedEvidence } from './workflow-approval-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { runFixtureCli, startWebFixture } from './web-fixture.js';

test('new evidence rejects wrong units, parameters, binary identities, missing plans, and divergent command output', async () => {
  const f = await startWebFixture();
  let db: DatabaseSync | undefined;
  try {
    const seeded = await seedBlockedValidation(f, true);
    const facts = seedApprovalFacts(f, seeded.workflowId, { distinctRevalidation: true });
    const api = new ApiClient(f.url, { token: f.token });
    db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
    const writeRow = db.prepare('UPDATE optimization_measurements SET record_json = ? WHERE measurement_id = ?');
    const writeCommand = db.prepare('UPDATE optimization_experiment_commands SET record_json = ? WHERE command_id = ?');
    const find = (experiment: string, kind: Measurement['kind'], role: Measurement['role']) => {
      const row = f.store.listMeasurements(experiment).find(item => item.kind === kind && item.role === role)!;
      const command = f.store.listCommandExecutions(experiment).find(item => item.stdout.includes(`"subject_id":"${row.subject_id}"`)
        && item.stdout.includes(`"role":"${row.role}"`) && item.stdout.includes(`"sample_index":${row.sample_index}`))!;
      assert.ok(row && command);
      return { row, command };
    };
    const update = (row: Measurement, command: CommandExecution, change: (copy: Measurement) => void, outputMatches = true) => {
      const next = structuredClone(row); change(next);
      writeRow.run(JSON.stringify(next), row.measurement_id);
      if (outputMatches) {
        const rawPayload = { ...next.domain_payload }; delete rawPayload.evaluator_identity; delete rawPayload.resource_policy;
        delete rawPayload.runner_artifact_path_check;
        const observation = { kind: next.kind, role: next.role, subject_id: next.subject_id, sample_index: next.sample_index,
          value: next.value, unit: next.unit, validity: next.validity, domain_payload: rawPayload };
        writeCommand.run(JSON.stringify({ ...command, stdout: `COREPILOT_MEASUREMENT ${JSON.stringify(observation)}\n` }), command.command_execution_id);
      }
    };
    const scenarios: Array<{ experiment: string; kind: Measurement['kind']; role: Measurement['role']; change: (row: Measurement) => void; outputMatches?: boolean }> = [
      { experiment: facts.first.experiment_id, kind: 'PERFORMANCE_SAMPLE', role: 'CANDIDATE', change: row => { row.unit = 'ns'; } },
      { experiment: facts.first.experiment_id, kind: 'PERFORMANCE_SAMPLE', role: 'CANDIDATE', change: row => { (row.domain_payload.parameters as Record<string, unknown>).n = 99; } },
      { experiment: facts.first.experiment_id, kind: 'PERFORMANCE_SAMPLE', role: 'BASELINE', change: row => { (row.domain_payload.artifact_identity as Record<string, unknown>).sha256 = '8'.repeat(64); } },
      { experiment: facts.first.experiment_id, kind: 'CORRECTNESS_CASE', role: 'EVALUATOR', change: row => { delete row.domain_payload.artifact_identity; } },
      { experiment: facts.first.experiment_id, kind: 'CORRECTNESS_CASE', role: 'EVALUATOR', change: row => { (row.domain_payload.artifact_identity as Record<string, unknown>).resolved_symbol_path = '/another/library.so'; } },
      { experiment: facts.first.experiment_id, kind: 'CORRECTNESS_CASE', role: 'EVALUATOR', change: row => { (row.domain_payload.artifact_identity as Record<string, unknown>)[`resolved_${facts.workflow.function_name}_path`] = '/another/library.so'; } },
      { experiment: facts.first.experiment_id, kind: 'CORRECTNESS_CASE', role: 'EVALUATOR', change: row => { (row.domain_payload.runner_artifact_path_check as Record<string, unknown>).planned_path = '/another/library.so'; } },
      { experiment: facts.first.experiment_id, kind: 'CORRECTNESS_CASE', role: 'EVALUATOR', change: row => { delete row.domain_payload.evaluator_binary_identity; } },
      { experiment: facts.first.experiment_id, kind: 'PERFORMANCE_SAMPLE', role: 'CANDIDATE', change: row => { delete row.domain_payload.benchmark_identity; } },
      { experiment: facts.repeated.experiment_id, kind: 'PERFORMANCE_SAMPLE', role: 'CANDIDATE', change: row => { (row.domain_payload.artifact_identity as Record<string, unknown>).sha256 = '2'.repeat(64); } },
      { experiment: facts.repeated.experiment_id, kind: 'PERFORMANCE_SAMPLE', role: 'CANDIDATE', change: row => { (row.domain_payload.benchmark_identity as Record<string, unknown>).sha256 = '8'.repeat(64); } },
      { experiment: facts.first.experiment_id, kind: 'PERFORMANCE_SAMPLE', role: 'CANDIDATE', change: row => { row.unit = 'ns'; }, outputMatches: false },
    ];
    for (const scenario of scenarios) {
      const { row, command } = find(scenario.experiment, scenario.kind, scenario.role);
      update(row, command, scenario.change, scenario.outputMatches);
      await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /测量身份或执行记录无法核验/);
      writeRow.run(JSON.stringify(row), row.measurement_id);
      writeCommand.run(JSON.stringify(command), command.command_execution_id);
    }
    const truncated = find(facts.first.experiment_id, 'PERFORMANCE_SAMPLE', 'CANDIDATE').command;
    writeCommand.run(JSON.stringify({ ...truncated, stdout: (truncated.stdout + 'x'.repeat(2 * 1024 * 1024)).slice(0, 2 * 1024 * 1024) }), truncated.command_execution_id);
    await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /输出达到保留上限或缺失，可能已截断/);
    writeCommand.run(JSON.stringify(truncated), truncated.command_execution_id);
    const first = f.store.getExperiment(facts.first.experiment_id)!;
    const wrongCommand = find(facts.first.experiment_id, 'PERFORMANCE_SAMPLE', 'CANDIDATE').command;
    writeCommand.run(JSON.stringify({ ...wrongCommand, args: [...wrongCommand.args, '--unexpected'] }), wrongCommand.command_execution_id);
    await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /执行命令与计划不一致/);
    writeCommand.run(JSON.stringify(wrongCommand), wrongCommand.command_execution_id);
    const wrongSource = structuredClone(first);
    (wrongSource.declared_context.runner_execution_plan as { candidate: { source_sha256: string } }).candidate.source_sha256 = '9'.repeat(64);
    f.store.saveExperiment(wrongSource);
    await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /候选源码或评价器身份不一致/);
    const noPlan = structuredClone(first); delete noPlan.declared_context.runner_execution_plan;
    f.store.saveExperiment(noPlan);
    await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /缺少原始 RPC 执行计划/);
    const cli = await runFixtureCli(f.url, f.token, ['workflow', 'evidence', seeded.workflowId, '--prepare', '--json']);
    assert.notEqual(cli.code, 0); assert.match(cli.stderr, /缺少原始 RPC 执行计划/);
    f.store.saveExperiment(first);
    // Runner permits a producer to omit threads in the payload when they are
    // independently specified and enforced by the execution context.
    const optionalThreads = find(facts.first.experiment_id, 'CORRECTNESS_CASE', 'EVALUATOR');
    update(optionalThreads.row, optionalThreads.command, row => { delete (row.domain_payload.parameters as Record<string, unknown>).threads; });
    assert.ok((await api.prepareWorkflowEvidence(seeded.workflowId)).snapshot);
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
  } finally { db?.close(); await f.close(); }
});

test('new evidence permits a remote alias only with a consistent Runner file identity check', async () => {
  const f = await startWebFixture();
  let db: DatabaseSync | undefined;
  try {
    const seeded = await seedBlockedValidation(f, true);
    const facts = seedApprovalFacts(f, seeded.workflowId);
    const api = new ApiClient(f.url, { token: f.token });
    const row = f.store.listMeasurements(facts.first.experiment_id).find(item => item.kind === 'CORRECTNESS_CASE')!;
    const command = f.store.listCommandExecutions(facts.first.experiment_id).find(item => item.stdout.includes(`"subject_id":"${row.subject_id}"`))!;
    db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
    const writeRow = db.prepare('UPDATE optimization_measurements SET record_json = ? WHERE measurement_id = ?');
    const writeCommand = db.prepare('UPDATE optimization_experiment_commands SET record_json = ? WHERE command_id = ?');
    const altered = structuredClone(row);
    (altered.domain_payload.artifact_identity as Record<string, unknown>).resolved_symbol_path = '/runner/alias/library.so';
    const raw = { ...altered.domain_payload }; delete raw.evaluator_identity; delete raw.resource_policy; delete raw.runner_artifact_path_check;
    const observation = { kind: altered.kind, role: altered.role, subject_id: altered.subject_id, sample_index: altered.sample_index,
      value: altered.value, unit: altered.unit, validity: altered.validity, domain_payload: raw };
    writeCommand.run(JSON.stringify({ ...command, stdout: `COREPILOT_MEASUREMENT ${JSON.stringify(observation)}\n` }), command.command_execution_id);
    delete altered.domain_payload.runner_artifact_path_check;
    writeRow.run(JSON.stringify(altered), altered.measurement_id);
    await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /缺少 Runner 库路径核对记录/);
    const fileId = { device: '1', inode: '42' };
    const inputPath = (altered.domain_payload.artifact_identity as { input_path: string }).input_path;
    altered.domain_payload.runner_artifact_path_check = { planned_path: inputPath, input_realpath: '/runner/real/library.so', input_file_id: fileId,
      reported_paths: [{ field: 'input_path', path: inputPath, realpath: '/runner/real/library.so', file_id: fileId },
        { field: 'resolved_symbol_path', path: '/runner/alias/library.so', realpath: '/runner/other.so', file_id: { ...fileId, inode: '99' } }] };
    writeRow.run(JSON.stringify(altered), altered.measurement_id);
    await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /Runner 库路径核对记录无效/);
    const reported = (altered.domain_payload.runner_artifact_path_check as { reported_paths: Array<{ realpath: string; file_id: { inode: string } }> }).reported_paths[1];
    reported.realpath = '/runner/real/library.so'; reported.file_id.inode = '42';
    writeRow.run(JSON.stringify(altered), altered.measurement_id);
    assert.ok((await api.prepareWorkflowEvidence(seeded.workflowId)).snapshot);
  } finally { db?.close(); await f.close(); }
});

test('an older unapproved snapshot cannot bypass trace checks at approval time', async () => {
  const f = await startWebFixture();
  let db: DatabaseSync | undefined;
  try {
    const seeded = await seedBlockedValidation(f, true);
    const facts = seedApprovalFacts(f, seeded.workflowId);
    const api = new ApiClient(f.url, { token: f.token });
    const snapshot = (await api.prepareWorkflowEvidence(seeded.workflowId)).snapshot;
    const row = f.store.listMeasurements(facts.first.experiment_id).find(item => item.kind === 'PERFORMANCE_SAMPLE')!;
    const command = f.store.listCommandExecutions(facts.first.experiment_id).find(item => item.stdout.includes(`"subject_id":"${row.subject_id}"`)
      && item.stdout.includes(`"role":"${row.role}"`) && item.stdout.includes(`"sample_index":${row.sample_index}`))!;
    db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
    db.prepare('UPDATE optimization_measurements SET record_json = ? WHERE measurement_id = ?').run(JSON.stringify({ ...row, unit: 'ns' }), row.measurement_id);
    db.prepare('UPDATE optimization_experiment_commands SET record_json = ? WHERE command_id = ?')
      .run(JSON.stringify({ ...command, stdout: command.stdout.replace('"unit":"seconds"', '"unit":"ns"') }), command.command_execution_id);
    const root = path.dirname(snapshot.artifact.manifest_path);
    const manifest = JSON.parse(fs.readFileSync(snapshot.artifact.manifest_path, 'utf8')) as { files: Array<{ relative_path: string }> };
    const files = new Map(manifest.files.map(({ relative_path }) => [relative_path, fs.readFileSync(path.join(root, ...relative_path.split('/')))]));
    files.set('formal/measurements.json', Buffer.from(JSON.stringify(f.store.listMeasurements(facts.first.experiment_id), null, 2) + '\n'));
    files.set('formal/commands.json', Buffer.from(JSON.stringify(f.store.listCommandExecutions(facts.first.experiment_id), null, 2) + '\n'));
    const artifact = freezeEvidenceFiles(path.join(f.root, 'legacy-unapproved'), files);
    const workflow = f.service.get(seeded.workflowId)!;
    f.store.saveOptimizationWorkflowJson(seeded.workflowId, JSON.stringify({ ...workflow, review_evidence: { ...snapshot, artifact } }));
    await assert.rejects(api.approveWorkflowEvidence(seeded.workflowId, { expected_evidence_digest: artifact.digest,
      reviewer: 'Fixture Reviewer', authorization_reference: 'fixture' }), /测量身份或执行记录无法核验/);
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
  } finally { db?.close(); await f.close(); }
});

test('revalidation permits workload-specific benchmarks but requires the same one across both roles for each workload', async () => {
  const f = await startWebFixture();
  let db: DatabaseSync | undefined;
  try {
    const seeded = await seedBlockedValidation(f, true);
    const facts = seedApprovalFacts(f, seeded.workflowId, { twoWorkloads: true });
    const api = new ApiClient(f.url, { token: f.token });
    const rows = f.store.listMeasurements(facts.repeated.experiment_id).filter(row => row.kind === 'PERFORMANCE_SAMPLE');
    const benchmark = (row: Measurement) => (row.domain_payload.benchmark_identity as { sha256: string }).sha256;
    assert.notEqual(benchmark(rows.find(row => row.subject_id === 'workload-1')!), benchmark(rows.find(row => row.subject_id === 'workload-2')!));
    assert.ok((await api.prepareWorkflowEvidence(seeded.workflowId)).snapshot);

    const row = rows.find(item => item.subject_id === 'workload-2' && item.role === 'CANDIDATE')!;
    const command = f.store.listCommandExecutions(facts.repeated.experiment_id).find(item => item.stdout.includes(`"subject_id":"${row.subject_id}"`)
      && item.stdout.includes(`"role":"${row.role}"`) && item.stdout.includes(`"sample_index":${row.sample_index}`))!;
    const modified = structuredClone(row);
    (modified.domain_payload.benchmark_identity as { sha256: string }).sha256 = '8'.repeat(64);
    db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
    db.prepare('UPDATE optimization_measurements SET record_json = ? WHERE measurement_id = ?').run(JSON.stringify(modified), row.measurement_id);
    db.prepare('UPDATE optimization_experiment_commands SET record_json = ? WHERE command_id = ?')
      .run(JSON.stringify({ ...command, stdout: command.stdout.replace('6'.repeat(64), '8'.repeat(64)) }), command.command_execution_id);
    await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /负载 workload-2 的两端性能样本评价程序自报身份不一致/);
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
  } finally { db?.close(); await f.close(); }
});

test('existing legacy approval stays retryable without fabricating a missing RPC plan', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    const facts = seedApprovalFacts(f, seeded.workflowId, { statisticalGate: false });
    for (const id of [facts.first.experiment_id, facts.repeated.experiment_id]) {
      const experiment = f.store.getExperiment(id)!;
      delete experiment.declared_context.runner_execution_plan;
      f.store.saveExperiment(experiment);
    }
    const { approval, artifact } = seedLegacyApprovedEvidence(f, seeded.workflowId, facts);
    const api = new ApiClient(f.url, { token: f.token });
    const result = await api.approveWorkflowEvidence(seeded.workflowId, { expected_evidence_digest: artifact.digest,
      reviewer: 'Fixture Reviewer', authorization_reference: 'legacy fixture' });
    assert.equal(result.approval.approval_id, approval.approval_id);
    assert.equal(f.store.getExperiment(facts.first.experiment_id)!.declared_context.runner_execution_plan, undefined);
  } finally { await f.close(); }
});
