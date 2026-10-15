import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { App, calculateCursorPosition, calculatePromptCursorPosition } from '../src/cli-interactive/app.js';
import type { WorkbenchContext } from '../src/cli-interactive/context.js';

/**
 * Regression for the mouse-scroll ghosting: the welcome card and command output
 * must be rendered via ink's <Static> (written to stdout exactly once), while
 * only the input area lives in the live frame. This test drives several
 * re-renders (via window resize) and asserts the version title appears exactly
 * once in the raw byte stream. The resize-reflow patch must not replay it,
 * otherwise repeated Ctrl+wheel steps accumulate duplicate homepages.
 */
class FakeStream extends PassThrough {
  isTTY = true;
  columns = 100;
  rows = 30;
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  cursorTo(): this {
    return this;
  }
  clearLine(): this {
    return this;
  }
  moveCursor(): this {
    return this;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function makeContext(): WorkbenchContext {
  return {
    config: () => ({
      backend: { runner: 'mock' as const },
      model: { provider: 'mock', name: null },
      target: { name: 'phy-arm' },
      project_root: 'D:/tmp/project',
    }),
    ensureBackend: async () => ({ url: 'http://127.0.0.1:7346', reused: false }),
    getApi: async () => ({ listTasks: async () => ({ tasks: [] }) }),
  } as unknown as WorkbenchContext;
}

test('homepage is written once and the input area is redrawn on resize', async () => {
  const stdout = new FakeStream();
  const stdin = new FakeStream();
  let output = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const instance = render(React.createElement(App, { ctx: makeContext() }), {
    stdout,
    stdin,
    patchConsole: false,
  });

  // Let the async startup effect load config/tasks and write the welcome card.
  await new Promise((r) => setTimeout(r, 80));

  // Several window resizes force the live frame to redraw (the input area rule
  // width follows the terminal width), without touching the static card.
  for (let i = 0; i < 3; i++) {
    stdout.columns = 90 + i * 5;
    stdout.emit('resize');
    await new Promise((r) => setTimeout(r, 20));
  }

  instance.unmount();
  await new Promise((r) => setTimeout(r, 20));

  const titleCount = countOccurrences(output, 'CorePilot v0.4.0');
  const footerCount = countOccurrences(output, 'Tab 补全');

  assert.equal(titleCount, 1, 'welcome card is emitted once and never replayed during resize');
  assert.ok(footerCount >= 2, 'input-area footer is redrawn (live frame)');
  assert.doesNotMatch(output, /后台 http:\/\/|（复用）|（已启动）/, 'healthy backend details stay internal');
});

test('missing-config guidance stays in the live frame across terminal resize', async () => {
  const stdout = new FakeStream();
  const stdin = new FakeStream();
  let output = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const context = {
    configPath: 'D:/tmp/phyopt.yaml',
    hasConfig: () => false,
    config: () => ({ model: null, target: null, project_root: 'D:/tmp', backend: { runner: 'workflow' as const } }),
    ensureBackend: async () => { throw new Error('must not start without config'); },
    getApi: async () => { throw new Error('must not query without config'); },
  } as unknown as WorkbenchContext;

  const instance = render(React.createElement(App, { ctx: context }), {
    stdout,
    stdin,
    patchConsole: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await instance.waitUntilRenderFlush();
  assert.match(output, /请编辑您的优化配置文件/);
  assert.doesNotMatch(output, /未找到配置文件|可使用 \/model/);

  const before = output.length;
  stdout.columns = 72;
  stdout.emit('resize');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await instance.waitUntilRenderFlush();
  assert.match(output.slice(before), /请编辑您的优化配置文件/);

  instance.unmount();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test('native cursor accounts for the missing-config guidance row', () => {
  assert.deepEqual(
    calculateCursorPosition({ columns: 80, configMissing: true, prompt: true, cursorCells: 12 }),
    { x: 14, y: 2 },
  );
  assert.deepEqual(
    calculateCursorPosition({ columns: 80, configMissing: true, prompt: false, cursorCells: 2 }),
    { x: 4, y: 2 },
  );
});

test('multi-line prompt cursor follows explicit lines instead of flattening them', () => {
  assert.deepEqual(
    calculatePromptCursorPosition({
      columns: 80,
      configMissing: false,
      question: '编译命令：',
      textBeforeCursor: 'make \\\n    NO_LAPACK=1',
    }),
    { x: 19, y: 3 },
  );
  assert.deepEqual(
    calculatePromptCursorPosition({
      columns: 80,
      configMissing: true,
      question: '编译命令：',
      textBeforeCursor: '',
    }),
    { x: 4, y: 3 },
  );
});

test('hides missing-config guidance while /model configuration is active', async () => {
  const stdout = new FakeStream();
  const stdin = new FakeStream();
  let output = '';
  stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const context = {
    configPath: 'D:/tmp/phyopt.yaml',
    credentialsPath: 'D:/tmp/phyopt-homepage-no-credentials-for-test.json',
    modelSettingsPath: 'D:/tmp/phyopt-homepage-no-model-settings-for-test.json',
    hasConfig: () => false,
    config: () => ({ model: null, target: null, project_root: 'D:/tmp', backend: { runner: 'workflow' as const } }),
    ensureBackend: async () => { throw new Error('must not start without config'); },
    getApi: async () => { throw new Error('must not query without config'); },
  } as unknown as WorkbenchContext;

  const instance = render(React.createElement(App, { ctx: context }), {
    stdout,
    stdin,
    patchConsole: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await instance.waitUntilRenderFlush();
  const beforeCommand = output.length;
  stdin.write('/model');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const beforeExecute = output.length;
  stdin.write('\r');
  await new Promise((resolve) => setTimeout(resolve, 80));
  await instance.waitUntilRenderFlush();
  assert.match(output.slice(beforeCommand, beforeExecute), /请编辑您的优化配置文件/);
  assert.doesNotMatch(output.slice(beforeExecute), /请编辑您的优化配置文件/);

  stdin.write('\r');
  await new Promise((resolve) => setTimeout(resolve, 30));
  stdin.write('\u001b');
  await new Promise((resolve) => setTimeout(resolve, 80));
  stdin.write('\u001b');
  await new Promise((resolve) => setTimeout(resolve, 80));
  await instance.waitUntilRenderFlush();
  assert.match(output, /已取消模型配置/);

  instance.unmount();
  await new Promise((resolve) => setTimeout(resolve, 20));
});
