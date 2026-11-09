import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { loadOptimizationConfig, resolveRunnerConfig } from '../src/config/optimization-config.js';
import { parseOptimizeCliInput } from '../src/config/optimize-cli-input.js';
import { LibraryPackageLoader } from '../src/library-package/loader.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import type { DirectoryListing, RunnerConnectionCheck } from '../src/contracts/project.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import { createCandidateWorkspace, checkpointCandidate } from '../src/workspace/candidate-workspace.js';
import { runFixtureDelivery } from './delivery-git-fixture.js';

test('browser session and CLI Bearer share projects, config, workflow IDs, reports, cancel and durable idempotency', async () => {
  const f = await startWebFixture();
  try {
    assert.equal((await fetch(f.url + '/')).status, 200);
    assert.equal((await fetch(f.url + '/v1/health')).status, 200);
    assert.equal((await fetch(f.url + '/v1/projects')).status, 401);
    assert.equal((await fetch(f.url + '/v1/session', { method: 'POST', body: JSON.stringify({ token: 'wrong' }) })).status, 401);
    const login = await fetch(f.url + '/v1/session', { method: 'POST', headers: { origin: f.url, 'x-forwarded-proto': 'https' }, body: JSON.stringify({ token: f.token }) });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie')!; assert.match(setCookie, /HttpOnly; SameSite=Strict/); assert.match(setCookie, /Secure/);
    const cookie = setCookie.split(';')[0];
    const browser = (p: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(f.url + p, { method,
      headers: { cookie, origin: f.url, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await browser('/v1/projects', 'POST', { name: 'Browser project', repository_root: f.repo, config_path: f.configPath });
    assert.equal(result.status, 201); const { project } = await result.json();
    const cli = await runFixtureCli(f.url, f.token, ['project', 'list']);
    assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).projects[0].project_id, project.project_id);
    const api = new ApiClient(f.url, { token: f.token });
    const config = (await (await browser(`/v1/projects/${project.project_id}/config`)).json()).config;
    assert.equal(config.model.api_key, '[redacted]'); assert.doesNotMatch(JSON.stringify(config), /fixture-model-secret/);
    config.model.model_id = 'changed-model';
    assert.equal((await browser(`/v1/projects/${project.project_id}/config`, 'PUT', { config })).status, 200);
    assert.equal(loadOptimizationConfig(f.configPath).config.model.api_key, 'fixture-model-secret');
    assert.equal(loadOptimizationConfig(f.configPath).config.model.model_id, 'changed-model');
    const bad = await browser(`/v1/projects/${project.project_id}/config`, 'PUT', { config: { ...config, model: { ...config.model, endpoint: 'invalid endpoint' } } });
    assert.equal(bad.status, 400); assert.equal(loadOptimizationConfig(f.configPath).config.model.endpoint, config.model.endpoint);
    const payload = { project_id: project.project_id, enable_performance: true, candidate_scope: { include: ['kernel.c'], exclude: [] } };
    const submitted = await browser('/v1/workflows', 'POST', payload, { 'idempotency-key': 'shared-retry' }); assert.equal(submitted.status, 202);
    const { workflow_id: id } = await submitted.json();
    const replay = await api.submitOptimizationWorkflow(payload, { requestId: 'shared-retry' }) as { workflow_id: string };
    assert.equal(replay.workflow_id, id); assert.equal((await api.listOptimizationWorkflows()).workflows.length, 1);
    const recreated = new OptimizationWorkflowService({ store: f.store, transportFactory: () => { throw new Error('must not execute on replay'); } });
    assert.equal(recreated.submitPublic(f.projects.request(project.project_id, { enable_performance: true, candidate_scope: payload.candidate_scope }), { requestId: 'shared-retry' }).workflowId, id);
    const mismatch = await browser('/v1/workflows', 'POST', { ...payload, enable_performance: false }, { 'idempotency-key': 'shared-retry' });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).error.code, 'WORKFLOW_REQUEST_CONFLICT');
    const cliReport = await runFixtureCli(f.url, f.token, ['workflow', 'report', id, '--json']); assert.equal(cliReport.code, 0, cliReport.stderr);
    const webReport = await (await browser(`/v1/workflows/${encodeURIComponent(id)}/report`)).json();
    assert.deepEqual(JSON.parse(cliReport.stdout).workflow, webReport.report.workflow);
    const status = await runFixtureCli(f.url, f.token, ['workflow', 'status', id, '--json']);
    assert.equal(JSON.parse(status.stdout).execution_attached, false);
    const watch = await runFixtureCli(f.url, f.token, ['workflow', 'watch', id, '--timeout', '1', '--interval', '0.1']);
    assert.equal(watch.code, 1); assert.match(watch.stdout + watch.stderr, /未接管/);
    const cancellation = await browser(`/v1/workflows/${encodeURIComponent(id)}/cancel`, 'POST', {});
    assert.equal(cancellation.status, 409, 'a detached/non-executing task cannot claim cancellation was accepted');
    assert.equal((await cancellation.json()).error.code, 'WORKFLOW_NOT_ACTIVE');
    assert.equal((await api.listOptimizationWorkflows()).workflows[0].status, 'CREATED');
    const controllers = (f.service as unknown as { controllers: Map<string, AbortController> }).controllers;
    const pendingCancel = new AbortController(); controllers.set(id, pendingCancel);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const requested = await browser(`/v1/workflows/${encodeURIComponent(id)}/cancel`, 'POST', {});
        assert.equal(requested.status, 202);
        assert.equal((await requested.json()).status, 'CANCEL_REQUESTED');
      }
      assert.equal(pendingCancel.signal.aborted, true);
      assert.equal(f.service.get(id)?.status, 'CREATED', 'a request alone does not establish a terminal outcome');
    } finally { controllers.delete(id); }
    const second = await runFixtureCli(f.url, f.token, ['optimize', '--project', project.project_id, '--performance', '--allow', 'kernel.c']);
    assert.equal(second.code, 0, second.stderr); const secondId = second.stdout.match(/workflow:[\w-]+/)![0];
    assert.equal((await (await browser(`/v1/workflows/${encodeURIComponent(secondId)}`)).json()).workflow.config_path, f.configPath);
    const crossed = await browser('/v1/projects', 'POST', {}, { origin: 'http://different.invalid' }); assert.equal(crossed.status, 403);
    assert.equal((await fetch(f.url + '/v1/projects', { headers: { cookie: cookie + '-tamper' } })).status, 401);
    const rootHtml = await (await fetch(f.url + '/')).text(); assert.match(rootHtml, /CorePilot/);
    assert.equal((await fetch(f.url + '/unknown-page')).status, 200);
    assert.equal((await fetch(f.url + '/%2e%2e%2fpackage.json')).status, 404);
    assert.equal((await fetch(f.url + '/v1/unknown')).status, 401);
    assert.equal((await browser('/v1/unknown')).status, 404);
    assert.equal((await browser('/v1/session', 'DELETE')).status, 200);
  } finally { await f.close(); }
});

