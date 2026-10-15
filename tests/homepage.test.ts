import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BANNER_LINES, bannerText } from '../src/cli-interactive/banner.js';
import {
  buildLogo,
  displayWidth,
  homepageLines,
  truncatePath,
  MAX_CARD_WIDTH,
  TWO_COLUMN_MIN_WIDTH,
} from '../src/cli-interactive/homepage.js';
import type { HomepageStatus, Span } from '../src/cli-interactive/homepage.js';
import { VERSION } from '../src/version.js';

function text(spans: Span[]): string {
  return spans.map((s) => s.text).join('');
}

function flatten(status: HomepageStatus, columns: number): string[] {
  return homepageLines(status, columns).map(text);
}

const status: HomepageStatus = {
  model: '未配置',
  target: '未选择',
  path: 'D:/Projects/phytium/blas_ft/source/src/kernels/sgemv/n/very/long/path',
  recentActivity: ['执行中 · phy-arm', '已完成 · mock-target', '等待资源 · s5000c'],
};

test('displayWidth counts CJK and full-width chars as 2 columns', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('面向 ARM 的代码优化'), 19);
  assert.equal(displayWidth('│──┌┐'), 5);
  assert.equal(displayWidth('█'), 1);
});

test('buildLogo returns 5 equal-width block rows spelling CorePilot', () => {
  const logo = buildLogo();
  assert.deepEqual(logo, [
    ' ██                 ███   █   █          █  ',
    '█  █  ██  ███   ██  █  █      █     ██   █  ',
    '█    █  █ █  █ ████ ███   █   █    █  █ ███ ',
    '█  █ █  █ █    █    █     █   █    █  █  █  ',
    ' ██   ██  █     ██  █     █    ██   ██   █  ',
  ]);
  assert.equal(logo.length, 5);
  const widths = logo.map(displayWidth);
  assert.equal(new Set(widths).size, 1, 'all logo rows share the same display width');
  assert.ok(logo.every((row) => row.includes('█')));
  // CorePilot block glyphs are present and distinct.
  assert.ok(logo[2].includes('███'), 'middle row has the crossbars');
});

test('startup banner shares the CorePilot homepage wordmark', () => {
  assert.deepEqual(BANNER_LINES.slice(1, -1), buildLogo().map(row => `  ${row}`));
  assert.ok(bannerText().includes(`CorePilot v${VERSION}`));
  assert.doesNotMatch(bannerText(), /phyopt|pyhopt/i);
});

test('truncatePath keeps the tail directory and never exceeds max', () => {
  const long = 'D:/a/very/long/path/with/many/segments/ending/here';
  assert.equal(truncatePath('short/path', 40), 'short/path');
  const out = truncatePath(long, 20);
  assert.ok(out.startsWith('…'), 'truncated path is prefixed with an ellipsis');
  assert.ok(out.endsWith('here'), 'tail directory name is preserved');
  assert.ok(displayWidth(out) <= 20, 'result stays within the budget');
});

test('truncatePath handles CJK path segments by display width', () => {
  const p = 'D:/项目/优化/代码库/src/kernels/sgemv/尾目录';
  const out = truncatePath(p, 16);
  assert.ok(displayWidth(out) <= 16);
  assert.ok(out.endsWith('尾目录'), 'CJK tail is preserved');
});

test('wide terminal renders two columns with the block wordmark', () => {
  const lines = flatten(status, 120);
  const joined = lines.join('\n');
  assert.ok(joined.includes(`CorePilot v${VERSION}`), 'title embeds version');
  assert.ok(joined.includes('█'), 'block logo present in two-column mode');
  assert.ok(joined.includes('开始使用') && joined.includes('最近活动'), 'right column sections present');
  assert.ok(joined.includes('模型：未配置'), 'model summary present');
  assert.ok(joined.includes('硬件：未选择'), 'target summary present');
  assert.ok(joined.includes('目录：'), 'directory summary present');
});

