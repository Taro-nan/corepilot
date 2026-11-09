import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient, ApiClientError } from '../src/client/api-client.js';
import { ValidationTrialService } from '../src/application/validation-trial-service.js';
import { RUNNER_PROTOCOL_VERSION } from '../src/contracts/runner-rpc.js';
import { publishTrialRecord, trialRequestIdentity } from '../src/storage/validation-trial-intake.js';
import { generatedTestEntrypoint, VALIDATION_PYTHON_HARNESS } from '../src/application/validation-python-harness.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';

test('HTTP trial intake survives concurrent requests, restart, mutable defaults and a close race', async () => {
  const f = await startWebFixture();
  let release!: () => void;
  let probeGate: Promise<void> | null = new Promise<void>(resolve => { release = resolve; });
  let healthRequests = 0, submissions = 0, cancels = 0;
  const runner = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://runner'); res.setHeader('content-type', 'application/json');
    if (url.pathname === '/health') {
      healthRequests++;
      void (async () => { await probeGate; res.end(JSON.stringify({ runner_id: 'intake-runner', protocol_version: RUNNER_PROTOCOL_VERSION,
        status: 'READY', resource_enforcement: 'REQUIRED', capabilities: { controlled_validation: 1, source_archive_upload: 1 } })); })();
    } else if (url.pathname === '/machine') res.end(JSON.stringify({ hostname: 'fixture', architecture: 'x64', cpu_count: 2, machine_identity_sha256: 'a'.repeat(64) }));
    else if (url.pathname === '/source-archives' && req.method === 'PUT') {
      const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(Buffer.from(chunk))); req.on('end', () => {
        const bytes = Buffer.concat(chunks); res.end(JSON.stringify({ workspace_path: url.searchParams.get('workspace_path'), archive_sha256: createHash('sha256').update(bytes).digest('hex'),
          archive_bytes: bytes.length, source_sha256: 'b'.repeat(64) }));
      });
    } else if (url.pathname === '/experiments' && req.method === 'POST') {
      const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(Buffer.from(chunk))); req.on('end', () => {
        submissions++; const plan = JSON.parse(Buffer.concat(chunks).toString());
        res.end(JSON.stringify({ experiment_id: plan.experiment.experiment_id, status: 'PENDING' }));
      });
    } else if (url.pathname.endsWith('/cancel')) { cancels++; res.end('{}'); }
    else { res.writeHead(404); res.end(JSON.stringify({ error: { code: 'EXPERIMENT_NOT_FOUND', message: 'fixture' } })); }
  });
  await new Promise<void>(resolve => runner.listen(0, '127.0.0.1', resolve));
  try {
    const addr = runner.address(); assert.ok(addr && typeof addr === 'object');
    const project = f.projects.add({ name: 'Trial idempotency', repository_root: f.repo });
    const discovered = await f.projects.discover(project.project_id, 'kernel', { command: 'node -e "process.exit(0)"', cwd: '.' });
    const packageId = discovered.evidence.generated.package_id, version = discovered.evidence.generated.version, targetId = discovered.targets[0].target_id;
    const validRunner = { mode: 'rpc' as const, endpoint: `http://127.0.0.1:${addr.port}`, token: 'fixture', request_timeout_ms: 10_000, poll_interval_ms: 100 };
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), runner: validRunner });
    const transport = () => ({ async runRemote(argv: string[]) { return { command: argv[0], argv, exit_code: 0, stderr: '', stdout: '' }; },
      uploadFile() { return { exit_code: 0, stderr: '' }; } });
    let trials = new ValidationTrialService(f.dataDir, f.projects.machines, transport);
    (f.projects as unknown as { validationTrials: ValidationTrialService }).validationTrials = trials;
    const api = new ApiClient(f.url, { token: f.token });
    const input = { package_id: packageId, package_version: version, target_id: targetId, purpose: 'BASELINE_BUILD',
      source_branch: 'main', build: { command: 'node -e "process.exit(0)"', cwd: '.' } };
    async function lookup(key: string, close = false) {
      const response = await fetch(`${f.url}/v1/projects/${project.project_id}/validation-trial-request${close ? '/close' : ''}`, {
        method: close ? 'POST' : 'GET', headers: { authorization: `Bearer ${f.token}`, 'idempotency-key': key, ...(close ? { 'content-type': 'application/json' } : {}) },
        ...(close ? { body: '{}' } : {}) });
      assert.equal(response.status, 200); return await response.json() as { state: string; trial_id?: string };
    }
    const one = api.startProjectTrial(project.project_id, input, 'same-request');
    const two = api.startProjectTrial(project.project_id, { ...input, build: { cwd: '.', command: input.build.command } }, 'same-request');
    for (let i = 0; i < 100 && (await lookup('same-request')).state !== 'PREPARING'; i++) await delay(10);
    assert.equal((await lookup('same-request')).state, 'PREPARING');
    const secondInstance = new ValidationTrialService(f.dataDir, f.projects.machines, transport);
    const three = secondInstance.start(project, packageId, version, targetId, 'main', 'BASELINE_BUILD', { build: input.build, requestId: 'same-request' });
    await assert.rejects(api.startProjectTrial(project.project_id, { ...input, source_branch: 'other' }, 'same-request'),
      (error: unknown) => error instanceof ApiClientError && error.status === 409 && error.code === 'TRIAL_REQUEST_CONFLICT');
    release(); probeGate = null;
    const [first, repeated, third] = await Promise.all([one, two, three]) as Array<{ trial_id: string; source_commit: string }>;
    assert.equal(first.trial_id, repeated.trial_id);
    assert.equal(first.trial_id, third.trial_id);
    assert.equal(healthRequests, 1, 'same-key concurrent callers share the same preflight');
    for (let i = 0; i < 200 && submissions < 1; i++) await delay(20);
    assert.equal(submissions, 1);
    assert.deepEqual(await lookup('same-request'), { state: 'CREATED', trial_id: first.trial_id });
    assert.deepEqual(await lookup('same-request', true), { state: 'CREATED', trial_id: first.trial_id });
    assert.equal(cancels, 0, 'closing a created request must never cancel the Runner');
    await assert.rejects(api.startProjectTrial(project.project_id, { ...input, build: { ...input.build, command: 'different command' } }, 'same-request'),
      (error: unknown) => error instanceof ApiClientError && error.code === 'TRIAL_REQUEST_CONFLICT');

    const trialsRoot = path.join(f.dataDir, 'projects', project.project_id, 'validation-trials');
    fs.writeFileSync(path.join(trialsRoot, 'orphan.tmp'), 'interrupted write');
    fs.writeFileSync(path.join(f.repo, 'kernel.c'), 'int kernel(void) { return 3; }\n'); f.git('add', 'kernel.c'); f.git('commit', '-m', 'advance branch');
    const draft = f.projects.validationAssets.get(project, packageId, version, targetId);
    const changed = f.projects.validationAssets.save(project, packageId, version, targetId, { ...draft, source: 'edited', expected_digest: draft.evaluator_digest,
      test_plan: { ...draft.test_plan, seed: draft.test_plan.seed + 1 } });
    assert.notEqual(changed.evaluator_digest, draft.evaluator_digest);
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), runner: { ...validRunner, endpoint: 'http://127.0.0.1:1' } });
    trials = new ValidationTrialService(f.dataDir, f.projects.machines, transport);
    (f.projects as unknown as { validationTrials: ValidationTrialService }).validationTrials = trials;
    const replay = await api.startProjectTrial(project.project_id, input, 'same-request') as { trial_id: string; source_commit: string };
    assert.equal(replay.trial_id, first.trial_id); assert.equal(replay.source_commit, first.source_commit);
    assert.notEqual(replay.source_commit, f.git('rev-parse', 'HEAD'));
    const processReplay = `import fs from 'node:fs'; import {ValidationTrialService} from './src/application/validation-trial-service.ts';
const data=JSON.parse(fs.readFileSync(0,'utf8')); const machines={resolve(){throw new Error('replay must not access a machine')}};
const service=new ValidationTrialService(data.dir,machines); const i=data.input;
console.log(JSON.stringify(await service.start(data.project,i.package_id,i.package_version,i.target_id,i.source_branch,i.purpose,{build:i.build,requestId:'same-request'})));`;
    const child = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', processReplay], {
      cwd: process.cwd(), input: JSON.stringify({ dir: f.dataDir, project, input }), encoding: 'utf8', windowsHide: true });
    assert.equal(JSON.parse(child).trial_id, first.trial_id, 'a new process recovers the committed request without probing Runner');
    assert.equal(submissions, 1);
    assert.equal(trials.list(project).length, 1, 'temporary and request files do not become trial records');

    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), runner: validRunner });
    probeGate = new Promise<void>(resolve => { release = resolve; });
    const beforeProbe = healthRequests;
    const racing = api.startProjectTrial(project.project_id, input, 'close-race');
    for (let i = 0; i < 100 && healthRequests === beforeProbe; i++) await delay(10);
    assert.equal((await lookup('close-race')).state, 'PREPARING');
    assert.equal((await lookup('close-race', true)).state, 'CLOSED');
    release(); probeGate = null;
    await assert.rejects(racing, (error: unknown) => error instanceof ApiClientError && error.code === 'TRIAL_REQUEST_CLOSED');
    assert.equal(submissions, 1);
    assert.equal((await lookup('never-arrived')).state, 'NOT_FOUND');
    assert.equal((await lookup('never-arrived', true)).state, 'CLOSED');
    await assert.rejects(api.startProjectTrial(project.project_id, input, 'never-arrived'),
      (error: unknown) => error instanceof ApiClientError && error.code === 'TRIAL_REQUEST_CLOSED');

    const cliArgs = ['project', 'baseline-branch', project.project_id, packageId, version, targetId, '--branch', 'main', '--request-id', 'cli-request'];
    const futureId = trialRequestIdentity(project.project_id, 'cli-request').trialId.slice('validation:'.length);
    const staleTemp = path.join(trialsRoot, `${futureId}.json.interrupted.tmp`);
    fs.writeFileSync(staleTemp, 'partial temporary data');
    const cliOne = await runFixtureCli(f.url, f.token, cliArgs); assert.equal(cliOne.code, 0, cliOne.stderr);
    const cliTwo = await runFixtureCli(f.url, f.token, cliArgs); assert.equal(cliTwo.code, 0, cliTwo.stderr);
    assert.equal(JSON.parse(cliOne.stdout).trial_id, JSON.parse(cliTwo.stdout).trial_id);
    assert.notEqual(JSON.parse(cliOne.stdout).trial_id, first.trial_id);
    assert.equal(fs.readFileSync(staleTemp, 'utf8'), 'partial temporary data');
    for (let i = 0; i < 200 && submissions < 2; i++) await delay(20);
    assert.equal(submissions, 2);
  } finally { release?.(); await f.close(); await new Promise<void>(resolve => runner.close(() => resolve())); }
});

