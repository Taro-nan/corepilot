import path from 'node:path';
import type { ValidationTestPlan } from '../contracts/validation-assets.js';
import fs from 'node:fs';
import type { EvaluatorParameter, FormalWorkloadDefinition, LoadedFormalEvaluatorBundle } from '../contracts/formal-evaluator.js';
import type { ExperimentExecutionStep, FormalExecutionContext } from '../contracts/runner-rpc.js';
import { expandEvaluatorArguments, formalCaseParameters, formalWorkloadParameters } from './formal-arguments.js';
import { readValidationTestPlan, performanceRoles, testPlanEnvironment, TEST_PLAN_FILE } from './validation-test-plan.js';
import { entryResources } from './execution-matrix.js';
import { EVALUATOR_EXECUTION_ENVIRONMENT } from './execution-environment.js';

export interface FormalEvaluatorStepInput {
  bundle: LoadedFormalEvaluatorBundle;
  stagedEvaluatorRoot: string;
  runtimeRoot: string;
  candidateArtifact: FormalArtifactInput;
  baselineArtifact: FormalArtifactInput;
  baselineLibraryPaths?: string[];
  candidateLibraryPaths?: string[];
  candidateSourceRoot?: string;
  correctnessTimeoutMs: number;
  performanceTimeoutMs: number;
  includePerformance: boolean;
}

export interface FormalArtifactInput {
  artifactId: string;
  path: string;
  sha256: string | null;
  dependencies?: Array<{ path: string; sha256: string }>;
}

/** Expands the immutable inventories into one command per case/warmup/raw sample. */
export function createFormalEvaluatorSteps(input: FormalEvaluatorStepInput): ExperimentExecutionStep[] {
  const testPlan = readValidationTestPlan(input.bundle.root, input.bundle.manifest);
  const setupScript = targetJoin(input.stagedEvaluatorRoot, 'scripts/build-evaluator.sh');
  const correctnessScript = targetJoin(input.stagedEvaluatorRoot, input.bundle.manifest.correctness.command.script);
  const performanceScript = targetJoin(input.stagedEvaluatorRoot, input.bundle.manifest.performance.command.script);
  const steps: ExperimentExecutionStep[] = [{
    step: 'EVALUATOR_SETUP',
    execution_domain: 'EVALUATOR',
    command: command(input.bundle.manifest.correctness.command.executable, [setupScript, input.runtimeRoot], input.stagedEvaluatorRoot, input.correctnessTimeoutMs),
  }];

  for (const testCase of input.bundle.correctness.cases) {
    steps.push({
      step: 'CORRECTNESS',
      execution_domain: 'EVALUATOR',
      command: { ...command(input.bundle.manifest.correctness.command.executable, [
        correctnessScript,
        ...expandEvaluatorArguments(input.bundle.manifest.correctness.command.arguments, {
          ...formalCaseParameters(testCase),
          case_id: testCase.case_id,
          artifact_path: input.candidateArtifact.path,
          runtime_root: input.runtimeRoot,
        }, `correctness case '${testCase.case_id}'`),
      ], input.stagedEvaluatorRoot, input.correctnessTimeoutMs),
        ...(input.candidateLibraryPaths?.length ? { environment: { LD_LIBRARY_PATH: input.candidateLibraryPaths.join(':') } } : {}) },
      measurements_from_stdout: true,
      formal_context: { ...context('CORRECTNESS_CASE', testCase.case_id, 'EVALUATOR', null, formalCaseParameters(testCase), testCase.threads, input.candidateArtifact, input.bundle),
        resources: entryResources(testCase, testPlan, input.bundle.manifest) },
    });
  }

  if (!input.includePerformance) return applyTestEnvironment(input, steps);
  for (const workload of input.bundle.workloads.workloads) {
    for (let index = 0; index < input.bundle.manifest.performance.sampling.warmup_count; index += 1) {
      for (const role of performanceRoles(testPlan.sampling.order, index)) {
        const artifact = role === 'BASELINE' ? input.baselineArtifact : input.candidateArtifact;
        steps.push(performanceStep(input, testPlan, performanceScript, workload, 'PERFORMANCE_WARMUP', 'warmup', role, artifact, index));
      }
    }
    for (let index = 0; index < input.bundle.manifest.performance.sampling.sample_count; index += 1) {
      for (const role of performanceRoles(testPlan.sampling.order, index)) {
        const artifact = role === 'BASELINE' ? input.baselineArtifact : input.candidateArtifact;
        steps.push(performanceStep(input, testPlan, performanceScript, workload, 'PERFORMANCE_SAMPLE', 'sample', role, artifact, index));
      }
    }
  }
  return applyTestEnvironment(input, steps);
}

