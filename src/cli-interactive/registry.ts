/**
 * 交互工作台从统一命令规范读取菜单、帮助和补全信息。
 * 命令名称只能在 `cli-command-spec.ts` 中定义。
 */
import {
  WORKBENCH_COMMANDS,
  type WorkbenchArgSpec,
  type WorkbenchCommandSpec,
} from '../cli-command-spec.js';

export type ArgSpec = WorkbenchArgSpec;
export type CommandSpec = WorkbenchCommandSpec;
export const COMMANDS: readonly CommandSpec[] = WORKBENCH_COMMANDS;

export function findCommand(name: string): CommandSpec | null {
  const normalized = name.startsWith('/') ? name : `/${name}`;
  return COMMANDS.find((command) => command.name === normalized) ?? null;
}

/** 返回 Tab 补全使用的一级命令名。 */
export function commandNames(): string[] {
  return COMMANDS.map((command) => command.name);
}