test('unsupported hard links fail closed without publishing a partial request', () => {
  fs.mkdirSync(path.join(process.cwd(), 'build'), { recursive: true });
  const f = fs.mkdtempSync(path.join(process.cwd(), 'build', 'trial-storage-'));
  const filename = path.join(f, 'request.json'), original = fs.linkSync;
  try {
    fs.linkSync = (() => { throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }); }) as typeof fs.linkSync;
    assert.throws(() => publishTrialRecord(filename, { value: 1 }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'TRIAL_ATOMIC_STORAGE_UNAVAILABLE');
    assert.equal(fs.existsSync(filename), false); assert.deepEqual(fs.readdirSync(f), []);
  } finally { fs.linkSync = original; fs.rmSync(f, { recursive: true, force: true }); }
});

test('new generated trials validate only the executed APIs, while build-only and existing requests keep their semantics', async () => {
  const f = await startWebFixture(); let submissions = 0;
  const runner = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://runner'); res.setHeader('content-type', 'application/json');
    if (url.pathname === '/health') res.end(JSON.stringify({ runner_id: 'generated-fixture', protocol_version: RUNNER_PROTOCOL_VERSION,
      status: 'READY', resource_enforcement: 'REQUIRED', capabilities: { controlled_validation: 1, source_archive_upload: 1 } }));
    else if (url.pathname === '/machine') res.end(JSON.stringify({ hostname: 'fixture', architecture: 'x64', cpu_count: 2, machine_identity_sha256: 'a'.repeat(64) }));
    else if (url.pathname === '/source-archives' && req.method === 'PUT') {
      const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(Buffer.from(chunk))); req.on('end', () => {
        const bytes = Buffer.concat(chunks); res.end(JSON.stringify({ workspace_path: url.searchParams.get('workspace_path'), archive_sha256: createHash('sha256').update(bytes).digest('hex'),
          archive_bytes: bytes.length, source_sha256: 'b'.repeat(64) }));
      });
    } else if (url.pathname === '/experiments' && req.method === 'POST') {
      const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(Buffer.from(chunk))); req.on('end', () => {
        submissions++; const plan = JSON.parse(Buffer.concat(chunks).toString()); res.end(JSON.stringify({ experiment_id: plan.experiment.experiment_id, status: 'PENDING' }));
      });
    } else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>(resolve => runner.listen(0, '127.0.0.1', resolve));
  try {
    const addr = runner.address(); assert.ok(addr && typeof addr === 'object');
    const project = f.projects.add({ name: 'Generated trial', repository_root: f.repo });
    const discovered = await f.projects.discover(project.project_id, 'kernel', { command: 'node -e "process.exit(0)"', cwd: '.' });
    const packageId = discovered.evidence.generated.package_id, version = discovered.evidence.generated.version, targetId = discovered.targets[0].target_id;
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), runner: { mode: 'rpc', endpoint: `http://127.0.0.1:${addr.port}`, token: 'fixture' } });
    const transport = () => ({ async runRemote(argv: string[]) { return { command: argv[0], argv, exit_code: 0, stderr: '', stdout: '' }; },
      uploadFile() { return { exit_code: 0, stderr: '' }; } });
    const trials = new ValidationTrialService(f.dataDir, f.projects.machines, transport);
    (f.projects as unknown as { validationTrials: ValidationTrialService }).validationTrials = trials;
    const api = new ApiClient(f.url, { token: f.token });
    const original = f.readyValidation(project, packageId, version, targetId);
    const support = [{ path: 'support/corepilot_test.py', content: VALIDATION_PYTHON_HARNESS },
      { path: 'support/test-correctness.py', content: 'from corepilot_test import TestContext\n' },
      { path: 'support/test-performance.py', content: 'from corepilot_test import TestContext\n' }];
    let draft = f.projects.validationAssets.save(project, packageId, version, targetId, { ...original, source: 'edited', expected_digest: original.evaluator_digest,
      correctness_script: generatedTestEntrypoint('correctness'), performance_script: generatedTestEntrypoint('performance'), supporting_files: support,
      test_plan: { ...original.test_plan, resources: { cpu_set: '0', numa_node: 0 }, candidate_api: 'candidate_wrapper', baseline_api: 'baseline_wrapper' } });
    const input = { package_id: packageId, package_version: version, target_id: targetId, source_branch: 'main', mode: 'correctness' };
    const previous = await api.startProjectTrial(project.project_id, input, 'old-accepted') as { trial_id: string };
    for (let i = 0; i < 200 && submissions < 1; i++) await delay(20);
    assert.equal(submissions, 1);
    draft = f.projects.validationAssets.save(project, packageId, version, targetId, { ...draft, source: 'edited', expected_digest: draft.evaluator_digest,
      test_plan: { ...draft.test_plan, candidate_api: '', baseline_api: '' } });
    assert.equal((await api.startProjectTrial(project.project_id, input, 'old-accepted') as { trial_id: string }).trial_id, previous.trial_id);
    await assert.rejects(api.startProjectTrial(project.project_id, input), /候选库实际导出的测试 API/);
    await api.startProjectTrial(project.project_id, { ...input, purpose: 'BASELINE_BUILD' });
    for (let i = 0; i < 200 && submissions < 2; i++) await delay(20);
    assert.equal(submissions, 2, 'a build-only request does not require generated-test API names');
    draft = f.projects.validationAssets.save(project, packageId, version, targetId, { ...draft, source: 'edited', expected_digest: draft.evaluator_digest,
      test_plan: { ...draft.test_plan, candidate_api: 'candidate_wrapper', baseline_api: '' } });
    await assert.rejects(api.startProjectTrial(project.project_id, { ...input, mode: 'comparison' }), /比较基线库实际导出的测试 API/);
    await api.startProjectTrial(project.project_id, input);
    for (let i = 0; i < 200 && submissions < 3; i++) await delay(20);
    assert.equal(submissions, 3, 'correctness-only does not require a baseline API');
    draft = f.projects.validationAssets.save(project, packageId, version, targetId, { ...draft, source: 'edited', expected_digest: draft.evaluator_digest,
      test_plan: { ...draft.test_plan, baseline_api: 'different_wrapper' } });
    await assert.rejects(api.startProjectTrial(project.project_id, { ...input, mode: 'calibration' }),
      (error: unknown) => error instanceof ApiClientError && error.code === 'CALIBRATION_API_MISMATCH' && /同一个 API/.test(error.message));
    draft = f.projects.validationAssets.save(project, packageId, version, targetId, { ...draft, source: 'edited', expected_digest: draft.evaluator_digest,
      test_plan: { ...draft.test_plan, baseline_api: 'candidate_wrapper' } });
    await assert.rejects(api.startProjectTrial(project.project_id, { ...input, mode: 'calibration' }), /重复测量/);
    const oldSupport = support.map(file => file.path === 'support/corepilot_test.py' ? { ...file,
      content: 'class TestContext:\n def emit(self):\n  return {"input_path": self.artifact_path, "resolved_symbol_path": self.artifact_path}\n' } : file);
    draft = f.projects.validationAssets.save(project, packageId, version, targetId, { ...draft, source: 'edited', expected_digest: draft.evaluator_digest,
      supporting_files: oldSupport, test_plan: { ...draft.test_plan, baseline_api: 'baseline_wrapper' } });
    await assert.rejects(api.startProjectTrial(project.project_id, input), /旧版生成适配器/);
    draft = f.projects.validationAssets.save(project, packageId, version, targetId, { ...draft, source: 'edited', expected_digest: draft.evaluator_digest,
      correctness_script: original.correctness_script, performance_script: original.performance_script, supporting_files: [],
      test_plan: { ...draft.test_plan, candidate_api: '', baseline_api: 'different_wrapper' } });
    await api.startProjectTrial(project.project_id, input);
    for (let i = 0; i < 200 && submissions < 4; i++) await delay(20);
    assert.equal(submissions, 4, 'custom evaluator scripts are not forced to use the generated adapter contract');
    await assert.rejects(api.startProjectTrial(project.project_id, { ...input, mode: 'calibration' }), /重复测量/,
      'custom evaluator inputs are not rejected by the generated API-name assumption');
  } finally { await f.close(); await new Promise<void>(resolve => runner.close(() => resolve())); }
});
