import type { ValidationAssetDraft, ValidationCorrectnessInput } from '../contracts/validation-assets.js';

/** Fill draft gaps without replacing saved inputs, reference rules or resource settings. */
export function generatedCorrectnessConditions(draft: ValidationAssetDraft, proposed: Record<string, unknown>) {
  const existing = draft.cases.filter(item => item.case_id !== 'review-required');
  const incoming = Array.isArray(proposed.cases) ? proposed.cases as ValidationCorrectnessInput[] : [];
  const cases = existing.length ? existing.map(item => {
    const suggested = incoming.find(next => next.case_id === item.case_id);
    return { ...item, ...(!item.input_generation && suggested?.input_generation ? { input_generation: suggested.input_generation } : {}) };
  }) : incoming.map(item => ({ ...item, threads: draft.cases[0]?.threads ?? 1 }));
  const missingOracle = !draft.oracle_description.trim() || /No trusted oracle exists|UNKNOWN_REVIEW_REQUIRED/i.test(draft.oracle_description);
  const missingTolerance = !draft.tolerance_rule.trim() || /UNKNOWN_REVIEW_REQUIRED/i.test(draft.tolerance_rule);
  return { cases,
    oracle_description: missingOracle ? proposed.oracle_description : draft.oracle_description,
    tolerance_rule: missingTolerance ? proposed.tolerance_rule : draft.tolerance_rule,
    tolerance_absolute: missingTolerance ? proposed.tolerance_absolute : draft.tolerance_absolute,
    tolerance_relative: missingTolerance ? proposed.tolerance_relative : draft.tolerance_relative };
}
