import type { ValidationCase } from '../contracts/validation-testpack.js';

/** Normalize old SGEMV-shaped cases and new domain-neutral cases alike. */
export function validationCaseParameters(testCase: ValidationCase): Record<string, string | number | boolean> {
  const parameters = testCase.parameters
    ? { ...testCase.parameters }
    : {
        ...(testCase.m === undefined ? {} : { m: testCase.m }),
        ...(testCase.n === undefined ? {} : { n: testCase.n }),
        ...(testCase.seed === undefined ? {} : { seed: testCase.seed }),
      };
  return { ...parameters, threads: testCase.threads };
}

/**
 * A testpack may intentionally describe only a compatibility subset of a
 * richer evaluator inventory. Every value it does declare must match.
 */
export function parametersAreSubset(
  expectedSubset: Readonly<Record<string, string | number | boolean>>,
  actual: Readonly<Record<string, string | number | boolean>>,
): boolean {
  return Object.entries(expectedSubset).every(([name, value]) => Object.hasOwn(actual, name) && actual[name] === value);
}
