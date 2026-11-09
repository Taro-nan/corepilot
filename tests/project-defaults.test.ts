import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { initialOptimizationWorkflowRecord } from '../src/workflow/optimization-workflow.js';
import { runFixtureCli, startWebFixture } from './web-fixture.js';

test('project defaults are shared by public requests without checking out or changing existing validation', async () => {
  const f = await startWebFixture();
  try {
    f.git('branch', 'feature/other');
    const project = f.projects.add({ name: 'Defaults', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
    const api = new ApiClient(f.url, { token: f.token });
    const originalValidation = f.projects.config(project.project_id).validation;
    const prior = initialOptimizationWorkflowRecord('workflow:previous', { functionName: 'kernel', entryFile: null, configPath: f.configPath, repositoryRoot: f.repo, enablePerformance: false });
    const priorJson = JSON.stringify({ ...prior, status: 'FAILED', source_branch: 'main' });
    f.store.saveOptimizationWorkflowJson(prior.workflow_id, priorJson);
    const machine = f.projects.machines.save({ name: 'Fixture CPU', runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:1', token: 'unused' } });
    await api.projectAction(project.project_id, 'defaults', { source_branch: 'feature/other' }, 'PUT');
    await api.projectAction(project.project_id, 'defaults', { function_name: 'kernel_other' }, 'PUT');
    await assert.rejects(api.projectAction(project.project_id, 'check', {}), /differs from testpack function/);
    const cli = await runFixtureCli(f.url, f.token, ['optimize', '--project', project.project_id]);
    assert.notEqual(cli.code, 0);
    assert.match(cli.stderr, /kernel_other.*differs from testpack function/);
    await api.projectAction(project.project_id, 'machine', { machine_id: machine.machine_id }, 'PUT');
    const updated = (await api.listProjects()).projects.find(item => item.project_id === project.project_id)!;
    assert.equal(updated.source_branch, 'feature/other');
    assert.equal(updated.default_function, 'kernel_other');
    const request = f.projects.request(project.project_id, {});
    assert.equal(request.source_branch, 'feature/other');
    assert.equal(request.function_name, 'kernel_other');
    assert.equal(request.machine_id, machine.machine_id);
    assert.deepEqual(f.projects.config(project.project_id).validation, originalValidation);
    assert.equal(f.projects.request(project.project_id, { function_name: 'kernel', source_branch: 'main' }).function_name, 'kernel');
    assert.equal(f.git('branch', '--show-current'), 'main');
    await assert.rejects(api.projectAction(project.project_id, 'defaults', { source_branch: 'missing' }, 'PUT'), /找不到本地 Git 分支/);
    await assert.rejects(api.projectAction(project.project_id, 'defaults', { function_name: ' ' }, 'PUT'), /目标函数/);
    assert.equal(f.projects.get(project.project_id).source_branch, 'feature/other');
    assert.equal(f.projects.get(project.project_id).default_function, 'kernel_other');
    assert.equal(f.store.getOptimizationWorkflowJson(prior.workflow_id), priorJson);
    assert.equal(f.service.list().length, 1);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});