test('a new project is editable immediately, preserves secrets and Package ownership, and discovers drafts through the shared loader', async () => {
  const f = await startWebFixture();
  try {
    const p = f.projects.add({ name: 'Fresh project', repository_root: f.repo });
    const c = f.projects.config(p.project_id); assert.equal(c.build.executable, ''); assert.equal(c.validation.testpack, '');
    assert.ok((await f.projects.directories('')).path);
    const secret = { ...c, model: { ...c.model, api_key: 'first-key', proxy: 'http://user:password@localhost:8080' }, runner: { mode: 'rpc' as const, endpoint: 'http://localhost:4327', token: 'runner-secret', request_timeout_ms: 1000, poll_interval_ms: 100 } };
    f.projects.saveConfig(p.project_id, secret);
    const masked = f.projects.config(p.project_id); assert.equal(masked.runner?.mode === 'rpc' && masked.runner.token, '[redacted]');
    f.projects.saveConfig(p.project_id, { ...masked, model: { ...masked.model, model_id: 'other' } });
    const preserved = loadOptimizationConfig(p.config_path).config;
    assert.equal(preserved.model.api_key, 'first-key'); assert.equal(preserved.model.proxy, secret.model.proxy);
    assert.equal(preserved.runner?.mode === 'rpc' && preserved.runner.token, 'runner-secret');
    const packageConfig = { ...masked, validation: { testpack: '', library_package: { package_id: 'example-vector', package_version: '0.1.0', target_id: 'vector-scale-add' }, baseline_artifact: '/tmp/base.so' } };
    f.projects.saveConfig(p.project_id, packageConfig);
    assert.doesNotMatch(fs.readFileSync(p.config_path, 'utf8'), /^build:|^  testpack:/m);
    const discovery = await f.projects.discover(p.project_id, 'kernel'); assert.equal(discovery.state, 'DRAFT');
    const loader = new LibraryPackageLoader({ catalogRoot: path.join(f.dataDir, 'catalog') });
    const drafts = loader.listPackages().filter(p => p.package_id.startsWith('project-')); assert.equal(drafts.length, 1);
    assert.equal(drafts[0].qualification.state, 'DRAFT');
    assert.throws(() => loader.resolveSelection({ package_id: drafts[0].package_id, package_version: drafts[0].version, target_id: loader.loadPackage(drafts[0].package_id, drafts[0].version).manifest.targets[0].target_id }, { requireQualified: true }));
    assert.ok(loader.listPackages().some(p => p.package_id === 'ftblas'));
    assert.equal(f.projects.add({ name: 'again', repository_root: f.repo }).project_id, p.project_id);
  } finally { await f.close(); }
});

