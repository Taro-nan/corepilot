#!/usr/bin/env node
/**
 * Real CLI entry point (the package `bin`).
 *
 * It installs the SQLite experimental-warning filter FIRST, then dynamically
 * imports the CLI. Dynamic import is required because ESM hoists all static
 * imports above the module body, so a static import of `./cli.js` would load
 * `node:sqlite` (transitively) before any filter could run.
 */
import { installSqliteWarningFilter } from './warning-filter.js';

installSqliteWarningFilter();

const { runCli } = await import('./cli.js');

const code = await runCli(process.argv.slice(2));
process.exitCode = code;
