export function renderCliHelp(): string {
  return [
    'CorePilot：面向 CPU 基础算法库的 Agent 性能工程工具',
    '',
    '  corepilot optimize --config <path> --function <name> [--file <entry-file>] [--performance] [--api-key <key>]',
    '  corepilot serve --db <path> [--host <host>] [--port <port>] [--ssh-alias <alias> | --ssh-host <host> --ssh-username <user> [--ssh-port <port>] [--ssh-identity-file <path>]]',
    '  corepilot backend start|status|stop --config <path>',
    '  corepilot workflow status|cancel|approve <workflow-id>',
    '  corepilot package list | corepilot package inspect <id> [version] | corepilot package init <repo-path> [--target <symbol>] [--config <phyopt.yaml>]',
    '',
    '兼容命令：phyopt、phyopt-runner；现有 phyopt.yaml、PHYOPT_* 和 .phyopt/ 保持兼容。',
    '--file 只是调查入口，Agent 仍可读取和修改整个算法库。',
  ].join('\n');
}

export interface WorkbenchArgSpec { name: string; required?: boolean; description?: string }
export interface WorkbenchCommandSpec { name: string; description: string; usage: string; args?: readonly WorkbenchArgSpec[] }

export const WORKBENCH_COMMANDS: readonly WorkbenchCommandSpec[] = [
  { name: '/optimize', description: '按函数启动源码优化', usage: '/optimize --function <name> [--file <entry-file>] [--performance]' },
  { name: '/workflow', description: '查看、取消或审批工作流', usage: '/workflow status|cancel|approve <workflow-id>' },
  { name: '/task', description: '管理通用后台任务', usage: '/task list|status|cancel|retry|resume' },
  { name: '/model', description: '配置并验证模型', usage: '/model' },
  { name: '/build', description: '配置构建命令', usage: '/build' },
  { name: '/target', description: '配置或切换目标机器', usage: '/target' },
  { name: '/config', description: '显示当前 YAML 配置内容', usage: '/config' },
  { name: '/exit', description: '退出工作台', usage: '/exit' },
];

export function renderHelpForArgv(_argv: readonly string[]): string {
  return renderCliHelp();
}
