import type { Candidate, DomainIdentity } from './optimization-domain.js';

export interface FrozenEvidenceArtifactIdentity {
  evidence_id: string;
  digest: string;
  archive_path: string;
  archive_sha256: string;
  manifest_path: string;
}

export interface OptimizationApprovalRecord {
  schema_version: 1;
  approval_id: string;
  task_id: string;
  workflow_id: string | null;
  candidate_id: string;
  candidate_commit: string;
  candidate_before: Candidate;
  source_baseline_identity: DomainIdentity;
  baseline_identity: DomainIdentity;
  evaluator_identity: DomainIdentity;
  evaluator_digest: string;
  machine_identity: Record<string, unknown>;
  first_formal_experiment_id: string;
  revalidation_experiment_id: string;
  evidence_artifact_identity: FrozenEvidenceArtifactIdentity;
  evidence_sha256: string;
  approval_status: 'APPROVED';
  evidence_status_before: 'FROZEN';
  evidence_status: 'APPROVED';
  claim_scope: Record<string, unknown>;
  reviewer: string;
  approved_at: string;
  authorization: { kind: 'EXPLICIT_OWNER_DIRECTIVE'; reference: string };
}
