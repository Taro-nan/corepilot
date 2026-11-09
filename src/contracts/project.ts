import type { RunnerHealth, RunnerMachineInfo } from './runner-rpc.js';

/** Connectivity facts only; this does not grant evaluator qualification or approval. */
export interface RunnerConnectionCheck {
  ok: true;
  message: string;
  checked_at: string;
  health: RunnerHealth;
  machine: RunnerMachineInfo;
}

export interface ProjectRecord {
  project_id: string;
  name: string;
  repository_root: string;
  config_path: string;
  /** Default local Git branch; each workflow may select another branch. */
  source_branch?: string;
  /** User-selected task default; validation still has its own function identity. */
  default_function?: string;
  created_at: string;
  updated_at: string;
}

export interface RepositoryInspection {
  repository_root: string;
  is_git: boolean;
  current_branch: string | null;
  head_commit: string | null;
  branches: Array<{ name: string; commit: string; subject: string; upstream: string | null }>;
}

export interface DirectoryListing {
  path: string;
  parent: string;
  roots: Array<{ name: string; path: string; kind?: 'drive' | 'home' | 'workspace' }>;
  breadcrumbs: Array<{ name: string; path: string }>;
  directories: Array<{ name: string; path: string }>;
}
