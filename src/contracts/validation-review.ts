import type { CandidateSourceScope, PackageBuildDefinition, LibraryPackageTarget } from './library-package.js';
import type { ValidationQualityResult } from './validation-quality.js';

/** Target execution readiness and the separate, explicit human adoption decision. */
export interface ValidationReview {
  state: 'NEEDS_TRIAL' | 'WAITING' | 'BLOCKED' | 'READY_FOR_REVIEW' | 'QUALIFIED';
  evaluator_digest: string;
  package_digest: string;
  function_name: string;
  blockers: string[];
  build: PackageBuildDefinition;
  scope: CandidateSourceScope;
  acceptance: LibraryPackageTarget['performance_acceptance'];
  baseline: { library: string; version: string; sha256: string };
  trial: null | {
    trial_id: string; source_commit: string; source_branch: string | null; machine_name: string;
    machine_identity_sha256: string | null; started_at: string | null; ended_at: string | null;
    correctness_passed: number; correctness_planned: number; performance_measured: number; performance_planned: number;
    resource_commands: number;
  };
  approval: null | { reviewer: string; approved_at: string; trial_id: string | null };
  quality?: ValidationQualityResult;
}

export interface ValidationReviewDecision {
  expected_digest: string;
  expected_package_digest: string;
  trial_id: string;
  reviewer: string;
  confirm: true;
}
