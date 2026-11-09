import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startWebFixture } from '../../../tests/web-fixture.js';
import { CorePilotClient, serverKey, serverUrl } from '../src/client.js';

const statusIs = (status: number) => (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === status;

test('server addresses cannot contain credentials and only health is sent before service verification', async () => {
  for (const address of ['not a url', 'ftp://example.invalid', 'https://name:password@example.invalid',
    'https://example.invalid/?token=secret', 'https://example.invalid/#secret']) assert.throws(() => serverUrl(address));
  assert.equal(serverUrl('http://127.0.0.1:4317/'), 'http://127.0.0.1:4317');
  assert.notEqual(serverKey('http://localhost:4317'), serverKey('http://localhost:4318'));
  let authorization: string | undefined;
  const server = http.createServer((req, res) => { authorization = req.headers.authorization; res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    await assert.rejects(CorePilotClient.connect(`http://127.0.0.1:${address.port}`, 'private-fixture-token'), /不是兼容的 CorePilot/);
    assert.equal(authorization, undefined, 'a token is never sent to an unverified health endpoint');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('candidate diff reports malformed responses and disconnection after a successful health check', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/health') res.end(JSON.stringify({ service: 'corepilot', api_version: 1, status: 'ok', runner: 'workflow', capabilities: ['workflows'] }));
    else { res.setHeader('content-type', 'application/json'); res.end('{"unexpected":"fixture"}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const client = await CorePilotClient.connect(`http://127.0.0.1:${address.port}`);
  await assert.rejects(client.candidateDiff('workflow:a', 'candidate:a'), /未返回可读取的候选补丁/);
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await assert.rejects(client.candidateDiff('workflow:a', 'candidate:a'), /无法连接 CorePilot 服务/);
});

test('extension client uses the real project, workflow, report and diff API, with explicit cancellation', async () => {
  // This is a local, deterministic model fixture; it has no Runner and produces no performance evidence.
  const f = await startWebFixture({ execute: true });
  try {
    const project = f.projects.add({ name: 'IDE fixture', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
    const anonymous = await CorePilotClient.connect(f.url);
    await assert.rejects(anonymous.projects(), statusIs(401));
    const client = await CorePilotClient.connect(f.url, f.token);
    assert.equal((await client.projects()).find(row => row.project_id === project.project_id)?.name, 'IDE fixture');
    const input = { project_id: project.project_id, function_name: 'kernel', entry_file: 'kernel.c', source_branch: 'main',
      verification_mode: 'source_only', candidate_scope: { include: ['kernel.c'], exclude: [] }, enable_performance: false };
    const first = await client.api.submitOptimizationWorkflow(input, { requestId: 'ide-fixture-candidate' }) as { workflow_id: string };
    let record = f.service.get(first.workflow_id)!;
    for (let i = 0; i < 500 && record.status !== 'CANDIDATE_READY'; i++) {
      if (record.status === 'FAILED') assert.fail(record.error ?? 'fixture source workflow failed');
      await delay(20); record = f.service.get(first.workflow_id)!;
    }
    assert.equal(record.status, 'CANDIDATE_READY');
    assert.ok(record.candidate_id);
    const list = await client.workflows(project);
    assert.equal(list.workflows.find(row => row.workflow_id === first.workflow_id)?.verification_mode, 'source_only');
    const sameRepository = { ...project, project_id: randomUUID(), name: 'Same repository, another project',
      config_path: path.join(f.root, 'other-config.yaml') };
    assert.ok((await client.workflows(sameRepository)).workflows.some(row => row.workflow_id === first.workflow_id),
      'same-repository matching is only an association, not proof of project identity');
    const sharedConfig = { ...project, project_id: randomUUID(), name: 'Another repository, shared configuration',
      repository_root: path.join(f.root, 'other-repository') };
    f.store.saveProject(sharedConfig);
    assert.ok((await client.workflows(sharedConfig)).workflows.some(row => row.workflow_id === first.workflow_id),
      'two persisted projects can share a configuration, so the matching row must remain qualified');
    const detail = await client.workflow(first.workflow_id);
    assert.equal(detail.workflow.candidate_id, record.candidate_id);
    const report = await client.api.getOptimizationReport(first.workflow_id);
    assert.match(report.markdown, /NOT_EXECUTED \/ NOT_EXECUTED \/ NOT_EXECUTED/);
    const patch = await client.candidateDiff(first.workflow_id, record.candidate_id!);
    assert.match(patch, /\+int kernel\(void\) \{ return 2; \}/);
    await assert.rejects(anonymous.candidateDiff(first.workflow_id, record.candidate_id!), statusIs(401));
    await assert.rejects(client.candidateDiff(first.workflow_id, 'candidate:missing'), statusIs(404));

    const second = await client.api.submitOptimizationWorkflow(input, { requestId: 'ide-fixture-cancel' }) as { workflow_id: string };
    const cancellation = await client.api.cancelOptimizationWorkflow(second.workflow_id) as { status: string };
    assert.equal(cancellation.status, 'CANCEL_REQUESTED', 'a request is not reported as confirmed cancellation');
    assert.equal(f.store.listExperiments(record.optimization_task_id!).length, 0);
  } finally { await f.close(); }
});
