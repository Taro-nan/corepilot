import { render, type RenderOptions } from 'ink';
import React from 'react';
import { App } from './app.js';
import { WorkbenchContext } from './context.js';

type InkInstance = ReturnType<typeof render>;

export const INTERACTIVE_RENDER_OPTIONS = {
  exitOnCtrlC: false,
  // Enter and Shift+Enter are otherwise both emitted as CR by many terminals.
  // Request CSI-u disambiguation so Ink can expose the Shift modifier.
  kittyKeyboard: {
    mode: 'enabled',
    flags: ['disambiguateEscapeCodes'],
  },
} satisfies RenderOptions;

interface ExitBoundaryProps {
  onError: () => Promise<void> | void;
  children?: React.ReactNode;
}

interface ExitBoundaryState {
  failed: boolean;
}

/** Route render-time component failures through the same teardown request. */
export class ExitBoundary extends React.Component<ExitBoundaryProps, ExitBoundaryState> {
  state: ExitBoundaryState = { failed: false };

  static getDerivedStateFromError(): ExitBoundaryState {
    return { failed: true };
  }

  componentDidCatch(): void {
    // React commits error boundaries synchronously while Ink is constructing
    // the root. Defer one microtask so startInteractive has assigned the Ink
    // instance before the coordinator tries to unmount it.
    queueMicrotask(() => { void this.props.onError(); });
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Build the one-shot teardown barrier used by every interactive exit path.
 * Keeping it separate from startInteractive makes the ordering directly
 * testable without starting a backend or taking over a real terminal.
 */
export function createShutdownCoordinator(getInstance: () => InkInstance | null): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;

  return (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const current = getInstance();
      if (!current) return;
      try {
        await current.waitUntilRenderFlush();
      } catch {
        // If a render is already failing, unmount still needs to run.
      }
      try {
        current.clear();
      } catch {
        // Ink's unmount remains the authoritative cleanup path.
      }
      try {
        current.unmount();
      } finally {
        try {
          await current.waitUntilExit();
        } catch {
          // Preserve the existing CLI exit semantics; cleanup is best effort.
        }
      }
    })();
    return shutdownPromise;
  };
}

/**
 * Enter the interactive workbench. Loaded lazily from the CLI so non-
 * interactive commands never pay the React/ink import cost.
 */
export async function startInteractive(options: { configPath?: string } = {}): Promise<void> {
  const ctx = new WorkbenchContext(options);
  let instance: InkInstance | null = null;
  let shutdownRequested = false;
  const coordinator = createShutdownCoordinator(() => instance);
  const shutdown = (): Promise<void> => {
    shutdownRequested = true;
    return coordinator();
  };

  // Ink's outer provider otherwise intercepts Ctrl+C and unmounts immediately,
  // bypassing App's lifecycle coordinator. Let App route every exit source
  // through the same exiting -> flush -> clear -> unmount sequence.
  instance = render(
    React.createElement(ExitBoundary, { onError: shutdown }, React.createElement(App, { ctx, onExitRequest: shutdown })),
    INTERACTIVE_RENDER_OPTIONS,
  );
  try {
    await instance.waitUntilExit();
  } finally {
    // Normal exits arrive through App and have already claimed the shared
    // shutdown promise. If Ink was torn down externally (signal-exit or a
    // component error), do not call clear() after the fact; Ink already owns
    // that teardown and its exit promise is the synchronization barrier.
    if (shutdownRequested) await shutdown();
  }

  // Ink's interactive log intentionally leaves the cursor at the end of its
  // frame. Add exactly one normal newline only after its exit promise has
  // settled, so PowerShell receives a clean prompt line and no later Ink
  // callback can append to it.
  if (process.stdout.isTTY && !process.stdout.destroyed && !process.stdout.writableEnded) {
    await new Promise<void>((resolve) => {
      process.stdout.write('\n', () => resolve());
    });
  }
}
