import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { App } from '../src/cli-interactive/app.js';
import type { WorkbenchContext } from '../src/cli-interactive/context.js';

/**
 * Regression for Windows Terminal resize/font-zoom ghosting. When width
 * shrinks, ConPTY reflows the already-painted frame into more physical rows,
 * while ink's normal relative clear still uses the old logical row count.
 * The local ink patch must erase the reflowed frame precisely, without
 * clearing the viewport or replaying <Static> history.
 */
class FakeStream extends PassThrough {
  isTTY = true;
  columns: number;
  rows: number;
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
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

test('width decrease erases every reflowed frame row without clearing or replaying history', async () => {
  const stdout = new FakeStream(96, 24);
  const stdin = new FakeStream(96, 24);
  let output = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const instance = render(React.createElement(App, { ctx: makeContext() }), {
    stdout,
    stdin,
    patchConsole: false,
  });

  await new Promise((r) => setTimeout(r, 80));
  await instance.waitUntilRenderFlush();
  const before = output;

  // At 96 columns the live frame uses five logical rows (including ink's
  // trailing line slot). At 48 columns, its full-width rules/footer reflow and
  // require more rows. An unpatched log.clear() erases only the old five.
  stdout.columns = 48;
  stdout.emit('resize');
  await new Promise((r) => setTimeout(r, 80));
  await instance.waitUntilRenderFlush();

  instance.unmount();
  await new Promise((r) => setTimeout(r, 20));

  const step = output.slice(before.length);
  const firstFrame = step.indexOf('─');
  const erasePrefix = firstFrame >= 0 ? step.slice(0, firstFrame) : step;
  const erasedRows = erasePrefix.split('\u001B[2K').length - 1;
  const titleCount = output.split('CorePilot v0.4.0').length - 1;

  assert.ok(erasedRows > 5, `must erase the physically reflowed frame, got only ${erasedRows} rows`);
  assert.ok(!step.includes('\u001B[2J'), 'must not clear the viewport');
  assert.ok(!step.includes('\u001B[3J'), 'must not clear scrollback');
  assert.ok(!step.includes('CorePilot v0.4.0'), 'must not replay static homepage output');
  assert.equal(titleCount, 1, 'homepage remains a single scrollback copy');
});

test('repeated Ctrl+wheel-style width decreases never accumulate homepage copies', async () => {
  const stdout = new FakeStream(100, 24);
  const stdin = new FakeStream(100, 24);
  let output = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const instance = render(React.createElement(App, { ctx: makeContext() }), {
    stdout,
    stdin,
    patchConsole: false,
  });

  await new Promise((r) => setTimeout(r, 80));
  await instance.waitUntilRenderFlush();

  const before = output.length;
  for (const width of [92, 84, 76, 68, 60, 52]) {
    stdout.columns = width;
    stdout.emit('resize');
  }
  await new Promise((r) => setTimeout(r, 160));
  await instance.waitUntilRenderFlush();

  const step = output.slice(before);
  const frameCount = step.split('❯').length - 1;
  assert.ok(frameCount >= 1 && frameCount <= 2, `resize burst should settle in at most two frames, got ${frameCount}`);
  assert.ok(!step.includes('\u001B[2J'), 'resize burst must not clear viewport');
  assert.ok(!step.includes('\u001B[3J'), 'resize burst must not clear scrollback');
  assert.ok(!step.includes('CorePilot v0.4.0'), 'resize burst must not replay homepage');

  instance.unmount();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(output.split('CorePilot v0.4.0').length - 1, 1, 'all zoom steps preserve one homepage copy');
});
