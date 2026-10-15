# Candidate Evaluation Feedback

After validation, the workflow saves a versioned `CandidateEvaluationFeedback`
and includes it in the next Pi Agent prompt. It binds the Candidate and Experiment
IDs, correctness coverage and failed cases, Runner failure code, performance and
confidence results, observed resource validity, and investigation areas.

Failed-case feedback retains bounded stdout/stderr and structured evaluator
observations, including opaque domain parameters and observed/reference summaries.
Rejected measurement output is explicitly `COMMAND_OUTPUT_DIAGNOSTIC`, not trusted
Formal Evidence. Development Gate results remain `DEVELOPMENT_ONLY` and cannot
excuse incorrect output. Missing cases are not reported as passing.

## Agent decisions

On the next round, `record_candidate_decision` accepts only the feedback's exact
Candidate/Experiment IDs. Before editing the failed source, the Agent chooses:

- `REPAIR`: investigate the failure and create a new immutable Candidate in the
  existing lineage using the existing development and Formal gates.
- `ABANDON`: preserve the failed Candidate and stop without success or approval.
  The workflow uses its existing threshold-not-met terminal state.
- `NEW_HYPOTHESIS`: record an evidence-backed hypothesis and investigate again;
  a hypothesis-only round is allowed but consumes the existing round budget.

Source scope and development-findings guards still apply. Neither this tool nor
feedback grants permission to edit the oracle, evaluator, cases, baseline, build
policy or acceptance policy. Merely returning text without an explicit decision
is not treated as successful repair or abandonment.

## Resource measurement errors

Runner owns Formal resource evidence under `domain_payload.resource_policy`,
including declared threads, applied thread environment, observed runtime threads,
CPU affinity and NUMA policy. Evaluators may omit `threads` from their domain
parameters. If they report it, it must match the Runner resource declaration.
Required Runner resource observations remain mandatory. Missing observations
produce `MISSING_RESOURCE_CONTEXT`, a readable message and `missing_fields`.
Domain parameters are still compared exactly with the qualified inventory;
missing domain parameters or measurement fields violate the measurement contract.

The Experiment stays invalid and missing-context observations cannot generate
Formal performance Evidence. Incorrect resource values and other contract drift
remain rejected. Runner-owned resource context and failure details survive the
RPC-to-workflow adapter, even when the underlying command exits zero.

## Experiment failure classification

Runner status and persisted Candidate feedback include `failure_classification`:

- `execution_status`: `COMPLETED`, `FAILED` or `TIMEOUT`.
- `evaluation_status`: `PASS`, `FAIL` or `UNKNOWN`.
- `contract_status`: `VALID` or `VIOLATED`.
- `violation_reason`: `MISSING_RESOURCE_CONTEXT`, `MISSING_MEASUREMENT_FIELD`,
  `INVALID_EVIDENCE` or null.
- `failure_origin`: `CANDIDATE`, `EVALUATOR`, `EXECUTION`, `CONTRACT` or null.

A verified correctness FAIL is `CANDIDATE_CORRECTNESS_FAILED`, with a valid
measurement contract. Evaluator process failures and identity failures leave the
Candidate evaluation unknown. Timeouts are classified before parsing missing
output. Contract violations retain diagnostic command output without admitting
invalid observations as Formal measurements. Failed commands are not interpreted
as failed correctness cases without valid evaluator evidence.

Runner completion reports execution and measurement validation. The Control
Plane adds the unchanged performance acceptance result to Agent feedback:
threshold failure is Candidate evaluation FAIL, while collected samples without
a completed acceptance decision leave evaluation UNKNOWN. Feedback is retained
in the existing SQLite hypothesis outcomes and delivered to the next Agent round.
