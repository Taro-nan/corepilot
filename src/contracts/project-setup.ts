import type { BuildCandidate, FunctionCandidate } from '../onboarding/repository-inspector.js';
import type { BuildRequirements } from './build-planning.js';
import type { ValidationReview } from './validation-review.js';
import type { LibraryPackageSelection } from './library-package.js';

export interface ProjectSourceDiscovery {
  schema_version: 1;
  inspected_at: string;
  repository: { path: string; name: string; git_commit: string | null; git_dirty: boolean | null };
  file_count: number;
  languages: string[];
  builds: BuildCandidate[];
  /** Missing in discovery snapshots created before build planning was introduced. */
  build_requirements?: BuildRequirements;
  functions: FunctionCandidate[];
  tests: string[];
  benchmarks: string[];
  references: string[];
  unknowns: string[];
}
export interface SetupCheck {
  id: 'build' | 'correctness' | 'performance' | 'baseline' | 'evaluator';
  title: string;
  state: 'MISSING' | 'CONFIGURED' | 'NEEDS_REVIEW' | 'INVALID';
  message: string;
}
export interface ProjectSetup {
  discovery: ProjectSourceDiscovery | null;
  checks: SetupCheck[];
  validation: { function_name: string; correctness_cases: number; performance_workloads: number; evaluator_status: string; review?: ValidationReview; review_error?: string } | null;
  next_steps: string[];
}

/** A matching recorded plan; its presence does not qualify it for execution. */
export interface ProjectValidationPlan {
  function_name: string;
  selection: LibraryPackageSelection;
  package_state: string;
  evaluator_state: string;
  current: boolean;
  baseline: { library: string; version: string; source: string | null; artifact_path: string };
}
export interface ProjectValidationPlans {
  function_name: string;
  plans: ProjectValidationPlan[];
  current_testpack: { function_name: string; evaluator_state: string } | null;
  warnings: string[];
}
