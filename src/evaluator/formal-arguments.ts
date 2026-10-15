import type {
  EvaluatorParameter,
  FormalCaseDefinition,
  FormalWorkloadDefinition,
} from '../contracts/formal-evaluator.js';

export type EvaluatorArgumentBindings = Readonly<Record<string, EvaluatorParameter>>;

/** Domain parameters stored with measurements and checked again by the Runner. */
export function formalCaseParameters(item: FormalCaseDefinition): Record<string, EvaluatorParameter> {
  return { ...item.parameters, threads: item.threads };
}

/** Domain parameters stored with measurements and checked again by the Runner. */
export function formalWorkloadParameters(item: FormalWorkloadDefinition): Record<string, EvaluatorParameter> {
  return { ...item.parameters, threads: item.threads };
}

/** Expand one manifest argument contract without knowing anything about its software domain. */
export function expandEvaluatorArguments(
  argumentNames: readonly string[],
  bindings: EvaluatorArgumentBindings,
  label: string,
): string[] {
  return argumentNames.map((name) => {
    const value = bindings[name];
    if (value === undefined) throw new Error(`${label} argument '${name}' has no declared binding`);
    return String(value);
  });
}

/** Command args include the evaluator script before the manifest-declared arguments. */
export function evaluatorCommandArgumentIndex(argumentNames: readonly string[], name: string): number {
  const index = argumentNames.indexOf(name);
  if (index < 0) throw new Error(`evaluator command contract does not declare '${name}'`);
  return index + 1;
}
