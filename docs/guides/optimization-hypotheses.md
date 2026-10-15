# Hypothesis-driven optimization

The existing Control Plane persists `OptimizationHypothesis` as an independent
domain object before source mutation. Its immutable proposal contains description,
motivation, investigation evidence, expected effect, risk, affected source files,
task identity, parent Hypothesis and Agent identity. `record_hypothesis` exposes
this declarative proposal to the existing Pi runtime; it does not run an Agent loop
or grant authority over evaluator assets.

Every newly created domain Candidate requires a same-task `hypothesis_id` and its
changed files must stay inside both the Hypothesis scope and existing package
scope. Candidate commits are implementations of a Hypothesis, not the primary
reasoning record. Investigation-only Hypotheses can exist without a Candidate.
The Agent can continue, replace or abandon an untested proposal through
`record_hypothesis_decision`, without inventing a Candidate or experimental result.

## Decisions and history

- `REPAIR` creates a new Candidate under the same Hypothesis and preserves all
  earlier failed implementations and outcomes.
- `NEW_HYPOTHESIS` creates an immutable child proposal before another source
  mutation; a text-only idea is not a producing Hypothesis.
- `ABANDON` records abandonment without changing or deleting experimental facts.

Before every production Agent round, the workflow supplies the task-scoped SQLite
reasoning history: proposals, parents, corresponding Candidates/commits,
Experiments, evaluation results, outcome reasons and structured failure feedback.
Proposal-only rounds consume the existing iteration budget. There is no search
service, vector database, knowledge graph or alternate execution architecture.

## Experimental outcomes

The Control Plane, never the Agent, appends one `HypothesisOutcome` per completed
evaluation or revalidation Experiment:

- `ACCEPTED`: complete correctness, valid resources and valid Formal performance
  acceptance pass the existing policy. This is experimental support, not owner
  approval or permission to bypass independent revalidation.
- `REJECTED`: a trustworthy correctness failure or a valid Formal performance
  acceptance failure. Repairs can subsequently test the same Hypothesis again.
- `INCONCLUSIVE`: missing/invalid resources, evaluator or infrastructure failure,
  incomplete correctness, unmeasured performance or development-only results.

Resource and evaluator invalidity take precedence over apparent speedups or raw
diagnostic output. All outcomes remain immutable; the Hypothesis status reflects
its latest outcome unless explicitly abandoned. A later revalidation does not
erase the first evaluation. No oracle, baseline, package, acceptance policy or
Runner changes are required.

## Persistence compatibility

`optimization_hypotheses` and `optimization_hypothesis_outcomes` are additive
tables in the existing SQLite store. Reopening preserves proposal and outcome
history. Old Candidate records remain readable and are not retrospectively
assigned invented investigation evidence; the mandatory association applies to
new domain Candidate creation. The standalone legacy workflow fixture API can
omit the reasoning callbacks, but the production service always supplies them.
