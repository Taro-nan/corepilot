import { Type } from 'typebox';
import type { AgentTool } from './pi-agent-runtime.js';
import type { OptimizationReasoningHistory } from '../contracts/optimization-hypothesis.js';
import type { CandidateWorkspaceState } from '../workspace/candidate-workspace.js';
import { snapshotEditingTree } from '../workspace/git-source-archive.js';

const notice = 'Only a temporary-index Git tree preview and recorded Candidates associated with Hypotheses in this task are compared. Source or Git filter output may change before checkpoint. Matching trees do not establish identical commits, binaries, Evaluators, machines, resources or results. Up to 10 matching Candidates and their last 5 experiments are shown; use read_optimization_history for more. Review the referenced experiments; do not reuse their results for this Candidate. A new experiment or independent revalidation remains allowed.';

/** Let the Agent inspect a possible repeat before choosing whether to submit. */
export function candidateHistoryTool(workspace: CandidateWorkspaceState,
  history: () => OptimizationReasoningHistory | Promise<OptimizationReasoningHistory>): AgentTool {
  return {
    name: 'inspect_candidate_history',
    label: 'Inspect Candidate source history',
    description: 'Compare the current proposed source tree with previously recorded Candidate trees in this task. Call after edits and before submit_candidate when useful. A match is a historical clue, not a validation result or a restriction on retesting.',
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: async (_id, _args, signal) => {
      let result: Record<string, unknown>;
      try {
        signal?.throwIfAborted();
        const stored = await history();
        if (stored.hypotheses.every(item => item.candidates.length === 0)) {
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'NO_RECORDED_CANDIDATES', notice: 'No Candidates associated with Hypotheses are recorded in this task. The source tree was not inspected; other tasks and orphaned historical Candidates are not covered.' }) }], details: {} };
        }
        const gitId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
        if (stored.hypotheses.some(item => item.candidates.some(candidate =>
          !candidate.candidate_id || !candidate.source || !gitId.test(candidate.source.tree) || !gitId.test(candidate.source.commit)))) {
          throw new Error('recorded Candidate source identity is incomplete');
        }
        const tree = await snapshotEditingTree(workspace, signal);
        if (!gitId.test(tree)) throw new Error('invalid Git tree');
        const matching = stored.hypotheses.flatMap(item => item.candidates
          .filter(candidate => candidate.source?.tree === tree)
          .map(candidate => {
            const experiments = item.experiments.filter(experiment => experiment.candidate_id === candidate.candidate_id);
            return {
              candidate_id: candidate.candidate_id,
              commit: candidate.source.commit,
              hypothesis_id: candidate.hypothesis_id,
              experiment_count: experiments.length,
              experiments: experiments.slice(-5).map(experiment => ({
                experiment_id: experiment.experiment_id, type: experiment.type, status: experiment.status,
                validity: experiment.validity, failure_category: experiment.failure_category,
                evaluation: experiment.evaluation ? { build: experiment.evaluation.build,
                  correctness: experiment.evaluation.correctness, performance: experiment.evaluation.performance } : null,
              })),
            };
          }));
        result = { status: matching.length ? 'MATCH' : 'NO_RECORDED_MATCH', tree, match_count: matching.length,
          candidates: matching.slice(-10), notice };
      } catch (error) {
        if (signal?.aborted) throw error;
        result = { status: 'UNKNOWN', notice: 'Source tree or recorded history could not be inspected. This does not mean the source is new; continue using the existing submission and verification rules.' };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
    },
  };
}
