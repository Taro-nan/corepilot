import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import type { ProjectValidationPlans } from '../src/contracts/project-setup.js';
import { runFixtureCli, startWebFixture } from './web-fixture.js';

test('Web and CLI find only matching project plans and keep each target baseline and qualification separate', async () => {
  const f = await startWebFixture();
  try {
    fs.appendFileSync(path.join(f.repo, 'include', 'kernel.h'), '\nint kernel_extra(void);\n');
    fs.appendFileSync(path.join(f.repo, 'kernel.c'), '\nint kernel_extra(void) { return 3; }\n');
    const project = f.projects.add({ name: 'Plan owner', repository_root: f.repo, config_path: f.configPath });
    const draft = await f.projects.discover(project.project_id, undefined, undefined, ['kernel', 'kernel_extra']);
    const selection = { package_id: draft.evidence.generated.package_id, package_version: draft.evidence.generated.version,
      target_id: draft.targets.find(item => item.symbol === 'kernel_extra')!.target_id };
    const artifact = path.join(f.root, 'comparison.so'), bytes = Buffer.from('comparison fixture');
    fs.writeFileSync(artifact, bytes);
    await f.projects.validationAssets.bindSingleBaseline(project, selection.package_id, selection.package_version, selection.target_id,
      { artifactPath: artifact, sha256: createHash('sha256').update(bytes).digest('hex'), library: 'Fixture baseline', versionLabel: '2', source: { kind: 'upload', detail: 'fixture' } });
    const otherRoot = path.join(f.root, 'other-source');
    fs.mkdirSync(path.join(otherRoot, 'include'), { recursive: true });
    fs.writeFileSync(path.join(otherRoot, 'include', 'other.h'), 'int kernel_extra(void);\n');
    fs.writeFileSync(path.join(otherRoot, 'other.c'), 'int kernel_extra(void) { return 4; }\n');
    const other = f.projects.add({ name: 'Other project', repository_root: otherRoot });
    const otherDraft = await f.projects.discover(other.project_id, 'kernel_extra');
    const before = fs.readFileSync(project.config_path, 'utf8');
    const api = new ApiClient(f.url, { token: f.token });
    const result = await api.projectAction(project.project_id, 'validation-plans?function_name=kernel_extra') as ProjectValidationPlans;
    assert.equal(result.plans.length, 1);
    assert.deepEqual(result.plans[0].selection, selection);
    assert.equal(result.plans[0].current, false);
    assert.equal(result.plans[0].evaluator_state, 'DRAFT');
    assert.equal(result.plans[0].baseline.artifact_path, artifact);
    assert.equal(result.plans[0].baseline.library, 'Fixture baseline');
    assert.ok(!JSON.stringify(result).includes(otherDraft.evidence.generated.package_id));
    assert.equal(result.current_testpack, null);
    const cli = await runFixtureCli(f.url, f.token, ['project', 'validation-plans', project.project_id, '--function', 'kernel_extra']);
    assert.equal(cli.code, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), result);
    const otherFunction = await api.projectAction(project.project_id, 'validation-plans?function_name=kernel') as ProjectValidationPlans;
    assert.equal(otherFunction.plans.length, 1);
    assert.equal(otherFunction.current_testpack?.function_name, 'kernel');
    assert.equal(otherFunction.plans[0].baseline.artifact_path, '');
    assert.equal(fs.readFileSync(project.config_path, 'utf8'), before);
    assert.equal(f.service.list().length, 0);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});
