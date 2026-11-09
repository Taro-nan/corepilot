import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
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
import { ExperimentStateChangedError, type LocalExperimentFacts } from './optimization-store.js';
import type { HypothesisOutcome, OptimizationHypothesis } from '../contracts/optimization-hypothesis.js';
import type { OptimizationApprovalRecord } from '../contracts/optimization-approval.js';
import type { ProjectRecord } from '../contracts/project.js';
import type { ExecutionMachineRecord } from '../contracts/execution-machine.js';
import { taskStatusForExecutionOutcome, type OptimizationWorkflowRecord, type WorkflowExecutionOutcomePatch, type WorkflowExperimentIntent } from '../contracts/workflow.js';
import { OptimizationIntakeAmbiguousError, OptimizationIntakeClosedError, OptimizationIntakeConflictError, type OptimizationIntakeStatus } from '../contracts/optimization-intake.js';
import { isControlIdentityId } from '../contracts/control-identity.js';

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

function sameCandidateSource(left: Candidate['source'], right: Candidate['source']): boolean {
  if (!left || !right || left.repository !== right.repository || left.commit !== right.commit || left.tree !== right.tree ||
      left.archive_sha256 !== right.archive_sha256 || !Array.isArray(left.changed_files) || !Array.isArray(right.changed_files) ||
      left.changed_files.length !== right.changed_files.length) return false;
  const byPath = new Map(left.changed_files.map(file => [file.path, file]));
  if (byPath.size !== left.changed_files.length || new Set(right.changed_files.map(file => file.path)).size !== right.changed_files.length) return false;
  return right.changed_files.every(file => {
    const old = byPath.get(file.path);
    return !!old && old.before_sha256 === file.before_sha256 && old.after_sha256 === file.after_sha256;
  });
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
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY, repository_root TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_machines (
        machine_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record_json TEXT NOT NULL
      );
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
      CREATE INDEX IF NOT EXISTS optimization_workflows_request
        ON optimization_workflows(json_extract(workflow_json, '$.request_id'));
      CREATE TABLE IF NOT EXISTS optimization_intake_closures (
        request_id TEXT PRIMARY KEY, closed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS optimization_workflows_delivery_state
        ON optimization_workflows(json_extract(workflow_json, '$.delivery_operation.status'));
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

  /** Null means a legacy database has never had an identity table. */
  readControlDatabaseIdentity(): string | null {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('control_database_identity', 'control_identity_guard')").all() as Array<{ name: string }>;
    if (!tables.length) return null;
    if (tables.length !== 2) throw new Error('控制端数据库身份缺失或损坏，请由维护者核对原数据库。');
    const guard = this.db.prepare('SELECT singleton FROM control_identity_guard WHERE singleton = 1').get();
    const row = this.db.prepare('SELECT database_id FROM control_database_identity WHERE singleton = 1').get() as { database_id: unknown } | undefined;
    if (!guard || !row || !isControlIdentityId(row.database_id)) throw new Error('控制端数据库身份缺失或损坏，请由维护者核对原数据库。');
    return row.database_id;
  }

  /** A transaction makes table creation and its first identity one durable step. */
  initializeControlDatabaseIdentity(): string {
    const timeout = (this.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    this.db.exec('PRAGMA busy_timeout = 5000');
    try {
      return this.transaction(() => {
        const existing = this.readControlDatabaseIdentity();
        if (existing) return existing;
        const id = randomUUID();
        this.db.exec('CREATE TABLE control_database_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), database_id TEXT NOT NULL)');
        this.db.exec('CREATE TABLE control_identity_guard (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))');
        this.db.prepare('INSERT INTO control_database_identity (singleton, database_id) VALUES (1, ?)').run(id);
        this.db.prepare('INSERT INTO control_identity_guard (singleton) VALUES (1)').run();
        return id;
      });
    } finally { this.db.exec(`PRAGMA busy_timeout = ${Number(timeout)}`); }
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
    const now = Date.now();
    const result = this.db.prepare('UPDATE host_lease SET expires_at = ? WHERE lease_key = 1 AND owner_id = ? AND expires_at > ?')
      .run(new Date(now + ttlMs).toISOString(), ownerId, new Date(now).toISOString());
    return Number(result.changes) === 1;
  }

  releaseLease(ownerId: string): void { this.db.prepare('DELETE FROM host_lease WHERE lease_key = 1 AND owner_id = ?').run(ownerId); }

  getActiveLease(): LeaseRecord | null {
    return (this.db.prepare('SELECT owner_id, expires_at FROM host_lease WHERE lease_key = 1').get() as LeaseRecord | undefined) ?? null;
  }

  saveOptimizationWorkflowJson(workflowId: string, workflowJson: string): void {
    this.db.prepare('INSERT INTO optimization_workflows (workflow_id, workflow_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(workflow_id) DO UPDATE SET workflow_json=excluded.workflow_json, updated_at=excluded.updated_at').run(workflowId, workflowJson, new Date().toISOString());
  }

  createOptimizationIntake(task: OptimizationTask, workflow: OptimizationWorkflowRecord): { workflowId: string; created: boolean } {
    if (task.workflow_id !== workflow.workflow_id || task.task_id !== workflow.optimization_task_id || task.status !== 'CREATED' ||
        !['CREATED', 'GENERATING'].includes(workflow.status) || (!!workflow.request_id !== !!workflow.request_digest)) {
      throw new Error('optimization intake identity or status mismatch');
    }
    return this.transaction(() => {
      if (workflow.request_id) {
        if (this.getOptimizationIntakeStatus(workflow.request_id).status === 'CLOSED') throw new OptimizationIntakeClosedError();
        const previous = this.getOptimizationWorkflowByRequestId(workflow.request_id);
        if (previous) {
          const existing = JSON.parse(previous) as OptimizationWorkflowRecord;
          const matches = existing.request_input_digest && workflow.request_input_digest
            ? existing.request_input_digest === workflow.request_input_digest : existing.request_digest === workflow.request_digest;
          if (!matches) throw new OptimizationIntakeConflictError();
          return { workflowId: existing.workflow_id, created: false };
        }
      }
      // save* are upserts elsewhere; intake must never overwrite an existing fact.
      if (this.getOptimizationTask(task.task_id) || this.getOptimizationWorkflowJson(workflow.workflow_id)) {
        throw new Error('optimization intake identity already exists');
      }
      this.saveOptimizationTask(task);
      this.saveOptimizationWorkflowJson(workflow.workflow_id, JSON.stringify(workflow));
      return { workflowId: workflow.workflow_id, created: true };
    });
  }

  attachOptimizationCandidate(workflowId: string, candidate: Candidate): Candidate {
    return this.transaction(() => {
      const json = this.getOptimizationWorkflowJson(workflowId);
      const workflow = json ? JSON.parse(json) as OptimizationWorkflowRecord : null;
      const task = this.getOptimizationTask(candidate.task_id);
      if (!workflow || workflow.optimization_task_id !== candidate.task_id || workflow.status !== 'GENERATING' ||
          !task || task.workflow_id !== workflowId || task.status !== 'RUNNING' || candidate.status !== 'FROZEN') {
        throw new Error('候选与当前活动工作流或任务不匹配，请保留现场并核对。');
      }
      const candidates = this.listCandidates(candidate.task_id);
      const sameCommit = candidates.filter(item => item.source.commit === candidate.source.commit);
      if (sameCommit.length > 1) throw new Error('同一源码提交存在多个历史候选，无法自动确定恢复身份，请保留现场并核对。');
      const previous = sameCommit[0];
      let resolved = candidate;
      if (previous) {
        if (candidates.at(-1)?.candidate_id !== previous.candidate_id || previous.hypothesis_id !== candidate.hypothesis_id ||
            previous.status !== 'FROZEN' || !sameCandidateSource(previous.source, candidate.source) ||
            this.listExperiments(candidate.task_id).some(item => item.candidate_id === previous.candidate_id)) {
          throw new Error('已保存候选与恢复检查点不一致或已有实验，请保留现场并核对原候选与实验。');
        }
        resolved = previous;
      } else {
        const parent = candidates.at(-1) ?? null;
        if (candidate.parent_candidate_id !== (parent?.candidate_id ?? null) || candidate.sequence !== (parent?.sequence ?? 0) + 1) {
          throw new Error('候选谱系在保存前已变化，请保留现场并重新核对。');
        }
      }
      const currentId = workflow.candidate_id ?? null;
      if (currentId !== resolved.candidate_id && currentId !== resolved.parent_candidate_id) {
        throw new Error('工作流候选引用与检查点不一致，请保留现场并核对。');
      }
      if (!previous) this.createCandidate(candidate);
      if (currentId !== resolved.candidate_id) {
        this.saveOptimizationWorkflowJson(workflowId, JSON.stringify({ ...workflow, candidate_id: resolved.candidate_id, updated_at: new Date().toISOString() }));
      }
      return resolved;
    });
  }

  attachOptimizationExperiment(workflowId: string, experiment: Experiment, intent: WorkflowExperimentIntent): Experiment {
    return this.transaction(() => {
      const json = this.getOptimizationWorkflowJson(workflowId);
      const workflow = json ? JSON.parse(json) as OptimizationWorkflowRecord : null;
      const task = this.getOptimizationTask(experiment.task_id);
      const candidate = this.getCandidate(experiment.candidate_id);
      if (!workflow || workflow.optimization_task_id !== experiment.task_id || workflow.status !== 'GENERATING' ||
          workflow.candidate_id !== experiment.candidate_id || !task || task.workflow_id !== workflowId || task.status !== 'RUNNING' ||
          !candidate || candidate.task_id !== experiment.task_id || intent.schema_version !== 1 ||
          !/^experiment:[A-Za-z0-9_-]{1,128}$/.test(intent.experiment_id) || !Number.isSafeInteger(intent.round) || intent.round < 1 ||
          !['FORMAL_EVALUATION', 'REVALIDATION'].includes(intent.type) || experiment.experiment_id !== intent.experiment_id ||
          experiment.candidate_id !== intent.candidate_id || experiment.type !== intent.type ||
          !isDeepStrictEqual(experiment.declared_context, { ...task.declared_context, workflow_experiment_intent: intent }) ||
          !task.evaluator || !isDeepStrictEqual(experiment.evaluator, task.evaluator) ||
          !isDeepStrictEqual(experiment.baseline, task.performance_baseline ?? task.source_baseline) ||
          !['PENDING', 'RUNNING'].includes(experiment.status) || experiment.validity !== 'UNKNOWN' || experiment.failure_category !== null ||
          experiment.observed_context !== null || experiment.ended_at !== null || experiment.evaluation !== null) {
        throw new Error('实验创建意图与当前工作流、候选或阶段不匹配，请保留现场并核对。');
      }
      const unresolved = this.listExperiments(experiment.task_id).filter(item =>
        ['PENDING', 'RUNNING', 'UNKNOWN'].includes(item.status) && item.experiment_id !== intent.experiment_id);
      if (unresolved.length) throw new Error(`任务仍有未确认终态的原实验 ${unresolved[0].experiment_id}；请先核对原实验，系统不会自动新建或重发。`);
      const existing = this.getExperiment(intent.experiment_id);
      const reference = intent.type === 'FORMAL_EVALUATION' ? 'experiment_id' : 'revalidation_experiment_id';
      if (existing) {
        if (!isDeepStrictEqual(workflow.experiment_creation_intent, intent) || workflow[reference] !== intent.experiment_id ||
            existing.task_id !== experiment.task_id || existing.candidate_id !== intent.candidate_id || existing.type !== intent.type ||
            existing.status !== experiment.status || existing.validity !== 'UNKNOWN' || existing.failure_category !== null ||
            existing.ended_at !== null || existing.evaluation !== null || existing.observed_context !== null ||
            !isDeepStrictEqual(existing.evaluator, experiment.evaluator) || !isDeepStrictEqual(existing.baseline, experiment.baseline) ||
            !isDeepStrictEqual(existing.declared_context, experiment.declared_context) ||
            this.listCommandExecutions(existing.experiment_id).length || this.listMeasurements(existing.experiment_id).length) {
          throw new Error(`原实验 ${intent.experiment_id} 的身份或执行状态无法安全确认；请保留现场并核对。`);
        }
        return existing;
      }
      if (workflow.experiment_creation_intent?.experiment_id === intent.experiment_id) {
        throw new Error(`工作流引用的原实验 ${intent.experiment_id} 缺失，请保留现场并核对。`);
      }
      this.createExperiment(experiment);
      this.saveOptimizationWorkflowJson(workflowId, JSON.stringify({ ...workflow, [reference]: intent.experiment_id,
        experiment_creation_intent: structuredClone(intent), updated_at: new Date().toISOString() }));
      return experiment;
    });
  }

  authorizeLegacySourceContinuation(expectedWorkflowJson: string, workflow: OptimizationWorkflowRecord): void {
    const previous = JSON.parse(expectedWorkflowJson) as OptimizationWorkflowRecord;
    const authorization = workflow.source_scope_authorization;
    if (!authorization || authorization.kind !== 'CONTINUATION' || workflow.status !== 'GENERATING' ||
        previous.workflow_id !== workflow.workflow_id || previous.optimization_task_id !== workflow.optimization_task_id ||
        previous.source_scope_authorization ||
        authorization.previous_candidate_id !== (previous.candidate_id ?? null)) throw new Error('历史源码任务授权状态不匹配。');
    this.transaction(() => {
      if (this.getOptimizationWorkflowJson(previous.workflow_id) !== expectedWorkflowJson) throw new Error('任务状态已改变，请刷新后重新授权。');
      const task = previous.optimization_task_id ? this.getOptimizationTask(previous.optimization_task_id) : null;
      if (!task || task.workflow_id !== previous.workflow_id || task.library_package ||
          (previous.verification_mode === 'source_only') !== (task.target.scope.verification_mode === 'source_only') ||
          task.target.scope.candidate_scope || task.declared_context.source_scope_authorization) throw new Error('历史源码任务的领域授权状态不匹配。');
      this.saveOptimizationTask({ ...task, declared_context: { ...task.declared_context, source_scope_authorization: structuredClone(authorization) }, updated_at: workflow.updated_at });
      this.saveOptimizationWorkflowJson(workflow.workflow_id, JSON.stringify(workflow));
    });
  }

  finishOptimizationWorkflow(workflowId: string, taskId: string, patch: WorkflowExecutionOutcomePatch): void {
    this.transaction(() => {
      const json = this.getOptimizationWorkflowJson(workflowId);
      const workflow = json ? JSON.parse(json) as OptimizationWorkflowRecord : null;
      const task = this.getOptimizationTask(taskId);
      if (!workflow || workflow.workflow_id !== workflowId || workflow.optimization_task_id !== taskId ||
          !task || (task.workflow_id !== null && task.workflow_id !== workflowId)) {
        throw new Error('optimization execution task or workflow identity mismatch');
      }
      if (!['CREATED', 'GENERATING'].includes(workflow.status)) throw new Error('optimization workflow is no longer running');
      if (workflow.candidate_id) {
        const candidate = this.getCandidate(workflow.candidate_id);
        if (!candidate || candidate.task_id !== taskId ||
            (patch.candidate_commit !== undefined && patch.candidate_commit !== candidate.source.commit) ||
            (patch.candidate_tree !== undefined && patch.candidate_tree !== candidate.source.tree)) {
          throw new Error('optimization execution candidate identity mismatch');
        }
      }
      const timestamp = new Date().toISOString();
      this.saveOptimizationTask({ ...task, status: taskStatusForExecutionOutcome(patch.status), updated_at: timestamp });
      this.saveOptimizationWorkflowJson(workflowId, JSON.stringify({ ...workflow, ...patch, updated_at: timestamp }));
    });
  }

  recordWorkflowPersistenceFailure(workflowId: string, taskId: string, message: string): boolean {
    return this.transaction(() => {
      const json = this.getOptimizationWorkflowJson(workflowId);
      const workflow = json ? JSON.parse(json) as OptimizationWorkflowRecord : null;
      if (!workflow || workflow.workflow_id !== workflowId || workflow.optimization_task_id !== taskId ||
          !['CREATED', 'GENERATING'].includes(workflow.status)) return false;
      this.saveOptimizationWorkflowJson(workflowId, JSON.stringify({ ...workflow, error: message,
        progress: { phase: 'PERSISTENCE_ERROR', last_event: message }, updated_at: new Date().toISOString() }));
      return true;
    });
  }

  saveRecoveredWorkflow(workflowId: string, workflowJson: string, task: OptimizationTask | null): void {
    this.transaction(() => {
      if (task) {
        if ((task.workflow_id !== null && task.workflow_id !== workflowId) || task.status !== 'INTERRUPTED') {
          throw new Error('recovered task identity or status mismatch');
        }
        this.saveOptimizationTask(task);
      }
      this.saveOptimizationWorkflowJson(workflowId, workflowJson);
    });
  }

  createReproductionExperiment(experiment: Experiment, expectedWorkflowJson: string, workflowJson: string): void {
    const before = JSON.parse(expectedWorkflowJson) as OptimizationWorkflowRecord;
    const after = JSON.parse(workflowJson) as OptimizationWorkflowRecord;
    if (before.workflow_id !== after.workflow_id || before.optimization_task_id !== experiment.task_id ||
        before.candidate_id !== experiment.candidate_id || after.optimization_task_id !== experiment.task_id ||
        (before.reproduction && ['PREPARING', 'RUNNING', 'UNKNOWN'].includes(before.reproduction.status)) ||
        after.candidate_id !== experiment.candidate_id || after.reproduction?.experiment_id !== experiment.experiment_id ||
        after.reproduction.status !== 'PREPARING' || experiment.type !== 'REVALIDATION' || experiment.status !== 'PENDING' ||
        experiment.declared_context.purpose !== 'DELIVERY_REPRODUCTION' ||
        experiment.declared_context.reproduction_of !== after.reproduction.original_experiment_id) {
      throw new Error('reproduction experiment identity or status mismatch');
    }
    this.transaction(() => {
      if (this.getOptimizationWorkflowJson(before.workflow_id) !== expectedWorkflowJson) {
        throw new Error('任务状态已变化，请刷新后重新复现；原实验记录已保留。');
      }
      const pending = this.db.prepare(`SELECT experiment_id FROM optimization_experiments
        WHERE task_id = ? AND candidate_id = ? AND status IN ('PENDING', 'RUNNING', 'UNKNOWN') LIMIT 1`)
        .get(experiment.task_id, experiment.candidate_id) as { experiment_id: string } | undefined;
      if (pending) throw new Error(`当前候选仍有未确认终态的实验 ${pending.experiment_id}，请先核对原作业。`);
      this.createExperiment(experiment);
      this.saveOptimizationWorkflowJson(before.workflow_id, workflowJson);
    });
  }

  claimReproductionSubmission(workflowId: string, expected: Experiment, plan: Record<string, unknown>, remoteRoot: string, timestamp: string, runnerStoreInstanceId?: string): void {
    this.transaction(() => {
      const workflowJson = this.getOptimizationWorkflowJson(workflowId);
      const workflow = workflowJson ? JSON.parse(workflowJson) as OptimizationWorkflowRecord : null;
      const current = this.getExperiment(expected.experiment_id);
      if (!current || !isDeepStrictEqual(current, expected) || current.status !== 'PENDING' || current.started_at !== null ||
          current.ended_at !== null || current.declared_context.purpose !== 'DELIVERY_REPRODUCTION' ||
          current.declared_context.runner_execution_plan || current.declared_context.reproduction_submission_intent ||
          workflow?.optimization_task_id !== current.task_id || workflow.candidate_id !== current.candidate_id ||
          workflow.reproduction?.experiment_id !== current.experiment_id ||
          workflow.reproduction.cancel_requested === true ||
          !['PREPARING', 'RUNNING', 'UNKNOWN'].includes(workflow.reproduction.status) ||
          this.listCommandExecutions(current.experiment_id).length || this.listMeasurements(current.experiment_id).length) {
        throw new Error('复现实验状态已变化或无法证明尚未提交，请核对原实验。');
      }
      this.saveExperiment({ ...current, updated_at: timestamp, declared_context: { ...current.declared_context,
        runner_execution_plan: structuredClone(plan), ...(runnerStoreInstanceId ? { runner_store_instance_id: runnerStoreInstanceId } : {}),
        reproduction_submission_intent: { schema_version: 1, experiment_id: current.experiment_id, recorded_at: timestamp } } });
      workflow.reproduction.remote_root = remoteRoot;
      workflow.reproduction.updated_at = timestamp;
      workflow.updated_at = timestamp;
      this.saveOptimizationWorkflowJson(workflowId, JSON.stringify(workflow));
    });
  }

  updateReproduction(workflowId: string, experimentId: string, patch: Partial<Omit<NonNullable<OptimizationWorkflowRecord['reproduction']>, 'experiment_id'>>): boolean {
    return this.transaction(() => {
      const json = this.getOptimizationWorkflowJson(workflowId);
      const workflow = json ? JSON.parse(json) as OptimizationWorkflowRecord : null;
      const reproduction = workflow?.reproduction;
      if (!workflow || !reproduction || reproduction.experiment_id !== experimentId ||
          !['PREPARING', 'RUNNING', 'UNKNOWN'].includes(reproduction.status)) return false;
      const timestamp = new Date().toISOString();
      workflow.reproduction = { ...reproduction, ...patch, updated_at: timestamp };
      workflow.updated_at = timestamp;
      this.saveOptimizationWorkflowJson(workflowId, JSON.stringify(workflow));
      return true;
    });
  }

  saveCompletedDelivery(workflowId: string, workflowJson: string, task: OptimizationTask | null): void {
    this.transaction(() => {
      if (task) {
        if (task.workflow_id !== workflowId || task.status !== 'COMPLETED') throw new Error('delivery task identity or status mismatch');
        this.saveOptimizationTask(task);
      }
      this.saveOptimizationWorkflowJson(workflowId, workflowJson);
    });
  }

  getOptimizationWorkflowJson(workflowId: string): string | null {
    const row = this.db.prepare('SELECT workflow_json FROM optimization_workflows WHERE workflow_id = ?').get(workflowId) as { workflow_json: string } | undefined;
    return row?.workflow_json ?? null;
  }

  listOptimizationWorkflowJson(limit: number): string[] {
    const rows = this.db.prepare('SELECT workflow_json FROM optimization_workflows ORDER BY updated_at DESC, workflow_id DESC LIMIT ?').all(limit) as Array<{ workflow_json: string }>;
    return rows.map(row => row.workflow_json);
  }

  listRecoverableWorkflowJson(): string[] {
    const rows = this.db.prepare(`SELECT workflow.workflow_json FROM optimization_workflows AS workflow
      LEFT JOIN optimization_tasks AS task ON task.task_id = json_extract(workflow.workflow_json, '$.optimization_task_id')
        AND (task.workflow_id IS NULL OR task.workflow_id = workflow.workflow_id)
      WHERE json_extract(workflow.workflow_json, '$.status') = 'GENERATING'
         OR (json_extract(workflow.workflow_json, '$.status') = 'CREATED'
             AND (json_type(workflow.workflow_json, '$.agent_session') = 'object' OR task.status = 'RUNNING'))
         OR (json_extract(workflow.workflow_json, '$.status') = 'INTERRUPTED' AND task.status IN ('CREATED', 'RUNNING'))
         OR json_extract(workflow.workflow_json, '$.reproduction.status') IN ('PREPARING', 'RUNNING')
      ORDER BY workflow.updated_at, workflow.workflow_id`).all() as Array<{ workflow_json: string }>;
    return rows.map(row => row.workflow_json);
  }

  listPendingDeliveryWorkflowIds(): string[] {
    const rows = this.db.prepare(`SELECT workflow_id FROM optimization_workflows
      WHERE json_extract(workflow_json, '$.delivery_operation.status') IN ('PREPARING', 'PREPARED', 'APPLYING', 'WAITING', 'NEEDS_ATTENTION')
         OR (json_extract(workflow_json, '$.delivery_operation.status') = 'COMPLETED'
             AND json_extract(workflow_json, '$.delivery_operation.cleanup') = 'PENDING')
      ORDER BY updated_at, workflow_id`).all() as Array<{ workflow_id: string }>;
    return rows.map(row => row.workflow_id);
  }

  getOptimizationWorkflowByRequestId(requestId: string): string | null {
    const rows = this.db.prepare("SELECT workflow_json FROM optimization_workflows WHERE json_extract(workflow_json, '$.request_id') = ? LIMIT 2").all(requestId) as Array<{ workflow_json: string }>;
    if (rows.length > 1) throw new OptimizationIntakeAmbiguousError();
    return rows[0]?.workflow_json ?? null;
  }

  getOptimizationIntakeStatus(requestId: string): OptimizationIntakeStatus {
    const json = this.getOptimizationWorkflowByRequestId(requestId);
    const closed = this.db.prepare('SELECT 1 FROM optimization_intake_closures WHERE request_id = ?').get(requestId);
    if (json && closed) throw new OptimizationIntakeAmbiguousError();
    if (json) return { status: 'CREATED', workflow_id: (JSON.parse(json) as OptimizationWorkflowRecord).workflow_id };
    return closed ? { status: 'CLOSED' } : { status: 'NOT_FOUND' };
  }

  closeOptimizationIntake(requestId: string): Exclude<OptimizationIntakeStatus, { status: 'NOT_FOUND' }> {
    return this.transaction(() => {
      const current = this.getOptimizationIntakeStatus(requestId);
      if (current.status !== 'NOT_FOUND') return current;
      this.db.prepare('INSERT INTO optimization_intake_closures (request_id, closed_at) VALUES (?, ?)').run(requestId, new Date().toISOString());
      return { status: 'CLOSED' };
    });
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db.prepare('SELECT record_json FROM projects ORDER BY project_id').all() as unknown as JsonRecordRow[];
    return rows.map(row => JSON.parse(row.record_json) as ProjectRecord);
  }

  getProject(projectId: string): ProjectRecord | null {
    return this.readJsonRecord<ProjectRecord>('SELECT record_json FROM projects WHERE project_id = ?', projectId);
  }

  saveProject(project: ProjectRecord): void {
    this.db.prepare('INSERT INTO projects (project_id, repository_root, record_json) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET repository_root=excluded.repository_root, record_json=excluded.record_json')
      .run(project.project_id, project.repository_root, JSON.stringify(project));
  }

  /** Relocate configuration references without changing frozen requests or evidence. */
  migrateProjectConfigPath(projectId: string, previousPath: string, nextPath: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const project = this.getProject(projectId);
      if (!project || project.config_path !== previousPath) throw new Error('Project configuration changed during migration');
      this.saveProject({ ...project, config_path: nextPath });
      this.db.prepare("UPDATE optimization_workflows SET workflow_json = json_set(workflow_json, '$.config_path', ?) WHERE json_extract(workflow_json, '$.config_path') = ?")
        .run(nextPath, previousPath);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listExecutionMachines(): ExecutionMachineRecord[] {
    return (this.db.prepare('SELECT record_json FROM execution_machines ORDER BY machine_id').all() as unknown as JsonRecordRow[]).map(row => JSON.parse(row.record_json) as ExecutionMachineRecord);
  }

  getExecutionMachine(machineId: string): ExecutionMachineRecord | null {
    return this.readJsonRecord<ExecutionMachineRecord>('SELECT record_json FROM execution_machines WHERE machine_id = ?', machineId);
  }

  saveExecutionMachine(machine: ExecutionMachineRecord, expectedRevision?: number): boolean {
    if (expectedRevision === undefined) {
      this.db.prepare('INSERT INTO execution_machines (machine_id, revision, record_json) VALUES (?, ?, ?)').run(machine.machine_id, machine.revision, JSON.stringify(machine));
      return true;
    }
    return this.db.prepare('UPDATE execution_machines SET revision = ?, record_json = ? WHERE machine_id = ? AND revision = ?')
      .run(machine.revision, JSON.stringify(machine), machine.machine_id, expectedRevision).changes === 1;
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

  private appendHypothesisOutcome(outcome: HypothesisOutcome): void {
    const hypothesis = this.getHypothesis(outcome.hypothesis_id);
    const candidate = this.getCandidate(outcome.candidate_id);
    const experiment = this.getExperiment(outcome.experiment_id);
    if (!hypothesis || hypothesis.task_id !== outcome.task_id || candidate?.task_id !== outcome.task_id || candidate.hypothesis_id !== hypothesis.hypothesis_id || experiment?.candidate_id !== candidate.candidate_id || experiment.task_id !== outcome.task_id) throw new Error('Hypothesis outcome identity mismatch');
    if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(experiment.status)) throw new Error('Hypothesis outcome requires a completed Experiment');
    this.db.prepare('INSERT INTO optimization_hypothesis_outcomes (outcome_id, hypothesis_id, task_id, candidate_id, experiment_id, record_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(outcome.outcome_id, outcome.hypothesis_id, outcome.task_id, outcome.candidate_id, outcome.experiment_id, JSON.stringify(outcome), outcome.recorded_at);
    this.db.prepare('UPDATE optimization_hypotheses SET record_json = ?, updated_at = ? WHERE hypothesis_id = ?')
      .run(JSON.stringify({ ...hypothesis, status: hypothesis.status === 'ABANDONED' ? 'ABANDONED' : outcome.status, updated_at: outcome.recorded_at }), outcome.recorded_at, hypothesis.hypothesis_id);
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

  saveExperimentIfCurrent(expected: Experiment, next: Experiment): void {
    this.transaction(() => {
      const current = this.getExperiment(expected.experiment_id);
      if (!current || !isDeepStrictEqual(current, expected)) throw new ExperimentStateChangedError(expected.experiment_id);
      if (next.experiment_id !== expected.experiment_id || next.task_id !== expected.task_id ||
          next.candidate_id !== expected.candidate_id || next.type !== expected.type) throw new Error('实验身份不一致。');
      this.saveExperiment(next);
    });
  }

  commitExperimentResult(expected: Experiment, next: Experiment, outcome: HypothesisOutcome | null, localFacts?: LocalExperimentFacts): Experiment {
    return this.transaction(() => {
      const current = this.getExperiment(expected.experiment_id);
      if (!current || !isDeepStrictEqual(current, expected)) throw new Error('实验状态已改变，请重新核对原实验后恢复。');
      if (next.experiment_id !== current.experiment_id || next.task_id !== current.task_id ||
          next.candidate_id !== current.candidate_id || next.type !== current.type) {
        throw new Error('实验评价与原实验身份不一致。');
      }
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(current.status) && next.status !== current.status) {
        throw new Error('不能更改已确认的实验终态。');
      }
      if (!isDeepStrictEqual(next.runner_terminal_facts, current.runner_terminal_facts) ||
          (current.observed_context && !isDeepStrictEqual(next.observed_context, current.observed_context))) {
        throw new Error('实验评价不能覆盖 Runner 的原始终态事实。');
      }
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(current.status) && current.evaluation &&
          (!isDeepStrictEqual(current.evaluation, next.evaluation) || current.validity !== next.validity || current.failure_category !== next.failure_category)) {
        throw new Error('已记录的实验评价或假设结果不一致，请保留原记录并核对。');
      }
      if (localFacts) {
        if (this.listCommandExecutions(current.experiment_id).length || this.listMeasurements(current.experiment_id).length) {
          throw new Error('原本地实验已有命令或测量记录，无法确认是否完整；请保留原记录并人工核对。');
        }
        if (localFacts.commands.some((command, index) => command.experiment_id !== current.experiment_id || command.sequence !== index) ||
            localFacts.measurements.some(measurement => measurement.experiment_id !== current.experiment_id)) {
          throw new Error('本地实验事实与原实验身份不一致。');
        }
      }
      const unchanged = isDeepStrictEqual({ ...current, updated_at: next.updated_at }, next);
      if (outcome) {
        if (outcome.experiment_id !== next.experiment_id || outcome.task_id !== next.task_id || outcome.candidate_id !== next.candidate_id) {
          throw new Error('假设结果与原实验身份不一致。');
        }
        const existing = this.readJsonRecord<HypothesisOutcome>('SELECT record_json FROM optimization_hypothesis_outcomes WHERE experiment_id = ?', next.experiment_id);
        if (existing) {
          if (!isDeepStrictEqual({ ...existing, recorded_at: outcome.recorded_at }, outcome) || !unchanged) {
            throw new Error('已记录的实验评价或假设结果不一致，请保留原记录并核对。');
          }
          return current;
        }
        if (unchanged) {
          this.appendHypothesisOutcome(outcome);
          return current;
        }
      } else if (unchanged) {
        return current;
      }
      if (localFacts) {
        for (const command of localFacts.commands) this.appendCommandExecution(command);
        for (const measurement of localFacts.measurements) this.appendMeasurement(measurement);
      }
      this.saveExperiment(next);
      if (outcome) this.appendHypothesisOutcome(outcome);
      return next;
    });
  }

  getExperiment(experimentId: string): Experiment | null {
    return this.readJsonRecord<Experiment>('SELECT record_json FROM optimization_experiments WHERE experiment_id = ?', experimentId);
  }

  listExperiments(taskId: string): Experiment[] {
    return this.readJsonRecords<Experiment>('SELECT record_json FROM optimization_experiments WHERE task_id = ? ORDER BY rowid', taskId);
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
  latestBuildForRepository(repository: string): import('../contracts/build-planning.js').StoredBuildFact | null {
    const row = this.db.prepare(`
      SELECT w.workflow_json AS workflow, t.record_json AS task, c.record_json AS execution
      FROM optimization_workflows w
      JOIN optimization_tasks t ON t.workflow_id = w.workflow_id
      JOIN optimization_experiments e ON e.task_id = t.task_id
      JOIN optimization_experiment_commands c ON c.experiment_id = e.experiment_id
      WHERE c.step = 'BUILD' AND json_extract(w.workflow_json, '$.repository_root') = ?
      ORDER BY json_extract(c.record_json, '$.end_time') DESC, c.sequence DESC LIMIT 1
    `).get(repository) as { workflow: string; task: string; execution: string } | undefined;
    return row ? { workflow: JSON.parse(row.workflow), task: JSON.parse(row.task), execution: JSON.parse(row.execution) } : null;
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
