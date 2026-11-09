import type { OptimizationConfig } from '../config/optimization-config.js';
import type { CommandExecution, OptimizationTask } from './optimization-domain.js';
import type { OptimizationWorkflowRecord } from './workflow.js';

export interface RunnerToolchain {
  runner_id: string; checked_at: string; architecture: string; platform: string;
  available_parallelism: number; cpu_count: number; memory_total_bytes: number;
  tools: Record<string, { status: 'AVAILABLE' | 'MISSING' | 'ERROR'; version: string | null }>;
}
export interface BuildRequirements {
  root_builds: Array<{ kind: string; path: string }>;
  cmake_minimum: string | null; cxx_standard: number | null; openmp_option: string | null;
  evidence: Array<{ path: string; line: number; text: string }>;
}
export interface StoredBuildFact {
  workflow: OptimizationWorkflowRecord; task: OptimizationTask; execution: CommandExecution;
}
export interface ProjectBuildOptions {
  recent: null | {
    command: string; build: Partial<OptimizationConfig['build']> | null;
    status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED'; executed_at: string;
    workflow_id: string; experiment_id: string; command_execution_id: string;
    machine_name: string | null; source_commit: string | null;
  };
  recommended: null | {
    command: string; build: OptimizationConfig['build'];
    machine_id: string; machine_revision: number; machine_name: string;
    toolchain: RunnerToolchain; inspected_at: string; source_commit: string | null;
    reasons: string[]; evidence: BuildRequirements['evidence']; status: 'NOT_BUILT';
  };
  message: string | null;
}
