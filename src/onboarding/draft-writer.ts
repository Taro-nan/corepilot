import fs from 'node:fs';
import path from 'node:path';
import {
  FORMAL_EVALUATOR_DIGEST_ALGORITHM,
  type EvaluatorQualificationRecord,
  type FormalEvaluatorManifest,
} from '../contracts/formal-evaluator.js';
import type { LibraryPackageManifest, PackageBuildDefinition } from '../contracts/library-package.js';
import { evaluatorContentSha256, loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import { LibraryPackageLoader, validateLibraryPackageManifest } from '../library-package/loader.js';
import type { FunctionCandidate, RepositoryInspection } from './repository-inspector.js';

export interface OnboardingEvidence {
  schema_version: 1;
  created_at: string;
  repository: RepositoryInspection['repository'];
  agent: { runtime: 'pi-agent-core' | 'deterministic-inspection'; model_id: string | null; completed: boolean; error: string | null; observations: string[] };
  files_inspected: RepositoryInspection['inspected_files'];
  build_evidence: RepositoryInspection['build_candidates'];
  api_evidence: RepositoryInspection['functions'];
  test_evidence: Array<{ path: string; status: 'DISCOVERED_TEST' | 'DEVELOPMENT_READY' | 'FORMAL_CANDIDATE' | 'NEEDS_HUMAN_REVIEW'; assertion_clues: string[] }>;
  benchmark_evidence: Array<{ path: string; status: 'DISCOVERED'; argument_clues: string[]; output_clues: string[]; workload_clues: string[] }>;
  reference_evidence: string[];
  dependency_evidence: { dependencies: string[]; languages: string[]; version_clues: RepositoryInspection['version_clues']; public_headers: string[] };
  candidate_scope_proposal: { include: string[]; exclude: string[] };
  unknowns: string[];
  risks: string[];
  human_decisions: Array<{ topic: string; status: 'PENDING'; decision: null }>;
  generated: { package_id: string; version: string; evaluator_id: string; evaluator_version: string };
}

export interface DraftWriteOptions {
  packagesRoot: string;
  evaluatorsRoot: string;
  packageId: string;
  version: string;
  target: FunctionCandidate | null;
  buildKind?: string | null;
  agent: OnboardingEvidence['agent'];
}

const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const ZERO = '0'.repeat(64);

function writeJson(root: string, relative: string, data: unknown): void {
  const filename = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
}

function writeText(root: string, relative: string, value: string): void {
  const filename = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, value, { flag: 'wx' });
}

function resolvedDestination(value: string): string {
  let existing = path.resolve(value);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`cannot resolve output path: ${value}`);
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), path.relative(existing, path.resolve(value)));
}

function buildDefinition(inspection: RepositoryInspection, buildKind?: string | null): PackageBuildDefinition {
  const chosen = buildKind === null ? undefined : inspection.build_candidates.find((item) => item.kind === buildKind) ?? inspection.build_candidates[0];
  if (!chosen) return { executable: 'false', args: [], cwd: '.', environment: {}, timeout_ms: 30000 };
  if (chosen.kind === 'make') return { executable: 'make', args: [], cwd: '.', environment: {}, timeout_ms: 120000 };
  if (chosen.kind === 'cmake') return { executable: 'cmake', args: ['--build', 'build'], cwd: '.', environment: {}, timeout_ms: 120000 };
  if (chosen.kind === 'meson') return { executable: 'meson', args: ['compile', '-C', 'build'], cwd: '.', environment: {}, timeout_ms: 120000 };
  if (chosen.kind === 'configure') return { executable: 'false', args: [], cwd: '.', environment: {}, timeout_ms: 30000 };
  return { executable: 'bash', args: [chosen.command], cwd: '.', environment: {}, timeout_ms: 120000 };
}

