import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { BinaryBundleBaselineDefinition, LibraryPackageSelection, LibraryPackageTaskReference } from '../contracts/library-package.js';
import type { DomainIdentity } from '../contracts/optimization-domain.js';
import type { LoadedValidationTestpack, ValidationCommand } from '../contracts/validation-testpack.js';
import type { CreateOptimizationTaskInput } from '../core/optimization-runtime.js';
import { LibraryPackageLoader } from './loader.js';
import { readValidationTestPlan } from '../evaluator/validation-test-plan.js';
import { readValidationQuality } from '../evaluator/validation-quality.js';

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

/** A bundle uses its aggregate identity in Package and its selected entry digest in Experiment. */
export function packageBaselineBinding(resolved: ResolvedPackageTask, configuredPath: string): {
  artifactDigest: string;
  bundle: BinaryBundleBaselineDefinition | null;
  bundleRoot: string | null;
  entryPath: string | null;
} {
  const bundle = resolved.loaded.binary_baselines[resolved.target.target_id] ?? null;
  if (!bundle) return { artifactDigest: resolved.target.artifacts.baseline.sha256,
    bundle: null, bundleRoot: null, entryPath: null };
  if (bundle.state !== 'VERIFIED' || bundle.dependency_closure.status !== 'VALID') {
    throw new Error('binary bundle baseline has not passed target dependency inspection');
  }
  const source = resolved.target.domain_payload.baseline_source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('binary bundle source binding is missing');
  const binding = source as Record<string, unknown>;
  if (typeof binding.bundle_root !== 'string' || typeof binding.entry_path !== 'string') throw new Error('binary bundle root or entry path is missing');
  const entry = bundle.libraries.find(item => item.path === binding.entry_path && item.role === 'ENTRY');
  if (!entry) throw new Error('binary bundle entry identity differs from Package');
  const expected = path.resolve(binding.bundle_root, ...entry.path.split('/'));
  if (path.resolve(configuredPath) !== expected) throw new Error('configured baseline artifact differs from binary bundle entry');
  return { artifactDigest: entry.sha256, bundle, bundleRoot: binding.bundle_root, entryPath: entry.path };
}

export function packageOptimizationTaskInput(resolved: ResolvedPackageTask, input: {
  workflowId?: string | null;
  sourceBaseline: DomainIdentity;
  baselineArtifactPath?: string;
  declaredContext?: Record<string, unknown>;
}): CreateOptimizationTaskInput {
  const reference = packageTaskReference(resolved);
  const baseline = resolved.target.artifacts.baseline;
  const binding = packageBaselineBinding(resolved, input.baselineArtifactPath ?? '');
  const quality = readValidationQuality(resolved.bundle.root, resolved.bundle.correctness.cases);
  let qualityResult: import('../contracts/validation-quality.js').ValidationQualityResult | undefined;
  const qualityReceipt = path.join(resolved.loaded.root, 'onboarding', `validation-review-${resolved.target.target_id}`, 'report.json');
  if (quality && fs.existsSync(qualityReceipt)) {
    const raw = fs.readFileSync(qualityReceipt);
    if (createHash('sha256').update(raw).digest('hex') === resolved.bundle.qualification.evidence.report_sha256) {
      const receipt = JSON.parse(raw.toString('utf8'));
      if (receipt.preview?.evaluator_digest === resolved.bundle.content_digest) qualityResult = receipt.preview.quality;
    }
  }
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
      id: baseline.id, version: baseline.version, digest: binding.artifactDigest,
      details: { library: baseline.library, ...('kind' in baseline ? { kind: baseline.kind, bundle_sha256: baseline.sha256 } : {}), ...(input.baselineArtifactPath ? { path: input.baselineArtifactPath } : {}) },
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
      test_conditions: readValidationTestPlan(resolved.bundle.root, resolved.bundle.manifest),
      correctness_scope: { cases: structuredClone(resolved.bundle.correctness.cases), reference: structuredClone(resolved.bundle.manifest.correctness.reference),
        tolerance: structuredClone(resolved.bundle.manifest.correctness.tolerance), ...(quality ? { quality } : {}), ...(qualityResult ? { quality_result: qualityResult } : {}) },
    },
  };
}

export function packageValidationTestpack(resolved: ResolvedPackageTask, baselineArtifactPath: string): LoadedValidationTestpack {
  if (!baselineArtifactPath.trim()) throw new Error('尚未配置比较基线。请在「构建与验证 → 准备比较基线」构建另一分支，或上传比较库后再开始正式优化。');
  const { bundle, loaded, target } = resolved;
  const baselineBinding = packageBaselineBinding(resolved, baselineArtifactPath);
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
            path: '${COREPILOT_CANDIDATE_ROOT}/' + target.artifacts.candidate.relative_path,
          },
          comparison: { id: target.artifacts.baseline.id, library: target.artifacts.baseline.library,
            version: target.artifacts.baseline.version, sha256: baselineBinding.artifactDigest, path: baselineArtifactPath },
        },
        thresholds: structuredClone(target.performance_acceptance),
        key_cases: bundle.workloads.workloads.filter((item) => item.critical).map((item) => item.workload_id),
        ...(readValidationTestPlan(bundle.root, bundle.manifest).statistics ? { statistics: readValidationTestPlan(bundle.root, bundle.manifest).statistics } : {}),
      },
      revalidation: {
        formal: { required: true, timeout_ms: correctnessCommand.timeout_ms, command: correctnessCommand },
        independent: { required: false, timeout_ms: performanceCommand.timeout_ms, command: performanceCommand },
      },
    },
  };
}
