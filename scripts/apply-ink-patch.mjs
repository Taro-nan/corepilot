// Apply the phyopt resize-reflow patch to node_modules/ink.
//
// Why: when the terminal width shrinks, Windows terminals (conpty/Windows
// Terminal) reflow — rewrap — the existing buffer, so ink's previous frame can
// occupy MORE rows than log-update's erase count tracks. ink's resized() then
// under-erases (relative erase from a stale row count) and stamps frame
// residue into the scrollback — visible as stacked "ghost" frames after
// zooming or shrinking the window.
//
// Fix: coalesce the burst of resize events emitted by Ctrl+wheel, then re-wrap
// ink's previous live-frame string at the settled width, erase exactly that
// many physical rows and draw once. Static output is never replayed and
// neither the viewport (ESC[2J) nor scrollback (ESC[3J) is cleared.
//
// The patch is idempotent and verified against the exact upstream snippet; a
// mismatch (e.g. after an ink upgrade) fails loudly instead of silently
// skipping. Run automatically via `postinstall` and by scripts/package-cli.mjs
// after staging production dependencies.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const targetRoot = path.resolve(process.argv[2] ?? process.cwd());
const inkFile = path.join(targetRoot, 'node_modules', 'ink', 'build', 'ink.js');

const MARKER = '[phyopt-reflow-patch-v4]';
const LEGACY_MARKERS = ['[phyopt-reflow-patch-v3]', '[phyopt-reflow-patch-v2]', '[phyopt-patch]'];
const ORIGINAL_BRANCH = `        if (currentWidth < this.lastTerminalWidth) {
            // We clear the screen when decreasing terminal width to prevent duplicate overlapping re-renders.
            this.log.clear();
            this.lastOutput = '';
            this.lastOutputToRender = '';
        }`;

const ORIGINAL = `    resized = () => {
        const currentWidth = getWindowSize(this.options.stdout).columns;
${ORIGINAL_BRANCH}
        this.calculateLayout();
        dom.emitLayoutListeners(this.rootNode);
        this.onRender();
        this.lastTerminalWidth = currentWidth;
    };`;

const PATCHED = `    resized = () => {
        // ${MARKER} Windows Terminal emits a burst of resize events for one
        // Ctrl+wheel gesture. Redrawing on every intermediate width can push
        // transient frames into scrollback, so wait until the width settles.
        clearTimeout(this.phyoptResizeTimer);
        this.phyoptResizeTimer = setTimeout(() => {
            this.phyoptResizeTimer = undefined;
            if (this.isUnmounted || this.isUnmounting) {
                return;
            }
            const currentWidth = getWindowSize(this.options.stdout).columns;
            if (currentWidth < this.lastTerminalWidth) {
                // ConPTY reflows the already-painted frame when width decreases.
                // Re-wrap the exact previous frame and erase only its new physical
                // row count; static output and scrollback stay untouched.
                const previousFrame = this.lastOutputToRender || (this.lastOutput ? this.lastOutput + '\\n' : '');
                const reflowedFrame = previousFrame
                    ? wrapAnsi(previousFrame, Math.max(1, currentWidth), { trim: false, hard: true })
                    : '';
                const reflowedLineCount = reflowedFrame ? reflowedFrame.split('\\n').length : 0;
                if (reflowedLineCount > 0) {
                    // A native input cursor is positioned inside the frame, not
                    // at its trailing line. Move back to the physical bottom
                    // before eraseLines(), accounting for terminal reflow.
                    let returnToBottom = '';
                    if (this.cursorPosition) {
                        const width = Math.max(1, currentWidth);
                        const logicalLines = previousFrame.split('\\n');
                        const cursorY = Math.max(0, Math.min(this.cursorPosition.y, logicalLines.length - 1));
                        let physicalCursorY = 0;
                        for (let index = 0; index < cursorY; index++) {
                            const wrappedLine = wrapAnsi(logicalLines[index] ?? '', width, { trim: false, hard: true });
                            physicalCursorY += Math.max(1, wrappedLine.split('\\n').length);
                        }
                        physicalCursorY += Math.floor(Math.max(0, this.cursorPosition.x) / width);
                        const down = Math.max(0, reflowedLineCount - 1 - physicalCursorY);
                        returnToBottom = hideCursorEscape +
                            (down > 0 ? ansiEscapes.cursorDown(down) : '') +
                            ansiEscapes.cursorTo(0);
                    }
                    const sync = this.shouldSync();
                    if (sync) {
                        this.options.stdout.write(bsu);
                    }
                    this.options.stdout.write(returnToBottom + ansiEscapes.eraseLines(reflowedLineCount));
                    if (sync) {
                        this.options.stdout.write(esu);
                    }
                }
                this.lastOutput = '';
                this.lastOutputToRender = '';
                this.lastOutputHeight = 0;
                this.log.reset();
                this.log.setCursorPosition(this.cursorPosition);
            }
            this.calculateLayout();
            dom.emitLayoutListeners(this.rootNode);
            this.onRender();
            this.lastTerminalWidth = currentWidth;
        }, 60);
    };`;

let source;
try {
  source = readFileSync(inkFile, 'utf8');
} catch (err) {
  console.error(`[apply-ink-patch] cannot read ${inkFile}: ${err.message}`);
  process.exit(1);
}

if (source.includes(MARKER)) {
  console.log('[apply-ink-patch] already patched, skipping');
  process.exit(0);
}

// Migrate any earlier phyopt patch in-place. This keeps postinstall idempotent
// for developer trees that were patched before v4 was introduced.
if (LEGACY_MARKERS.some((marker) => source.includes(marker))) {
  const legacyHelper = /    \/\/ \[phyopt-patch\] Upper bound[\s\S]*?(?=    resized = \(\) => \{)/;
  source = source.replace(legacyHelper, '');
  const legacyMethod = /    resized = \(\) => \{[\s\S]*?\n    \};(?=\n    resolveExitPromise)/;
  if (!legacyMethod.test(source)) {
    console.error('[apply-ink-patch] cannot locate the previous phyopt resized() method.');
    process.exit(1);
  }
  source = source.replace(legacyMethod, ORIGINAL);
}

if (!source.includes(ORIGINAL)) {
  console.error('[apply-ink-patch] ink/build/ink.js does not match the expected upstream snippet.');
  console.error('[apply-ink-patch] The ink version likely changed; re-derive the patch against');
  console.error('[apply-ink-patch] node_modules/ink/build/ink.js (resized()) before proceeding.');
  process.exit(1);
}

source = source.replace(ORIGINAL, PATCHED);
writeFileSync(inkFile, source);
console.log('[apply-ink-patch] patched', inkFile);
