import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useCursor, useInput, usePaste, useStdin, useStdout } from 'ink';
import type { WorkbenchContext } from './context.js';
import { runCommand } from './commands.js';
import type { CommandIO } from './commands.js';
import { COMMANDS } from './registry.js';
import { displayWidth, homepageLines } from './homepage.js';
import type { HomepageStatus, Span } from './homepage.js';
import { buildSlashMenuLayout, ensureMenuOffset, filterSlashCommands, menuVisibleCount } from './slash-menu.js';
import { targetLabel } from '../config/target-config.js';
import { readClipboardText } from './clipboard.js';

interface PromptState {
  question: string;
  secret: boolean;
}

interface SelectionChoice {
  label: string;
  value: unknown;
}

interface SelectionState {
  question: string;
  choices: SelectionChoice[];
  index: number;
  offset: number;
}

interface EditorState {
  text: string;
  /** Cursor offset in grapheme clusters, not UTF-16 code units. */
  cursor: number;
}

const CONFIG_GUIDANCE = '请编辑您的优化配置文件';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

function insertText(editor: EditorState, inserted: string): EditorState {
  const parts = graphemes(editor.text);
  const addition = graphemes(inserted);
  parts.splice(editor.cursor, 0, ...addition);
  return { text: parts.join(''), cursor: editor.cursor + addition.length };
}

function backspace(editor: EditorState): EditorState {
  if (editor.cursor === 0) return editor;
  const parts = graphemes(editor.text);
  parts.splice(editor.cursor - 1, 1);
  return { text: parts.join(''), cursor: editor.cursor - 1 };
}

function deleteForward(editor: EditorState): EditorState {
  const parts = graphemes(editor.text);
  if (editor.cursor >= parts.length) return editor;
  parts.splice(editor.cursor, 1);
  return { text: parts.join(''), cursor: editor.cursor };
}

function moveCursor(editor: EditorState, cursor: number): EditorState {
  return { ...editor, cursor: Math.max(0, Math.min(graphemes(editor.text).length, cursor)) };
}

function currentLineBounds(editor: EditorState): { start: number; end: number; column: number } {
  const parts = graphemes(editor.text);
  let start = editor.cursor;
  while (start > 0 && parts[start - 1] !== '\n') start--;
  let end = editor.cursor;
  while (end < parts.length && parts[end] !== '\n') end++;
  return { start, end, column: editor.cursor - start };
}

