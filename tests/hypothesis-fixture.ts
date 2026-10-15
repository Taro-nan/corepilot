import type { HypothesisProposal } from '../src/contracts/optimization-hypothesis.js';
import type { OptimizationRuntime } from '../src/core/optimization-runtime.js';

export function hypothesisProposal(description = 'Reduce repeated work in the fixture kernel', affectedScope = ['kernel.c']): HypothesisProposal {
  return { description, motivation: 'Source inspection identifies repeated work.', evidence: [{ kind: 'SOURCE_INSPECTION', summary: 'Read the fixture source before proposing the change.' }], expected_effect: 'Fewer operations with identical outputs under the frozen policy.', risk: 'Boundary cases may expose an incorrect implementation.', affected_scope: affectedScope };
}

export function proposeFixtureHypothesis(runtime: OptimizationRuntime, taskId: string, description: string, affectedScope = ['kernel.c'], parentHypothesisId: string | null = null) {
  return runtime.proposeHypothesis({ taskId, parentHypothesisId, proposal: hypothesisProposal(description, affectedScope), agentIdentity: { model: 'test-model' } });
}