test('unfinished project configuration stays editable and requires a real testpack and build before preflight succeeds', async () => {
  const f = await startWebFixture();
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const { project } = await api.addProject({ name: 'Setup', repository_root: f.repo, source_branch: 'main' });
    const initial = f.projects.config(project.project_id);
    assert.equal(initial.validation.testpack, ''); assert.equal(initial.build.executable, '');
    assert.equal(fs.existsSync(path.join(f.repo, 'testpacks', 'domain.yaml')), false);
    const known = loadOptimizationConfig(f.configPath).config;
    const partial = await api.projectAction(project.project_id, 'config', { config: { ...initial, model: known.model } }, 'PUT') as { config: typeof initial };
    assert.equal(partial.config.model.model_id, known.model.model_id);
    assert.equal(partial.config.validation.testpack, '');
    await assert.rejects(api.projectAction(project.project_id, 'check', {}), /尚未配置测试方案.*构建与验证/);
    await assert.rejects(api.submitOptimizationWorkflow({ project_id: project.project_id, function_name: 'kernel' }), /尚未配置测试方案/);
    const missing = path.join(f.repo, 'testpacks', 'domain.yaml');
    f.projects.saveConfig(project.project_id, { ...partial.config, validation: { testpack: missing } });
    await assert.rejects(api.projectAction(project.project_id, 'check', {}), error => {
      assert.match((error as Error).message, /测试方案文件不存在/);
      assert.ok((error as Error).message.includes(missing));
      assert.doesNotMatch((error as Error).message, /ENOENT|cannot read testpack/);
      return true;
    });
    await assert.rejects(api.submitOptimizationWorkflow({ project_id: project.project_id, function_name: 'kernel' }), /测试方案文件不存在/);
    assert.equal(fs.existsSync(missing), false);
    f.projects.saveConfig(project.project_id, { ...partial.config, validation: known.validation });
    await assert.rejects(api.projectAction(project.project_id, 'check', {}), /尚未配置构建命令/);
    f.projects.saveConfig(project.project_id, { ...known });
    const checked = await api.projectAction(project.project_id, 'check', { candidate_scope: { include: ['kernel.c'], exclude: [] } }) as { message: string; function_name: string };
    assert.equal(checked.function_name, 'kernel'); assert.match(checked.message, /输入检查通过/);
    assert.equal(f.service.list().length, 0);
  } finally { await f.close(); }
});

