import { VERSION } from '../version.js';

/**
 * Pure layout engine for the CorePilot welcome card.
 *
 * Returns the card as a list of lines, each line a list of colored spans, so
 * the ink layer only needs to render text and colors — no terminal I/O here.
 * This keeps the layout testable without a terminal.
 */

export type HomepageColor = 'red' | 'gray';

export interface Span {
  text: string;
  color?: HomepageColor;
}

export interface HomepageStatus {
  /** Display string for the model, e.g. "未配置" or "openai-compatible/deepseek-v4". */
  model: string;
  /** Display string for the target, e.g. "未选择" or "phy-arm". */
  target: string;
  /** Project root (absolute path) or null when not set. */
  path: string | null;
  /** Up to 3 short, already-localized activity lines (no UUIDs, no fake data). */
  recentActivity: string[];
}

export const MAX_CARD_WIDTH = 110;
/** Below this terminal width the card switches from two columns to one. */
export const TWO_COLUMN_MIN_WIDTH = 90;
/** Left column share of the two-column card body. */
export const LEFT_RATIO = 0.36;
/** Outer horizontal margin (leading spaces prepended to every line). */
const MARGIN = 2;

/** Terminal display width: CJK/full-width chars occupy 2 columns, the rest 1. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0x303e) ||
      (c >= 0x3041 && c <= 0x33ff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xa000 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

// ---- Block wordmark ----
// 5-row, 4-column block glyphs drawn with the terminal full-block character.
// Each glyph is exactly 4 columns wide; letters are joined with a single space.
const GLYPHS: Record<string, string[]> = {
  C: [' ██ ', '█  █', '█   ', '█  █', ' ██ '],
  o: ['    ', ' ██ ', '█  █', '█  █', ' ██ '],
  r: ['    ', '███ ', '█  █', '█   ', '█   '],
  e: ['    ', ' ██ ', '████', '█   ', ' ██ '],
  P: ['███ ', '█  █', '███ ', '█   ', '█   '],
  i: [' █  ', '    ', ' █  ', ' █  ', ' █  '],
  l: ['█   ', '█   ', '█   ', '█   ', ' ██ '],
  t: [' █  ', ' █  ', '███ ', ' █  ', ' █  '],
};

const WORD = ['C', 'o', 'r', 'e', 'P', 'i', 'l', 'o', 't'];

/** Five rows of the block "CorePilot" wordmark. */
export function buildLogo(): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 5; r++) {
    rows.push(WORD.map((letter) => GLYPHS[letter][r]).join(' '));
  }
  return rows;
}

/** Width of the widest wordmark row, so the left column never clips the logo. */
const LOGO_WIDTH = Math.max(...buildLogo().map(displayWidth));

/** Truncate a path to a display width, always keeping the tail directory. */
export function truncatePath(p: string, max: number): string {
  if (max < 1) return '';
  if (displayWidth(p) <= max) return p;

  const ellipsis = '…';
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return truncateTail(p, max);

  let tail = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = `${parts[i]}${sep}${tail}`;
    if (displayWidth(`${ellipsis}${sep}${candidate}`) <= max) {
      tail = candidate;
    } else {
      break;
    }
  }
  const result = `${ellipsis}${sep}${tail}`;
  if (displayWidth(result) <= max) return result;
  return truncateTail(result, max);
}

/** Hard fallback: keep the tail, drop code points from the front. */
function truncateTail(s: string, max: number): string {
  const ellipsis = '…';
  const chars = Array.from(s);
  let start = 0;
  while (start < chars.length && displayWidth(ellipsis + chars.slice(start).join('')) > max) {
    start++;
  }
  return ellipsis + chars.slice(start).join('');
}

// ---- Layout helpers ----

function padRight(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? text : text + ' '.repeat(width - w);
}

function center(text: string, width: number): string {
  const w = displayWidth(text);
  if (w >= width) return truncateEnd(text, width);
  const left = Math.floor((width - w) / 2);
  return ' '.repeat(left) + text + ' '.repeat(width - w - left);
}

