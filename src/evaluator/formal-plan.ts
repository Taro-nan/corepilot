import path from 'node:path';
import type { EvaluatorParameter, FormalWorkloadDefinition, LoadedFormalEvaluatorBundle } from '../contracts/formal-evaluator.js';
import type { ExperimentExecutionStep, FormalExecutionContext } from '../contracts/runner-rpc.js';
import { expandEvaluatorArguments, formalCaseParameters, formalWorkloadParameters } from './formal-arguments.js';

export interface FormalEvaluatorStepInput {
  bundle: LoadedFormalEvaluatorBundle;
  stagedEvaluatorRoot: string;
  runtimeRoot: string;
  candidateArtifact: FormalArtifactInput;
  baselineArtifact: FormalArtifactInput;
  correctnessTimeoutMs: number;
  performanceTimeoutMs: number;
  includePerformance: boolean;
}

export interface FormalArtifactInput {
  artifactId: string;
  path: string;
  sha256: string | null;
}

/** Expands the immutable inventories into one command per case/warmup/raw sample. */
export function createFormalEvaluatorSteps(input: FormalEvaluatorStepInput): ExperimentExecutionStep[] {
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
      command: command(input.bundle.manifest.correctness.command.executable, [
        correctnessScript,
        ...expandEvaluatorArguments(input.bundle.manifest.correctness.command.arguments, {
          ...formalCaseParameters(testCase),
          case_id: testCase.case_id,
          artifact_path: input.candidateArtifact.path,
          runtime_root: input.runtimeRoot,
        }, `correctness case '${testCase.case_id}'`),
      ], input.stagedEvaluatorRoot, input.correctnessTimeoutMs),
      measurements_from_stdout: true,
      formal_context: context('CORRECTNESS_CASE', testCase.case_id, 'EVALUATOR', null, formalCaseParameters(testCase), testCase.threads, input.candidateArtifact, input.bundle),
    });
  }

  if (!input.includePerformance) return steps;
  for (const workload of input.bundle.workloads.workloads) {
    for (let index = 0; index < input.bundle.manifest.performance.sampling.warmup_count; index += 1) {
      for (const [role, artifact] of [['BASELINE', input.baselineArtifact], ['CANDIDATE', input.candidateArtifact]] as const) {
        steps.push(performanceStep(input, performanceScript, workload, 'PERFORMANCE_WARMUP', 'warmup', role, artifact, index));
      }
    }
    for (let index = 0; index < input.bundle.manifest.performance.sampling.sample_count; index += 1) {
      for (const [role, artifact] of [['BASELINE', input.baselineArtifact], ['CANDIDATE', input.candidateArtifact]] as const) {
        steps.push(performanceStep(input, performanceScript, workload, 'PERFORMANCE_SAMPLE', 'sample', role, artifact, index));
      }
    }
  }
  return steps;
}

function performanceStep(
  input: FormalEvaluatorStepInput,
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
    command: command(input.bundle.manifest.performance.command.executable, [
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
    ...(phase === 'PERFORMANCE_SAMPLE' ? { measurements_from_stdout: true } : {}),
    formal_context: context(phase, workload.workload_id, role, index, formalWorkloadParameters(workload), workload.threads, artifact, input.bundle),
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
    artifact: { artifact_id: artifact.artifactId, path: artifact.path, sha256: artifact.sha256?.toLowerCase() ?? null },
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