function moveCursorVertically(editor: EditorState, direction: -1 | 1): EditorState {
  const parts = graphemes(editor.text);
  const current = currentLineBounds(editor);
  if (direction < 0) {
    if (current.start === 0) return editor;
    const targetEnd = current.start - 1;
    let targetStart = targetEnd;
    while (targetStart > 0 && parts[targetStart - 1] !== '\n') targetStart--;
    return moveCursor(editor, targetStart + Math.min(current.column, targetEnd - targetStart));
  }
  if (current.end >= parts.length) return editor;
  const targetStart = current.end + 1;
  let targetEnd = targetStart;
  while (targetEnd < parts.length && parts[targetEnd] !== '\n') targetEnd++;
  return moveCursor(editor, targetStart + Math.min(current.column, targetEnd - targetStart));
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function pastedText(text: string): string {
  // PowerShell and some terminal paste paths append a final line ending even
  // when it is not part of the clipboard payload. Internal newlines are kept
  // so the editor can display a shell command exactly as the user copied it.
  return normalizeLineEndings(text).replace(/\n+$/g, '');
}

function singleLineText(text: string): string {
  return pastedText(text).replace(/[ \t]*\n[ \t]*/g, ' ');
}

function wrappedRows(text: string, width: number): number {
  return Math.max(1, Math.ceil(displayWidth(text) / Math.max(1, width)));
}

export function calculateCursorPosition(options: {
  columns: number;
  configMissing: boolean;
  prompt: boolean;
  cursorCells: number;
}): { x: number; y: number } {
  const contentWidth = Math.max(1, options.columns - 4);
  const guidanceRows = options.configMissing ? wrappedRows(CONFIG_GUIDANCE, contentWidth) : 0;
  const inputRow = guidanceRows + 1;
  return {
    x: 2 + (options.cursorCells % contentWidth),
    y: inputRow + Math.floor(options.cursorCells / contentWidth),
  };
}

export function calculatePromptCursorPosition(options: {
  columns: number;
  configMissing: boolean;
  question: string;
  textBeforeCursor: string;
}): { x: number; y: number } {
  const contentWidth = Math.max(1, options.columns - 4);
  const guidanceRows = options.configMissing ? wrappedRows(CONFIG_GUIDANCE, contentWidth) : 0;
  const questionRows = wrappedRows(`? ${options.question}`, contentWidth);
  const lines = normalizeLineEndings(options.textBeforeCursor).split('\n');
  const previousLineRows = lines
    .slice(0, -1)
    .reduce((total, line) => total + wrappedRows(`  ${line}`, contentWidth), 0);
  const currentCells = displayWidth(`  ${lines.at(-1) ?? ''}`);
  return {
    x: 2 + (currentCells % contentWidth),
    y: guidanceRows + 1 + questionRows + previousLineRows + Math.floor(currentCells / contentWidth),
  };
}

/**
 * Static scrollback content. The welcome card and command output are written
 * to stdout exactly once and preserved in the terminal's scrollback — they must
 * NOT be part of the live frame, otherwise every keystroke/refresh re-draws
 * them and pushes a partial copy into the scrollback (the ghosting seen when
 * scrolling the mouse).
 */
type StaticLine =
  | { key: string; kind: 'homepage'; spans: Span[] }
  | { key: string; kind: 'output'; text: string; err: boolean };

let lineSeq = 0;

/** Short, honest verb for a task status — no UUID, no fabricated results. */
const STATUS_VERB: Record<string, string> = {
  PENDING: '排队中',
  WAITING_FOR_RESOURCES: '等待资源',
  RUNNING: '执行中',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCEL_REQUESTED: '取消中',
  CANCELLED: '已取消',
  RECOVERING: '恢复核对',
};

function activityLine(t: { status?: string; target?: { name?: string } }): string {
  const verb = STATUS_VERB[t.status ?? ''] ?? t.status ?? '任务';
  const target = t.target?.name;
  return target ? `${verb} · ${target}` : verb;
}

function renderSpans(spans: Span[]): React.ReactNode {
  return spans.map((span, i) => (
    <Text key={i} color={span.color === 'red' ? '#EF4444' : span.color === 'gray' ? 'gray' : undefined}>
      {span.text}
    </Text>
  ));
}

export interface AppProps {
  ctx: WorkbenchContext;
  nativeCursor?: boolean;
  /** Injectable for terminal-level Ctrl+V regression tests. */
  clipboardReader?: () => Promise<string>;
  /** Parent-owned shutdown coordinator. It must unmount Ink and await it. */
  onExitRequest?: () => Promise<void> | void;
}

export function App({ ctx, nativeCursor = true, clipboardReader = readClipboardText, onExitRequest }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { setCursorPosition } = useCursor();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(() => Math.max(1, stdout.columns ?? 80));
  const [rows, setRows] = useState(() => Math.max(1, stdout.rows ?? 24));
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const [staticLines, setStaticLines] = useState<StaticLine[]>([]);
  const mode = 'workflow';
  const [editor, setEditor] = useState<EditorState>({ text: '', cursor: 0 });
  const input = editor.text;
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptEditor, setPromptEditor] = useState<EditorState>({ text: '', cursor: 0 });
  const promptValue = promptEditor.text;
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuOffset, setMenuOffset] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [exiting, setExiting] = useState(false);
  const [commandPending, setCommandPending] = useState(false);
  const [configMissing, setConfigMissing] = useState(() => ctx.hasConfig ? !ctx.hasConfig() : false);

  const promptResolveRef = useRef<((v: string | null) => void) | null>(null);
  const selectionResolveRef = useRef<((v: unknown | null) => void) | null>(null);
  const pendingEscapeRef = useRef(false);
  const clipboardPastePendingRef = useRef(false);
  const runningRef = useRef(false);
  const exitingRef = useRef(false);
  const exitPromiseRef = useRef<Promise<void> | null>(null);

  const requestExit = useCallback((): Promise<void> => {
    if (exitPromiseRef.current) return exitPromiseRef.current;
    exitingRef.current = true;
    setExiting(true);
    // A command may currently be waiting on a prompt. Resolve that prompt so
    // its command promise cannot keep the CLI alive after the UI is gone.
    const pendingPrompt = promptResolveRef.current;
    promptResolveRef.current = null;
    if (pendingPrompt) {
      setPrompt(null);
      pendingPrompt('');
    }
    const pendingSelection = selectionResolveRef.current;
    selectionResolveRef.current = null;
    if (pendingSelection) {
      setSelection(null);
      pendingSelection(null);
    }
    const promise = Promise.resolve()
      .then(() => onExitRequest?.())
      .then(() => {
        // Tests and embedders may render App without a parent coordinator.
        // Keep the same idempotent path by falling back to Ink's exit API.
        if (!onExitRequest) exit();
      });
    exitPromiseRef.current = promise;
    return promise;
  }, [exit, onExitRequest]);

  // Do not use Ink's eager useWindowSize here: Ctrl+wheel produces a rapid
  // sequence of intermediate widths and that hook redraws every one. Keep the
  // React content stable until the same resize burst has settled.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (exitingRef.current) return;
        setColumns(Math.max(1, stdout.columns ?? 80));
        setRows(Math.max(1, stdout.rows ?? 24));
      }, 75);
    };
    stdout.on('resize', onResize);
    return () => {
      if (timer) clearTimeout(timer);
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const append = (text: string, err = false): void => {
    if (exitingRef.current) return;
    const parts = text.split('\n');
    setStaticLines((prev) => [
      ...prev,
      ...parts.map((p) => ({ key: `out-${++lineSeq}`, kind: 'output' as const, text: p, err })),
    ]);
  };

  const io = useMemo<CommandIO>(() => {
    const print = (text: string): void => append(text, false);
    const error = (text: string): void => append(text, true);
    const ask = (question: string, secret: boolean, initialValue = ''): Promise<string | null> =>
      new Promise<string | null>((resolve) => {
        promptResolveRef.current = resolve;
        setPromptEditor({ text: initialValue, cursor: graphemes(initialValue).length });
        setPrompt({ question, secret });
      });
    return {
      interactive: true,
      print,
      error,
      prompt: (q, o) => ask(q, o?.secret ?? false, o?.initialValue ?? ''),
      select: <T,>(q: string, choices: { label: string; value: T }[]): Promise<T | null> =>
        new Promise<T | null>((resolve) => {
          selectionResolveRef.current = (value) => resolve(value as T | null);
          setSelection({
            question: q,
            choices: choices.map((choice) => ({ label: choice.label, value: choice.value })),
            index: 0,
            offset: 0,
          });
        }),
      confirm: async (q) => {
        const a = await ask(q + ' (y/n)', false);
        return a?.trim().toLowerCase().startsWith('y') ?? false;
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bracketed paste delivers the complete text, including newlines, without
  // turning each pasted line into an Enter submission. Prompt editors keep
  // those line breaks for a readable multi-line preview; command parsing
  // normalizes shell continuations only after the user confirms the value.
  usePaste((text) => {
    // A command remains pending while it awaits an interactive prompt. The
    // prompt must still accept paste; only discard paste during the short
    // command-transition state where no editor is visible.
    if (exitingRef.current || (!prompt && commandPending) || selection) return;
    const value = pastedText(text);
    if (prompt) {
      const promptPaste = prompt.secret ? value.replace(/\n/g, '') : value;
      setPromptEditor((editorValue) => insertText(editorValue, promptPaste));
    } else {
      setEditor((editorValue) => insertText(editorValue, singleLineText(value)));
    }
  });

  const pasteClipboard = useCallback(async (): Promise<void> => {
    if (exitingRef.current || (!prompt && commandPending) || selection || clipboardPastePendingRef.current) return;
    clipboardPastePendingRef.current = true;
    try {
      const text = await clipboardReader();
      if (exitingRef.current) return;
      const value = pastedText(text);
      if (prompt) {
        const promptPaste = prompt.secret ? value.replace(/\n/g, '') : value;
        setPromptEditor((editorValue) => insertText(editorValue, promptPaste));
      } else {
        setEditor((editorValue) => insertText(editorValue, singleLineText(value)));
      }
    } catch (error) {
      append((error as Error).message, true);
    } finally {
      clipboardPastePendingRef.current = false;
    }
  }, [clipboardReader, commandPending, prompt, selection]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      let backendNote = '';
      const hasConfig = ctx.hasConfig ? ctx.hasConfig() : true;
      if (hasConfig) {
        try {
          await ctx.ensureBackend();
        } catch (err) {
          backendNote = `后台不可用：${(err as Error).message}`;
        }
      }
      if (disposed || exitingRef.current) return;
      const cfg = (() => {
        try {
          return ctx.config();
        } catch {
          return { model: null, target: null, project_root: process.cwd(), backend: { runner: 'workflow' as const } };
        }
      })();
      const targetName = cfg.target ? targetLabel(cfg.target) : '未选择';
      const modelName = cfg.model
        ? cfg.model.model_id
        : '未配置';

      let recentActivity: string[] = [];
      if (hasConfig) {
        try {
          const api = await ctx.getApi();
          const res = (await api.listTasks()) as { tasks?: { status?: string; target?: { name?: string } }[] };
          recentActivity = (res.tasks ?? []).slice(0, 3).map(activityLine);
        } catch {
          recentActivity = [];
        }
      }

      const homeStatus: HomepageStatus = {
        model: modelName,
        target: targetName,
        path: cfg.project_root,
        recentActivity,
      };
      if (disposed || exitingRef.current) return;
      const spans = homepageLines(homeStatus, columnsRef.current);
      const homeItems: StaticLine[] = [
        ...spans.map((line, i) => ({ key: `hp-${i}`, kind: 'homepage' as const, spans: line })),
        { key: 'hp-blank', kind: 'output' as const, text: ' ', err: false },
      ];

      // The welcome card is written once. A backend failure note follows it as
      // ordinary scrollback output; nothing else re-prints the card.
      const noteItems: StaticLine[] = backendNote
        ? backendNote.split('\n').map((p) => ({ key: `out-${++lineSeq}`, kind: 'output' as const, text: p, err: backendNote.includes('不可用') }))
        : [];
      if (!disposed && !exitingRef.current) setStaticLines([...homeItems, ...noteItems]);
    })();
    return () => {
      // The async startup path has no cancellable backend request, so the
      // disposed/ref guards prevent its completion from scheduling a
      // post-exit render.
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onStdinEnd = (): void => { void requestExit(); };
    stdin.on('end', onStdinEnd);
    stdin.on('close', onStdinEnd);
    return () => {
      stdin.off('end', onStdinEnd);
      stdin.off('close', onStdinEnd);
    };
  }, [requestExit, stdin]);

  const modeLabel = mode === 'workflow' ? '优化工作流' : mode;
  const contentWidth = Math.max(0, columns - 4);
  const rule = '─'.repeat(contentWidth);
  const menuOpen = input.startsWith('/') && !input.includes(' ') && !menuDismissed;
  const menuCommands = menuOpen ? filterSlashCommands(COMMANDS, input) : [];
  const menuCount = menuVisibleCount(rows, menuCommands.length);
  const safeMenuIndex = menuCommands.length > 0 ? Math.min(menuIndex, menuCommands.length - 1) : 0;
  const safeMenuOffset = ensureMenuOffset(safeMenuIndex, menuOffset, menuCount, menuCommands.length);
  const menuLayout = buildSlashMenuLayout(menuCommands.slice(safeMenuOffset, safeMenuOffset + menuCount), contentWidth);
  const selectionCount = selection ? menuVisibleCount(rows, selection.choices.length) : 0;
  const safeSelectionIndex = selection
    ? Math.min(selection.index, Math.max(0, selection.choices.length - 1))
    : 0;
  const safeSelectionOffset = selection
    ? ensureMenuOffset(safeSelectionIndex, selection.offset, selectionCount, selection.choices.length)
    : 0;

  // Reset the picker when the command prefix changes, while preserving the
  // current selection during an up/down movement.
  const menuPrefix = menuOpen ? input : '';
  useEffect(() => {
    setMenuIndex(0);
    setMenuOffset(0);
  }, [menuPrefix]);

  useEffect(() => {
    if (menuCommands.length === 0) {
      setMenuIndex(0);
      setMenuOffset(0);
      return;
    }
    setMenuIndex((current) => Math.min(current, menuCommands.length - 1));
    setMenuOffset((current) => ensureMenuOffset(safeMenuIndex, current, menuCount, menuCommands.length));
  }, [menuCommands.length, menuCount, safeMenuIndex]);

  // Use the terminal's native cursor. It blinks according to the user's
  // terminal settings and supports IME without periodic React redraws.
  const inputBeforeCursor = graphemes(input).slice(0, editor.cursor).join('');
  const promptDisplayValue = prompt?.secret
    ? '*'.repeat(graphemes(promptValue).length)
    : normalizeLineEndings(promptValue);
  const promptDisplayLines = promptDisplayValue.split('\n');
  const promptBeforeCursor = prompt?.secret
    ? '*'.repeat(promptEditor.cursor)
    : graphemes(promptValue).slice(0, promptEditor.cursor).join('');
  const cursorPosition = prompt
    ? calculatePromptCursorPosition({
        columns,
        configMissing,
        question: prompt.question,
        textBeforeCursor: promptBeforeCursor,
      })
    : calculateCursorPosition({
        columns,
        configMissing,
        prompt: false,
        cursorCells: displayWidth(`❯ ${inputBeforeCursor}`),
      });
  setCursorPosition(nativeCursor && !exiting && !selection
    && (!commandPending || Boolean(prompt))
    ? cursorPosition
    : undefined);

  async function submitCommand(commandOverride?: string): Promise<void> {
    if (runningRef.current) return;
    runningRef.current = true;
    setCommandPending(true);
    const line = commandOverride ?? input;
    setEditor({ text: '', cursor: 0 });
    if (line.trim().split(/\s+/)[0] === '/model') setConfigMissing(false);
    if (line.trim().length > 0) {
      // Keep the executed command in scrollback so users can distinguish
      // their input from command output after the live input line is cleared.
      append(`❯ ${line}`);
      setHistory((h) => [line, ...h.filter((x) => x !== line)].slice(0, 100));
    }
    setHistIdx(-1);
    try {
      const outcome = await runCommand(ctx, line, io);
      if (outcome.exit) {
        // Keep the existing command message semantics, then hand teardown to
        // the single lifecycle coordinator. No delayed render timer is needed.
        append(outcome.message, !outcome.ok);
        await requestExit();
      } else {
        append(outcome.message, !outcome.ok);
      }
    } finally {
      if (ctx.hasConfig) setConfigMissing(!ctx.hasConfig());
      setCommandPending(false);
      runningRef.current = false;
    }
  }

  function submitPrompt(): void {
    const resolve = promptResolveRef.current;
    setPrompt(null);
    promptResolveRef.current = null;
    resolve?.(promptValue);
    if (!prompt?.secret) append(`${prompt?.question ?? ''} ${promptValue}`);
  }

  function cancelPrompt(): void {
    const resolve = promptResolveRef.current;
    setPrompt(null);
    promptResolveRef.current = null;
    resolve?.(null);
  }

  function submitSelection(value: unknown | null): void {
    const resolve = selectionResolveRef.current;
    selectionResolveRef.current = null;
    setSelection(null);
    resolve?.(value);
  }

  // Esc pressed during the short transition between a command step and its
  // next prompt must not be lost. Apply it as soon as that prompt/selection
  // becomes visible, so cancellation remains predictable for fast typing.
  useEffect(() => {
    if (!pendingEscapeRef.current) return;
    if (prompt) {
      pendingEscapeRef.current = false;
      cancelPrompt();
    } else if (selection) {
      pendingEscapeRef.current = false;
      submitSelection(null);
    }
    // The resolver refs are intentionally used here instead of adding the
    // freshly-created render callbacks to the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, selection]);

  useInput((char, key) => {
    if (exitingRef.current) return;

    if (key.ctrl && (char === 'c' || char === 'C' || char === 'd' || char === 'D')) {
      void requestExit();
      return;
    }
    if (char === '\u0004') {
      void requestExit();
      return;
    }

    if ((key.ctrl && (char === 'v' || char === 'V')) || char === '\u0016') {
      void pasteClipboard();
      return;
    }

    if (selection) {
      if (key.escape) {
        submitSelection(null);
      } else if (key.return) {
        submitSelection(selection.choices[safeSelectionIndex]?.value ?? null);
      } else if (key.upArrow && selection.choices.length > 0) {
        const next = (safeSelectionIndex - 1 + selection.choices.length) % selection.choices.length;
        setSelection((current) => current ? {
          ...current,
          index: next,
          offset: ensureMenuOffset(next, current.offset, selectionCount, current.choices.length),
        } : current);
      } else if (key.downArrow && selection.choices.length > 0) {
        const next = (safeSelectionIndex + 1) % selection.choices.length;
        setSelection((current) => current ? {
          ...current,
          index: next,
          offset: ensureMenuOffset(next, current.offset, selectionCount, current.choices.length),
        } : current);
      }
      return;
    }

    if (prompt) {
      if (key.escape) {
        cancelPrompt();
      } else if (key.return && (key.shift || key.meta) && !prompt.secret) {
        setPromptEditor((value) => insertText(value, '\n'));
      } else if (key.return) {
        submitPrompt();
      } else if (key.leftArrow) {
        setPromptEditor((value) => moveCursor(value, value.cursor - 1));
      } else if (key.rightArrow) {
        setPromptEditor((value) => moveCursor(value, value.cursor + 1));
      } else if (key.upArrow) {
        setPromptEditor((value) => moveCursorVertically(value, -1));
      } else if (key.downArrow) {
        setPromptEditor((value) => moveCursorVertically(value, 1));
      } else if (key.home) {
        setPromptEditor((value) => moveCursor(value, currentLineBounds(value).start));
      } else if (key.end) {
        setPromptEditor((value) => moveCursor(value, currentLineBounds(value).end));
      } else if (key.backspace) {
        setPromptEditor(backspace);
      } else if (key.delete) {
        setPromptEditor(deleteForward);
      } else if (!key.ctrl && char) {
        setPromptEditor((value) => insertText(value, normalizeLineEndings(char)));
      }
      return;
    }

    if (commandPending) {
      if (key.escape) pendingEscapeRef.current = true;
      return;
    }

    if (key.escape) {
      if (menuOpen) setMenuDismissed(true);
      return;
    }
    if (key.return) {
      const selected = menuOpen && menuCommands.length > 0 ? menuCommands[safeMenuIndex]?.name : undefined;
      void submitCommand(selected);
      return;
    }
    if (menuOpen && key.upArrow) {
      if (menuCommands.length > 0) {
        const next = (safeMenuIndex - 1 + menuCommands.length) % menuCommands.length;
        setMenuIndex(next);
        setMenuOffset((current) => ensureMenuOffset(next, current, menuCount, menuCommands.length));
      }
      return;
    }
    if (menuOpen && key.downArrow) {
      if (menuCommands.length > 0) {
        const next = (safeMenuIndex + 1) % menuCommands.length;
        setMenuIndex(next);
        setMenuOffset((current) => ensureMenuOffset(next, current, menuCount, menuCommands.length));
      }
      return;
    }
    if (key.leftArrow) {
      setEditor((value) => moveCursor(value, value.cursor - 1));
      return;
    }
    if (key.rightArrow) {
      setEditor((value) => moveCursor(value, value.cursor + 1));
      return;
    }
    if (key.home) {
      setEditor((value) => moveCursor(value, 0));
      return;
    }
    if (key.end) {
      setEditor((value) => moveCursor(value, graphemes(value.text).length));
      return;
    }
    if (key.upArrow) {
      const next = Math.min(histIdx + 1, history.length - 1);
      if (next >= 0) {
        setHistIdx(next);
        setEditor({ text: history[next], cursor: graphemes(history[next]).length });
      }
      setMenuDismissed(true);
      return;
    }
    if (key.downArrow) {
      const next = histIdx - 1;
      if (next < 0) {
        setHistIdx(-1);
        setEditor({ text: '', cursor: 0 });
      } else {
        setHistIdx(next);
        setEditor({ text: history[next], cursor: graphemes(history[next]).length });
      }
      setMenuDismissed(true);
      return;
    }
    if (key.tab) {
      const trimmed = input.trimStart();
      if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
        if (menuCommands.length > 0) {
          const selected = menuCommands[safeMenuIndex].name;
          setEditor({ text: selected, cursor: graphemes(selected).length });
          setMenuDismissed(false);
        }
      }
      return;
    }
    if (key.backspace) {
      setEditor(backspace);
      setHistIdx(-1);
      setMenuDismissed(false);
      return;
    }
    if (key.delete) {
      setEditor(deleteForward);
      setHistIdx(-1);
      setMenuDismissed(false);
      return;
    }
    if (!key.ctrl && char) {
      setEditor((value) => insertText(value, char));
      setHistIdx(-1);
      setMenuDismissed(false);
    }
  });

  return (
    <Box flexDirection="column" paddingX={2}>
      <Static items={staticLines}>
        {(item) =>
          item.kind === 'homepage' ? (
            <Text key={item.key} wrap="truncate">
              {renderSpans(item.spans)}
            </Text>
          ) : (
            <Text key={item.key} color={item.err ? 'red' : undefined}>
              {item.text}
            </Text>
          )
        }
      </Static>

      {configMissing && <Text color="yellow" wrap="hard">{CONFIG_GUIDANCE}</Text>}

      {!exiting && (
        <Box flexDirection="column">
          <Text color="gray" wrap="truncate">{rule}</Text>
          {selection ? (
            <Box flexDirection="column">
              <Text color="yellow">? {selection.question}</Text>
              {selection.choices.slice(safeSelectionOffset, safeSelectionOffset + selectionCount).map((choice, index) => {
                const selected = safeSelectionOffset + index === safeSelectionIndex;
                return (
                  <Text key={`${selection.question}-${safeSelectionOffset + index}`} wrap="truncate" inverse={selected} bold={selected}>
                    {selected ? '❯ ' : '  '}{choice.label}
                  </Text>
                );
              })}
              <Text color="gray" wrap="truncate">↑↓ 选择 · Enter 确认 · Esc 返回</Text>
            </Box>
          ) : prompt ? (
            <Box flexDirection="column">
              <Text color="yellow" wrap="hard">? {prompt.question}</Text>
              {promptDisplayLines.map((line, index) => (
                <Text key={`prompt-line-${index}`} wrap="hard">{`  ${line}`}</Text>
              ))}
              <Text color="gray" wrap="truncate">
                {prompt.secret ? 'Enter 确认 · Esc 返回' : 'Enter 确认 · Shift+Enter 换行 · Esc 返回'}
              </Text>
            </Box>
          ) : commandPending ? (
            <Text color="gray">处理中…</Text>
          ) : (
            <Box flexDirection="column">
              <Box>
                <Text color="#EF4444">❯ </Text>
                <Text wrap="hard">{input}</Text>
              </Box>
              {menuOpen && menuCommands.length > 0 && (
                <Box flexDirection="column">
                  {menuLayout.items.map((item, index) => {
                    const selected = safeMenuOffset + index === safeMenuIndex;
                    return (
                      <Text key={menuCommands[safeMenuOffset + index].name} wrap="truncate">
                        <Text color={selected ? '#EF4444' : undefined}>{item.command}</Text>
                        <Text>{' '.repeat(menuLayout.gap)}</Text>
                        <Text color={selected ? '#9CA3AF' : 'gray'}>{item.description}</Text>
                      </Text>
                    );
                  })}
                  {(menuCommands.length > menuCount || safeMenuOffset > 0) && (
                    <Text color="gray" wrap="truncate">
                      {`${safeMenuIndex + 1}/${menuCommands.length} · ↑↓ 选择 · Enter 执行 · Tab 补全`}
                    </Text>
                  )}
                </Box>
              )}
              <Box justifyContent="space-between">
                <Text color="gray">{menuOpen ? '↑↓ 选择 · Enter 执行 · Tab 补全' : '/ 命令 · Tab 补全'}</Text>
                <Text color="gray">{modeLabel}</Text>
              </Box>
            </Box>
          )}
          <Text color="gray" wrap="truncate">{rule}</Text>
        </Box>
      )}
    </Box>
  );
}
