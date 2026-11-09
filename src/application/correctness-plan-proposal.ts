import { Type } from 'typebox';

export const generatedCorrectnessSchema = {
  cases: Type.Optional(Type.Array(Type.Object({ case_id: Type.String(), parameters: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])), input_generation: Type.Optional(Type.String()) }))),
  oracle_description: Type.Optional(Type.String()),
  tolerance_rule: Type.Optional(Type.String()),
  tolerance_absolute: Type.Optional(Type.Number()),
  tolerance_relative: Type.Optional(Type.Number()),
};

export const correctnessPlanToolSchema = Type.Object({
  status: Type.Union([Type.Literal('ready'), Type.Literal('needs_input')]),
  blockers: Type.Optional(Type.Array(Type.String())),
  summary: Type.Optional(Type.String()),
  ...generatedCorrectnessSchema,
  rationale: Type.Optional(Type.String()),
  assumptions: Type.Optional(Type.Array(Type.String())),
  evidence_files: Type.Optional(Type.Array(Type.String())),
});

export const correctnessPlanPrompt = `You propose a REVIEWABLE correctness test plan for a CPU library.
Read the supplied selected-version API, implementation and existing test evidence. Missing oracle/cases/tolerance
are the reason for this request: propose them when the function semantics can be established from evidence.
Return a plan in Chinese, NOT executable code and NOT a qualification/approval decision.
Keep existing explicitly configured correctness inputs/reference/tolerances; fill placeholders and explain suggestions.
Reuse existing performance input PARAMETERS where relevant; a workload name such as small-64 is not evidence
that width or height equals 64. If parameters are absent, propose concrete sizes as NEW recommendations for review.
Cases should cover a small representative normal input, boundaries relevant to the API, and numerical/layout regimes.
Never change thread counts, CPU affinity, NUMA, sampling, random seed, performance workloads or the baseline.
Do not describe or choose any resource profile or thread count in summary/cases/rationale: CorePilot expands
every correctness input over the SAVED execution matrix. A default per-input thread field does not limit that matrix.
The supplied cases are LOGICAL inputs, NOT per-thread executions. CorePilot owns matrix expansion.
maximum_new_case_count applies only when proposing NEW inputs; existing logical inputs must all be preserved.
Use only scalar case parameters and stable ASCII case IDs.
For each case provide input_generation: a deterministic complete recipe specifying indexing, formula or exact
values, dtype conversion, padding and any random algorithm using the saved seed. Pattern names alone are
labels, not complete recipes. Fill missing recipes as reviewable suggestions without changing saved parameters.
An independent reference must derive from the mathematical/API specification, existing trusted tests or an
explicitly documented reference library. Do not copy the optimized implementation as its own oracle.
For numeric functions specify normalization, accumulation precision, finite input distribution/range and comparison
formula. Suggest absolute/relative tolerances with a concrete rationale; exact integer operations may use zero.
Each generated-data case must encode its distinct pattern and finite data range as scalar PARAMETERS, not only
in the case ID or prose. Otherwise the code generator cannot distinguish zeros, mixed signs or cancellation cases.
Use a numerically stable independent reference (e.g. compensated sums, centered two-pass variance, or decimal
arithmetic where appropriate). Avoid subtracting near-equal large moments for a small variance. Do not assume
long double has a particular width or is more accurate on all architectures; describe a portable precision strategy.
The independent reference must evaluate the actual input values after conversion to the declared input dtype.
Derive a tolerance recommendation from input dtype/range/conditioning and the intended API accuracy, not just
the output dtype. Never promise a tolerance is sufficient because a test has few elements; no execution happened.
Input quantization is not an output error: both the library and oracle consume the SAME rounded stored values.
Do not use input quantization or unstable cancellation in the current implementation to justify a large absolute
allowance. A numerically unstable implementation should FAIL the proposed contract, not receive a weaker oracle.
Where supplied tests already use a stricter threshold, preserve that ceiling in your recommendation or ask a
specific compatibility question. Sanity-check the proposed tolerance against zero/constant and small-magnitude
outputs: a grossly wrong result (e.g. output 1 for expected 0) must not pass. Explain the scale of absolute error.
Do not silently relax tolerance for difficult cases or after failures. If observed implementation behavior differs
from the intended mathematical contract, state it as an unresolved compatibility question for user review.
Make undefined API behavior explicit in assumptions. Do not invent error/status semantics or NaN/Inf requirements
without evidence. Explain evidence limits and assumptions in Chinese. Matching API names do not mean shared implementation.
Only claim documents/tests were consulted if they are actually in the supplied evidence. Unseen vendor manuals
are not established evidence. Distinguish mathematical reference PROPOSALS from behavior established by files.
evidence_files must cite the supplied source evidence paths. If semantics cannot be established, submit needs_input
with specific questions about the actual missing API contract, not generic requests to manually design the entire plan.
Call submit_correctness_plan exactly once. The user decides whether to adopt this proposal; nothing is saved yet.`;