test('version title is centered within the left column top border', () => {
  const top = flatten(status, 120)[0];
  const titleToken = ` CorePilot v${VERSION} `;
  const titleStart = top.indexOf(titleToken);
  const titleEnd = titleStart + titleToken.length;
  const junction = top.indexOf('┬');
  assert.ok(titleStart > 1, 'title is not flush against the left corner');
  assert.ok(junction > titleEnd, 'junction sits to the right of the title');
  assert.match(top.slice(1, titleStart), /^─*$/, 'only dashes before the title');
  assert.match(top.slice(titleEnd, junction), /^─*$/, 'only dashes after the title');
  assert.equal(
    top.slice(1, titleStart).length,
    top.slice(titleEnd, junction).length,
    'title is horizontally centered in the left column',
  );
});

test('wordmark + subtitle are vertically centered in the left column', () => {
  const lines = homepageLines(status, 120);
  const body = lines.slice(1, -1); // drop top/bottom borders
  const contentRows: number[] = [];
  body.forEach((line, i) => {
    const divIdx = line.findIndex((s) => s.text === ' │ ');
    const leftSpans = line.slice(1, divIdx);
    if (leftSpans.some((s) => s.text.trim().length > 0)) contentRows.push(i);
  });
  assert.equal(contentRows.length, 6, 'logo (5 rows) + subtitle (1 row)');
  const topBlank = contentRows[0];
  const bottomBlank = body.length - 1 - contentRows[contentRows.length - 1];
  assert.ok(topBlank >= 1, 'has vertical padding above the wordmark');
  assert.ok(Math.abs(topBlank - bottomBlank) <= 1, 'block is vertically centered');
});

test('right column shows two gray horizontal separators between sections', () => {
  const lines = homepageLines(status, 120);
  const separators = lines.filter((line) =>
    line.some((s) => s.color === 'gray' && /^[ ─]+$/.test(s.text) && s.text.includes('─')),
  );
  assert.equal(separators.length, 2, 'exactly two right-column separators');
});

test('wordmark is not clipped at the two-column threshold', () => {
  for (const columns of [90, 91, 92]) {
    const lines = flatten(status, columns);
    assert.ok(
      lines.join('\n').includes(buildLogo()[0]),
      `logo row 0 fully present at ${columns} columns`,
    );
    assert.ok(!lines.join('\n').includes('█…'), `no clipped logo at ${columns} columns`);
  }
});

test('narrow terminal falls back to a single column', () => {
  const lines = flatten(status, 80);
  assert.ok(lines.some((l) => l.includes('CorePilot')), 'compact title present');
  assert.ok(!lines.some((l) => l.includes('█')), 'block logo omitted in single-column mode');
  // No vertical divider between columns in single-column mode: only the two
  // outer borders plus the framed content.
  for (const line of lines) {
    const inner = line.slice(2, -2);
    assert.ok(!inner.includes('│'), 'no inner column divider in single-column mode');
  }
});

test('every line is exactly the card width and never exceeds the terminal', () => {
  for (const columns of [120, 100, 90, 80, 60, 40]) {
    const lines = flatten(status, columns);
    const cardW = Math.max(1, Math.min(columns - 4, MAX_CARD_WIDTH));
    for (const line of lines) {
      assert.equal(displayWidth(line), cardW, `line width at ${columns} columns`);
    }
  }
});

test('empty activity shows the empty state instead of fabricating records', () => {
  const empty = { ...status, recentActivity: [] };
  const lines = flatten(empty, 100);
  assert.ok(lines.some((l) => l.includes('还没有活动，输入 /optimize 开始')));
  assert.ok(!lines.some((l) => l.includes('UUID') || l.includes('加速比')), 'no fabricated metrics');
});

test('unconfigured model and target are shown as 未配置 / 未选择', () => {
  const lines = flatten(status, 100);
  assert.ok(lines.some((l) => l.includes('模型：未配置')));
  assert.ok(lines.some((l) => l.includes('硬件：未选择')));
});

test('null path renders as 未设置 without crashing', () => {
  const lines = flatten({ ...status, path: null }, 100);
  assert.ok(lines.some((l) => l.includes('目录：未设置')));
});

test('threshold constant matches the documented 90-column switch', () => {
  assert.equal(TWO_COLUMN_MIN_WIDTH, 90);
  assert.equal(MAX_CARD_WIDTH, 110);
});
