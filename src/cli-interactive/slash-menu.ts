import type { CommandSpec } from './registry.js';
import { displayWidth } from './homepage.js';

/** ANSI SGR/control sequences are styling, not terminal cells. */
const ANSI_ESCAPE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -\/]*[@-~]/g;

export interface SlashMenuItem {
  command: string;
  description: string;
  commandWidth: number;
  descriptionWidth: number;
}

export interface SlashMenuLayout {
  items: SlashMenuItem[];
  commandColumnWidth: number;
  gap: number;
  descriptionColumnWidth: number;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

export function visibleWidth(text: string): number {
  return displayWidth(stripAnsi(text));
}

/** Truncate by terminal cells, preserving a single-line result. */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  const clean = stripAnsi(text).replace(/[\r\n]/g, ' ');
  if (visibleWidth(clean) <= width) return clean;
  if (width === 1) return '…';
  let result = '';
  let used = 0;
  for (const char of Array.from(clean)) {
    const charWidth = visibleWidth(char);
    if (used + charWidth > width - 1) break;
    result += char;
    used += charWidth;
  }
  return `${result}…`;
}

function padToWidth(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

/** Filter only by the command prefix; argument text is not fuzzy-matched. */
export function filterSlashCommands(commands: readonly CommandSpec[], query: string): CommandSpec[] {
  const prefix = query.trimStart().split(/\s+/, 1)[0] ?? '';
  if (!prefix.startsWith('/')) return [];
  return commands.filter((command) => command.name.startsWith(prefix));
}

/**
 * Build a two-column, single-line menu. The caller applies colors while
 * rendering the returned fields, so ANSI styling never affects alignment.
 */
export function buildSlashMenuLayout(commands: readonly CommandSpec[], width: number, gap = 4): SlashMenuLayout {
  const totalWidth = Math.max(1, width);
  const longestCommand = Math.max(1, ...commands.map((command) => visibleWidth(command.name)));
  const commandColumnWidth = Math.min(longestCommand, totalWidth);
  const actualGap = Math.min(Math.max(0, gap), Math.max(0, totalWidth - commandColumnWidth));
  const descriptionColumnWidth = Math.max(0, totalWidth - commandColumnWidth - actualGap);
  const items = commands.map((command) => ({
    command: padToWidth(truncateToWidth(command.name, commandColumnWidth), commandColumnWidth),
    description: truncateToWidth(command.description, descriptionColumnWidth),
    commandWidth: commandColumnWidth,
    descriptionWidth: descriptionColumnWidth,
  }));
  return { items, commandColumnWidth, gap: actualGap, descriptionColumnWidth };
}

/** Number of menu rows that fit below the input without pushing the footer away. */
export function menuVisibleCount(terminalRows: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  const budget = Math.max(1, Math.floor(terminalRows) - 6);
  // A short terminal gets a compact picker (up to eight rows); a tall one can
  // show the complete registry without scrolling.
  return Math.min(itemCount, budget < itemCount ? Math.min(8, budget) : itemCount);
}

/** Keep the selected item visible after an up/down movement or a resize. */
export function ensureMenuOffset(selected: number, offset: number, visibleCount: number, itemCount: number): number {
  if (itemCount <= 0 || visibleCount <= 0) return 0;
  const maxOffset = Math.max(0, itemCount - visibleCount);
  let next = Math.max(0, Math.min(offset, maxOffset));
  if (selected < next) next = selected;
  if (selected >= next + visibleCount) next = selected - visibleCount + 1;
  return Math.max(0, Math.min(next, maxOffset));
}
