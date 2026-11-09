import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient } from '../src/client/api-client.js';
import { RunnerClient } from '../src/client/runner-client.js';
import { ValidationTrialService } from '../src/application/validation-trial-service.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import { startWebFixture } from './web-fixture.js';

// The proxy forwards the actual plan to a local Runner, then replaces its
// successful response. It also simulates a transient lookup against a Runner
// that cannot see the experiment; neither behavior supplies performance data.
for (const [purpose, maskedStatus] of [['BASELINE_BUILD', 503], ['VALIDATION_DRAFT', 409]] as const) {
  test(`${purpose} reconciles the accepted Runner job after HTTP ${maskedStatus} and a Control restart`, async () => {
    fs.mkdirSync(path.join(process.cwd(), 'build'), { recursive: true });
    const runnerRoot = fs.mkdtempSync(path.join(process.cwd(), 'build', 'trial-runner-'));
    // Runner paths describe its target platform. On Windows the test maps the
    // current drive's root to a POSIX path, as the application targets Linux.
    const remoteRoot = process.platform === 'win32' ? runnerRoot.slice(2).replaceAll('\\', '/') : runnerRoot;
    const runner = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'fixture-runner',
      dbPath: path.join(runnerRoot, 'runner.sqlite'), workspaceRoot: runnerRoot, resourceEnforcement: 'REQUIRED' });
    let submitCount = 0, queryCount = 0, maskQuery = false, wrongIdentity = false, rejectSubmission = false;
    const submittedIds: string[] = [];
    const proxy = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://proxy');
      if (req.method === 'GET' && /^\/experiments\/[^/]+$/.test(url.pathname)) {
        queryCount++;
        if (maskQuery) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'EXPERIMENT_NOT_FOUND', message: 'fixture lookup unavailable' } })); return; }
      }
      const submit = req.method === 'POST' && url.pathname === '/experiments';
      if (submit && rejectSubmission) {
        submitCount++; req.resume();
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INVALID_EXPERIMENT_PLAN', message: 'fixture rejected before storing' } })); return;
      }
      const chunks: Buffer[] = [];
      if (submit) { submitCount++; req.on('data', chunk => chunks.push(Buffer.from(chunk))); req.on('end', () => submittedIds.push(JSON.parse(Buffer.concat(chunks).toString()).experiment.experiment_id)); }
      const upstream = http.request({ hostname: '127.0.0.1', port: runner.port, method: req.method, path: req.url, headers: req.headers }, response => {
        const body: Buffer[] = [];
        response.on('data', chunk => body.push(Buffer.from(chunk)));
        response.on('end', () => {
          let status = response.statusCode ?? 500;
          let payload = Buffer.concat(body);
          if (submit && status === 202) {
            status = maskedStatus;
            payload = Buffer.from(JSON.stringify({ error: { code: 'PROXY_FAILURE', message: 'response changed after Runner accepted' } }));
          }
          if (process.platform === 'win32' && req.method === 'PUT' && url.pathname === '/source-archives' && status === 201) {
            const staged = JSON.parse(payload.toString());
            staged.workspace_path = url.searchParams.get('workspace_path');
            payload = Buffer.from(JSON.stringify(staged));
          }
          if (wrongIdentity && req.method === 'GET' && /^\/experiments\/[^/]+$/.test(url.pathname) && status === 200) {
            const receipt = JSON.parse(payload.toString()); receipt.experiment_id = 'validation:other';
            payload = Buffer.from(JSON.stringify(receipt));
          }
          res.writeHead(status, { 'content-type': 'application/json' }); res.end(payload);
        });
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address(); assert.ok(address && typeof address === 'object');
    const f = await startWebFixture();
    try {
      const project = f.projects.add({ name: 'Recovery fixture', repository_root: f.repo });
      const discovery = await f.projects.discover(project.project_id, 'kernel', { command: 'node -e "process.exit(0)"', cwd: '.' });
      const packageId = discovery.evidence.generated.package_id, version = discovery.evidence.generated.version, targetId = discovery.targets[0].target_id;
      const original = f.readyValidation(project, packageId, version, targetId);
      const saved = f.projects.validationAssets.save(project, packageId, version, targetId, { ...original, source: 'edited', expected_digest: original.evaluator_digest,
        test_plan: { ...original.test_plan, resources: { cpu_set: '0', numa_node: 0 } } });
      const currentConfig = f.projects.config(project.project_id);
      f.projects.saveConfig(project.project_id, { ...currentConfig,
        target: { ...currentConfig.target, workspace_root: remoteRoot },
        runner: { mode: 'rpc', endpoint: `http://127.0.0.1:${address.port}`, token: 'fixture-runner', request_timeout_ms: 5000, poll_interval_ms: 100 } });
      const transport = () => ({ async runRemote(argv: string[]) { return { command: argv[0], argv, exit_code: 0, stderr: '', stdout: '' }; },
        uploadFile() { return { exit_code: 0, stderr: '' }; } });
      let trials = new ValidationTrialService(f.dataDir, f.projects.machines, transport);
      (f.projects as unknown as { validationTrials: ValidationTrialService }).validationTrials = trials;
      const api = new ApiClient(f.url, { token: f.token });
      const input = { package_id: packageId, package_version: version, target_id: targetId, purpose, source_branch: 'main',
        mode: 'correctness', expected_digest: saved.evaluator_digest };
      const started = await api.projectAction(project.project_id, 'validation-trials', input) as { trial_id: string };
      let record: ReturnType<ValidationTrialService['list']>[number] | undefined;
      for (let i = 0; i < 200; i++) {
        record = trials.list(project).find(row => row.trial_id === started.trial_id);
        if (record?.preparation?.state === 'UNKNOWN' || record?.preparation?.state === 'FAILED') break;
        await delay(20);
      }
      assert.equal(record?.preparation?.state, 'UNKNOWN', record?.preparation?.message ?? 'submission did not finish');
      assert.deepEqual(submittedIds, [started.trial_id]);
      const direct = new RunnerClient({ baseUrl: runner.url, token: 'fixture-runner' });
      assert.equal((await direct.getExperiment(started.trial_id)).experiment_id, started.trial_id);

      const savedCommit = record.source_commit;
      const filename = path.join(f.dataDir, 'projects', project.project_id, 'validation-trials', started.trial_id.slice('validation:'.length) + '.json');
      // Recreate the last durable state when Control dies before receiving or
      // persisting the submit response; no second POST is made on restart.
      fs.writeFileSync(filename, JSON.stringify({ ...record, preparation: { state: 'PREPARING', phase: 'SUBMITTING', message: '提交中断前的原始记录' } }));
      trials = new ValidationTrialService(f.dataDir, f.projects.machines, transport);
      (f.projects as unknown as { validationTrials: ValidationTrialService }).validationTrials = trials;
      maskQuery = true;
      const missing = await api.projectAction(project.project_id, `validation-trials/${encodeURIComponent(started.trial_id)}`) as { status: { status: string; failure: { code: string; message: string } }; trial: { source_commit: string } };
      assert.equal(missing.status.status, 'UNKNOWN');
      assert.equal(missing.status.failure.code, 'EXPERIMENT_NOT_FOUND');
      assert.match(missing.status.failure.message, /不会自动重复提交/);
      assert.equal(missing.trial.source_commit, savedCommit);
      assert.equal(submitCount, 1);
      maskQuery = false;
      wrongIdentity = true;
      const mismatched = await api.projectAction(project.project_id, `validation-trials/${encodeURIComponent(started.trial_id)}`) as { status: { status: string; failure: { code: string } }; passed: boolean };
      assert.equal(mismatched.status.status, 'UNKNOWN'); assert.equal(mismatched.status.failure.code, 'TRIAL_RUNNER_IDENTITY_MISMATCH'); assert.equal(mismatched.passed, false);
      wrongIdentity = false;
      const reconciled = await api.projectAction(project.project_id, `validation-trials/${encodeURIComponent(started.trial_id)}`) as { status: { status: string }; trial: { source_commit: string; preparation: { message: string } } };
      assert.ok(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(reconciled.status.status), reconciled.status.status);
      assert.equal(reconciled.trial.source_commit, savedCommit);
      assert.equal(reconciled.trial.preparation.message, '提交中断前的原始记录');
      assert.equal(submitCount, 1);
      assert.ok(queryCount >= 2);

      // A crash before the submit boundary has no Runner job to query.
      const before = queryCount;
      fs.writeFileSync(filename, JSON.stringify({ ...record, preparation: { state: 'PREPARING', phase: 'UPLOADING', message: '准备中断' } }));
      const notSubmitted = await api.projectAction(project.project_id, `validation-trials/${encodeURIComponent(started.trial_id)}`) as { status: { status: string } };
      assert.equal(notSubmitted.status.status, 'UNKNOWN');
      assert.equal(queryCount, before);
      assert.equal(submitCount, 1);

      rejectSubmission = true;
      const rejected = await api.projectAction(project.project_id, 'validation-trials', input) as { trial_id: string };
      let rejectedRecord: ReturnType<ValidationTrialService['list']>[number] | undefined;
      for (let i = 0; i < 200; i++) {
        rejectedRecord = trials.list(project).find(row => row.trial_id === rejected.trial_id);
        if (rejectedRecord?.preparation?.state === 'FAILED') break;
        await delay(20);
      }
      assert.equal(rejectedRecord?.preparation?.state, 'FAILED');
      assert.equal(rejectedRecord?.preparation?.phase, 'SUBMITTING');
      const queriesBeforeRejectedRead = queryCount;
      const rejectedStatus = await api.projectAction(project.project_id, `validation-trials/${encodeURIComponent(rejected.trial_id)}`) as { status: { status: string } };
      assert.equal(rejectedStatus.status.status, 'FAILED');
      assert.equal(queryCount, queriesBeforeRejectedRead);
      assert.equal(submitCount, 2);
      await assert.rejects(direct.getExperiment(rejected.trial_id), /experiment not found/);
    } finally {
      await f.close();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      await runner.close();
      fs.rmSync(runnerRoot, { recursive: true, force: true });
    }
  });
}