test('model discovery previews unsaved connections through the shared API without saving or invoking inference', async () => {
  const f = await startWebFixture();
  const previousKey = process.env.COREPILOT_MODEL_API_KEY;
  delete process.env.COREPILOT_MODEL_API_KEY;
  try {
    const p = f.projects.add({ name: 'Models', repository_root: f.repo, config_path: f.configPath });
    const api = new ApiClient(f.url, { token: f.token });
    const config = f.projects.config(p.project_id);
    const original = fs.readFileSync(f.configPath, 'utf8');
    const discover = (model?: unknown) => api.projectAction(p.project_id, 'models', model === undefined ? {} : { model }) as Promise<{ models: Array<{ id: string }> }>;
    assert.equal((await discover()).models[0].id, 'fixture-model');
    assert.equal((await discover({ endpoint: config.model.endpoint + '/', api_key: '[redacted]', proxy: '' })).models[0].id, 'fixture-model');
    assert.equal(f.modelRequests.lists.at(-1)?.authorization, 'Bearer fixture-model-secret');
    const alternate = config.model.endpoint.replace('/v1', '/alternate');
    assert.equal((await discover({ endpoint: alternate, api_key: 'draft-only-key' })).models[0].id, 'alternate-model');
    assert.deepEqual(f.modelRequests.lists.at(-1), { path: '/alternate/models', authorization: 'Bearer draft-only-key' });
    const count = f.modelRequests.lists.length;
    for (const api_key of ['[redacted]', '', undefined]) {
      await assert.rejects(discover({ endpoint: alternate, ...(api_key === undefined ? {} : { api_key }) }), /未找到模型 API Key/);
    }
    for (const model of [null, [], 'invalid', { endpoint: 'not-an-endpoint' }, { api_key: 42 }, { proxy: false }, { model_id: 'irrelevant' }]) {
      const response = await fetch(`${f.url}/v1/projects/${p.project_id}/models`, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
      assert.equal(response.status, 400);
    }
    assert.equal(f.modelRequests.lists.length, count, 'invalid or uncredentialed drafts must not contact the model endpoint');
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
    assert.equal(f.projects.get(p.project_id).updated_at, p.updated_at);
    assert.equal(f.modelRequests.inference, 0);
    assert.equal(f.service.list().length, 0);
    assert.doesNotMatch(JSON.stringify(await discover({ endpoint: alternate, api_key: 'draft-only-key' })), /draft-only-key|fixture-model-secret/);
    f.projects.saveConfig(p.project_id, { ...config, model: { ...config.model, endpoint: alternate } });
    assert.equal(loadOptimizationConfig(f.configPath).config.model.api_key, undefined, 'saving a different endpoint must not reuse a masked key');
  } finally {
    if (previousKey === undefined) delete process.env.COREPILOT_MODEL_API_KEY; else process.env.COREPILOT_MODEL_API_KEY = previousKey;
    await f.close();
  }
});

test('new projects explicitly await RPC setup while imported legacy configurations retain their execution mode', async () => {
  const f = await startWebFixture();
  try {
    const p = f.projects.add({ name: 'RPC setup', repository_root: f.repo });
    const config = f.projects.config(p.project_id);
    assert.equal(config.runner?.mode, 'rpc');
    assert.equal(config.runner?.mode === 'rpc' && config.runner.endpoint, '');
    assert.equal(config.runner?.mode === 'rpc' && config.runner.token, '');
    assert.throws(() => resolveRunnerConfig(config), /尚未配置 Runner RPC 地址/);
    if (config.runner?.mode !== 'rpc') throw new Error('expected RPC setup');
    f.projects.saveConfig(p.project_id, { ...config, runner: { ...config.runner, endpoint: 'http://127.0.0.1:4327' } });
    assert.throws(() => resolveRunnerConfig(loadOptimizationConfig(p.config_path).config), /尚未配置 Runner Token/);
    assert.equal(f.projects.config(p.project_id).runner?.mode === 'rpc' && (f.projects.config(p.project_id).runner as { token: string }).token, '');
    assert.equal(resolveRunnerConfig(loadOptimizationConfig(f.configPath).config).mode, 'legacy');
    assert.equal(f.service.list().length, 0);
  } finally { await f.close(); }
});

test('Runner connection checks use real RPC independently of model, SSH, testpacks and config persistence', async () => {
  const f = await startWebFixture();
  const runner = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'runner-connection-fixture', dbPath: path.join(f.root, 'runner.sqlite'), workspaceRoot: path.join(f.root, 'runner') });
  const incompatible = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'READY', protocol_version: 999 })); });
  await new Promise<void>(resolve => incompatible.listen(0, '127.0.0.1', resolve));
  const incompatibleAddress = incompatible.address(); assert.ok(incompatibleAddress && typeof incompatibleAddress === 'object');
  const envName = 'COREPILOT_RUNNER_CONNECTION_FIXTURE';
  const previousEnv = process.env[envName]; process.env[envName] = 'runner-connection-fixture';
  try {
    const p = f.projects.add({ name: 'RPC connection', repository_root: f.repo });
    const api = new ApiClient(f.url, { token: f.token });
    const original = fs.readFileSync(p.config_path, 'utf8');
    const connection = { mode: 'rpc', endpoint: runner.url, token: 'runner-connection-fixture', request_timeout_ms: 1000, poll_interval_ms: 100 };
    const check = (draft?: unknown) => api.projectAction(p.project_id, 'runner-test', draft === undefined ? {} : { runner: draft }) as Promise<RunnerConnectionCheck>;
    await assert.rejects(check(), /尚未配置 Runner RPC 地址/);
    await assert.rejects(check({ ...connection, token: 'incorrect-token' }), /Runner 认证失败/);
    const checked = await check(connection);
    assert.equal(checked.ok, true); assert.equal(checked.health.status, 'READY');
    assert.equal(checked.health.resource_enforcement, 'DISABLED', 'a successful connection is not a formal resource qualification');
    assert.ok(checked.machine.cpu_count > 0); assert.ok(checked.machine.machine_identity_sha256);
    assert.ok(Date.parse(checked.checked_at));
    assert.doesNotMatch(JSON.stringify(checked), /runner-connection-fixture|fixture-model-secret/);
    assert.equal((await check({ ...connection, token: '${' + envName + '}' })).ok, true);
    await assert.rejects(check({ ...connection, endpoint: `http://127.0.0.1:${incompatibleAddress.port}` }), /协议版本不兼容/);
    for (const draft of [null, [], { ...connection, endpoint: 'ssh://invalid' }, { ...connection, request_timeout_ms: 0 }]) await assert.rejects(check(draft));
    assert.equal(fs.readFileSync(p.config_path, 'utf8'), original, 'connectivity checks do not save unrelated drafts');
    assert.equal(f.projects.get(p.project_id).updated_at, p.updated_at);
    assert.equal(f.modelRequests.inference, 0); assert.equal(f.modelRequests.lists.length, 0); assert.equal(f.service.list().length, 0);
    const saved = f.projects.saveConfig(p.project_id, { ...f.projects.config(p.project_id), runner: connection });
    assert.equal(saved.runner?.mode === 'rpc' && saved.runner.token, '[redacted]');
    assert.equal((await check(saved.runner)).ok, true, 'masked credentials work for the saved endpoint');
    await assert.rejects(check({ ...saved.runner, endpoint: `${runner.url}/other` }), /尚未配置 Runner Token/);
    const moved = f.projects.saveConfig(p.project_id, { ...saved, runner: { ...connection, token: '[redacted]', endpoint: `${runner.url}/other` } });
    assert.equal(moved.runner?.mode === 'rpc' && moved.runner.token, '', 'a masked token cannot move to another endpoint');
  } finally {
    if (previousEnv === undefined) delete process.env[envName]; else process.env[envName] = previousEnv;
    await new Promise<void>(resolve => incompatible.close(() => resolve()));
    await runner.close(); await f.close();
  }
});

