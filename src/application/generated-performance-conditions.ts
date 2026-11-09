import { Type } from 'typebox';
import type { ValidationAssetDraft, ValidationPerformanceInput } from '../contracts/validation-assets.js';

export const generatedPerformanceSchema = {
  workloads: Type.Optional(Type.Array(Type.Object({ workload_id: Type.String(),
    parameters: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])), input_generation: Type.Optional(Type.String()) }))),
  benchmark_description: Type.Optional(Type.String()),
};

/** Missing input details are draft suggestions; saved parameters and all resource/weight choices prevail. */
export function generatedPerformanceConditions(draft: ValidationAssetDraft, proposed: Record<string, unknown>) {
  const incoming = Array.isArray(proposed.workloads) ? proposed.workloads as ValidationPerformanceInput[] : [];
  return {
    workloads: draft.workloads.map(item => {
      const suggested = incoming.find(next => next.workload_id === item.workload_id);
      return { ...item,
        ...(!Object.keys(item.parameters).length && suggested?.parameters ? { parameters: suggested.parameters } : {}),
        ...(!item.input_generation && suggested?.input_generation ? { input_generation: suggested.input_generation } : {}) };
    }),
    benchmark_description: !draft.benchmark_description.trim() || /No formal benchmark exists|UNKNOWN_REVIEW_REQUIRED/i.test(draft.benchmark_description)
      ? proposed.benchmark_description : draft.benchmark_description,
  };
}