function evaluatorDraft(root: string, evaluatorId: string, version: string, api: string, libraryName: string): string {
  const correctnessArgs = ['case_id', 'artifact_path', 'threads', 'runtime_root'];
  const performanceArgs = ['phase', 'role', 'workload_id', 'artifact_path', 'iteration_index', 'threads', 'runtime_root'];
  const requiredFiles = [
    'correctness/cases.json', 'correctness/policy.json', 'correctness/oracle-proposal.txt',
    'benchmark/workloads.json', 'benchmark/policy.json', 'benchmark/benchmark-proposal.txt',
    'benchmark/output-schema.json', 'scripts/run-correctness.sh', 'scripts/run-performance.sh',
  ];
  const manifest: FormalEvaluatorManifest = {
    schema_version: 1, evaluator_id: evaluatorId, version, owner: 'human-review-required',
    domain: { name: libraryName, api, layout: 'UNKNOWN_REVIEW_REQUIRED', operation: 'UNKNOWN_REVIEW_REQUIRED', datatype: 'UNKNOWN_REVIEW_REQUIRED' },
    target: { platform: 'UNKNOWN_REVIEW_REQUIRED', build_target: 'UNKNOWN_REVIEW_REQUIRED', compatibility_scope: 'UNKNOWN_REVIEW_REQUIRED' },
    digest_algorithm: FORMAL_EVALUATOR_DIGEST_ALGORITHM, digest: ZERO,
    qualification: { record: 'qualification.json', requires_target_qualification: true, requires_owner_approval: true },
    correctness: {
      definition: 'DRAFT ONLY: no trusted correctness oracle; this script always fails.',
      inventory: 'correctness/cases.json', case_ids: ['review-required'],
      command: { executable: 'bash', script: 'scripts/run-correctness.sh', arguments: correctnessArgs, measurement_prefix: 'PHYOPT_MEASUREMENT' },
      reference: { implementation: 'correctness/oracle-proposal.txt', accumulation: 'UNKNOWN_REVIEW_REQUIRED', qualification_required: true },
      tolerance: { rule: 'UNKNOWN_REVIEW_REQUIRED', absolute: 0, relative: 0, qualification_required: true },
    },
    performance: {
      definition: 'DRAFT ONLY: no formal benchmark or qualified workload; this script always fails.',
      inventory: 'benchmark/workloads.json', workload_ids: ['review-required'],
      command: { executable: 'bash', script: 'scripts/run-performance.sh', arguments: performanceArgs, measurement_prefix: 'PHYOPT_MEASUREMENT' },
      sampling: { warmup_count: 0, sample_count: 1, statistic: 'median', process_model: 'one-process-per-sample' },
      measurement: { unit: 'seconds', value: 'latency_seconds', derived: ['median'], raw_samples_retained: true, output_schema: 'benchmark/output-schema.json' },
    },
    resource_requirements: {
      cpu_set: 'UNKNOWN_REVIEW_REQUIRED', numa_node: 0, thread_counts: [1],
      enforcement: { threads: 'NOT_ENFORCED', cpu_set: 'NOT_ENFORCED', numa_node: 'NOT_ENFORCED' },
    },
    baseline_definition: {
      mode: 'live-symmetric-execution', historical_measurements_are_formal_evidence: false,
      identity_required: ['artifact_id', 'sha256', 'runtime_path'], symmetry_required: ['workload', 'sampling', 'resource_policy'],
    },
    acceptance_policy: {
      correctness: 'UNKNOWN_REVIEW_REQUIRED', performance: 'UNKNOWN_REVIEW_REQUIRED', regression: 'UNKNOWN_REVIEW_REQUIRED',
    },
    artifact_identity_policy: {
      required_files: ['qualification.json', ...requiredFiles],
      source_files: ['correctness/oracle-proposal.txt', 'benchmark/benchmark-proposal.txt'],
      benchmark_binary: 'UNKNOWN_REVIEW_REQUIRED', candidate_binary: 'UNKNOWN_REVIEW_REQUIRED',
      baseline_binary: 'UNKNOWN_REVIEW_REQUIRED', runtime_resolution: 'UNKNOWN_REVIEW_REQUIRED',
      mutable_dependencies: 'explicit-artifact-inputs-only',
    },
  };
  writeJson(root, 'manifest.json', manifest);
  writeJson(root, 'correctness/cases.json', { schema_version: 1, cases: [{ case_id: 'review-required', parameters: {}, threads: 1 }] });
  writeJson(root, 'benchmark/workloads.json', { schema_version: 1, workloads: [{ workload_id: 'review-required', parameters: {}, threads: 1, critical: false, weight: 1 }] });
  writeJson(root, 'correctness/policy.json', { status: 'DRAFT', argument_contract: correctnessArgs, oracle: 'UNKNOWN_REVIEW_REQUIRED' });
  writeJson(root, 'benchmark/policy.json', { status: 'DRAFT', argument_contract: performanceArgs, benchmark: 'UNKNOWN_REVIEW_REQUIRED' });
  writeJson(root, 'benchmark/output-schema.json', {
    line_prefix: 'PHYOPT_MEASUREMENT',
    required_fields: ['kind', 'role', 'subject_id', 'sample_index', 'value', 'unit', 'validity', 'domain_payload'],
  });
  writeText(root, 'correctness/oracle-proposal.txt', 'No trusted oracle exists. Human review must supply an independent correctness harness.\n');
  writeText(root, 'benchmark/benchmark-proposal.txt', 'No formal benchmark exists. Human review must supply qualified workloads and a benchmark harness.\n');
  for (const [name, args] of [['run-correctness', correctnessArgs], ['run-performance', performanceArgs]] as const) {
    writeText(root, `scripts/${name}.sh`, `#!/bin/sh\n: PHYOPT_ARGUMENT_CONTRACT: ${args.join(',')}\nprintf '%s\\n' 'DRAFT evaluator is not executable' >&2\nexit 1\n`);
  }
  const digest = evaluatorContentSha256(root);
  manifest.digest = digest;
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const qualification: EvaluatorQualificationRecord = {
    schema_version: 1, evaluator_id: evaluatorId, version, subject_digest: digest, status: 'DRAFT',
    target: { ...manifest.target, machine_identity_sha256: null },
    qualification_run: { run_id: null, result: 'NOT_RUN', started_at: null, completed_at: null },
    owner: manifest.owner, reviewer: null, approved_at: null,
    evidence: { report_sha256: null, raw_measurements_sha256: null }, updated_at: new Date().toISOString(),
    checks: [{ check_id: 'target.execution', scope: 'TARGET', status: 'REQUIRES_TARGET_QUALIFICATION', summary: 'No target qualification or human approval has occurred.' }],
  };
  writeJson(root, 'qualification.json', qualification);
  loadFormalEvaluatorBundle(root);
  return digest;
}