test('remote project CLI does not inspect local Git or configuration and rejects ambiguous inputs', () => {
  const parsed = parseOptimizeCliInput(['--project', 'server-project', '--performance', '--watch'], '/nonexistent-client-path');
  assert.equal(parsed.projectId, 'server-project'); assert.equal(parsed.enablePerformance, true); assert.equal(parsed.functionName, '');
  assert.throws(() => parseOptimizeCliInput(['--project', 'server', '--config', 'local.yaml']));
  assert.throws(() => parseOptimizeCliInput(['--project', ' ']));
});

test('project preflight checks the submitted function, accepts repository-relative config, and creates no workflow', async () => {
  const f = await startWebFixture();
  try {
    fs.copyFileSync(f.configPath, path.join(f.repo, 'imported.yaml'));
    const api = new ApiClient(f.url + '/', { token: f.token });
    const { project } = await api.addProject({ name: 'Relative configuration', repository_root: f.repo, config_path: 'imported.yaml' });
    assert.equal(project.config_path, path.join(f.repo, 'imported.yaml'));
    await assert.rejects(api.projectAction(project.project_id, 'check', { function_name: 'wrong_function' }), /wrong_function.*kernel/);
    const valid = await api.projectAction(project.project_id, 'check', { function_name: 'kernel', candidate_scope: { include: ['kernel.c'], exclude: [] } }) as { function_name: string };
    assert.equal(valid.function_name, 'kernel');
    const invalid = await fetch(`${f.url}/v1/projects/${project.project_id}/check`, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ function_name: 123 }) });
    assert.equal(invalid.status, 400);
    assert.equal((await api.listOptimizationWorkflows()).workflows.length, 0);
    await assert.rejects(api.addProject({ name: 'Missing source', repository_root: path.join(f.root, 'missing-source') }), /找不到源码目录/);
  } finally { await f.close(); }
});

