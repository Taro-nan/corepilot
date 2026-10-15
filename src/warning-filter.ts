/**
 * Precisely suppress the one known `node:sqlite` experimental notice, and
 * nothing else.
 *
 * Node 24 emits `ExperimentalWarning: SQLite is an experimental feature and
 * might change at any time` (asynchronously, after the first `DatabaseSync` is
 * constructed) whenever the built-in SQLite module is used. This notice has no
 * dedicated warning code, so `--disable-warning=ExperimentalWarning` would hide
 * every other experimental warning too, and `--no-warnings` is even broader —
 * neither is acceptable. Instead we wrap `process.emitWarning` and drop only
 * the exact known message, forwarding everything else untouched (other
 * warnings keep printing; errors are never touched).
 */

const SQLITE_EXPERIMENTAL_NOTICE =
  'SQLite is an experimental feature and might change at any time';

/**
 * Install the filter. Must run BEFORE the first `new DatabaseSync(...)` in the
 * process — the CLI entry calls this before importing any module that touches
 * `node:sqlite`.
 */
export function installSqliteWarningFilter(): void {
  const original = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (typeof warning === 'string' && warning === SQLITE_EXPERIMENTAL_NOTICE) {
      return;
    }
    return original(warning, ...rest);
  }) as typeof process.emitWarning;
}
