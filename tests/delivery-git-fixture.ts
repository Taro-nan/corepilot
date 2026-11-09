import { randomUUID } from 'node:crypto';
import type { CandidateWorkspaceState } from '../src/workspace/candidate-workspace.js';
import type { WorkflowDeliveryOperation } from '../src/contracts/delivery.js';
import { applyCandidateDelivery, cleanupDeliveryWorkspaces, prepareCandidateDelivery, resolveDeliveryTarget } from '../src/workspace/delivery-git.js';

/** Exercise Git behavior in a disposable repository, without creating a product approval. */
export async function runFixtureDelivery(input: { workspace: CandidateWorkspaceState; expectedBaselineCommit: string; commitMessage: string }, cleanup = false) {
  const resolved = await resolveDeliveryTarget(input.workspace.repository, input.workspace.source_branch);
  if (resolved.commit !== input.expectedBaselineCommit) throw new Error('baseline changed after validation');
  const now = new Date().toISOString();
  const operation: WorkflowDeliveryOperation = { schema_version: 1, operation_id: randomUUID(), status: 'PREPARING', target: resolved.target,
    repository: input.workspace.repository, editing_workspace: input.workspace.editing, validation_workspace: input.workspace.validation,
    baseline_commit: input.expectedBaselineCommit, candidate_id: 'fixture', candidate_commit: input.workspace.candidate_commit!,
    candidate_tree: input.workspace.candidate_tree!, formal_experiment_id: 'fixture-formal', revalidation_experiment_id: 'fixture-revalidation',
    commit_message: input.commitMessage, prepared_commit: null, requested_at: now, updated_at: now, last_checked_at: null,
    observation: 'UNKNOWN', message: 'fixture', stop_confirmation_required: false, stop_confirmed_at: null, cleanup: 'PENDING', cleanup_message: null };
  operation.prepared_commit = await prepareCandidateDelivery(operation);
  const result = await applyCandidateDelivery(operation);
  if (cleanup) await cleanupDeliveryWorkspaces(operation);
  return result;
}
