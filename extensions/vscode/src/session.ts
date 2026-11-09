import * as vscode from 'vscode';
import { ApiClientError } from '../../../src/client/api-client.js';
import type { ProjectRecord } from '../../../src/contracts/project.js';
import { CorePilotClient, serverKey, serverUrl } from './client.js';

const defaultUrl = 'http://127.0.0.1:4317';
export const configuredUrl = () => serverUrl(vscode.workspace.getConfiguration('corepilot').get<string>('serverUrl', defaultUrl));
const credentialKey = (url: string) => `corepilot.serverToken.${serverKey(url)}`;
const projectKey = (url: string) => `corepilot.project.${serverKey(url)}`;

export async function connect(context: vscode.ExtensionContext): Promise<CorePilotClient> {
  const url = configuredUrl();
  // Read the secret only for this exact configured endpoint.
  return CorePilotClient.connect(url, await context.secrets.get(credentialKey(url)) ?? '');
}

export async function selectProject(context: vscode.ExtensionContext, client: CorePilotClient): Promise<ProjectRecord | null> {
  const projects = await client.projects();
  if (!projects.length) {
    void vscode.window.showInformationMessage('此服务还没有项目。请在 CorePilot 网页中添加源码项目。');
    return null;
  }
  const picked = await vscode.window.showQuickPick(projects.map(project => ({
    label: project.name, description: project.source_branch ?? '未设置分支', detail: `服务端源码目录：${project.repository_root}`, project,
  })), { title: '选择 CorePilot 项目', placeHolder: '项目和路径由已连接的服务提供' });
  if (!picked) return null;
  await context.workspaceState.update(projectKey(client.url), picked.project.project_id);
  return picked.project;
}

export async function selectedProject(context: vscode.ExtensionContext, client: CorePilotClient): Promise<ProjectRecord | null> {
  const id = context.workspaceState.get<string>(projectKey(client.url));
  if (!id) return null;
  return (await client.projects()).find(project => project.project_id === id) ?? null;
}

export async function setToken(context: vscode.ExtensionContext): Promise<void> {
  const url = configuredUrl();
  const token = await vscode.window.showInputBox({ title: 'CorePilot 服务连接令牌',
    prompt: `仅为 ${url} 保存到 VS Code SecretStorage；留空移除已保存的令牌。`, password: true, ignoreFocusOut: true });
  if (token === undefined) return;
  if (token) await context.secrets.store(credentialKey(url), token);
  else await context.secrets.delete(credentialKey(url));
  void vscode.window.showInformationMessage(token ? 'CorePilot 连接令牌已保存。' : 'CorePilot 连接令牌已移除。');
}

export async function showConnectionError(error: unknown): Promise<void> {
  if (error instanceof ApiClientError && error.status === 401) {
    const choice = await vscode.window.showErrorMessage('CorePilot 需要服务连接令牌。请核对服务地址并设置令牌。', '设置令牌');
    if (choice) await vscode.commands.executeCommand('corepilot.setToken');
    return;
  }
  const message = error instanceof ApiClientError && error.code === 'CONNECTION_FAILED'
    ? '无法连接 CorePilot 服务。请检查服务是否运行、地址是否正确，然后重试。'
    : error instanceof Error ? error.message : '操作未完成，请重试。';
  void vscode.window.showErrorMessage(`CorePilot: ${message}`);
}