export function writeOnboardingDraft(inspection: RepositoryInspection, options: DraftWriteOptions): {
  packagePath: string; evaluatorPath: string; evidence: OnboardingEvidence;
} {
  const { packageId, version, target } = options;
  if (!IDENTIFIER.test(packageId) || !VERSION.test(version)) throw new Error('invalid package id or version');
  const targetId = target ? target.symbol.replace(/_/g, '-').toLowerCase().replace(/[^a-z0-9-]/g, '') : 'unknown-api';
  const safeTargetId = IDENTIFIER.test(targetId) ? targetId : 'unknown-api';
  const evaluatorId = `${packageId}-${safeTargetId}`;
  const packagePath = path.resolve(options.packagesRoot, packageId, version);
  const evaluatorPath = path.resolve(options.evaluatorsRoot, evaluatorId, version);
  const repository = inspection.repository.path;
  for (const output of [packagePath, evaluatorPath]) {
    const relative = path.relative(repository, resolvedDestination(output));
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('draft output must not be inside the source repository');
    if (fs.existsSync(output)) throw new Error(`draft already exists: ${output}`);
  }
  const include = target?.implementation_files.filter((item) => !/(?:^|\/)(?:tests?|benchmarks?|perf|reference)(?:\/|[._-])/i.test(item)) ?? [];
  const candidateScope = {
    include: include.length ? include : ['REVIEW_REQUIRED_SOURCE_FILE'],
    exclude: [...new Set([...inspection.tests, ...inspection.benchmarks, ...inspection.references, ...inspection.build_candidates.flatMap((item) => item.evidence)])].slice(0, 200),
  };
  const humanTopics = ['build command', 'optimization target and public API', 'candidate source scope', 'correctness oracle', 'tolerance', 'workloads', 'baseline identity', 'acceptance policy', 'target resources'];
  const evidence: OnboardingEvidence = {
    schema_version: 1, created_at: new Date().toISOString(), repository: inspection.repository, agent: options.agent,
    files_inspected: inspection.inspected_files, build_evidence: inspection.build_candidates, api_evidence: inspection.functions,
    test_evidence: inspection.test_assets.map((item) => ({ ...item, status: 'DISCOVERED_TEST' })),
    benchmark_evidence: inspection.benchmark_assets.map((item) => ({ ...item, status: 'DISCOVERED' })),
    reference_evidence: inspection.references,
    dependency_evidence: {
      dependencies: inspection.dependencies, languages: inspection.languages,
      version_clues: inspection.version_clues, public_headers: inspection.public_headers,
    },
    candidate_scope_proposal: candidateScope,
    unknowns: [...inspection.unknowns, ...(target ? [] : ['Optimization target was not confirmed.'])],
    risks: ['Discovered tests and benchmarks are development assets only.', 'Generated evaluator has no trusted oracle or formal benchmark.', 'No build or execution probe was run.'],
    human_decisions: humanTopics.map((topic) => ({ topic, status: 'PENDING', decision: null })),
    generated: { package_id: packageId, version, evaluator_id: evaluatorId, evaluator_version: version },
  };
  fs.mkdirSync(packagePath, { recursive: true });
  fs.mkdirSync(evaluatorPath, { recursive: true });
  const digest = evaluatorDraft(evaluatorPath, evaluatorId, version, target?.public_api ?? 'UNKNOWN', inspection.repository.name);
  const manifest = {
    schema_version: 1, package_id: packageId, version, owner: 'human-review-required',
    library: {
      name: inspection.repository.name, source_compatibility: ['UNVERIFIED_REVIEW_REQUIRED'], target_compatibility: ['UNVERIFIED_REVIEW_REQUIRED'],
    },
    qualification: { state: 'DRAFT', reviewer: null, reviewed_at: null },
    functions: [{ function_id: safeTargetId, api: target?.public_api ?? 'UNKNOWN' }],
    build_definitions: [{ build_id: 'discovered-build', definition: 'build/discovered.json' }],
    formal_evaluators: [{ evaluator_id: evaluatorId, version, owner: 'human-review-required', digest, catalog_path: `${evaluatorId}/${version}` }],
    targets: [{
      target_id: safeTargetId, function_id: safeTargetId, build_id: 'discovered-build',
      evaluator: { evaluator_id: evaluatorId, evaluator_version: version }, candidate_scope: candidateScope,
      development_benchmark: { evaluator: { evaluator_id: evaluatorId, evaluator_version: version }, workload_ids: ['review-required'] },
      artifacts: {
        candidate: { artifact_id: 'unverified-candidate', relative_path: 'REVIEW_REQUIRED_ARTIFACT' },
        baseline: { id: 'unverified-baseline', library: inspection.repository.name, version: 'UNVERIFIED', sha256: ZERO },
      },
      performance_acceptance: { weighted_geomean_min: 1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: 0.95 },
      analysis_sampling: { interleave_seed: 0, bootstrap_iterations: 100 },
      domain_payload: { onboarding_draft: true },
    }],
  } as unknown as LibraryPackageManifest;
  validateLibraryPackageManifest(manifest);
  writeJson(packagePath, 'package.json', manifest);
  writeJson(packagePath, 'build/discovered.json', buildDefinition(inspection, options.buildKind));
  writeJson(packagePath, 'development/tests.json', {
    status: 'DISCOVERED_TEST', command: null, formal_correctness: false, assets: evidence.test_evidence,
  });
  writeJson(packagePath, 'development/benchmark.json', {
    status: inspection.benchmarks.length ? 'DISCOVERED' : 'MISSING', command: null, formal_benchmark: false,
    assets: evidence.benchmark_evidence,
  });
  writeJson(packagePath, 'onboarding/evidence.json', evidence);
  const loader = new LibraryPackageLoader({ packagesRoot: options.packagesRoot, evaluatorsRoot: options.evaluatorsRoot });
  loader.resolveSelection({ package_id: packageId, package_version: version, target_id: safeTargetId });
  return { packagePath, evaluatorPath, evidence };
}
