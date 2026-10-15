import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { App } from '../src/cli-interactive/app.js';
import type { WorkbenchContext } from '../src/cli-interactive/context.js';

/**
 * Regression for the resize ghosting ("放大还是会有残影"). A small terminal
 * emulator applies ink's ANSI escapes to a cell grid so we can assert the final
 * visible screen after a resize sequence — a string layout test cannot observe
 * the erase/rewrite behavior that produces ghosting.
 */

function charWidth(ch: string): number {
  const c = ch.codePointAt(0)!;
  return (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xff00 && c <= 0xff60)
    ? 2
    : 1;
}

class TerminalSimulator {
  columns: number;
  rows: number;
  private grid: string[][] = [];
  private cur = { r: 0, c: 0 };

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.reset();
  }

  reset(): void {
    this.grid = Array.from({ length: this.rows }, () => new Array<string>(this.columns).fill(' '));
  }

  setSize(columns: number, rows: number): void {
    const old = this.grid;
    const oldColumns = this.columns;
    const oldCursor = { ...this.cur };

    // Windows Terminal reflows populated rows when the viewport narrows. The
    // production resize patch deliberately accounts for those extra physical
    // rows, so the simulator must model them instead of merely truncating.
    if (columns < oldColumns) {
      const lastContentRow = old.reduce((last, row, index) =>
        row.some((cell) => cell !== ' ') ? index : last, -1);
      const lastRelevantRow = Math.max(oldCursor.r, lastContentRow);
      const reflowed: string[][] = [];
      let nextCursor = { r: 0, c: 0 };

      for (let r = 0; r <= lastRelevantRow; r++) {
        const source = old[r] ?? [];
        let used = source.length;
        while (used > 0 && source[used - 1] === ' ') used--;
        const cells = source.slice(0, used);
        const chunks: string[][] = [];
        if (cells.length === 0) {
          chunks.push([]);
        } else {
          for (let start = 0; start < cells.length; start += columns) {
            chunks.push(cells.slice(start, start + columns));
          }
        }

        if (r === oldCursor.r) {
          nextCursor = {
            r: reflowed.length + Math.floor(oldCursor.c / columns),
            c: oldCursor.c % columns,
          };
        }

        for (const chunk of chunks) {
          reflowed.push([...chunk, ...new Array<string>(Math.max(0, columns - chunk.length)).fill(' ')]);
        }
      }

      while (reflowed.length < rows) reflowed.push(new Array<string>(columns).fill(' '));
      const overflow = Math.max(0, reflowed.length - rows);
      this.grid = reflowed.slice(overflow, overflow + rows);
      this.columns = columns;
      this.rows = rows;
      this.cur.r = Math.max(0, Math.min(rows - 1, nextCursor.r - overflow));
      this.cur.c = Math.max(0, Math.min(columns - 1, nextCursor.c));
      return;
    }

    const next: string[][] = [];
    for (let r = 0; r < rows; r++) {
      const row = new Array<string>(columns).fill(' ');
      if (old[r]) {
        for (let c = 0; c < Math.min(columns, this.columns); c++) row[c] = old[r][c] ?? ' ';
      }
      next.push(row);
    }
    this.grid = next;
    this.columns = columns;
    this.rows = rows;
    this.cur.r = Math.min(this.cur.r, rows - 1);
    this.cur.c = Math.min(this.cur.c, columns - 1);
  }

  private put(ch: string): void {
    if (ch === '\n') {
      this.cur.r++;
      this.cur.c = 0;
      this.scrollIfNeeded();
      return;
    }
    if (ch === '\r') {
      this.cur.c = 0;
      return;
    }
    const cw = charWidth(ch);
    if (this.cur.c + cw > this.columns) {
      this.cur.r++;
      this.cur.c = 0;
      this.scrollIfNeeded();
    }
    this.grid[this.cur.r][this.cur.c] = ch;
    this.cur.c += cw;
  }

  private scrollIfNeeded(): void {
    if (this.cur.r >= this.rows) {
      this.grid.shift();
      this.grid.push(new Array<string>(this.columns).fill(' '));
      this.cur.r = this.rows - 1;
    }
  }

  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\u001b') {
        const m = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(data.slice(i));
        if (!m) {
          i++;
          continue;
        }
        const params = m[1];
        const cmd = m[2];
        i += m[0].length;
        if (cmd === 'K') this.grid[this.cur.r] = new Array<string>(this.columns).fill(' ');
        else if (cmd === 'A') this.cur.r = Math.max(0, this.cur.r - (Number.parseInt(params) || 1));
        else if (cmd === 'G') this.cur.c = Math.min(this.columns - 1, Number.parseInt(params) || 0);
        else if (cmd === 'J') this.reset();
        else if (cmd === 'H') this.cur = { r: 0, c: 0 };
      } else {
        this.put(ch);
        i++;
      }
    }
  }

  lines(): string[] {
    return this.grid.map((row) => row.join('').trimEnd());
  }
}

class FakeStdout extends PassThrough {
  isTTY = true;
  columns = 80;
  rows = 40;
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

class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
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

test('resizing does not leave duplicate rules or a duplicated homepage', async () => {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const sim = new TerminalSimulator(80, 40);
  stdout.on('data', (chunk: Buffer) => sim.write(chunk.toString()));

  // Cursor positioning has its own byte-stream regression test. Keep this
  // cell-grid simulator focused on frame layout and resize reflow.
  const instance = render(React.createElement(App, { ctx: makeContext(), nativeCursor: false }), {
    stdout,
    stdin,
    patchConsole: false,
  });

  await new Promise((r) => setTimeout(r, 80));

  const resize = (columns: number, rows: number): void => {
    stdout.columns = columns;
    stdout.rows = rows;
    sim.setSize(columns, rows);
    stdout.emit('resize');
  };

  // Enlarge, shrink (the width-decrease path), then enlarge again — the
  // sequence that used to leave duplicated rule lines.
  resize(120, 40);
  await new Promise((r) => setTimeout(r, 40));
  resize(80, 40);
  await new Promise((r) => setTimeout(r, 40));
  resize(160, 60);
  await new Promise((r) => setTimeout(r, 60));

  instance.unmount();
  await new Promise((r) => setTimeout(r, 20));

  const lines = sim.lines().filter((l) => l.trim().length > 0);
  const all = lines.join('\n');

  assert.equal(all.split('CorePilot v0.4.0').length - 1, 1, 'homepage appears exactly once');
  const ruleLines = lines.filter((l) => /^ *─+ *$/.test(l));
  assert.equal(ruleLines.length, 2, 'exactly two input-area rules (no duplicated rule lines)');
});
