import type { LibraryPackageSelection, LibraryPackageTaskReference } from '../contracts/library-package.js';
import type { DomainIdentity } from '../contracts/optimization-domain.js';
import type { LoadedValidationTestpack, ValidationCommand } from '../contracts/validation-testpack.js';
import type { CreateOptimizationTaskInput } from '../core/optimization-runtime.js';
import { LibraryPackageLoader } from './loader.js';

export type ResolvedPackageTask = ReturnType<LibraryPackageLoader['resolveSelection']>;

export function resolveLibraryPackageTask(selection: LibraryPackageSelection, options: {
  loader?: LibraryPackageLoader;
  requireQualified?: boolean;
} = {}): ResolvedPackageTask {
  return (options.loader ?? new LibraryPackageLoader()).resolveSelection(selection, { requireQualified: options.requireQualified ?? false });
}

export function packageTaskReference(resolved: ResolvedPackageTask): LibraryPackageTaskReference {
  return {
    package_id: resolved.loaded.manifest.package_id,
    package_version: resolved.loaded.manifest.version,
    package_digest: resolved.loaded.content_digest,
    target_id: resolved.target.target_id,
    function_id: resolved.target.function_id,
    evaluator_id: resolved.bundle.manifest.evaluator_id,
    evaluator_version: resolved.bundle.manifest.version,
  };
}

export function packageOptimizationTaskInput(resolved: ResolvedPackageTask, input: {
  workflowId?: string | null;
  sourceBaseline: DomainIdentity;
  baselineArtifactPath?: string;
  declaredContext?: Record<string, unknown>;
}): CreateOptimizationTaskInput {
  const reference = packageTaskReference(resolved);
  const baseline = resolved.target.artifacts.baseline;
  return {
    workflowId: input.workflowId ?? null,
    libraryPackage: reference,
    target: {
      kind: 'software_function',
      name: resolved.functionDefinition.api,
      scope: {
        target_id: reference.target_id,
        function_id: reference.function_id,
        build: structuredClone(resolved.build),
        candidate_scope: structuredClone(resolved.target.candidate_scope),
        artifacts: structuredClone(resolved.target.artifacts),
        domain_payload: structuredClone(resolved.target.domain_payload),
        development_feedback: {
          workload_ids: [...resolved.target.development_benchmark.workload_ids],
          tools: ['inspect_machine', 'inspect_binary', 'disassemble', 'run_dev_benchmark', 'profile_perf_stat'],
        },
      },
    },
    sourceBaseline: input.sourceBaseline,
    performanceBaseline: {
      id: baseline.id, version: baseline.version, digest: baseline.sha256,
      details: { library: baseline.library, ...('kind' in baseline ? { kind: baseline.kind } : {}), ...(input.baselineArtifactPath ? { path: input.baselineArtifactPath } : {}) },
    },
    evaluator: {
      id: reference.evaluator_id, version: reference.evaluator_version, digest: resolved.bundle.content_digest,
      details: { owner: resolved.bundle.manifest.owner },
    },
    declaredContext: {
      ...input.declaredContext,
      resources: structuredClone(resolved.bundle.manifest.resource_requirements),
      workload_inventory: structuredClone(resolved.bundle.workloads.workloads),
      sampling: structuredClone(resolved.bundle.manifest.performance.sampling),
      acceptance_policy: structuredClone(resolved.target.performance_acceptance),
    },
  };
}

export function packageValidationTestpack(resolved: ResolvedPackageTask, baselineArtifactPath: string): LoadedValidationTestpack {
  if (!baselineArtifactPath.trim()) throw new Error('package execution requires a baseline_artifact binding outside the package');
  const { bundle, loaded, target } = resolved;
  if ('kind' in target.artifacts.baseline && target.artifacts.baseline.kind === 'binary_bundle') {
    throw new Error('binary bundle baseline requires verified target dependency closure and bundle staging before formal execution');
  }
  const evaluator = bundle.manifest;
  const command = (executable: string, timeout: number): ValidationCommand => ({
    executable, args: [], cwd: bundle.root, environment: {}, timeout_ms: timeout,
  });
  const correctnessCommand = command(evaluator.correctness.command.executable, 120_000);
  const performanceCommand = command(evaluator.performance.command.executable, 1_200_000);
  return {
    testpackPath: `${loaded.root}/package.json`,
    testpackDir: loaded.root,
    rawSha256: loaded.content_digest,
    testpack: {
      schema_version: 1,
      testpack_id: `${loaded.manifest.package_id}-${target.target_id}-${loaded.manifest.version}`,
      function_name: resolved.functionDefinition.api,
      function_family: bundle.manifest.domain.name,
      operation: bundle.manifest.domain.operation,
      data_type: bundle.manifest.domain.datatype,
      evaluator: { id: evaluator.evaluator_id, version: evaluator.version, owner: evaluator.owner, root: bundle.root, sha256: bundle.content_digest },
      resources: {
        cpu_set: evaluator.resource_requirements.cpu_set,
        numa_nodes: [evaluator.resource_requirements.numa_node],
        thread_counts: [...evaluator.resource_requirements.thread_counts],
      },
      correctness: {
        command: correctnessCommand,
        cases: bundle.correctness.cases.map((item) => ({
          case_id: item.case_id, parameters: structuredClone(item.parameters), threads: item.threads, critical: true, weight: 1,
        })),
        pass_required: bundle.correctness.cases.length,
      },
      performance: {
        command: performanceCommand,
        cases: bundle.workloads.workloads.map((item) => ({
          case_id: item.workload_id, parameters: structuredClone(item.parameters), threads: item.threads, critical: item.critical, weight: item.weight,
        })),
        sampling: { warmup: evaluator.performance.sampling.warmup_count, samples: evaluator.performance.sampling.sample_count, ...target.analysis_sampling },
        baselines: {
          current: {
            id: target.artifacts.candidate.artifact_id,
            library: loaded.manifest.library.name,
            version: loaded.manifest.version,
            sha256: '0'.repeat(64),
            path: '${PHYOPT_CANDIDATE_ROOT}/' + target.artifacts.candidate.relative_path,
          },
          comparison: { ...target.artifacts.baseline, path: baselineArtifactPath },
        },
        thresholds: structuredClone(target.performance_acceptance),
        key_cases: bundle.workloads.workloads.filter((item) => item.critical).map((item) => item.workload_id),
      },
      revalidation: {
        formal: { required: true, timeout_ms: correctnessCommand.timeout_ms, command: correctnessCommand },
        independent: { required: false, timeout_ms: performanceCommand.timeout_ms, command: performanceCommand },
      },
    },
  };
}
