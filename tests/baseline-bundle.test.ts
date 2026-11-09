import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import { BaselineBundleService } from '../src/application/baseline-bundle-service.js';
import { loadOptimizationConfig } from '../src/config/optimization-config.js';
import { packageBaselineBinding } from '../src/library-package/task-definition.js';
import { RUNNER_PROTOCOL_VERSION } from '../src/contracts/runner-rpc.js';
import { binaryBundleIdentitySha256, validateBinaryBundleBaselineDefinition } from '../src/library-package/loader.js';
import { ApiClient } from '../src/client/api-client.js';
import type { BaselineImportStatus } from '../src/contracts/baseline-bundle.js';
import { validationBaselineHeaders } from '../src/application/validation-generation.js';

test('CLI and browser API upload the same multi-file baseline, select its entry and preserve draft qualification', async () => {
  const fixture = await startWebFixture();
  const machineHash = 'a'.repeat(64);
  const runner = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') res.end(JSON.stringify({ runner_id: 'fixture', version: '0.4.0',
      protocol_version: RUNNER_PROTOCOL_VERSION, status: 'READY', resource_enforcement: 'REQUIRED' }));
    else if (req.url === '/machine') res.end(JSON.stringify({ hostname: 'fixture', architecture: 'aarch64',
      cpu_count: 4, machine_identity_sha256: machineHash }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => runner.listen(0, '127.0.0.1', resolve));
  try {
    const address = runner.address(); assert.ok(address && typeof address === 'object');
    const project = fixture.projects.add({ name: 'Bundle', repository_root: fixture.repo });
    const discovered = await fixture.projects.discover(project.project_id, 'kernel');
    const packageId = discovered.evidence.generated.package_id;
    const version = discovered.evidence.generated.version;
    const targetId = discovered.targets[0].target_id;
    const config = loadOptimizationConfig(project.config_path).config;
    fixture.projects.saveConfig(project.project_id, { ...config, runner: { mode: 'rpc',
      endpoint: `http://127.0.0.1:${address.port}`, token: 'fixture-secret',
      request_timeout_ms: 10_000, poll_interval_ms: 250 } });
    let requireDependency = false;
    const stage: NonNullable<ConstructorParameters<typeof BaselineBundleService>[3]> = async input => ({ ok: !requireDependency || input.files.some(file => file.path === 'lib/librequired.so'),
      machine_identity_sha256: machineHash, checked_at: new Date().toISOString(),
      entry_sha256: input.files.find(file => file.path === input.entryPath)!.sha256,
      libraries: input.files.filter(file => file.path.endsWith('.so')).map(file => ({ path: file.path,
        sha256: file.sha256, soname: path.basename(file.path), role: 'ENTRY',
        elf: { class: 'ELF64', endian: 'little', machine: 'AArch64', build_id: 'fixture' }, needed: [] })),
      resolved_libraries: input.files.filter(file => file.path.endsWith('.so')).map(file => ({
        soname: path.basename(file.path), path: path.join(input.localRoot, file.path), sha256: file.sha256 })),
      issues: requireDependency && !input.files.some(file => file.path === 'lib/librequired.so') ? ['libdemo.so: 缺少依赖 librequired.so'] : [] });
    (fixture.projects as unknown as { baselineBundles: BaselineBundleService }).baselineBundles =
      new BaselineBundleService(fixture.dataDir, fixture.projects.machines, fixture.projects.validationAssets,
        stage);
    const directory = path.join(fixture.root, 'external');
    fs.mkdirSync(path.join(directory, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'include'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'lib', 'libdemo.so'), 'fixture ELF bytes');
    fs.writeFileSync(path.join(directory, 'include', 'demo.h'), 'void demo(void);');
    const cli = await runFixtureCli(fixture.url, fixture.token, ['project', 'baseline-bundle', project.project_id,
      packageId, version, targetId, '--directory', directory, '--entry', 'lib/libdemo.so',
      '--library-name', 'External fixture', '--library-version', '2.0']);
    assert.equal(cli.code, 0, cli.stderr);
    const bound = JSON.parse(cli.stdout) as { ok: boolean; baseline: { sha256: string }; artifact_path: string };
    assert.equal(bound.ok, true);
    assert.equal(fs.readFileSync(bound.artifact_path, 'utf8'), 'fixture ELF bytes');
    const selected = fixture.projects.packageLoader.resolveSelection({ package_id: packageId,
      package_version: version, target_id: targetId });
    const binding = packageBaselineBinding(selected, bound.artifact_path);
    assert.equal(binding.bundle?.state, 'VERIFIED');
    assert.equal(binding.bundle?.libraries[0].role, 'ENTRY');
    assert.equal(selected.bundle.qualification.status, 'DRAFT');
    assert.equal(loadOptimizationConfig(project.config_path).config.validation.baseline_artifact, bound.artifact_path);
    assert.equal(bound.baseline.sha256, binding.bundle?.sha256);
    const aliases = structuredClone(binding.bundle!);
    aliases.libraries.push({ ...aliases.libraries[0], path: 'lib/libdemo.so.1', role: 'OTHER' });
    aliases.sha256 = binaryBundleIdentitySha256(aliases);
    assert.doesNotThrow(() => validateBinaryBundleBaselineDefinition(aliases));
    aliases.libraries[1].sha256 = 'b'.repeat(64);
    aliases.sha256 = binaryBundleIdentitySha256(aliases);
    assert.throws(() => validateBinaryBundleBaselineDefinition(aliases), /conflicting bytes for SONAME/);
    const response = await fetch(`${fixture.url}/v1/projects/${project.project_id}/baseline-bundles/${JSON.parse(cli.stdout).bundle_id}`,
      { headers: { authorization: `Bearer ${fixture.token}` } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { entries: string[] }).entries, ['lib/libdemo.so']);
    const api = new ApiClient(fixture.url, { token: fixture.token });
    const base = 'baseline-bundles';
    const create = async (label: string) => await api.projectAction(project.project_id, base, { package_id: packageId,
      package_version: version, target_id: targetId, library: label, library_version: '3.0' }) as { bundle_id: string };
    const upload = async (id: string, relative: string, bytes: string) => {
      const r = await fetch(`${fixture.url}/v1/projects/${project.project_id}/${base}/${id}/files?path=${encodeURIComponent(relative)}`,
        { method: 'PUT', headers: { authorization: `Bearer ${fixture.token}` }, body: bytes });
      assert.equal(r.status, 200, await r.text());
    };
    const pending = await create('External reviewed');
    const endpoint = `${base}/${pending.bundle_id}`;
    const baselineBefore = selected.target.artifacts.baseline.sha256;
    requireDependency = true;
    await upload(pending.bundle_id, 'lib/libdemo.so', 'new main library');
    await upload(pending.bundle_id, 'include/demo.h', 'void external_version_three(void);');
    await assert.rejects(api.projectAction(project.project_id, `${endpoint}/bind`, { entry_path: 'lib/libdemo.so' }), /先在目标机检查/);
    const failed = await api.projectAction(project.project_id, `${endpoint}/check`, { entry_path: 'lib/libdemo.so' }) as { ok: boolean };
    assert.equal(failed.ok, false);
    let status = await api.projectAction(project.project_id, endpoint) as BaselineImportStatus;
    assert.equal(status.state, 'CHECK_FAILED');
    assert.match(status.check!.inspection!.issues[0], /librequired/);
    assert.equal(fixture.projects.packageLoader.resolveSelection({ package_id: packageId, package_version: version, target_id: targetId }).target.artifacts.baseline.sha256,
      baselineBefore, 'upload and failed checking cannot replace the current comparison');
    // A restarted Control process reads the actual failed check and resumes the same import.
    (fixture.projects as unknown as { baselineBundles: BaselineBundleService }).baselineBundles =
      new BaselineBundleService(fixture.dataDir, fixture.projects.machines, fixture.projects.validationAssets, stage);
    const restored = await api.projectAction(project.project_id, `${base}?package_id=${packageId}&package_version=${version}&target_id=${targetId}`) as { imports: BaselineImportStatus[] };
    assert.equal(restored.imports[0].state, 'CHECK_FAILED');
    await upload(pending.bundle_id, 'lib/librequired.so', 'new dependency');
    assert.equal((await api.projectAction(project.project_id, endpoint) as BaselineImportStatus).state, 'UPLOADING', 'new files invalidate the prior check');
    await api.projectAction(project.project_id, `${endpoint}/check`, { entry_path: 'lib/libdemo.so' });
    status = await api.projectAction(project.project_id, endpoint) as BaselineImportStatus;
    assert.equal(status.state, 'READY');
    assert.equal(fixture.projects.config(project.project_id).validation.baseline_artifact, bound.artifact_path, 'successful checks still do not bind');
    await assert.rejects(api.projectAction(project.project_id, `${endpoint}/bind`, { entry_path: 'lib/librequired.so' }), /先在目标机检查/);
    const oldConfig = loadOptimizationConfig(project.config_path).config;
    fixture.projects.saveConfig(project.project_id, { ...oldConfig, target: { ...oldConfig.target, workspace_root: '/changed-workspace' } });
    await assert.rejects(api.projectAction(project.project_id, `${endpoint}/bind`, { entry_path: 'lib/libdemo.so' }), /配置已变化/);
    fixture.projects.saveConfig(project.project_id, oldConfig);
    const stale = await create('Stale upload');
    await upload(stale.bundle_id, 'lib/libdemo.so', 'other library');
    requireDependency = false;
    await api.projectAction(project.project_id, `${base}/${stale.bundle_id}/check`, { entry_path: 'lib/libdemo.so' });
    const fixed = await api.projectAction(project.project_id, `${endpoint}/bind`, { entry_path: 'lib/libdemo.so' }) as { baseline: { sha256: string }; artifact_path: string };
    assert.notEqual(fixed.baseline.sha256, baselineBefore);
    assert.equal((await api.projectAction(project.project_id, endpoint) as BaselineImportStatus).state, 'BOUND');
    assert.equal(fixture.projects.config(project.project_id).validation.baseline_artifact, fixed.artifact_path);
    await assert.rejects(api.projectAction(project.project_id, `${base}/${stale.bundle_id}/bind`, { entry_path: 'lib/libdemo.so' }), /已被其他操作更换/);
    const current = fixture.projects.packageLoader.resolveSelection({ package_id: packageId, package_version: version, target_id: targetId });
    assert.equal(current.target.artifacts.baseline.sha256, fixed.baseline.sha256);
    assert.equal(validationBaselineHeaders(project, current, [])[0].content, 'void external_version_three(void);');
    assert.equal(current.bundle.qualification.status, 'DRAFT');
    const again = await api.projectAction(project.project_id, `${endpoint}/bind`, { entry_path: 'lib/libdemo.so' }) as { baseline: { sha256: string } };
    assert.equal(again.baseline.sha256, fixed.baseline.sha256, 'repeating an explicit bind is idempotent');
  } finally { await fixture.close(); await new Promise<void>(resolve => runner.close(() => resolve())); }
});