test('directory browser exposes disk roots, direct ancestor paths and all child folders', async () => {
  const f = await startWebFixture();
  try {
    const headers = { authorization: `Bearer ${f.token}` };
    const defaults = await (await fetch(`${f.url}/v1/directories`, { headers })).json() as DirectoryListing;
    assert.equal(defaults.path, fs.realpathSync(process.cwd()));
    assert.ok(defaults.roots.some(location => location.kind === 'workspace'));
    assert.ok(defaults.roots.some(location => location.kind === 'home'));
    const directory = path.join(f.root, 'folders'); fs.mkdirSync(directory);
    for (let index = 0; index < 215; index++) fs.mkdirSync(path.join(directory, `folder-${index}`));
    const response = await fetch(`${f.url}/v1/directories?path=${encodeURIComponent(directory)}`, { headers });
    assert.equal(response.status, 200);
    const listing = await response.json() as DirectoryListing;
    assert.equal(listing.directories.length, 215);
    assert.equal(listing.roots.some(root => root.path === path.parse(directory).root), true);
    assert.equal(listing.breadcrumbs[0].path, path.parse(directory).root);
    assert.equal(listing.breadcrumbs.at(-1)?.path, directory);
    const root = await fetch(`${f.url}/v1/directories?path=${encodeURIComponent(listing.roots[0].path)}`, { headers });
    assert.equal(root.status, 200);
    const atRoot = await root.json() as DirectoryListing;
    assert.equal(atRoot.parent, atRoot.path);
  } finally { await f.close(); }
});

test('model discovery accepts normalized package-owned build configuration without saving it', async () => {
  const f = await startWebFixture();
  try {
    const project = f.projects.add({ name: 'Package models', repository_root: f.repo, config_path: f.configPath });
    const d = await f.projects.discover(project.project_id, 'kernel');
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '', library_package: {
      package_id: d.evidence.generated.package_id, package_version: d.evidence.generated.version, target_id: d.targets[0].target_id } } });
    const before = fs.readFileSync(f.configPath, 'utf8');
    const config = f.projects.config(project.project_id);
    const models = await f.projects.discoverModels(project.project_id, { endpoint: config.model.endpoint, api_key: '[redacted]', proxy: '' });
    assert.equal(models.models[0].id, 'fixture-model');
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), before); assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});

test('repository branches, project defaults and CLI branch overrides share frozen source identities', async () => {
  const f = await startWebFixture();
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const main = f.git('rev-parse', 'HEAD');
    f.git('checkout', '-b', 'feature/vector');
    fs.writeFileSync(path.join(f.repo, 'branch.txt'), 'selected branch\n');
    f.git('add', '.'); f.git('commit', '-m', 'Feature branch source');
    const feature = f.git('rev-parse', 'HEAD');
    f.git('checkout', 'main');
    const inspection = await api.inspectRepository(f.repo);
    assert.equal(inspection.current_branch, 'main');
    assert.equal(inspection.branches.find(branch => branch.name === 'feature/vector')?.commit, feature);
    const { project } = await api.addProject({ name: 'Branches', repository_root: f.repo, config_path: f.configPath, source_branch: 'feature/vector' });
    assert.equal(project.source_branch, 'feature/vector');
    const scope = { include: ['kernel.c'], exclude: [] };
    const checked = await api.projectAction(project.project_id, 'check', { candidate_scope: scope }) as { source_branch: string; baseline_commit: string };
    assert.equal(checked.baseline_commit, feature);
    const submitted = await api.submitOptimizationWorkflow({ project_id: project.project_id, candidate_scope: scope }, { requestId: 'branch-request' }) as { workflow_id: string };
    assert.equal(f.service.get(submitted.workflow_id)?.source_branch, 'feature/vector');
    assert.equal(f.service.get(submitted.workflow_id)?.baseline_commit, feature);
    f.git('update-ref', 'refs/heads/feature/vector', main);
    const retried = await api.submitOptimizationWorkflow({ project_id: project.project_id, candidate_scope: scope }, { requestId: 'branch-request' }) as { workflow_id: string };
    assert.equal(retried.workflow_id, submitted.workflow_id);
    assert.equal(f.service.get(retried.workflow_id)?.baseline_commit, feature);
    await assert.rejects(api.submitOptimizationWorkflow({ project_id: project.project_id, source_branch: 'main', candidate_scope: scope }, { requestId: 'branch-request' }), /different optimization inputs/);
    const cli = await runFixtureCli(f.url, f.token, ['optimize', '--project', project.project_id, '--branch', 'main', '--allow', 'kernel.c']);
    assert.equal(cli.code, 0, cli.stderr);
    const cliId = cli.stdout.match(/workflow:[\w-]+/)![0];
    assert.equal(f.service.get(cliId)?.source_branch, 'main');
    assert.equal(f.service.get(cliId)?.baseline_commit, main);
    const legacy = await api.submitOptimizationWorkflow({ config_path: f.configPath, repository_root: f.repo, function_name: 'kernel', entry_file: null, candidate_scope: scope, enable_performance: false }, { requestId: 'legacy-no-branch' }) as { workflow_id: string };
    const legacyDigest = createHash('sha256').update(JSON.stringify({ config_path: f.configPath, function_name: 'kernel', entry_file: null, candidate_scope: scope, repository_root: f.repo, enable_performance: false })).digest('hex');
    assert.equal(f.service.get(legacy.workflow_id)?.request_digest, legacyDigest);
    const invalid = await fetch(`${f.url}/v1/workflows`, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ project_id: project.project_id, source_branch: 123 }) });
    assert.equal(invalid.status, 400);
    await assert.rejects(api.submitOptimizationWorkflow({ project_id: project.project_id, source_branch: 'missing' }), /找不到本地 Git 分支/);
    assert.equal(parseOptimizeCliInput(['--project', project.project_id, '--branch', 'feature/vector']).sourceBranch, 'feature/vector');
    assert.throws(() => parseOptimizeCliInput(['--project', project.project_id, '--branch', ' ']));
    const plain = path.join(f.root, 'plain'); fs.mkdirSync(plain);
    assert.equal((await api.inspectRepository(plain)).is_git, false);
    assert.equal(f.git('branch', '--show-current'), 'main');
  } finally { await f.close(); }
});

