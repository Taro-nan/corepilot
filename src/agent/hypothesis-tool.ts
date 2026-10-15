import { Type } from 'typebox';
import type { AgentTool } from './pi-agent-runtime.js';
import type { HypothesisProposal, OptimizationHypothesis } from '../contracts/optimization-hypothesis.js';

export function hypothesisProposalTool(parentHypothesisId: string | null, propose: (proposal: HypothesisProposal) => Promise<OptimizationHypothesis>): AgentTool {
  const text = () => Type.String({ minLength: 1, maxLength: 8192 });
  return {
    name: 'record_hypothesis',
    label: 'Propose optimization hypothesis',
    description: 'Persist an evidence-backed Hypothesis before any source change. Describe motivation, expected mechanism/effect, risk and exact relative source files. Evidence is an Agent investigation claim, not Formal Evidence. REPAIR reuses the existing Hypothesis; NEW_HYPOTHESIS creates its child. The returned hypothesis_id must produce the Candidate.',
    parameters: Type.Object({
      parent_hypothesis_id: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      description: text(), motivation: text(), expected_effect: text(), risk: text(),
      affected_scope: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 64 }),
      evidence: Type.Array(Type.Object({
        kind: Type.Union([Type.Literal('SOURCE_INSPECTION'), Type.Literal('DEVELOPMENT_FEEDBACK'), Type.Literal('EXPERIMENT_FEEDBACK')]),
        summary: text(),
        experiment_id: Type.Optional(Type.String({ minLength: 1 })),
        command_execution_id: Type.Optional(Type.String({ minLength: 1 })),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
    }, { additionalProperties: false }),
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      const input = args as HypothesisProposal & { parent_hypothesis_id: string | null };
      if (input.parent_hypothesis_id !== parentHypothesisId) throw new Error('Hypothesis parent differs from the current reasoning lineage');
      const { parent_hypothesis_id: _parent, ...proposal } = input;
      const hypothesis = await propose(proposal);
      return { content: [{ type: 'text', text: JSON.stringify(hypothesis) }], details: { hypothesis_id: hypothesis.hypothesis_id } };
    },
  };
}
