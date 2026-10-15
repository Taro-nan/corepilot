import { Type } from 'typebox';
import type { AgentTool } from './pi-agent-runtime.js';
import type { CandidateEvaluationDecision, CandidateEvaluationFeedback } from '../contracts/candidate-evaluation-feedback.js';

export function candidateDecisionTool(feedback: Pick<CandidateEvaluationFeedback, 'candidate_id' | 'experiment_id'>, recordDecision: (decision: CandidateEvaluationDecision) => void): AgentTool {
  return {
    name: 'record_candidate_decision',
    label: 'Record candidate decision',
    description: 'Choose REPAIR, ABANDON, or NEW_HYPOTHESIS for the evaluated Candidate. Preserve all failed evidence and never alter the evaluator, baseline or acceptance policy. ABANDON ends this optimization without approval.',
    parameters: Type.Object({
      candidate_id: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      experiment_id: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      action: Type.Union([Type.Literal('REPAIR'), Type.Literal('ABANDON'), Type.Literal('NEW_HYPOTHESIS')]),
      reason: Type.String({ minLength: 1, maxLength: 4096 }),
      hypothesis: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      const input = args as Record<string, unknown>;
      if (input.candidate_id !== feedback.candidate_id || input.experiment_id !== feedback.experiment_id) throw new Error('candidate decision identity differs from evaluation feedback');
      if (input.action !== 'REPAIR' && input.action !== 'ABANDON' && input.action !== 'NEW_HYPOTHESIS') throw new Error('invalid candidate decision action');
      if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 4096) throw new Error('candidate decision requires a bounded reason');
      if (input.hypothesis !== undefined && (typeof input.hypothesis !== 'string' || !input.hypothesis.trim() || input.hypothesis.length > 8192)) throw new Error('candidate hypothesis must be bounded and non-empty');
      if (input.action === 'NEW_HYPOTHESIS' && input.hypothesis === undefined) throw new Error('NEW_HYPOTHESIS requires a hypothesis');
      const decision: CandidateEvaluationDecision = { candidate_id: feedback.candidate_id, experiment_id: feedback.experiment_id, action: input.action, reason: input.reason.trim(), hypothesis: typeof input.hypothesis === 'string' ? input.hypothesis.trim() : null };
      recordDecision(decision);
      return { content: [{ type: 'text', text: JSON.stringify(decision) }], details: { decision }, ...(decision.action !== 'REPAIR' ? { terminate: true } : {}) };
    },
  };
}

export function hypothesisDecisionTool(hypothesisId: string, recordDecision: (decision: CandidateEvaluationDecision) => void): AgentTool {
  const delegate = candidateDecisionTool({ candidate_id: null, experiment_id: null }, decision => recordDecision({ ...decision, hypothesis_id: hypothesisId }));
  return {
    ...delegate,
    name: 'record_hypothesis_decision',
    label: 'Record hypothesis decision',
    description: 'Choose REPAIR to continue an untested Hypothesis, NEW_HYPOTHESIS to propose a child, or ABANDON to stop. No experimental outcome is invented.',
    parameters: Type.Object({
      hypothesis_id: Type.String({ minLength: 1 }),
      action: Type.Union([Type.Literal('REPAIR'), Type.Literal('ABANDON'), Type.Literal('NEW_HYPOTHESIS')]),
      reason: Type.String({ minLength: 1, maxLength: 4096 }),
      hypothesis: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
    }, { additionalProperties: false }),
    execute: async (toolCallId, args) => {
      const input = args as Record<string, unknown>;
      if (input.hypothesis_id !== hypothesisId) throw new Error('hypothesis decision identity differs from active Hypothesis');
      return delegate.execute(toolCallId, { ...input, candidate_id: null, experiment_id: null });
    },
  };
}
