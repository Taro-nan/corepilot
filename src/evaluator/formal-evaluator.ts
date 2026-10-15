import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FORMAL_EVALUATOR_DIGEST_ALGORITHM,
  FORMAL_EVALUATOR_SCHEMA_VERSION,
  type EvaluatorQualificationCheck,
  type EvaluatorQualificationRecord,
  type EvaluatorQualificationState,
  type EvaluatorParameter,
  type FormalCaseDefinition,
  type FormalEvaluatorCommandContract,
  type FormalEvaluatorManifest,
  type FormalCorrectnessInventory,
  type FormalWorkloadDefinition,
  type FormalWorkloadInventory,
  type LoadedFormalEvaluatorBundle,
  type TargetQualificationResult,
} from '../contracts/formal-evaluator.js';

const DIGEST_PLACEHOLDER = '0'.repeat(64);
const QUALIFICATION_STATES = new Set<EvaluatorQualificationState>([
  'DRAFT',
  'QUALIFICATION_PENDING',
  'TARGET_VALIDATED',
  'QUALIFIED',
  'REJECTED',
  'SUPERSEDED',
]);
const TARGET_RESULTS = new Set<TargetQualificationResult>([
  'NOT_RUN',
  'TARGET_EXECUTION_FAILED',
  'TARGET_EXECUTION_PASSED',
]);
const FORBIDDEN_MUTABLE_REFERENCES = [
  /(?:^|[\s"'])testpacks\//m,
  /(?:^|[\s"'])benchmark-assets\//m,
  /(?:^|[\s"'])testplans\//m,
  /(?:^|[\s"'])build-inputs\//m,
  /(?:^|[\s"'])\.\.\/(?:testpacks|benchmark-assets|testplans|build-inputs)\//m,
  /\/home\/[A-Za-z0-9_.-]+\//m,
  /[A-Za-z]:\\Users\\/m,
];

export class FormalEvaluatorBundleError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
    this.name = 'FormalEvaluatorBundleError';
  }
}

export interface LoadFormalEvaluatorOptions {
  requireQualified?: boolean;
  /** Bootstrap-only gate for one exact TARGET_VALIDATED content identity. */
  allowTargetValidatedDigest?: string;
  expected?: { evaluatorId: string; version: string; digest: string };
}

export interface EvaluatorQualificationInspection {
  evaluator_id: string | null;
  version: string | null;
  declared_digest: string | null;
  observed_digest: string | null;
  qualification_subject_digest: string | null;
  qualification_attestation_digest: string | null;
  declared_state: EvaluatorQualificationState | null;
  effective_state: EvaluatorQualificationState;
  checks: EvaluatorQualificationCheck[];
}

/**
 * Content identity for immutable evaluator assets. qualification.json is an
 * attestation over this digest and is intentionally excluded. The manifest is
 * canonically serialized with only its digest field zeroed to avoid self-hash.
 */
export function evaluatorContentSha256(root: string): string {
  const absoluteRoot = path.resolve(root);
  const hash = createHash('sha256');
  for (const relative of bundleFiles(absoluteRoot).filter((item) => item !== 'qualification.json')) {
    hash.update(relative);
    hash.update('\0');
    const absolute = path.join(absoluteRoot, ...relative.split('/'));
    if (relative === 'manifest.json') {
      const manifest = readJsonFile(absolute, 'manifest.json') as Record<string, unknown>;
      hash.update(stableJson({ ...manifest, digest: DIGEST_PLACEHOLDER }));
    } else {
      hash.update(fs.readFileSync(absolute));
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Compatibility name retained for callers; its value is the content digest. */
export const evaluatorBundleSha256 = evaluatorContentSha256;

export function loadFormalEvaluatorBundle(
  root: string,
  options: LoadFormalEvaluatorOptions = {},
): LoadedFormalEvaluatorBundle {
  const absoluteRoot = path.resolve(root);
  const problems: string[] = [];
  const manifest = parseManifest(readBundleJson(absoluteRoot, 'manifest.json', problems), problems);
  if (!manifest) throw new FormalEvaluatorBundleError(problems);

  const required = new Set(['manifest.json', manifest.qualification.record, ...manifest.artifact_identity_policy.required_files]);
  for (const relative of required) {
    if (!safeRelativePath(relative)) problems.push(`bundle path must be relative and contained: ${relative}`);
    else if (!fs.existsSync(path.join(absoluteRoot, ...relative.split('/')))) problems.push(`required bundle file is missing: ${relative}`);
  }

  let observedDigest = '';
  try { observedDigest = evaluatorContentSha256(absoluteRoot); }
  catch (error) { problems.push(`cannot compute evaluator digest: ${(error as Error).message}`); }
  if (observedDigest && observedDigest !== manifest.digest.toLowerCase()) {
    problems.push(`evaluator bundle digest mismatch: expected ${manifest.digest}, observed ${observedDigest}`);
  }

  if (options.expected) {
    if (manifest.evaluator_id !== options.expected.evaluatorId) problems.push('manifest evaluator_id differs from the requested evaluator');
    if (manifest.version !== options.expected.version) problems.push('manifest version differs from the requested evaluator version');
    if (manifest.digest.toLowerCase() !== options.expected.digest.toLowerCase()) problems.push('manifest digest differs from the requested evaluator digest');
  }

  const qualification = parseQualification(readBundleJson(absoluteRoot, manifest.qualification.record, problems), problems);
  const correctness = parseCorrectnessInventory(readBundleJson(absoluteRoot, manifest.correctness.inventory, problems), problems);
  const workloads = parseWorkloadInventory(readBundleJson(absoluteRoot, manifest.performance.inventory, problems), problems);
  if (!qualification || !correctness || !workloads) throw new FormalEvaluatorBundleError(problems);
  let qualificationDigest = '';
  try {
    qualificationDigest = createHash('sha256')
      .update(fs.readFileSync(path.join(absoluteRoot, manifest.qualification.record)))
      .digest('hex');
  } catch (error) {
    problems.push(`cannot compute qualification attestation digest: ${(error as Error).message}`);
  }

  validateQualification(
    manifest,
    qualification,
    observedDigest,
    options.requireQualified === true,
    options.allowTargetValidatedDigest,
    problems,
  );
  validateInventories(manifest, correctness, workloads, problems);
  validatePoliciesAndScripts(absoluteRoot, manifest, problems);
  validateOutputSchema(absoluteRoot, manifest, problems);
  validateNoMutableDependencies(absoluteRoot, problems);

  if (problems.length > 0) throw new FormalEvaluatorBundleError(problems);
  return {
    root: absoluteRoot,
    manifest,
    qualification,
    correctness,
    workloads,
    content_digest: observedDigest,
    qualification_digest: qualificationDigest,
    observed_digest: observedDigest,
  };
}

/** Static/local qualification. Target checks remain explicit and are never promoted to PASS here. */
export function inspectFormalEvaluatorBundle(root: string): EvaluatorQualificationInspection {
  const checks: EvaluatorQualificationCheck[] = [];
  const add = (check_id: string, status: EvaluatorQualificationCheck['status'], summary: string) => {
    checks.push({ check_id, scope: 'STATIC', status, summary });
  };
  let loaded: LoadedFormalEvaluatorBundle | null = null;
  try {
    loaded = loadFormalEvaluatorBundle(root);
    for (const [id, summary] of [
      ['manifest.completeness', 'manifest contains the required evaluator, domain, target, policy, and identity fields'],
      ['digest.correctness', 'declared evaluator content digest matches immutable assets and excludes qualification.json'],
      ['files.required', 'all required files exist inside the bundle'],
      ['inventory.correctness', 'manifest correctness case ids exactly match correctness/cases.json'],
      ['inventory.performance', 'manifest workload ids exactly match benchmark/workloads.json'],
      ['scripts.arguments', 'script argument markers match manifest and policy contracts'],
      ['benchmark.output_schema', 'benchmark output schema is compatible with Runner measurements'],
      ['runner.contract', 'measurement prefixes and one-process-per-sample contract are supported'],
      ['isolation.mutable_dependencies', 'bundle has no legacy or candidate-relative mutable asset dependency'],
    ] as const) add(id, 'PASS', summary);
  } catch (error) {
    const detail = error instanceof FormalEvaluatorBundleError ? error.problems.join('; ') : (error as Error).message;
    add('bundle.static_validation', 'FAIL', detail);
  }

  const targetChecks: EvaluatorQualificationCheck[] = loaded
    ? loaded.qualification.checks.filter((item) => item.scope === 'TARGET').map((item) => ({ ...item }))
    : [{
        check_id: 'target.execution',
        scope: 'TARGET',
        status: 'REQUIRES_TARGET_QUALIFICATION',
        summary: 'target qualification cannot be inferred from local static checks',
      }];
  checks.push(...targetChecks);
  const hasFailure = checks.some((item) => item.status === 'FAIL');
  const requiresTarget = checks.some((item) => item.status === 'REQUIRES_TARGET_QUALIFICATION');
  const effective: EvaluatorQualificationState = hasFailure
    ? 'REJECTED'
    : requiresTarget
      ? 'QUALIFICATION_PENDING'
      : loaded?.qualification.status ?? 'DRAFT';
  return {
    evaluator_id: loaded?.manifest.evaluator_id ?? null,
    version: loaded?.manifest.version ?? null,
    declared_digest: loaded?.manifest.digest ?? null,
    observed_digest: loaded?.observed_digest ?? null,
    qualification_subject_digest: loaded?.qualification.subject_digest ?? null,
    qualification_attestation_digest: loaded?.qualification_digest ?? null,
    declared_state: loaded?.qualification.status ?? null,
    effective_state: effective,
    checks,
  };
}

function parseManifest(value: unknown, problems: string[]): FormalEvaluatorManifest | null {
  const raw = record(value, 'manifest', problems);
  if (!raw) return null;
  if (raw.schema_version !== FORMAL_EVALUATOR_SCHEMA_VERSION) problems.push(`manifest.schema_version must be ${FORMAL_EVALUATOR_SCHEMA_VERSION}`);
  const evaluatorId = requiredString(raw.evaluator_id, 'manifest.evaluator_id', problems);
  const version = requiredString(raw.version, 'manifest.version', problems);
  const owner = requiredString(raw.owner, 'manifest.owner', problems);
  if (raw.digest_algorithm !== FORMAL_EVALUATOR_DIGEST_ALGORITHM) problems.push(`manifest.digest_algorithm must be ${FORMAL_EVALUATOR_DIGEST_ALGORITHM}`);
  const digest = requiredString(raw.digest, 'manifest.digest', problems).toLowerCase();
  if (digest && !/^[0-9a-f]{64}$/.test(digest)) problems.push('manifest.digest must be a SHA-256 digest');

  const domain = record(raw.domain, 'manifest.domain', problems);
  const target = record(raw.target, 'manifest.target', problems);
  const qualification = record(raw.qualification, 'manifest.qualification', problems);
  const correctness = record(raw.correctness, 'manifest.correctness', problems);
  const performance = record(raw.performance, 'manifest.performance', problems);
  const resources = record(raw.resource_requirements, 'manifest.resource_requirements', problems);
  const baseline = record(raw.baseline_definition, 'manifest.baseline_definition', problems);
  const acceptance = record(raw.acceptance_policy, 'manifest.acceptance_policy', problems);
  const artifacts = record(raw.artifact_identity_policy, 'manifest.artifact_identity_policy', problems);
  if (!domain || !target || !qualification || !correctness || !performance || !resources || !baseline || !acceptance || !artifacts) return null;

  const qualificationRecord = requiredString(qualification.record, 'manifest.qualification.record', problems);
  if (qualificationRecord !== 'qualification.json') problems.push('manifest.qualification.record must be qualification.json');
  requiredTrue(qualification.requires_target_qualification, 'manifest.qualification.requires_target_qualification', problems);
  requiredTrue(qualification.requires_owner_approval, 'manifest.qualification.requires_owner_approval', problems);

  const correctnessCommand = parseCommandContract(correctness.command, 'manifest.correctness.command', problems);
  const reference = record(correctness.reference, 'manifest.correctness.reference', problems);
  const tolerance = record(correctness.tolerance, 'manifest.correctness.tolerance', problems);
  const performanceCommand = parseCommandContract(performance.command, 'manifest.performance.command', problems);
  const sampling = record(performance.sampling, 'manifest.performance.sampling', problems);
  const measurement = record(performance.measurement, 'manifest.performance.measurement', problems);
  const enforcement = record(resources.enforcement, 'manifest.resource_requirements.enforcement', problems);
  if (!correctnessCommand || !reference || !tolerance || !performanceCommand || !sampling || !measurement || !enforcement) return null;

  const enforceValue = (value: unknown, field: string): 'ENFORCED' | 'NOT_ENFORCED' => {
    if (value !== 'ENFORCED' && value !== 'NOT_ENFORCED') problems.push(`${field} must be ENFORCED or NOT_ENFORCED`);
    return value === 'ENFORCED' ? 'ENFORCED' : 'NOT_ENFORCED';
  };
  const warmupCount = nonNegativeInteger(sampling.warmup_count, 'manifest.performance.sampling.warmup_count', problems);
  const sampleCount = positiveInteger(sampling.sample_count, 'manifest.performance.sampling.sample_count', problems);
  if (sampling.statistic !== 'median') problems.push('manifest.performance.sampling.statistic must be median');
  if (sampling.process_model !== 'one-process-per-sample') problems.push('manifest.performance.sampling.process_model must be one-process-per-sample');
  if (measurement.unit !== 'seconds' || measurement.value !== 'latency_seconds' || measurement.raw_samples_retained !== true) {
    problems.push('manifest.performance.measurement must retain raw latency_seconds values in seconds');
  }
  if (baseline.mode !== 'live-symmetric-execution' || baseline.historical_measurements_are_formal_evidence !== false) {
    problems.push('manifest.baseline_definition must require live symmetric execution and exclude historical measurements');
  }
  if (artifacts.mutable_dependencies !== 'explicit-artifact-inputs-only') problems.push('manifest artifact mutable dependency policy is invalid');

  const threadCounts = numberArray(resources.thread_counts, 'manifest.resource_requirements.thread_counts', problems, true);
  return {
    schema_version: FORMAL_EVALUATOR_SCHEMA_VERSION,
    evaluator_id: evaluatorId,
    version,
    owner,
    domain: {
      name: requiredString(domain.name, 'manifest.domain.name', problems),
      api: requiredString(domain.api, 'manifest.domain.api', problems),
      layout: requiredString(domain.layout, 'manifest.domain.layout', problems),
      operation: requiredString(domain.operation, 'manifest.domain.operation', problems),
      datatype: requiredString(domain.datatype, 'manifest.domain.datatype', problems),
    },
    target: {
      platform: requiredString(target.platform, 'manifest.target.platform', problems),
      build_target: requiredString(target.build_target, 'manifest.target.build_target', problems),
      compatibility_scope: requiredString(target.compatibility_scope, 'manifest.target.compatibility_scope', problems),
    },
    digest_algorithm: FORMAL_EVALUATOR_DIGEST_ALGORITHM,
    digest,
    qualification: {
      record: qualificationRecord,
      requires_target_qualification: true,
      requires_owner_approval: true,
    },
    correctness: {
      definition: requiredString(correctness.definition, 'manifest.correctness.definition', problems),
      inventory: requiredString(correctness.inventory, 'manifest.correctness.inventory', problems),
      case_ids: stringArray(correctness.case_ids, 'manifest.correctness.case_ids', problems, true),
      command: correctnessCommand,
      reference: {
        implementation: requiredString(reference.implementation, 'manifest.correctness.reference.implementation', problems),
        accumulation: requiredString(reference.accumulation, 'manifest.correctness.reference.accumulation', problems),
        qualification_required: requiredTrue(reference.qualification_required, 'manifest.correctness.reference.qualification_required', problems),
      },
      tolerance: {
        rule: requiredString(tolerance.rule, 'manifest.correctness.tolerance.rule', problems),
        absolute: nonNegativeNumber(tolerance.absolute, 'manifest.correctness.tolerance.absolute', problems),
        relative: nonNegativeNumber(tolerance.relative, 'manifest.correctness.tolerance.relative', problems),
        qualification_required: requiredTrue(tolerance.qualification_required, 'manifest.correctness.tolerance.qualification_required', problems),
      },
    },
    performance: {
      definition: requiredString(performance.definition, 'manifest.performance.definition', problems),
      inventory: requiredString(performance.inventory, 'manifest.performance.inventory', problems),
      workload_ids: stringArray(performance.workload_ids, 'manifest.performance.workload_ids', problems, true),
      command: performanceCommand,
      sampling: { warmup_count: warmupCount, sample_count: sampleCount, statistic: 'median', process_model: 'one-process-per-sample' },
      measurement: {
        unit: 'seconds',
        value: 'latency_seconds',
        derived: stringArray(measurement.derived, 'manifest.performance.measurement.derived', problems, true),
        raw_samples_retained: true,
        output_schema: requiredString(measurement.output_schema, 'manifest.performance.measurement.output_schema', problems),
      },
    },
    resource_requirements: {
      cpu_set: requiredString(resources.cpu_set, 'manifest.resource_requirements.cpu_set', problems),
      numa_node: nonNegativeInteger(resources.numa_node, 'manifest.resource_requirements.numa_node', problems),
      thread_counts: threadCounts,
      enforcement: {
        threads: enforceValue(enforcement.threads, 'manifest.resource_requirements.enforcement.threads'),
        cpu_set: enforceValue(enforcement.cpu_set, 'manifest.resource_requirements.enforcement.cpu_set'),
        numa_node: enforceValue(enforcement.numa_node, 'manifest.resource_requirements.enforcement.numa_node'),
      },
    },
    baseline_definition: {
      mode: 'live-symmetric-execution',
      historical_measurements_are_formal_evidence: false,
      identity_required: stringArray(baseline.identity_required, 'manifest.baseline_definition.identity_required', problems, true),
      symmetry_required: stringArray(baseline.symmetry_required, 'manifest.baseline_definition.symmetry_required', problems, true),
    },
    acceptance_policy: {
      correctness: requiredString(acceptance.correctness, 'manifest.acceptance_policy.correctness', problems),
      performance: requiredString(acceptance.performance, 'manifest.acceptance_policy.performance', problems),
      regression: requiredString(acceptance.regression, 'manifest.acceptance_policy.regression', problems),
    },
    artifact_identity_policy: {
      required_files: stringArray(artifacts.required_files, 'manifest.artifact_identity_policy.required_files', problems, true),
      source_files: stringArray(artifacts.source_files, 'manifest.artifact_identity_policy.source_files', problems, true),
      benchmark_binary: requiredString(artifacts.benchmark_binary, 'manifest.artifact_identity_policy.benchmark_binary', problems),
      candidate_binary: requiredString(artifacts.candidate_binary, 'manifest.artifact_identity_policy.candidate_binary', problems),
      baseline_binary: requiredString(artifacts.baseline_binary, 'manifest.artifact_identity_policy.baseline_binary', problems),
      runtime_resolution: requiredString(artifacts.runtime_resolution, 'manifest.artifact_identity_policy.runtime_resolution', problems),
      mutable_dependencies: 'explicit-artifact-inputs-only',
    },
  };
}

function parseCommandContract(value: unknown, field: string, problems: string[]): FormalEvaluatorCommandContract | null {
  const raw = record(value, field, problems);
  if (!raw) return null;
  return {
    executable: requiredString(raw.executable, `${field}.executable`, problems),
    script: requiredString(raw.script, `${field}.script`, problems),
    arguments: stringArray(raw.arguments, `${field}.arguments`, problems, true),
    measurement_prefix: requiredString(raw.measurement_prefix, `${field}.measurement_prefix`, problems),
  };
}

function parseQualification(value: unknown, problems: string[]): EvaluatorQualificationRecord | null {
  const raw = record(value, 'qualification record', problems);
  if (!raw) return null;
  if (raw.schema_version !== FORMAL_EVALUATOR_SCHEMA_VERSION) problems.push(`qualification.schema_version must be ${FORMAL_EVALUATOR_SCHEMA_VERSION}`);
  const status = requiredString(raw.status, 'qualification.status', problems) as EvaluatorQualificationState;
  if (!QUALIFICATION_STATES.has(status)) problems.push('qualification.status is invalid');
  const subjectDigest = sha256String(raw.subject_digest, 'qualification.subject_digest', problems);
  const target = record(raw.target, 'qualification.target', problems);
  const run = record(raw.qualification_run, 'qualification.qualification_run', problems);
  const evidence = record(raw.evidence, 'qualification.evidence', problems);
  if (!target || !run || !evidence) return null;
  const result = requiredString(run.result, 'qualification.qualification_run.result', problems) as TargetQualificationResult;
  if (!TARGET_RESULTS.has(result)) problems.push('qualification.qualification_run.result is invalid');
  const rawChecks = Array.isArray(raw.checks) ? raw.checks : [];
  if (!Array.isArray(raw.checks) || rawChecks.length === 0) problems.push('qualification.checks must be a non-empty array');
  const checks: EvaluatorQualificationCheck[] = rawChecks.flatMap((value, index) => {
    const item = record(value, `qualification.checks[${index}]`, problems);
    if (!item) return [];
    const scope = item.scope === 'TARGET' ? 'TARGET' : 'STATIC';
    if (item.scope !== 'STATIC' && item.scope !== 'TARGET') problems.push(`qualification.checks[${index}].scope is invalid`);
    const status = item.status;
    if (status !== 'PASS' && status !== 'FAIL' && status !== 'REQUIRES_TARGET_QUALIFICATION') problems.push(`qualification.checks[${index}].status is invalid`);
    return [{
      check_id: requiredString(item.check_id, `qualification.checks[${index}].check_id`, problems),
      scope,
      status: status === 'PASS' || status === 'FAIL' ? status : 'REQUIRES_TARGET_QUALIFICATION',
      summary: requiredString(item.summary, `qualification.checks[${index}].summary`, problems),
    }];
  });
  return {
    schema_version: FORMAL_EVALUATOR_SCHEMA_VERSION,
    evaluator_id: requiredString(raw.evaluator_id, 'qualification.evaluator_id', problems),
    version: requiredString(raw.version, 'qualification.version', problems),
    subject_digest: subjectDigest,
    status,
    target: {
      platform: requiredString(target.platform, 'qualification.target.platform', problems),
      build_target: requiredString(target.build_target, 'qualification.target.build_target', problems),
      compatibility_scope: requiredString(target.compatibility_scope, 'qualification.target.compatibility_scope', problems),
      machine_identity_sha256: nullableSha256(target.machine_identity_sha256, 'qualification.target.machine_identity_sha256', problems),
    },
    qualification_run: {
      run_id: nullableString(run.run_id, 'qualification.qualification_run.run_id', problems),
      result: TARGET_RESULTS.has(result) ? result : 'NOT_RUN',
      started_at: nullableString(run.started_at, 'qualification.qualification_run.started_at', problems),
      completed_at: nullableString(run.completed_at, 'qualification.qualification_run.completed_at', problems),
    },
    owner: requiredString(raw.owner, 'qualification.owner', problems),
    reviewer: nullableString(raw.reviewer, 'qualification.reviewer', problems),
    approved_at: nullableString(raw.approved_at, 'qualification.approved_at', problems),
    evidence: {
      report_sha256: nullableSha256(evidence.report_sha256, 'qualification.evidence.report_sha256', problems),
      raw_measurements_sha256: nullableSha256(evidence.raw_measurements_sha256, 'qualification.evidence.raw_measurements_sha256', problems),
    },
    updated_at: requiredString(raw.updated_at, 'qualification.updated_at', problems),
    checks,
  };
}

function parseCorrectnessInventory(value: unknown, problems: string[]): FormalCorrectnessInventory | null {
  const raw = record(value, 'correctness inventory', problems);
  if (!raw) return null;
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) problems.push('correctness inventory cases must be non-empty');
  const cases = (Array.isArray(raw.cases) ? raw.cases : []).flatMap((value, index) => {
    const item = record(value, `correctness.cases[${index}]`, problems);
    return item ? [parseFormalCase(item, `correctness.cases[${index}]`, problems)] : [];
  });
  return { schema_version: FORMAL_EVALUATOR_SCHEMA_VERSION, cases };
}

function parseWorkloadInventory(value: unknown, problems: string[]): FormalWorkloadInventory | null {
  const raw = record(value, 'workload inventory', problems);
  if (!raw) return null;
  if (!Array.isArray(raw.workloads) || raw.workloads.length === 0) problems.push('workload inventory workloads must be non-empty');
  const workloads = (Array.isArray(raw.workloads) ? raw.workloads : []).flatMap((value, index) => {
    const item = record(value, `workloads[${index}]`, problems);
    if (!item) return [];
    const field = `workloads[${index}]`;
    if (typeof item.critical !== 'boolean') problems.push(`workloads[${index}].critical must be boolean`);
    return [{
      workload_id: requiredString(item.workload_id, `${field}.workload_id`, problems),
      parameters: parseInventoryParameters(item, field, new Set(['workload_id', 'parameters', 'threads', 'critical', 'weight']), problems),
      threads: positiveInteger(item.threads, `${field}.threads`, problems),
      critical: item.critical === true,
      weight: nonNegativeNumber(item.weight, `${field}.weight`, problems),
    } satisfies FormalWorkloadDefinition];
  });
  return { schema_version: FORMAL_EVALUATOR_SCHEMA_VERSION, workloads };
}

function parseFormalCase(raw: Record<string, unknown>, field: string, problems: string[]): FormalCaseDefinition {
  return {
    case_id: requiredString(raw.case_id, `${field}.case_id`, problems),
    parameters: parseInventoryParameters(raw, field, new Set(['case_id', 'parameters', 'threads']), problems),
    threads: positiveInteger(raw.threads, `${field}.threads`, problems),
  };
}

const RESERVED_COMMAND_ARGUMENTS = new Set([
  'case_id', 'workload_id', 'artifact_path', 'runtime_root', 'phase', 'role', 'iteration_index', 'threads',
]);

/**
 * New bundles use an explicit `parameters` mapping. For already-qualified v1
 * bundles, every non-metadata scalar field is normalized into that same map.
 */
function parseInventoryParameters(
  raw: Record<string, unknown>,
  field: string,
  metadata: ReadonlySet<string>,
  problems: string[],
): Record<string, EvaluatorParameter> {
  const explicit = raw.parameters;
  const source = explicit === undefined ? raw : record(explicit, `${field}.parameters`, problems) ?? {};
  const output: Record<string, EvaluatorParameter> = {};
  for (const [name, value] of Object.entries(source)) {
    if (explicit === undefined && metadata.has(name)) continue;
    if (explicit !== undefined && RESERVED_COMMAND_ARGUMENTS.has(name)) {
      problems.push(`${field}.parameters.${name} conflicts with a reserved evaluator argument`);
      continue;
    }
    if (explicit !== undefined && metadata.has(name)) {
      problems.push(`${field}.parameters.${name} conflicts with inventory metadata`);
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) problems.push(`${field}.parameters.${name} must be finite`);
      else output[name] = value;
    } else if (typeof value === 'string' || typeof value === 'boolean') {
      output[name] = value;
    } else {
      problems.push(`${field}.parameters.${name} must be a string, number, or boolean`);
    }
  }
  if (explicit !== undefined) {
    for (const name of Object.keys(raw)) {
      if (!metadata.has(name)) problems.push(`${field}.${name} must be placed under ${field}.parameters`);
    }
  } else {
    for (const name of Object.keys(output)) {
      if (RESERVED_COMMAND_ARGUMENTS.has(name)) {
        problems.push(`${field}.${name} conflicts with a reserved evaluator argument`);
        delete output[name];
      }
    }
  }
  return output;
}

function validateQualification(
  manifest: FormalEvaluatorManifest,
  qualification: EvaluatorQualificationRecord,
  observedDigest: string,
  requireQualified: boolean,
  allowTargetValidatedDigest: string | undefined,
  problems: string[],
): void {
  if (qualification.evaluator_id !== manifest.evaluator_id || qualification.version !== manifest.version) {
    problems.push('qualification identity differs from manifest identity');
  }
  if (qualification.subject_digest !== manifest.digest || (observedDigest && qualification.subject_digest !== observedDigest)) {
    problems.push(`qualification subject_digest mismatch: expected ${observedDigest || manifest.digest}, got ${qualification.subject_digest}`);
  }
  if (qualification.target.platform !== manifest.target.platform ||
      qualification.target.build_target !== manifest.target.build_target ||
      qualification.target.compatibility_scope !== manifest.target.compatibility_scope) {
    problems.push('qualification target identity differs from manifest target identity');
  }
  if (qualification.owner !== manifest.owner) problems.push('qualification owner differs from manifest owner');
  const ids = qualification.checks.map((item) => item.check_id);
  if (new Set(ids).size !== ids.length) problems.push('qualification check ids must be unique');
  if (manifest.qualification.requires_target_qualification && !qualification.checks.some((item) => item.scope === 'TARGET')) {
    problems.push('qualification record is missing target checks');
  }
  const hasPassedTargetRun = qualification.qualification_run.result === 'TARGET_EXECUTION_PASSED';
  if (hasPassedTargetRun || qualification.status === 'TARGET_VALIDATED' || qualification.status === 'QUALIFIED') {
    if (!qualification.qualification_run.run_id || !qualification.qualification_run.started_at || !qualification.qualification_run.completed_at) {
      problems.push('target-validated qualification requires complete qualification run identity');
    }
    if (!qualification.target.machine_identity_sha256) problems.push('target-validated qualification requires machine identity');
    if (!qualification.evidence.report_sha256 || !qualification.evidence.raw_measurements_sha256) {
      problems.push('target-validated qualification requires report and raw measurement identities');
    }
  }
  if ((qualification.status === 'TARGET_VALIDATED' || qualification.status === 'QUALIFIED') && !hasPassedTargetRun) {
    problems.push(`${qualification.status} qualification requires TARGET_EXECUTION_PASSED`);
  }
  if (qualification.status === 'TARGET_VALIDATED' && qualification.checks.some((item) => item.status !== 'PASS')) {
    problems.push('a TARGET_VALIDATED evaluator must have PASS for every qualification check');
  }
  if (qualification.status === 'QUALIFIED' && qualification.checks.some((item) => item.status !== 'PASS')) {
    problems.push('a QUALIFIED evaluator must have PASS for every qualification check');
  }
  if (qualification.status === 'QUALIFIED' && manifest.qualification.requires_owner_approval &&
      (!qualification.reviewer || !qualification.approved_at)) {
    problems.push('a QUALIFIED evaluator requires explicit reviewer approval and approved_at');
  }
  if (qualification.status !== 'QUALIFIED' && (qualification.reviewer !== null || qualification.approved_at !== null)) {
    problems.push('reviewer approval fields are only valid for QUALIFIED status');
  }
  const exactTargetValidatedBootstrap = qualification.status === 'TARGET_VALIDATED' &&
    typeof allowTargetValidatedDigest === 'string' &&
    /^[0-9a-f]{64}$/i.test(allowTargetValidatedDigest) &&
    allowTargetValidatedDigest.toLowerCase() === qualification.subject_digest;
  if (requireQualified && qualification.status !== 'QUALIFIED' && !exactTargetValidatedBootstrap) {
    problems.push(`formal execution requires QUALIFIED evaluator; attestation status is ${qualification.status}`);
  }
}

function validateInventories(
  manifest: FormalEvaluatorManifest,
  correctness: FormalCorrectnessInventory,
  workloads: FormalWorkloadInventory,
  problems: string[],
): void {
  exactIds(manifest.correctness.case_ids, correctness.cases.map((item) => item.case_id), 'correctness case', problems);
  exactIds(manifest.performance.workload_ids, workloads.workloads.map((item) => item.workload_id), 'performance workload', problems);
  for (const item of [...correctness.cases, ...workloads.workloads]) {
    if (!manifest.resource_requirements.thread_counts.includes(item.threads)) {
      problems.push(`resource thread_counts does not include ${item.threads}`);
    }
  }
  validateArgumentCoverage(
    manifest.correctness.command.arguments,
    correctness.cases.map((item) => ({ id: item.case_id, parameters: item.parameters })),
    new Set(['case_id', 'artifact_path', 'runtime_root', 'threads']),
    'correctness',
    problems,
  );
  validateArgumentCoverage(
    manifest.performance.command.arguments,
    workloads.workloads.map((item) => ({ id: item.workload_id, parameters: item.parameters })),
    new Set(['phase', 'role', 'workload_id', 'artifact_path', 'iteration_index', 'runtime_root', 'threads']),
    'performance',
    problems,
  );
}

function validateArgumentCoverage(
  argumentNames: readonly string[],
  items: readonly { id: string; parameters: Readonly<Record<string, EvaluatorParameter>> }[],
  reserved: ReadonlySet<string>,
  label: string,
  problems: string[],
): void {
  if (new Set(argumentNames).size !== argumentNames.length) problems.push(`${label} command arguments must be unique`);
  for (const name of reserved) {
    if (!argumentNames.includes(name)) problems.push(`${label} command arguments must include reserved argument '${name}'`);
  }
  for (const item of items) {
    for (const name of argumentNames) {
      if (!reserved.has(name) && !(name in item.parameters)) {
        problems.push(`${label} '${item.id}' does not define command argument '${name}'`);
      }
    }
  }
}

function exactIds(declared: readonly string[], inventory: readonly string[], label: string, problems: string[]): void {
  if (new Set(declared).size !== declared.length) problems.push(`manifest ${label} ids contain duplicates`);
  if (new Set(inventory).size !== inventory.length) problems.push(`${label} inventory contains duplicates`);
  if (JSON.stringify(declared) !== JSON.stringify(inventory)) problems.push(`manifest ${label} ids do not exactly match inventory order and content`);
}

function validatePoliciesAndScripts(root: string, manifest: FormalEvaluatorManifest, problems: string[]): void {
  for (const [name, command, policyFile] of [
    ['correctness', manifest.correctness.command, 'correctness/policy.json'],
    ['performance', manifest.performance.command, 'benchmark/policy.json'],
  ] as const) {
    if (!safeRelativePath(command.script)) {
      problems.push(`${name} command script must stay inside the evaluator bundle`);
      continue;
    }
    const scriptPath = path.join(root, ...command.script.split('/'));
    if (!fs.existsSync(scriptPath)) {
      problems.push(`${name} command script is missing: ${command.script}`);
      continue;
    }
    const marker = fs.readFileSync(scriptPath, 'utf8').match(/PHYOPT_ARGUMENT_CONTRACT:\s*([^\r\n]+)/)?.[1]
      ?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
    if (JSON.stringify(marker) !== JSON.stringify(command.arguments)) problems.push(`${name} script argument contract differs from manifest`);
    const policy = readBundleJson(root, policyFile, problems);
    const policyRecord = record(policy, `${name} policy`, problems);
    if (policyRecord) {
      const policyArgs = stringArray(policyRecord.argument_contract, `${name} policy.argument_contract`, problems, true);
      if (JSON.stringify(policyArgs) !== JSON.stringify(command.arguments)) problems.push(`${name} policy argument contract differs from manifest`);
    }
    if (command.measurement_prefix !== 'PHYOPT_MEASUREMENT') problems.push(`${name} measurement prefix is not Runner-compatible`);
  }
}

function validateOutputSchema(root: string, manifest: FormalEvaluatorManifest, problems: string[]): void {
  const schema = record(readBundleJson(root, manifest.performance.measurement.output_schema, problems), 'benchmark output schema', problems);
  if (!schema) return;
  if (schema.line_prefix !== 'PHYOPT_MEASUREMENT') problems.push('benchmark output schema line_prefix must be PHYOPT_MEASUREMENT');
  const required = ['kind', 'role', 'subject_id', 'sample_index', 'value', 'unit', 'validity', 'domain_payload'];
  const fields = stringArray(schema.required_fields, 'benchmark output schema.required_fields', problems, true);
  if (JSON.stringify(fields) !== JSON.stringify(required)) problems.push('benchmark output schema required_fields differs from Runner measurement contract');
}

function validateNoMutableDependencies(root: string, problems: string[]): void {
  for (const relative of bundleFiles(root)) {
    if (!/\.(?:json|sh|c|h)$/i.test(relative)) continue;
    const text = fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
    for (const pattern of FORBIDDEN_MUTABLE_REFERENCES) {
      if (pattern.test(text)) problems.push(`bundle file has a legacy or host-specific mutable dependency: ${relative}`);
    }
  }
}

function bundleFiles(root: string, current = root): string[] {
  if (!fs.existsSync(current)) throw new Error(`evaluator bundle directory does not exist: ${root}`);
  if (!fs.statSync(current).isDirectory()) throw new Error(`evaluator bundle path is not a directory: ${root}`);
  const output: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed in evaluator bundle: ${absolute}`);
    if (entry.isDirectory()) output.push(...bundleFiles(root, absolute));
    else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`unsupported evaluator bundle entry: ${absolute}`);
  }
  return output.sort();
}

function readBundleJson(root: string, relative: string, problems: string[]): unknown {
  if (!safeRelativePath(relative)) {
    problems.push(`bundle JSON path must be relative and contained: ${relative}`);
    return null;
  }
  const absolute = path.join(root, ...relative.split('/'));
  try { return readJsonFile(absolute, relative); }
  catch (error) { problems.push((error as Error).message); return null; }
}

function readJsonFile(absolute: string, label: string): unknown {
  let raw: string;
  try { raw = fs.readFileSync(absolute, 'utf8'); }
  catch (error) { throw new Error(`cannot read ${label}: ${(error as Error).message}`); }
  try { return JSON.parse(raw) as unknown; }
  catch (error) { throw new Error(`invalid JSON in ${label}: ${(error as Error).message}`); }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const raw = value as Record<string, unknown>;
  return `{${Object.keys(raw).sort().map((key) => `${JSON.stringify(key)}:${stableJson(raw[key])}`).join(',')}}`;
}

function safeRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const normalized = value.replace(/\\/g, '/');
  return !normalized.split('/').some((part) => part === '..' || part === '');
}

function record(value: unknown, field: string, problems: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${field} must be an object`);
    return null;
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, problems: string[]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${field} must be a non-empty string`);
    return '';
  }
  return value;
}

function nullableString(value: unknown, field: string, problems: string[]): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${field} must be null or a non-empty string`);
    return null;
  }
  return value;
}

function sha256String(value: unknown, field: string, problems: string[]): string {
  const output = requiredString(value, field, problems).toLowerCase();
  if (output && !/^[0-9a-f]{64}$/.test(output)) problems.push(`${field} must be a SHA-256 digest`);
  return output;
}

function nullableSha256(value: unknown, field: string, problems: string[]): string | null {
  const output = nullableString(value, field, problems)?.toLowerCase() ?? null;
  if (output && !/^[0-9a-f]{64}$/.test(output)) problems.push(`${field} must be null or a SHA-256 digest`);
  return output;
}

function requiredTrue(value: unknown, field: string, problems: string[]): true {
  if (value !== true) problems.push(`${field} must be true`);
  return true;
}

function stringArray(value: unknown, field: string, problems: string[], nonEmpty: boolean): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    problems.push(`${field} must contain only non-empty strings`);
    return [];
  }
  if (nonEmpty && value.length === 0) problems.push(`${field} must not be empty`);
  return [...value] as string[];
}

function numberArray(value: unknown, field: string, problems: string[], nonEmpty: boolean): number[] {
  if (!Array.isArray(value) || !value.every((item) => Number.isInteger(item) && (item as number) > 0)) {
    problems.push(`${field} must contain only positive integers`);
    return [];
  }
  if (nonEmpty && value.length === 0) problems.push(`${field} must not be empty`);
  return [...value] as number[];
}

function finiteNumber(value: unknown, field: string, problems: string[]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${field} must be a finite number`);
    return 0;
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string, problems: string[]): number {
  const output = finiteNumber(value, field, problems);
  if (output < 0) problems.push(`${field} must be non-negative`);
  return output;
}

function integer(value: unknown, field: string, problems: string[]): number {
  if (!Number.isInteger(value)) {
    problems.push(`${field} must be an integer`);
    return 0;
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string, problems: string[]): number {
  const output = integer(value, field, problems);
  if (output < 0) problems.push(`${field} must be non-negative`);
  return output;
}

function positiveInteger(value: unknown, field: string, problems: string[]): number {
  const output = integer(value, field, problems);
  if (output < 1) problems.push(`${field} must be positive`);
  return output;
}