test('branch delivery preserves unrelated local files, rejects changed baselines and never merges into another branch', async () => {
  const f = await startWebFixture();
  try {
    const baseline = f.git('rev-parse', 'HEAD');
    f.git('branch', 'feature/delivery');
    const workspace = createCandidateWorkspace({ repository: f.repo, worktreeRoot: path.join(f.root, 'worktrees'), runId: 'branch', baselineCommit: baseline, sourceBranch: 'feature/delivery' });
    fs.writeFileSync(path.join(workspace.editing, 'kernel.c'), 'int kernel(void) { return 2; }\n');
    const checkpoint = checkpointCandidate(workspace);
    workspace.candidate_commit = checkpoint.commit;
    const otherCheckout = path.join(f.root, 'branch-checkout');
    f.git('worktree', 'add', otherCheckout, 'feature/delivery');
    fs.writeFileSync(path.join(otherCheckout, 'private-note.txt'), 'keep me');
    const first = await runFixtureDelivery({ workspace, expectedBaselineCommit: baseline, commitMessage: 'Deliver' });
    assert.equal(f.git('rev-parse', 'feature/delivery'), first.commit);
    assert.equal(first.tree, checkpoint.tree);
    assert.equal(fs.readFileSync(path.join(otherCheckout, 'private-note.txt'), 'utf8'), 'keep me');
    assert.equal(f.git('show', 'feature/delivery:kernel.c').trim(), 'int kernel(void) { return 2; }');
    fs.writeFileSync(path.join(otherCheckout, 'branch-note.txt'), 'new commit');
    f.git('-C', otherCheckout, 'add', '.'); f.git('-C', otherCheckout, 'commit', '-m', 'Branch advanced');
    await assert.rejects(runFixtureDelivery({ workspace, expectedBaselineCommit: baseline, commitMessage: 'Deliver' }), /baseline changed after validation/);
    assert.equal(f.git('rev-parse', 'HEAD'), baseline);
    assert.equal(f.git('branch', '--show-current'), 'main');
    f.git('branch', 'feature/clean', baseline);
    f.git('worktree', 'add', path.join(f.root, 'clean-checkout'), 'feature/clean');
    workspace.source_branch = 'feature/clean';
    const delivered = await runFixtureDelivery({ workspace, expectedBaselineCommit: baseline, commitMessage: 'Deliver to feature' });
    assert.equal(f.git('rev-parse', 'feature/clean'), delivered.commit);
    assert.equal(f.git('rev-parse', 'main'), baseline);
  } finally { await f.close(); }
});
