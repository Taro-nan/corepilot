import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CommandExecution, ExperimentStatus, Measurement } from '../contracts/optimization-domain.js';
import type { ExecutionStateRecord, RunnerStore } from './runner-store.js';

interface JsonRow { record_json: string }

/** Minimal runner-local SQLite store. It persists shared Domain records verbatim. */
export class SqliteRunnerStore implements RunnerStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    const absolute = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    this.db = new DatabaseSync(absolute);
  }

  init(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runner_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_executions (
        experiment_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        current_step TEXT,
        cancel_requested INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runner_executions_status
        ON runner_executions(status, created_at);
      CREATE TABLE IF NOT EXISTS runner_command_executions (
        command_execution_id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        FOREIGN KEY(experiment_id) REFERENCES runner_executions(experiment_id),
        UNIQUE(experiment_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS runner_commands_experiment_sequence
        ON runner_command_executions(experiment_id, sequence);
      CREATE TABLE IF NOT EXISTS runner_measurements (
        measurement_id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        role TEXT,
        sample_index INTEGER,
        recorded_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        FOREIGN KEY(experiment_id) REFERENCES runner_executions(experiment_id)
      );
      CREATE INDEX IF NOT EXISTS runner_measurements_experiment
        ON runner_measurements(experiment_id, kind, subject_id, role, sample_index);
      INSERT OR IGNORE INTO runner_metadata(key, value)
        SELECT 'queue_sequence', CAST(COALESCE(MAX(json_extract(record_json, '$.queue.sequence')), 0) AS TEXT) FROM runner_executions;
    `);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  resolveRunnerIdentity(preferredId?: string): string {
    const preferred = preferredId?.trim();
    this.db.prepare("INSERT OR IGNORE INTO runner_metadata (key, value) VALUES ('runner_id', ?)").run(preferred || `runner:${randomUUID()}`);
    const row = this.db.prepare("SELECT value FROM runner_metadata WHERE key = 'runner_id'").get() as { value: string };
    if (preferred && preferred !== row.value) throw new Error(`runner database belongs to '${row.value}', not '${preferred}'`);
    return row.value;
  }

  resolveStoreInstanceId(): string {
    // The winning INSERT is authoritative even when two processes upgrade an old database concurrently.
    this.db.prepare("INSERT OR IGNORE INTO runner_metadata (key, value) VALUES ('store_instance_id', ?)").run(randomUUID());
    const row = this.db.prepare("SELECT value FROM runner_metadata WHERE key = 'store_instance_id'").get() as { value: string };
    return row.value;
  }

  createExecution(record: ExecutionStateRecord): void {
    this.db.prepare(`
      INSERT INTO runner_executions
        (experiment_id, status, current_step, cancel_requested, record_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.experiment.experiment_id,
      record.experiment.status,
      record.current_step,
      record.cancel_requested ? 1 : 0,
      JSON.stringify(record),
      record.experiment.created_at,
      record.experiment.updated_at,
    );
  }

  allocateQueueSequence(): number {
    const row = this.db.prepare("UPDATE runner_metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'queue_sequence' RETURNING value").get() as { value: string };
    return Number(row.value);
  }

  saveExecution(record: ExecutionStateRecord): void {
    const result = this.db.prepare(`
      UPDATE runner_executions
      SET status = ?, current_step = ?, cancel_requested = ?, record_json = ?, updated_at = ?
      WHERE experiment_id = ?
    `).run(
      record.experiment.status,
      record.current_step,
      record.cancel_requested ? 1 : 0,
      JSON.stringify(record),
      record.experiment.updated_at,
      record.experiment.experiment_id,
    );
    if (Number(result.changes) !== 1) throw new Error(`runner experiment '${record.experiment.experiment_id}' not found`);
  }

  getExecution(experimentId: string): ExecutionStateRecord | null {
    const row = this.db.prepare('SELECT record_json FROM runner_executions WHERE experiment_id = ?').get(experimentId) as JsonRow | undefined;
    return row ? JSON.parse(row.record_json) as ExecutionStateRecord : null;
  }

  listExecutions(statuses: readonly ExperimentStatus[] = []): ExecutionStateRecord[] {
    const rows = this.db.prepare(`SELECT record_json FROM runner_executions ${statuses.length ? `WHERE status IN (${statuses.map(() => '?').join(',')})` : ''} ORDER BY created_at, experiment_id`).all(...statuses) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.record_json) as ExecutionStateRecord);
  }

  recoverInterruptedExecutions(timestamp: string): number {
    // Upgrading a pre-queue Runner must also preserve already-UNKNOWN ownership.
    for (const record of this.listExecutions(['UNKNOWN'])) {
      if (record.queue) continue;
      record.queue = { policy: 'runner-exclusive-fifo-v1', sequence: 0, enqueued_at: record.experiment.created_at,
        acquired_at: record.experiment.started_at ?? record.experiment.created_at, released_at: null, wait_ms: null };
      this.saveExecution(record);
    }
    const interrupted = this.listExecutions(['RUNNING']);
    for (const record of interrupted) {
      record.queue ??= { policy: 'runner-exclusive-fifo-v1', sequence: 0, enqueued_at: record.experiment.created_at,
        acquired_at: record.experiment.started_at ?? record.experiment.created_at, released_at: null, wait_ms: null };
      record.experiment = {
        ...record.experiment,
        status: 'UNKNOWN',
        validity: 'UNKNOWN',
        failure_category: 'UNKNOWN',
        ended_at: null,
        updated_at: timestamp,
      };
      record.failure = {
        code: 'RUNNER_RESTART',
        message: 'runner restarted while the experiment was running; prior process state cannot be confirmed',
        step: null,
        command_execution_id: null,
      };
      this.saveExecution(record);
    }
    return interrupted.length;
  }

  appendCommandExecution(execution: CommandExecution): void {
    this.db.prepare(`
      INSERT INTO runner_command_executions
        (command_execution_id, experiment_id, sequence, record_json)
      VALUES (?, ?, ?, ?)
    `).run(execution.command_execution_id, execution.experiment_id, execution.sequence, JSON.stringify(execution));
  }

  listCommandExecutions(experimentId: string): CommandExecution[] {
    const rows = this.db.prepare(`
      SELECT record_json FROM runner_command_executions
      WHERE experiment_id = ? ORDER BY sequence
    `).all(experimentId) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.record_json) as CommandExecution);
  }

  appendMeasurement(measurement: Measurement): void {
    this.db.prepare(`
      INSERT INTO runner_measurements
        (measurement_id, experiment_id, kind, subject_id, role, sample_index, recorded_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      measurement.measurement_id,
      measurement.experiment_id,
      measurement.kind,
      measurement.subject_id,
      measurement.role,
      measurement.sample_index,
      measurement.recorded_at,
      JSON.stringify(measurement),
    );
  }

  listMeasurements(experimentId: string): Measurement[] {
    const rows = this.db.prepare(`
      SELECT record_json FROM runner_measurements
      WHERE experiment_id = ?
      ORDER BY kind, subject_id, COALESCE(role, ''), COALESCE(sample_index, -1), recorded_at
    `).all(experimentId) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.record_json) as Measurement);
  }
}