function applyTestEnvironment(input: FormalEvaluatorStepInput, steps: ExperimentExecutionStep[]): ExperimentExecutionStep[] {
  if (fs.existsSync(path.join(input.bundle.root, TEST_PLAN_FILE))) {
    const testPlan = readValidationTestPlan(input.bundle.root, input.bundle.manifest);
    for (const step of steps) step.command.environment = { ...step.command.environment,
      ...testPlanEnvironment(testPlan), COREPILOT_TEST_ASSETS_ROOT: input.stagedEvaluatorRoot };
    for (const step of steps) step.command.environment = { ...step.command.environment,
      ...(input.candidateSourceRoot ? { COREPILOT_CANDIDATE_SOURCE_ROOT: input.candidateSourceRoot } : {}),
      COREPILOT_BASELINE_ARTIFACT: input.baselineArtifact.path,
      COREPILOT_CANDIDATE_ARTIFACT: input.candidateArtifact.path };
    for (const step of steps) if (step.formal_context?.resources.omp_proc_bind) step.command.environment.OMP_PROC_BIND = step.formal_context.resources.omp_proc_bind;
  }
  for (const step of steps) step.command.environment = { ...step.command.environment, ...EVALUATOR_EXECUTION_ENVIRONMENT };
  return steps;
}

function performanceStep(
  input: FormalEvaluatorStepInput,
  testPlan: ValidationTestPlan,
  script: string,
  workload: FormalWorkloadDefinition,
  phase: 'PERFORMANCE_WARMUP' | 'PERFORMANCE_SAMPLE',
  commandPhase: 'warmup' | 'sample',
  role: 'BASELINE' | 'CANDIDATE',
  artifact: FormalArtifactInput,
  index: number,
): ExperimentExecutionStep {
  return {
    step: 'PERFORMANCE',
    execution_domain: 'EVALUATOR',
    command: { ...command(input.bundle.manifest.performance.command.executable, [
      script,
      ...expandEvaluatorArguments(input.bundle.manifest.performance.command.arguments, {
        ...formalWorkloadParameters(workload),
        phase: commandPhase,
        role,
        workload_id: workload.workload_id,
        artifact_path: artifact.path,
        iteration_index: index,
        runtime_root: input.runtimeRoot,
      }, `performance workload '${workload.workload_id}'`),
    ], input.stagedEvaluatorRoot, input.performanceTimeoutMs),
    ...((role === 'BASELINE' ? input.baselineLibraryPaths : input.candidateLibraryPaths)?.length
      ? { environment: { LD_LIBRARY_PATH: (role === 'BASELINE' ? input.baselineLibraryPaths! : input.candidateLibraryPaths!).join(':') } } : {}) },
    ...(phase === 'PERFORMANCE_SAMPLE' ? { measurements_from_stdout: true } : {}),
    formal_context: { ...context(phase, workload.workload_id, role, index, formalWorkloadParameters(workload), workload.threads, artifact, input.bundle),
      resources: entryResources(workload, testPlan, input.bundle.manifest) },
  };
}

function command(executable: string, args: string[], cwd: string, timeoutMs: number) {
  return { executable, args, cwd, environment: {}, timeout_ms: timeoutMs };
}

function context(
  phase: FormalExecutionContext['phase'],
  subjectId: string,
  role: FormalExecutionContext['role'],
  iterationIndex: number | null,
  parameters: Record<string, EvaluatorParameter>,
  threads: number,
  artifact: FormalArtifactInput,
  bundle: LoadedFormalEvaluatorBundle,
): FormalExecutionContext {
  return {
    phase,
    subject_id: subjectId,
    role,
    iteration_index: iterationIndex,
    parameters,
    artifact: { artifact_id: artifact.artifactId, path: artifact.path, sha256: artifact.sha256?.toLowerCase() ?? null,
      ...(artifact.dependencies ? { dependencies: artifact.dependencies.map(item => ({ ...item })) } : {}) },
    resources: {
      threads,
      cpu_set: bundle.manifest.resource_requirements.cpu_set,
      numa_node: bundle.manifest.resource_requirements.numa_node,
    },
  };
}

function targetJoin(root: string, relative: string): string {
  if (/^[A-Za-z]:[\\/]/.test(root) || root.includes('\\')) return path.win32.resolve(root, ...relative.split('/'));
  return path.posix.resolve(root, relative);
}
