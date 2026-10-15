import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CommandRecord } from '../contracts/command.js';
import type { Event, EventType, MockScenario, RunnerJob, Target, Task, TaskStatus } from '../contracts/index.js';
import type {
  Candidate,
  CommandExecution,
  Experiment,
  Measurement,
  OptimizationTask,
} from '../contracts/optimization-domain.js';
import type { LeaseRecord, TaskStore } from './task-store.js';
import type { HypothesisOutcome, OptimizationHypothesis } from '../contracts/optimization-hypothesis.js';
import type { OptimizationApprovalRecord } from '../contracts/optimization-approval.js';

interface TaskRow {
  task_id: string; request_id: string; status: string; target_json: string; schema_version: number; is_mock: number;
  created_at: string; updated_at: string; error: string | null; next_check_at: string | null;
  availability_reason: string | null; report_path: string | null;
}

interface JobRow {
  job_id: string; task_id: string; request_id: string; scenario: string; status: string; attempt_number: number;
  schema_version: number; is_mock: number; created_at: string; updated_at: string; error: string | null;
}

interface EventRow {
  sequence: number; event_id: string; task_id: string; job_id: string | null; type: string;
  payload_json: string; schema_version: number; created_at: string;
}

interface JsonRecordRow {
  record_json: string;
}

