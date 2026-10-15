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
    `);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  resolveRunnerIdentity(preferredId?: string): string {
    const row = this.db.prepare("SELECT value FROM runner_metadata WHERE key = 'runner_id'").get() as { value: string } | undefined;
    if (row) {
      if (preferredId && preferredId !== row.value) throw new Error(`runner database belongs to '${row.value}', not '${preferredId}'`);
      return row.value;
    }
    const runnerId = preferredId?.trim() || `runner:${randomUUID()}`;
    this.db.prepare("INSERT INTO runner_metadata (key, value) VALUES ('runner_id', ?)").run(runnerId);
    return runnerId;
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
    const rows = this.db.prepare('SELECT record_json FROM runner_executions ORDER BY created_at, experiment_id').all() as unknown as JsonRow[];
    const records = rows.map((row) => JSON.parse(row.record_json) as ExecutionStateRecord);
    return statuses.length === 0 ? records : records.filter((record) => statuses.includes(record.experiment.status));
  }

  recoverInterruptedExecutions(timestamp: string): number {
    const interrupted = this.listExecutions(['RUNNING']);
    for (const record of interrupted) {
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
