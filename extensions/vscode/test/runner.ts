import * as vscode from 'vscode';
import * as assert from 'node:assert';
import path from 'node:path';

const PHASE = process.env.PHYOPT_PHASE ?? '1';
const SERVER_URL = process.env.PHYOPT_SERVER_URL ?? 'http://127.0.0.1:7346';

async function backendTasks(): Promise<Array<{ task_id: string; status: string; is_mock: boolean; target?: { name?: string }; report_path?: string | null }>> {
  const res = await fetch(SERVER_URL + '/v1/tasks');
  const body = (await res.json()) as { tasks?: Array<{ task_id: string; status: string; is_mock: boolean; target?: { name?: string }; report_path?: string | null }> };
  return body.tasks ?? [];
}

async function submitAndGetTaskId(): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0];
  assert.ok(root, 'no workspace folder');
  // A real user configures a target name in settings before submitting; the
  // extension refuses to submit while `phyopt.target` is empty.
  await vscode.workspace.getConfiguration('phyopt').update('target', 'mock-target', vscode.ConfigurationTarget.Workspace);
  const fixture = vscode.Uri.joinPath(root.uri, 'fixture.c');
  await vscode.workspace.fs.writeFile(fixture, Buffer.from('int fixture;\n'));
  await vscode.commands.executeCommand('phyopt.initTask', fixture);
  await new Promise((r) => setTimeout(r, 800));
  const tasks = await backendTasks();
  assert.ok(tasks.length >= 1, 'expected at least one task');
  // listTasks is newest-first; the just-submitted task is at index 0.
  return tasks[0].task_id;
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('phyopt.phyopt-agent-vscode');
  assert.ok(ext, 'extension not found');
  await ext.activate();

  if (PHASE === '1') {
    // Phase 1: activation + submit a task
    const taskId = await submitAndGetTaskId();
    assert.ok(taskId, 'no task id');
    const tasks = await backendTasks();
    assert.ok(tasks.some((t) => t.is_mock === true), 'task not marked mock');
    process.stdout.write('PHASE1_OK task=' + taskId + '\n');
  } else if (PHASE === '2') {
    // Phase 2: query prior task, open report, cancel a second task
    const tasks = await backendTasks();
    assert.ok(tasks.length >= 1, 'expected prior tasks');

    // open report: set report_path for the first task via backend, then
    // actually invoke phyopt.openReport and assert the opened document URI.
    const reportUri = vscode.Uri.joinPath((vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file('/tmp')), 'report.md');
    await vscode.workspace.fs.writeFile(reportUri, Buffer.from('# report\n'));
    const firstTaskId = tasks[0].task_id;
    const setRes = await fetch(SERVER_URL + '/v1/tasks/' + firstTaskId + '/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ report_path: reportUri.fsPath }) });
    assert.ok(setRes.ok, 'set report endpoint callable');

    await vscode.commands.executeCommand('phyopt.openReport', { summary: { task_id: firstTaskId, request_id: '', status: '', target_name: '', is_mock: false, error: null, report_path: reportUri.fsPath } });
    const active = vscode.window.activeTextEditor;
    assert.ok(active, 'no active editor after openReport');
    assert.equal(path.resolve(active.document.uri.fsPath), path.resolve(reportUri.fsPath));

    // cancel a second running task
    const taskId2 = await submitAndGetTaskId();
    await vscode.commands.executeCommand('phyopt.cancelTask', { summary: { task_id: taskId2, request_id: '', status: '', target_name: '', is_mock: true, error: null, report_path: null } });
    await new Promise((r) => setTimeout(r, 800));
    const after = await backendTasks();
    const cancelled = after.find((t) => t.task_id === taskId2);
    assert.ok(cancelled && (cancelled.status === 'CANCELLED' || cancelled.status === 'CANCEL_REQUESTED'), 'task not cancelled: ' + JSON.stringify(cancelled));
    process.stdout.write('PHASE2_OK task=' + taskId2 + '\n');
  }
}