function truncateEnd(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  const ellipsis = '…';
  if (width <= displayWidth(ellipsis)) return ellipsis.slice(0, width);
  const avail = width - displayWidth(ellipsis);
  const chars = Array.from(text);
  let acc = '';
  let accW = 0;
  for (const ch of chars) {
    const cw = displayWidth(ch);
    if (accW + cw > avail) break;
    acc += ch;
    accW += cw;
  }
  return acc + ellipsis;
}

/** Fit text to exactly `width` columns: pad short, truncate-end long. */
function fitEnd(text: string, width: number): string {
  return padRight(truncateEnd(text, width), width);
}

const SUBTITLE = '面向 ARM 的代码优化';

// ---- Two-column card ----

/** Right-column section separator: a thin gray rule with even side padding. */
const SEPARATOR_PAD = 2;

function rightSeparator(RW: number): Span {
  const inner = Math.max(0, RW - 2 * SEPARATOR_PAD);
  return { text: ' '.repeat(SEPARATOR_PAD) + '─'.repeat(inner) + ' '.repeat(SEPARATOR_PAD), color: 'gray' };
}

function twoColumnLines(status: HomepageStatus, W: number): Span[][] {
  const LW = Math.max(LOGO_WIDTH, Math.floor((W - 7) * LEFT_RATIO));
  const RW = W - 7 - LW;

  // Wordmark + subtitle form one unit; each line is horizontally centered, and
  // the unit as a whole is vertically centered in the left column content area.
  const leftBlock: Span[][] = [
    ...buildLogo().map((row) => [{ text: center(row, LW), color: 'red' as HomepageColor }]),
    [{ text: center(SUBTITLE, LW) }],
  ];
  const rightLines = buildRightLines(status, RW);

  const height = Math.max(leftBlock.length, rightLines.length);
  const topPad = Math.floor((height - leftBlock.length) / 2);

  const body: Span[][] = [];
  for (let i = 0; i < height; i++) {
    const li = i - topPad;
    const left = li >= 0 && li < leftBlock.length ? leftBlock[li] : [{ text: ' '.repeat(LW) }];
    const right = rightLines[i] ?? [{ text: ' '.repeat(RW) }];
    body.push([...left, { text: ' │ ', color: 'gray' }, ...right]);
  }
  return twoColumnFrame(body, W, LW);
}

function buildRightLines(status: HomepageStatus, RW: number): Span[][] {
  const blank = (): Span[] => [{ text: ' '.repeat(RW) }];
  const lines: Span[][] = [];
  lines.push([{ text: fitEnd('开始使用', RW) }]);
  lines.push([{ text: fitEnd('  /optimize  选择代码，启动完整优化', RW) }]);
  lines.push([{ text: fitEnd('  /model     配置模型', RW) }]);
  lines.push([{ text: fitEnd('  /target    选择目标硬件', RW) }]);
  lines.push(blank());
  lines.push([rightSeparator(RW)]);
  lines.push(blank());

  lines.push([{ text: fitEnd('最近活动', RW) }]);
  if (status.recentActivity.length === 0) {
    lines.push([{ text: fitEnd('  还没有活动，输入 /optimize 开始', RW) }]);
  } else {
    for (const a of status.recentActivity.slice(0, 3)) {
      lines.push([{ text: fitEnd(`  ${a}`, RW) }]);
    }
  }
  lines.push(blank());
  lines.push([rightSeparator(RW)]);
  lines.push(blank());

  lines.push([{ text: fitEnd(`模型：${status.model}`, RW) }]);
  lines.push([{ text: fitEnd(`硬件：${status.target}`, RW) }]);
  lines.push([{ text: fitEnd(`目录：${status.path ? truncatePath(status.path, RW - 6) : '未设置'}`, RW) }]);
  return lines;
}

// ---- Single-column card (narrow terminals) ----

