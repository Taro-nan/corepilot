import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { ProjectService } from '../src/application/project-service.js';

test('managed configuration migration preserves bytes and moves project and workflow references together', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-config-migration-'));
  const store = new SqliteTaskStore(path.join(root, 'control.sqlite')); store.init();
  const directory = path.join(root, 'projects', 'project-1'); fs.mkdirSync(directory, { recursive: true });
  const previous = path.join(directory, 'previous.yaml'), next = path.join(directory, 'corepilot.yaml');
  const bytes = Buffer.from('model:\n  model_id: private-model\n  api_key: unchanged-secret\n');
  fs.writeFileSync(previous, bytes);
  const project = { project_id: 'project-1', name: 'Migration fixture', repository_root: root, config_path: previous, created_at: 'original', updated_at: 'original' };
  const workflow = { workflow_id: 'workflow-1', status: 'DELIVERABLE', config_path: previous, config_file_sha256: 'frozen-config', request_digest: 'frozen-request', execution_contract_digest: 'frozen-contract', delivery: { tree: 'frozen-tree' } };
  store.saveProject(project); store.saveOptimizationWorkflowJson(workflow.workflow_id, JSON.stringify(workflow));
  try {
    new ProjectService(store, root);
    assert.deepEqual(store.getProject(project.project_id), { ...project, config_path: next });
    assert.deepEqual(JSON.parse(store.getOptimizationWorkflowJson(workflow.workflow_id)!), { ...workflow, config_path: next });
    assert.deepEqual(fs.readFileSync(next), bytes);
    assert.equal(fs.existsSync(previous), false);
    new ProjectService(store, root);
    assert.deepEqual(fs.readFileSync(next), bytes, 'restart is idempotent');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('configuration migration refuses conflicting files and rolls back filesystem when persistence fails', () => {
  for (const conflict of [true, false]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-config-conflict-'));
    const store = new SqliteTaskStore(path.join(root, 'control.sqlite')); store.init();
    const directory = path.join(root, 'projects', 'project-1'); fs.mkdirSync(directory, { recursive: true });
    const previous = path.join(directory, 'previous.yaml'), next = path.join(directory, 'corepilot.yaml');
    fs.writeFileSync(previous, 'original config');
    if (conflict) fs.writeFileSync(next, 'different config');
    store.saveProject({ project_id: 'project-1', name: 'Migration fixture', repository_root: root, config_path: previous, created_at: 'original', updated_at: 'original' });
    if (!conflict) store.migrateProjectConfigPath = () => { throw new Error('fixture persistence failure'); };
    try {
      assert.throws(() => new ProjectService(store, root));
      assert.equal(store.getProject('project-1')!.config_path, previous);
      assert.equal(fs.readFileSync(previous, 'utf8'), 'original config');
      assert.equal(fs.existsSync(next), conflict);
      if (conflict) assert.equal(fs.readFileSync(next, 'utf8'), 'different config');
    } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('imported configuration stays at its explicitly selected external path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-config-import-'));
  const store = new SqliteTaskStore(path.join(root, 'control.sqlite')); store.init();
  const config = path.join(root, 'external.yaml'); fs.writeFileSync(config, 'user-owned config');
  store.saveProject({ project_id: 'project-1', name: 'External fixture', repository_root: root, config_path: config, created_at: 'original', updated_at: 'original' });
  try {
    new ProjectService(store, root);
    assert.equal(store.getProject('project-1')!.config_path, config);
    assert.equal(fs.readFileSync(config, 'utf8'), 'user-owned config');
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
