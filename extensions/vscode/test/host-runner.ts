import * as vscode from 'vscode';
import * as fs from 'node:fs';

/** Executed inside an isolated Extension Host using the extracted VSIX. */
export async function run(): Promise<void> {
  const filename = process.env.COREPILOT_EXTENSION_TEST_RESULT;
  if (!filename) throw new Error('Missing isolated test result path');
  try {
    const extension = vscode.extensions.getExtension('corepilot.corepilot-agent-vscode');
    if (!extension) throw new Error('Installed CorePilot extension not found');
    await extension.activate();
    const registered = new Set(await vscode.commands.getCommands(true));
    const expected = ['corepilot.connect', 'corepilot.setToken', 'corepilot.selectProject', 'corepilot.newExperiment',
      'corepilot.initTask', 'corepilot.optimize', 'corepilot.openTesting', 'corepilot.showTasks', 'corepilot.showTaskDetails',
      'corepilot.openReport', 'corepilot.exportTask', 'corepilot.showCandidateDiff', 'corepilot.cancelTask', 'corepilot.refreshTasks'];
    const missing = expected.filter(command => !registered.has(command));
    if (missing.length) throw new Error(`Missing commands: ${missing.join(', ')}`);
    fs.writeFileSync(filename, JSON.stringify({ ok: true, version: extension.packageJSON.version, commands: expected.length }));
  } catch (error) {
    fs.writeFileSync(filename, JSON.stringify({ ok: false, error: (error as Error).message }));
    throw error;
  }
}