function singleColumnLines(status: HomepageStatus, W: number): Span[][] {
  const CW = Math.max(1, W - 4);
  const body: Span[][] = [];

  body.push([{ text: center('CorePilot', CW), color: 'red' }]);
  body.push([{ text: center(SUBTITLE, CW) }]);
  body.push([{ text: ' '.repeat(CW) }]);

  body.push([{ text: fitEnd('开始使用', CW) }]);
  body.push([{ text: fitEnd('  /optimize  选择代码，启动完整优化', CW) }]);
  body.push([{ text: fitEnd('  /model     配置模型', CW) }]);
  body.push([{ text: fitEnd('  /target    选择目标硬件', CW) }]);
  body.push([{ text: ' '.repeat(CW) }]);

  body.push([{ text: fitEnd('最近活动', CW) }]);
  if (status.recentActivity.length === 0) {
    body.push([{ text: fitEnd('  还没有活动，输入 /optimize 开始', CW) }]);
  } else {
    for (const a of status.recentActivity.slice(0, 3)) {
      body.push([{ text: fitEnd(`  ${a}`, CW) }]);
    }
  }
  body.push([{ text: ' '.repeat(CW) }]);

  body.push([{ text: fitEnd(`模型：${status.model}`, CW) }]);
  body.push([{ text: fitEnd(`硬件：${status.target}`, CW) }]);
  body.push([{ text: fitEnd(`目录：${status.path ? truncatePath(status.path, CW - 6) : '未设置'}`, CW) }]);

  return frame(body, W);
}

// ---- Frame ----

function frame(body: Span[][], W: number): Span[][] {
  const title = ` CorePilot v${VERSION} `;
  const fill = Math.max(0, W - 3 - displayWidth(title));
  const top: Span[] = [
    { text: '┌─', color: 'gray' },
    { text: title },
    { text: '─'.repeat(fill) + '┐', color: 'gray' },
  ];
  const bottom: Span[] = [{ text: '└' + '─'.repeat(Math.max(0, W - 2)) + '┘', color: 'gray' }];
  const rows: Span[][] = body.map((spans) => [
    { text: '│ ', color: 'gray' },
    ...spans,
    { text: ' │', color: 'gray' },
  ]);
  return [top, ...rows, bottom];
}

/**
 * Two-column frame: the version title sits centered within the LEFT column's
 * top border (between the left edge and the vertical divider), and a ┬ / ┴
 * junction marks where the divider meets the top/bottom borders.
 */
function twoColumnFrame(body: Span[][], W: number, LW: number): Span[][] {
  const title = ` CorePilot v${VERSION} `;
  const leftDash = LW + 2; // dash run between ┌ and ┬
  const titleW = displayWidth(title);
  const leftPad = Math.max(0, Math.floor((leftDash - titleW) / 2));
  const rightPad = Math.max(0, leftDash - titleW - leftPad);
  const rightDash = Math.max(0, W - LW - 5); // dash run between ┬ and ┐

  const top: Span[] = [
    { text: '┌' + '─'.repeat(leftPad), color: 'gray' },
    { text: title },
    { text: '─'.repeat(rightPad) + '┬' + '─'.repeat(rightDash) + '┐', color: 'gray' },
  ];
  const bottom: Span[] = [
    { text: '└' + '─'.repeat(LW + 2) + '┴' + '─'.repeat(rightDash) + '┘', color: 'gray' },
  ];
  const rows: Span[][] = body.map((spans) => [
    { text: '│ ', color: 'gray' },
    ...spans,
    { text: ' │', color: 'gray' },
  ]);
  return [top, ...rows, bottom];
}

/**
 * Build the welcome card for a terminal of `columns` width. Each returned line
 * is a list of spans; concatenating the text of a line yields exactly the
 * visual row. The card is capped at `MAX_CARD_WIDTH` and assumes the renderer
 * adds a `MARGIN`-column outer padding on each side (so the effective card
 * width is `min(columns - 2*MARGIN, MAX_CARD_WIDTH)`).
 */
export function homepageLines(status: HomepageStatus, columns: number): Span[][] {
  const W = Math.max(1, Math.min(columns - 2 * MARGIN, MAX_CARD_WIDTH));
  const twoCol = columns >= TWO_COLUMN_MIN_WIDTH;
  return twoCol ? twoColumnLines(status, W) : singleColumnLines(status, W);
}
