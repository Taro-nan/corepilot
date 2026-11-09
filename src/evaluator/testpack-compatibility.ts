import type { LoadedFormalEvaluatorBundle } from '../contracts/formal-evaluator.js';
import type { ValidationTestpack } from '../contracts/validation-testpack.js';
import { parametersAreSubset, validationCaseParameters } from '../testpack/validation-parameters.js';
import { formalCaseParameters, formalWorkloadParameters } from './formal-arguments.js';
import { readValidationTestPlan } from './validation-test-plan.js';

/** The plan used for execution and evidence must describe the same qualified evaluator. */
export function validateFormalTestpackCompatibility(testpack: ValidationTestpack, bundle: LoadedFormalEvaluatorBundle): void {
  const caseIds = testpack.correctness.cases.map(item => item.case_id);
  const workloadIds = testpack.performance.cases.map(item => item.case_id);
  if (JSON.stringify(caseIds) !== JSON.stringify(bundle.manifest.correctness.case_ids)) {
    throw new Error('formal testpack correctness inventory differs from evaluator bundle');
  }
  if (JSON.stringify(workloadIds) !== JSON.stringify(bundle.manifest.performance.workload_ids)) {
    throw new Error('formal testpack performance inventory differs from evaluator bundle');
  }
  for (let index = 0; index < testpack.correctness.cases.length; index += 1) {
    const testCase = testpack.correctness.cases[index];
    if (!parametersAreSubset(validationCaseParameters(testCase), formalCaseParameters(bundle.correctness.cases[index]))) {
      throw new Error(`formal testpack correctness parameters differ for '${testCase.case_id}'`);
    }
  }
  for (let index = 0; index < testpack.performance.cases.length; index += 1) {
    const testCase = testpack.performance.cases[index];
    const workload = bundle.workloads.workloads[index];
    if (!parametersAreSubset(validationCaseParameters(testCase), formalWorkloadParameters(workload))) {
      throw new Error(`formal testpack performance parameters differ for '${testCase.case_id}'`);
    }
    if (testCase.weight !== workload.weight || testCase.critical !== workload.critical ||
        (workload.critical && !testpack.performance.key_cases.includes(testCase.case_id))) {
      throw new Error(`formal testpack workload weight or critical status differs for '${testCase.case_id}'`);
    }
  }
  if (testpack.performance.sampling.warmup !== bundle.manifest.performance.sampling.warmup_count ||
      testpack.performance.sampling.samples !== bundle.manifest.performance.sampling.sample_count) {
    throw new Error('formal testpack sampling differs from evaluator bundle');
  }
  const policy = testpack.performance.statistics;
  const qualifiedPolicy = readValidationTestPlan(bundle.root, bundle.manifest).statistics;
  if (!!policy !== !!qualifiedPolicy || (policy && qualifiedPolicy &&
      (Object.keys(qualifiedPolicy) as Array<keyof typeof qualifiedPolicy>).some(key => policy[key] !== qualifiedPolicy[key]))) {
    throw new Error('formal testpack statistical policy differs from evaluator bundle');
  }
  const resources = bundle.manifest.resource_requirements;
  if (testpack.resources.cpu_set !== resources.cpu_set || !testpack.resources.numa_nodes.includes(resources.numa_node) ||
      JSON.stringify(testpack.resources.thread_counts) !== JSON.stringify(resources.thread_counts)) {
    throw new Error('formal testpack resource policy differs from evaluator bundle');
  }
}