/** SQLite 只保存通用任务、服务租约和 public workflow。 */
export class SqliteTaskStore implements TaskStore {
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
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
        target_json TEXT NOT NULL, schema_version INTEGER NOT NULL, is_mock INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
        next_check_at TEXT, availability_reason TEXT, report_path TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, request_id TEXT NOT NULL,
        scenario TEXT NOT NULL, status TEXT NOT NULL, attempt_number INTEGER NOT NULL,
        schema_version INTEGER NOT NULL, is_mock INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS jobs_task_attempt ON jobs(task_id, attempt_number DESC);
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL, job_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task_sequence ON events(task_id, sequence);
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
        result_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_lease (
        lease_key INTEGER PRIMARY KEY CHECK (lease_key = 1), owner_id TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS optimization_workflows (
        workflow_id TEXT PRIMARY KEY, workflow_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS optimization_tasks (
        task_id TEXT PRIMARY KEY, workflow_id TEXT UNIQUE, status TEXT NOT NULL,
        record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS optimization_candidates (
        candidate_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, parent_candidate_id TEXT,
        sequence INTEGER NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES optimization_tasks(task_id),
        FOREIGN KEY(parent_candidate_id) REFERENCES optimization_candidates(candidate_id),
        UNIQUE(task_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS optimization_hypotheses (
        hypothesis_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, parent_hypothesis_id TEXT,
        record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES optimization_tasks(task_id),
        FOREIGN KEY(parent_hypothesis_id) REFERENCES optimization_hypotheses(hypothesis_id)
      );
      CREATE INDEX IF NOT EXISTS optimization_hypotheses_task_created
        ON optimization_hypotheses(task_id, created_at);
      CREATE INDEX IF NOT EXISTS optimization_candidates_task_sequence
        ON optimization_candidates(task_id, sequence);
      CREATE TABLE IF NOT EXISTS optimization_experiments (
        experiment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
        purpose TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES optimization_tasks(task_id),
        FOREIGN KEY(candidate_id) REFERENCES optimization_candidates(candidate_id)
      );
      CREATE INDEX IF NOT EXISTS optimization_experiments_task_created
        ON optimization_experiments(task_id, created_at);
      CREATE INDEX IF NOT EXISTS optimization_experiments_candidate_created
        ON optimization_experiments(candidate_id, created_at);
      CREATE TABLE IF NOT EXISTS optimization_hypothesis_outcomes (
        outcome_id TEXT PRIMARY KEY, hypothesis_id TEXT NOT NULL, task_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL, experiment_id TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
        FOREIGN KEY(hypothesis_id) REFERENCES optimization_hypotheses(hypothesis_id),
        FOREIGN KEY(task_id) REFERENCES optimization_tasks(task_id),
        FOREIGN KEY(candidate_id) REFERENCES optimization_candidates(candidate_id),
        FOREIGN KEY(experiment_id) REFERENCES optimization_experiments(experiment_id)
      );
      CREATE INDEX IF NOT EXISTS optimization_outcomes_task_recorded
        ON optimization_hypothesis_outcomes(task_id, recorded_at);
      CREATE TABLE IF NOT EXISTS optimization_approvals (
        approval_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, candidate_id TEXT NOT NULL UNIQUE,
        evidence_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, approved_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES optimization_tasks(task_id),
        FOREIGN KEY(candidate_id) REFERENCES optimization_candidates(candidate_id)
      );
      CREATE TABLE IF NOT EXISTS optimization_experiment_commands (
        command_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, step TEXT NOT NULL,
        sequence INTEGER NOT NULL, record_json TEXT NOT NULL,
        FOREIGN KEY(experiment_id) REFERENCES optimization_experiments(experiment_id),
        UNIQUE(experiment_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS optimization_commands_experiment_sequence
        ON optimization_experiment_commands(experiment_id, sequence);
      CREATE TABLE IF NOT EXISTS optimization_measurements (
        measurement_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, role TEXT, sample_index INTEGER, record_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY(experiment_id) REFERENCES optimization_experiments(experiment_id)
      );
      CREATE INDEX IF NOT EXISTS optimization_measurements_experiment
        ON optimization_measurements(experiment_id, kind, name, role, sample_index);
    `);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  createTaskWithJob(task: Task, taskEvent: Event, job: RunnerJob, jobEvent: Event): void {
    this.transaction(() => { this.insertTask(task); this.insertEvent(taskEvent); this.insertJob(job); this.insertEvent(jobEvent); });
  }

  createTask(task: Task, event: Event): void { this.transaction(() => { this.insertTask(task); this.insertEvent(event); }); }
  createJob(job: RunnerJob, event: Event): void { this.transaction(() => { this.insertJob(job); this.insertEvent(event); }); }

  getTask(taskId: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as TaskRow | undefined;
    return row ? this.rowToTask(row) : null;
  }

  getTaskByRequestId(requestId: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE request_id = ?').get(requestId) as TaskRow | undefined;
    return row ? this.rowToTask(row) : null;
  }

  updateTaskStatus(taskId: string, status: TaskStatus, error: string | null, event: Event): void {
    this.transaction(() => {
      this.db.prepare('UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE task_id = ?').run(status, error, event.created_at, taskId);
      this.insertEvent(event);
    });
  }

  updateTaskNextCheck(taskId: string, nextCheckAt: string | null, availabilityReason: string | null): void {
    this.db.prepare('UPDATE tasks SET next_check_at = ?, availability_reason = ?, updated_at = ? WHERE task_id = ?').run(nextCheckAt, availabilityReason, new Date().toISOString(), taskId);
  }

  updateTaskReportPath(taskId: string, reportPath: string): void {
    this.db.prepare('UPDATE tasks SET report_path = ?, updated_at = ? WHERE task_id = ?').run(reportPath, new Date().toISOString(), taskId);
  }

  listTasksByStatus(statuses: readonly TaskStatus[]): Task[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at`).all(...statuses) as unknown as TaskRow[];
    return rows.map((row) => this.rowToTask(row));
  }

  claimTask(taskId: string, from: TaskStatus, to: TaskStatus): boolean {
    const result = this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ? AND status = ?').run(to, new Date().toISOString(), taskId, from);
    return Number(result.changes) === 1;
  }

  getJob(jobId: string): RunnerJob | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as JobRow | undefined;
    return row ? this.rowToJob(row) : null;
  }

  getJobByTaskId(taskId: string): RunnerJob | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1').get(taskId) as JobRow | undefined;
    return row ? this.rowToJob(row) : null;
  }

  updateJobStatus(jobId: string, status: TaskStatus, error: string | null, event: Event): void {
    this.transaction(() => {
      this.db.prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE job_id = ?').run(status, error, event.created_at, jobId);
      this.insertEvent(event);
    });
  }

  nextAttemptNumber(taskId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM jobs WHERE task_id = ?').get(taskId) as { next: number };
    return row.next;
  }

  appendEvent(event: Event): void { this.insertEvent(event); }

  listEvents(taskId: string): Event[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY sequence').all(taskId) as unknown as EventRow[];
    return rows.map((row) => ({ schema_version: row.schema_version, event_id: row.event_id, task_id: row.task_id, job_id: row.job_id, type: row.type as EventType, payload: JSON.parse(row.payload_json) as Record<string, unknown>, created_at: row.created_at, sequence: row.sequence }));
  }

  getCommand(commandId: string): CommandRecord | null {
    return (this.db.prepare('SELECT command_id, task_id, kind, result_json, created_at FROM commands WHERE command_id = ?').get(commandId) as CommandRecord | undefined) ?? null;
  }

  createCommand(record: CommandRecord): void {
    this.db.prepare('INSERT INTO commands (command_id, task_id, kind, result_json, created_at) VALUES (?, ?, ?, ?, ?)').run(record.command_id, record.task_id, record.kind, record.result_json, record.created_at);
  }

  tryAcquireLease(ownerId: string, ttlMs: number): boolean {
    const now = Date.now();
    return this.transaction(() => {
      const current = this.getActiveLease();
      if (current && current.owner_id !== ownerId && Date.parse(current.expires_at) > now) return false;
      const expiresAt = new Date(now + ttlMs).toISOString();
      this.db.prepare('INSERT INTO host_lease (lease_key, owner_id, expires_at) VALUES (1, ?, ?) ON CONFLICT(lease_key) DO UPDATE SET owner_id=excluded.owner_id, expires_at=excluded.expires_at').run(ownerId, expiresAt);
      return true;
    });
  }

  renewLease(ownerId: string, ttlMs: number): boolean {
    const result = this.db.prepare('UPDATE host_lease SET expires_at = ? WHERE lease_key = 1 AND owner_id = ?').run(new Date(Date.now() + ttlMs).toISOString(), ownerId);
    return Number(result.changes) === 1;
  }

  releaseLease(ownerId: string): void { this.db.prepare('DELETE FROM host_lease WHERE lease_key = 1 AND owner_id = ?').run(ownerId); }

  getActiveLease(): LeaseRecord | null {
    return (this.db.prepare('SELECT owner_id, expires_at FROM host_lease WHERE lease_key = 1').get() as LeaseRecord | undefined) ?? null;
  }

  saveOptimizationWorkflowJson(workflowId: string, workflowJson: string): void {
    this.db.prepare('INSERT INTO optimization_workflows (workflow_id, workflow_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(workflow_id) DO UPDATE SET workflow_json=excluded.workflow_json, updated_at=excluded.updated_at').run(workflowId, workflowJson, new Date().toISOString());
  }

  getOptimizationWorkflowJson(workflowId: string): string | null {
    const row = this.db.prepare('SELECT workflow_json FROM optimization_workflows WHERE workflow_id = ?').get(workflowId) as { workflow_json: string } | undefined;
    return row?.workflow_json ?? null;
  }

  saveOptimizationTask(task: OptimizationTask): void {
    this.db.prepare(`
      INSERT INTO optimization_tasks (task_id, workflow_id, status, record_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        workflow_id=excluded.workflow_id,
        status=excluded.status,
        record_json=excluded.record_json,
        updated_at=excluded.updated_at
    `).run(task.task_id, task.workflow_id, task.status, JSON.stringify(task), task.created_at, task.updated_at);
  }

  getOptimizationTask(taskId: string): OptimizationTask | null {
    return this.readJsonRecord<OptimizationTask>('SELECT record_json FROM optimization_tasks WHERE task_id = ?', taskId);
  }

  getOptimizationTaskByWorkflowId(workflowId: string): OptimizationTask | null {
    return this.readJsonRecord<OptimizationTask>('SELECT record_json FROM optimization_tasks WHERE workflow_id = ?', workflowId);
  }

  createCandidate(candidate: Candidate): void {
    const hypothesis = this.getHypothesis(candidate.hypothesis_id);
    if (!hypothesis || hypothesis.task_id !== candidate.task_id || hypothesis.status === 'ABANDONED') throw new Error('Candidate requires an active Hypothesis from the same task');
    this.db.prepare(`
      INSERT INTO optimization_candidates
        (candidate_id, task_id, parent_candidate_id, sequence, record_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(candidate.candidate_id, candidate.task_id, candidate.parent_candidate_id, candidate.sequence, JSON.stringify(candidate), candidate.created_at);
  }

  getCandidate(candidateId: string): Candidate | null {
    return this.readJsonRecord<Candidate>('SELECT record_json FROM optimization_candidates WHERE candidate_id = ?', candidateId);
  }

  listCandidates(taskId: string): Candidate[] {
    return this.readJsonRecords<Candidate>('SELECT record_json FROM optimization_candidates WHERE task_id = ? ORDER BY sequence', taskId);
  }

  recordCandidateApproval(record: OptimizationApprovalRecord): void {
    this.transaction(() => {
      const existing = this.getCandidateApproval(record.candidate_id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Candidate approval cannot change after recording');
        return;
      }
      const candidate = this.getCandidate(record.candidate_id);
      if (!candidate || candidate.task_id !== record.task_id || JSON.stringify(candidate) !== JSON.stringify(record.candidate_before)) {
        throw new Error('Candidate changed during approval');
      }
      if (record.approval_status !== 'APPROVED' || record.evidence_status !== 'APPROVED' || candidate.status === 'REJECTED' || candidate.status === 'APPROVED') {
        throw new Error('invalid Candidate approval transition');
      }
      this.db.prepare('INSERT INTO optimization_approvals (approval_id, task_id, candidate_id, evidence_id, record_json, approved_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(record.approval_id, record.task_id, record.candidate_id, record.evidence_artifact_identity.evidence_id, JSON.stringify(record), record.approved_at);
      this.db.prepare('UPDATE optimization_candidates SET record_json = ? WHERE candidate_id = ?')
        .run(JSON.stringify({ ...candidate, status: 'APPROVED' }), candidate.candidate_id);
    });
  }

  getCandidateApproval(candidateId: string): OptimizationApprovalRecord | null {
    return this.readJsonRecord<OptimizationApprovalRecord>('SELECT record_json FROM optimization_approvals WHERE candidate_id = ?', candidateId);
  }

  getEvidenceApproval(evidenceId: string): OptimizationApprovalRecord | null {
    return this.readJsonRecord<OptimizationApprovalRecord>('SELECT record_json FROM optimization_approvals WHERE evidence_id = ?', evidenceId);
  }

  createHypothesis(hypothesis: OptimizationHypothesis): void {
    if (hypothesis.parent_hypothesis_id && this.getHypothesis(hypothesis.parent_hypothesis_id)?.task_id !== hypothesis.task_id) throw new Error('Hypothesis parent belongs to another task or does not exist');
    this.db.prepare('INSERT INTO optimization_hypotheses (hypothesis_id, task_id, parent_hypothesis_id, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hypothesis.hypothesis_id, hypothesis.task_id, hypothesis.parent_hypothesis_id, JSON.stringify(hypothesis), hypothesis.created_at, hypothesis.updated_at);
  }

  getHypothesis(hypothesisId: string): OptimizationHypothesis | null {
    return this.readJsonRecord<OptimizationHypothesis>('SELECT record_json FROM optimization_hypotheses WHERE hypothesis_id = ?', hypothesisId);
  }

  listHypotheses(taskId: string): OptimizationHypothesis[] {
    return this.readJsonRecords<OptimizationHypothesis>('SELECT record_json FROM optimization_hypotheses WHERE task_id = ? ORDER BY rowid', taskId);
  }

  abandonHypothesis(hypothesisId: string, reason: string, recordedAt: string): void {
    const hypothesis = this.getHypothesis(hypothesisId);
    if (!hypothesis) throw new Error('Hypothesis not found');
    this.db.prepare('UPDATE optimization_hypotheses SET record_json = ?, updated_at = ? WHERE hypothesis_id = ?')
      .run(JSON.stringify({ ...hypothesis, status: 'ABANDONED', abandonment: { reason, recorded_at: recordedAt }, updated_at: recordedAt }), recordedAt, hypothesisId);
  }

  appendHypothesisOutcome(outcome: HypothesisOutcome): void {
    this.transaction(() => {
      const hypothesis = this.getHypothesis(outcome.hypothesis_id);
      const candidate = this.getCandidate(outcome.candidate_id);
      const experiment = this.getExperiment(outcome.experiment_id);
      if (!hypothesis || hypothesis.task_id !== outcome.task_id || candidate?.task_id !== outcome.task_id || candidate.hypothesis_id !== hypothesis.hypothesis_id || experiment?.candidate_id !== candidate.candidate_id || experiment.task_id !== outcome.task_id) throw new Error('Hypothesis outcome identity mismatch');
      if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(experiment.status)) throw new Error('Hypothesis outcome requires a completed Experiment');
      const existing = this.readJsonRecord<HypothesisOutcome>('SELECT record_json FROM optimization_hypothesis_outcomes WHERE experiment_id = ?', outcome.experiment_id);
      if (existing) {
        if (JSON.stringify({ ...existing, recorded_at: outcome.recorded_at }) !== JSON.stringify(outcome)) throw new Error('Hypothesis outcome cannot change after recording');
        return;
      }
      this.db.prepare('INSERT INTO optimization_hypothesis_outcomes (outcome_id, hypothesis_id, task_id, candidate_id, experiment_id, record_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(outcome.outcome_id, outcome.hypothesis_id, outcome.task_id, outcome.candidate_id, outcome.experiment_id, JSON.stringify(outcome), outcome.recorded_at);
      this.db.prepare('UPDATE optimization_hypotheses SET record_json = ?, updated_at = ? WHERE hypothesis_id = ?')
        .run(JSON.stringify({ ...hypothesis, status: hypothesis.status === 'ABANDONED' ? 'ABANDONED' : outcome.status, updated_at: outcome.recorded_at }), outcome.recorded_at, hypothesis.hypothesis_id);
    });
  }

  listHypothesisOutcomes(taskId: string): HypothesisOutcome[] {
    return this.readJsonRecords<HypothesisOutcome>('SELECT record_json FROM optimization_hypothesis_outcomes WHERE task_id = ? ORDER BY rowid', taskId);
  }

  createExperiment(experiment: Experiment): void {
    this.db.prepare(`
      INSERT INTO optimization_experiments
        (experiment_id, task_id, candidate_id, purpose, status, record_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(experiment.experiment_id, experiment.task_id, experiment.candidate_id, experiment.type, experiment.status, JSON.stringify(experiment), experiment.created_at, experiment.updated_at);
  }

  saveExperiment(experiment: Experiment): void {
    const result = this.db.prepare(`
      UPDATE optimization_experiments
      SET status = ?, record_json = ?, updated_at = ?
      WHERE experiment_id = ?
    `).run(experiment.status, JSON.stringify(experiment), experiment.updated_at, experiment.experiment_id);
    if (Number(result.changes) !== 1) throw new Error(`optimization experiment '${experiment.experiment_id}' not found`);
  }

  getExperiment(experimentId: string): Experiment | null {
    return this.readJsonRecord<Experiment>('SELECT record_json FROM optimization_experiments WHERE experiment_id = ?', experimentId);
  }

  listExperiments(taskId: string): Experiment[] {
    return this.readJsonRecords<Experiment>('SELECT record_json FROM optimization_experiments WHERE task_id = ? ORDER BY created_at, experiment_id', taskId);
  }

  appendCommandExecution(execution: CommandExecution): void {
    this.db.prepare(`
      INSERT INTO optimization_experiment_commands
        (command_id, experiment_id, step, sequence, record_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(execution.command_execution_id, execution.experiment_id, execution.step, execution.sequence, JSON.stringify(execution));
  }

  listCommandExecutions(experimentId: string): CommandExecution[] {
    return this.readJsonRecords<CommandExecution>('SELECT record_json FROM optimization_experiment_commands WHERE experiment_id = ? ORDER BY sequence', experimentId);
  }

  appendMeasurement(measurement: Measurement): void {
    this.db.prepare(`
      INSERT INTO optimization_measurements
        (measurement_id, experiment_id, kind, name, role, sample_index, record_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(measurement.measurement_id, measurement.experiment_id, measurement.kind, measurement.subject_id, measurement.role, measurement.sample_index, JSON.stringify(measurement), measurement.recorded_at);
  }

  listMeasurements(experimentId: string): Measurement[] {
    return this.readJsonRecords<Measurement>(`
      SELECT record_json FROM optimization_measurements
      WHERE experiment_id = ?
      ORDER BY kind, name, COALESCE(role, ''), COALESCE(sample_index, -1), recorded_at
    `, experimentId);
  }

  private readJsonRecord<T>(sql: string, value: string): T | null {
    const row = this.db.prepare(sql).get(value) as JsonRecordRow | undefined;
    return row ? JSON.parse(row.record_json) as T : null;
  }

  private readJsonRecords<T>(sql: string, value: string): T[] {
    const rows = this.db.prepare(sql).all(value) as unknown as JsonRecordRow[];
    return rows.map((row) => JSON.parse(row.record_json) as T);
  }

  private insertTask(task: Task): void {
    this.db.prepare('INSERT INTO tasks (task_id, request_id, status, target_json, schema_version, is_mock, created_at, updated_at, error, next_check_at, availability_reason, report_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(task.task_id, task.request_id, task.status, JSON.stringify(task.target), task.schema_version, task.is_mock ? 1 : 0, task.created_at, task.updated_at, task.error, task.next_check_at ?? null, task.availability_reason ?? null, task.report_path ?? null);
  }

  private insertJob(job: RunnerJob): void {
    this.db.prepare('INSERT INTO jobs (job_id, task_id, request_id, scenario, status, attempt_number, schema_version, is_mock, created_at, updated_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(job.job_id, job.task_id, job.request_id, job.scenario, job.status, job.attempt_number, job.schema_version, job.is_mock ? 1 : 0, job.created_at, job.updated_at, job.error);
  }

  private insertEvent(event: Event): void {
    this.db.prepare('INSERT INTO events (event_id, task_id, job_id, type, payload_json, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(event.event_id, event.task_id, event.job_id, event.type, JSON.stringify(event.payload), event.schema_version, event.created_at);
  }

  private rowToTask(row: TaskRow): Task {
    return { schema_version: row.schema_version, task_id: row.task_id, request_id: row.request_id, status: row.status as TaskStatus, target: JSON.parse(row.target_json) as Target, is_mock: row.is_mock === 1, created_at: row.created_at, updated_at: row.updated_at, error: row.error, next_check_at: row.next_check_at, availability_reason: row.availability_reason, report_path: row.report_path };
  }

  private rowToJob(row: JobRow): RunnerJob {
    return { schema_version: row.schema_version, job_id: row.job_id, task_id: row.task_id, request_id: row.request_id, scenario: row.scenario as MockScenario, status: row.status as TaskStatus, attempt_number: row.attempt_number, is_mock: row.is_mock === 1, created_at: row.created_at, updated_at: row.updated_at, error: row.error };
  }
}
