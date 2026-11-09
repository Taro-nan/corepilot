import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import type { ProjectRecord } from '../contracts/project.js';
import type { ValidationAssetDraft, ValidationAssetEdit, ValidationGenerationScope, ValidationSourceFile, CorrectnessPlanProposal, ValidationGenerationOutcome } from '../contracts/validation-assets.js';
import type { FormalEvaluatorManifest } from '../contracts/formal-evaluator.js';
import type { BinaryBundleBaselineDefinition, LibraryPackageManifest } from '../contracts/library-package.js';
import { validateBinaryBundleBaselineDefinition } from '../library-package/loader.js';
import { evaluatorContentSha256, loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import { LibraryPackageLoader } from '../library-package/loader.js';
import { createPiModels, createPiToolSubmissionStream, COREPILOT_PI_PROVIDER_ID } from '../model/pi-provider.js';
import { FORMAL_EVALUATOR_DIGEST_ALGORITHM } from '../contracts/formal-evaluator.js';
import { MEASUREMENT_PREFIX } from '../evaluator/measurement-protocol.js';
import { parseValidationInputs } from '../evaluator/validation-inputs.js';
import { createModelTransport } from '../model/model-transport.js';
import { resolveOptimizationApiKey, resolveOptimizationProxy, type OptimizationConfig } from '../config/optimization-config.js';
import { RepositoryInspector } from '../onboarding/repository-inspector.js';
import { parseValidationTestPlan, readValidationTestPlan, TEST_PLAN_FILE } from '../evaluator/validation-test-plan.js';
import { expandValidationInputs, validationInputRows } from '../evaluator/execution-matrix.js';
import type { ExecutionMachineService } from './execution-machine-service.js';
import { validationGenerationContext, validationGenerationPrompt, validationFunctionEvidence, validationBaselineHeaders, validationSourceCommit } from './validation-generation.js';
import { snapshotValidationAssets, archiveValidationAssets, validationAssetFiles } from './validation-asset-files.js';
import { runPiAgentRuntime, type AgentTool } from '../agent/pi-agent-runtime.js';
import { ValidationGenerationRuns, ValidationGenerationNeedsInput, type ValidationGenerationControl } from './validation-generation-runs.js';
import { validationGenerationBlockers } from './validation-generation.js';
import { observeGenerationModel } from '../model/generation-observer.js';
import { generatedTestEntrypoint, VALIDATION_PYTHON_HARNESS } from './validation-python-harness.js';
import { checkGeneratedPython } from './validation-code-check.js';
import { correctnessPlanPrompt, correctnessPlanToolSchema, generatedCorrectnessSchema } from './correctness-plan-proposal.js';
import { generatedCorrectnessConditions } from './generated-correctness-conditions.js';
import { generatedPerformanceConditions, generatedPerformanceSchema } from './generated-performance-conditions.js';
import { parseValidationQuality, readValidationQuality, QUALITY_PLAN_FILE } from '../evaluator/validation-quality.js';

const CORRECTNESS_ARGS = 'case_id,artifact_path,threads,runtime_root';
const PERFORMANCE_ARGS = 'phase,role,workload_id,artifact_path,iteration_index,threads,runtime_root';
const TEST_PACKAGE_README = `# CorePilot test package

This is a versioned evaluator draft, not automatic qualification or optimization evidence.
test-plan.json contains user-owned CPU/NUMA, sampling, seed, inner iterations, timing scope and API mappings.
correctness/cases.json and benchmark/workloads.json contain the exact inputs and thread counts.
correctness/input-generation.json, when present, contains deterministic data recipes keyed by logical input ID.
benchmark/input-generation.json contains equivalent performance input recipes for both library roles.
manifest.json contains the oracle/tolerance and resource/sampling contract. support/ contains test sources.

CorePilot CLI and browser submit this same package to Runner RPC; use project trial --compare to compare both libraries.
Runner applies taskset, NUMA CPU/memory binding and thread environment. It executes build-evaluator.sh before tests.
COREPILOT_TEST_ASSETS_ROOT points to this immutable directory; the runtime_root argument is the writable build/output directory.
COREPILOT_TEST_SEED, COREPILOT_INNER_ITERATIONS and COREPILOT_TIMING_SCOPE carry the exact saved settings.

Script positional arguments:
- scripts/build-evaluator.sh: runtime_root
- scripts/run-correctness.sh: case_id artifact_path threads runtime_root
- scripts/run-performance.sh: phase role workload_id artifact_path iteration_index threads runtime_root

phase is warmup or sample, role is BASELINE or CANDIDATE. Both roles use the same seed, inputs and measurement method.
Report positive seconds per call, dividing the timed inner loop by inner_iterations. Input preparation/conversion
is excluded for kernel timing and included for end-to-end timing. Warmup must not emit retained samples.
Measurements use one COREPILOT_MEASUREMENT JSON line per case/sample with exact inventory parameters,
artifact_identity (sha256, input_path, resolved_symbol_path) and evaluator_binary_identity/benchmark_identity.
CPU/thread/NUMA enforcement and actual command logs remain independently recorded by Runner.
`;

function json<T>(filename: string): T { return JSON.parse(fs.readFileSync(filename, 'utf8')) as T; }
function encoded(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function content(value: unknown, label: string, max = 96_000): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be text under ${max} characters`);
  return value;
}
function script(value: unknown, label: string, args: string): string {
  const body = content(value, label).trim();
  if (!body) throw new Error(`${label} is required`);
  return `#!/bin/sh\n: COREPILOT_ARGUMENT_CONTRACT: ${args}\n${body.replace(/^#![^\n]*\n?/, '').replace(/^:\s*[A-Z][A-Z0-9_]*_ARGUMENT_CONTRACT:[^\n]*\n?/m, '')}\n`;
}
function relativeArtifact(value: unknown): string {
  const artifact = content(value, 'candidate_artifact', 500).trim().replaceAll('\\', '/');
  if (!artifact || artifact.startsWith('/') || /^[A-Za-z]:/.test(artifact) || artifact.split('/').includes('..') || artifact.includes('\0')) {
    throw new Error('candidate_artifact must be a path relative to the source root');
  }
  return artifact;
}
function parsedEdit(value: unknown, previous?: Pick<ValidationAssetDraft, 'cases' | 'workloads'>): ValidationAssetEdit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('validation asset edit must be an object');
  const item = value as Record<string, unknown>;
  if (!['ai', 'uploaded', 'edited'].includes(String(item.source))) throw new Error('source must be ai, uploaded or edited');
  if (typeof item.expected_digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.expected_digest)) throw new Error('expected_digest is required');
  const absolute = item.tolerance_absolute;
  const relative = item.tolerance_relative;
  if (typeof absolute !== 'number' || !Number.isFinite(absolute) || absolute < 0 ||
      typeof relative !== 'number' || !Number.isFinite(relative) || relative < 0) throw new Error('tolerances must be non-negative numbers');
  const cases = parseValidationInputs(item.cases, 'cases', previous?.cases);
  return {
    source: item.source as ValidationAssetEdit['source'], expected_digest: item.expected_digest,
    correctness_script: script(item.correctness_script, 'correctness_script', CORRECTNESS_ARGS),
    performance_script: script(item.performance_script, 'performance_script', PERFORMANCE_ARGS),
    cases, workloads: parseValidationInputs(item.workloads, 'workloads', previous?.workloads),
    oracle_description: content(item.oracle_description, 'oracle_description', 10_000).trim() || 'UNKNOWN_REVIEW_REQUIRED',
    benchmark_description: content(item.benchmark_description, 'benchmark_description', 10_000).trim() || 'UNKNOWN_REVIEW_REQUIRED',
    tolerance_rule: content(item.tolerance_rule, 'tolerance_rule', 2_000).trim() || 'UNKNOWN_REVIEW_REQUIRED',
    tolerance_absolute: absolute, tolerance_relative: relative,
    candidate_artifact: relativeArtifact(item.candidate_artifact),
    ...(item.test_plan === undefined ? {} : { test_plan: parseValidationTestPlan(item.test_plan) }),
    ...(item.setup_script === undefined ? {} : { setup_script: script(item.setup_script, 'setup_script', 'runtime_root') }),
    ...(item.supporting_files === undefined ? {} : { supporting_files: parseSupportingFiles(item.supporting_files) }),
    ...(item.generation_notes === undefined ? {} : { generation_notes: content(item.generation_notes, 'generation_notes', 6000) }),
    ...(item.quality === undefined ? {} : { quality: parseValidationQuality(item.quality, cases.map(row => row.case_id)) }),
  };
}

function parseSupportingFiles(value: unknown): ValidationSourceFile[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('测试支持文件最多 32 份');
  const paths = new Set<string>();
  let bytes = 0;
  return value.map(file => {
    if (!file || typeof file.path !== 'string' || !/^support\/[A-Za-z0-9_./+-]+$/.test(file.path) ||
        file.path.split('/').some((part: string) => !part || part === '.' || part === '..') || paths.has(file.path)) {
      throw new Error('测试支持文件需要唯一的 support/ 相对路径');
    }
    const body = content(file.content, file.path, 200_000);
    bytes += Buffer.byteLength(body);
    if (bytes > 500_000) throw new Error('测试支持文件总计不能超过 500 KB');
    paths.add(file.path);
    return { path: file.path, content: body };
  });
}

export class ValidationAssetsService {
  private readonly catalog: string;
  readonly generations: ValidationGenerationRuns;
  constructor(private readonly dataDir: string, private readonly machines?: ExecutionMachineService) {
    this.catalog = path.join(dataDir, 'catalog'); this.generations = new ValidationGenerationRuns(dataDir);
  }

  private target(project: ProjectRecord, packageId: string, version: string, targetId: string) {
    if (packageId !== `project-${project.project_id.slice(0, 8)}`) throw new Error('this project can only edit its own generated package');
    const resolved = new LibraryPackageLoader({ catalogRoot: this.catalog }).resolveSelection({ package_id: packageId, package_version: version, target_id: targetId });
    const expectedRoot = path.resolve(this.catalog, 'packages', packageId, version);
    if (resolved.loaded.root !== expectedRoot) throw new Error('package is not a project-owned draft');
    return resolved;
  }

  get(project: ProjectRecord, packageId: string, version: string, targetId: string): ValidationAssetDraft {
    const resolved = this.target(project, packageId, version, targetId);
    const root = resolved.bundle.root;
    const history = path.join(resolved.loaded.root, 'onboarding', `validation-${targetId}.json`);
    const source = fs.existsSync(history) ? json<{ source: ValidationAssetDraft['source'] }>(history).source : 'placeholder';
    const generationFile = path.join(root, 'correctness/input-generation.json');
    const inputGeneration = fs.existsSync(generationFile) ? json<{ inputs: Record<string, string> }>(generationFile).inputs : {};
    const performanceGenerationFile = path.join(root, 'benchmark/input-generation.json');
    const performanceGeneration = fs.existsSync(performanceGenerationFile) ? json<{ inputs: Record<string, string> }>(performanceGenerationFile).inputs : {};
    const quality = readValidationQuality(root, resolved.bundle.correctness.cases);
    const baselineSource = resolved.target.domain_payload.baseline_source as { kind?: string; detail?: string } | undefined;
    const draft: ValidationAssetDraft = {
      package_id: packageId, package_version: version, target_id: targetId, function_name: resolved.functionDefinition.api,
      evaluator_id: resolved.bundle.manifest.evaluator_id, evaluator_digest: resolved.bundle.content_digest,
      qualification: resolved.bundle.qualification.status, source,
      comparison_baseline: { library: resolved.target.artifacts.baseline.library, version: resolved.target.artifacts.baseline.version,
        sha256: resolved.target.artifacts.baseline.sha256, source_kind: baselineSource?.kind ?? 'unknown',
        ...(baselineSource?.detail ? { source_detail: baselineSource.detail } : {}) },
      correctness_script: fs.readFileSync(path.join(root, 'scripts', 'run-correctness.sh'), 'utf8'),
      performance_script: fs.readFileSync(path.join(root, 'scripts', 'run-performance.sh'), 'utf8'),
      cases: validationInputRows(resolved.bundle.correctness.cases).map(item => ({ ...item,
        ...(Object.hasOwn(inputGeneration, item.case_id) ? { input_generation: inputGeneration[item.case_id] } : {}) })),
      workloads: validationInputRows(resolved.bundle.workloads.workloads).map(item => ({ ...item,
        ...(Object.hasOwn(performanceGeneration, item.workload_id) ? { input_generation: performanceGeneration[item.workload_id] } : {}) })),
      oracle_description: fs.readFileSync(path.join(root, 'correctness', 'oracle-proposal.txt'), 'utf8'),
      benchmark_description: fs.readFileSync(path.join(root, 'benchmark', 'benchmark-proposal.txt'), 'utf8'),
      tolerance_rule: resolved.bundle.manifest.correctness.tolerance.rule,
      tolerance_absolute: resolved.bundle.manifest.correctness.tolerance.absolute,
      tolerance_relative: resolved.bundle.manifest.correctness.tolerance.relative,
      candidate_artifact: resolved.target.artifacts.candidate.relative_path,
      test_plan: readValidationTestPlan(root, resolved.bundle.manifest, resolved.functionDefinition.api),
      setup_script: fs.existsSync(path.join(root, 'scripts/build-evaluator.sh'))
        ? fs.readFileSync(path.join(root, 'scripts/build-evaluator.sh'), 'utf8') : '#!/bin/sh\nset -eu\nmkdir -p -- "$1"\n',
      supporting_files: fs.existsSync(path.join(root, 'supporting-files.json'))
        ? json<string[]>(path.join(root, 'supporting-files.json')).map(relative => ({ path: relative, content: fs.readFileSync(path.join(root, relative), 'utf8') })) : [],
      ...(quality ? { quality } : {}),
    };
    return { ...draft, correctness_generation_blockers: validationGenerationBlockers(draft, 'correctness') };
  }

  save(project: ProjectRecord, packageId: string, version: string, targetId: string, input: unknown,
    review?: { generation_id: string; source_commit: string | null }): ValidationAssetDraft {
    const resolved = this.target(project, packageId, version, targetId);
    if (!['DRAFT', 'REVIEWED'].includes(resolved.loaded.manifest.qualification.state) || resolved.bundle.qualification.status !== 'DRAFT') {
      throw new Error('only an unqualified project draft can be edited; create a new version for reviewed assets');
    }
    const before = this.get(project, packageId, version, targetId);
    const edit = parsedEdit(input, before);
    if (resolved.bundle.content_digest !== edit.expected_digest) throw new Error('validation draft changed; reload it before saving');
    const root = resolved.bundle.root;
    const packageRoot = resolved.loaded.root;
    const namespaces = [resolved.bundle.manifest.correctness.command.measurement_prefix,
      resolved.bundle.manifest.performance.command.measurement_prefix].map(prefix => prefix.slice(0, -'_MEASUREMENT'.length));
    const normalizeProtocol = (content: string): string => namespaces.reduce((text, namespace) => namespace === 'COREPILOT' ? text
      : text.replace(new RegExp(`\\b${namespace}_(MEASUREMENT|ARGUMENT_CONTRACT|DECLARED_CPU_SET|DECLARED_NUMA_NODE|RESOURCE_ENFORCEMENT|ARTIFACT_SHA256|HARNESS_SHA256)\\b`, 'g'), 'COREPILOT_$1'), content);
    edit.correctness_script = normalizeProtocol(edit.correctness_script);
    edit.performance_script = normalizeProtocol(edit.performance_script);
    const testPlan = edit.test_plan ?? before.test_plan;
    const expandedCases = expandValidationInputs(edit.cases.map(({ input_generation: _recipe, ...item }) => item), testPlan),
      expandedWorkloads = expandValidationInputs(edit.workloads.map(({ input_generation: _recipe, ...item }) => item), testPlan);
    const commandCount = 2 + expandedCases.length + expandedWorkloads.length * 2 * (testPlan.sampling.warmup_count + testPlan.sampling.sample_count);
    if (commandCount > 2048) throw new Error(`当前组合将执行 ${commandCount} 条命令，超过 2048；请减少输入、线程、绑核方案或采样次数`);
    const support = (edit.supporting_files ?? before.supporting_files).map(file => ({ ...file, content: normalizeProtocol(file.content) }));
    this.snapshot(project, packageId, version, targetId);
    const files = new Map<string, string>([
      [path.join(root, 'scripts/run-correctness.sh'), edit.correctness_script],
      [path.join(root, 'scripts/run-performance.sh'), edit.performance_script],
      [path.join(root, 'correctness/cases.json'), encoded({ schema_version: 1, cases: expandedCases })],
      [path.join(root, 'benchmark/workloads.json'), encoded({ schema_version: 1, workloads: expandedWorkloads })],
      [path.join(root, 'correctness/oracle-proposal.txt'), edit.oracle_description + '\n'],
      [path.join(root, 'benchmark/benchmark-proposal.txt'), edit.benchmark_description + '\n'],
      [path.join(root, TEST_PLAN_FILE), encoded(testPlan)],
      [path.join(root, 'scripts/build-evaluator.sh'), normalizeProtocol(edit.setup_script ?? before.setup_script)],
      [path.join(root, 'supporting-files.json'), encoded(support.map(file => file.path))],
      [path.join(root, 'README.md'), TEST_PACKAGE_README],
      ...support.map(file => [path.join(root, file.path), file.content] as [string, string]),
    ]);
    const quality = edit.quality ?? before.quality;
    if (quality) files.set(path.join(root, QUALITY_PLAN_FILE), encoded(parseValidationQuality(quality, edit.cases.map(row => row.case_id))));
    const generationFile = path.join(root, 'correctness/input-generation.json');
    const recipes = Object.fromEntries(edit.cases.filter(item => item.input_generation).map(item => [item.case_id, item.input_generation]));
    if (Object.keys(recipes).length || fs.existsSync(generationFile)) files.set(generationFile, encoded({ schema_version: 1, inputs: recipes }));
    const performanceGenerationFile = path.join(root, 'benchmark/input-generation.json');
    const performanceRecipes = Object.fromEntries(edit.workloads.filter(item => item.input_generation).map(item => [item.workload_id, item.input_generation]));
    if (Object.keys(performanceRecipes).length || fs.existsSync(performanceGenerationFile)) files.set(performanceGenerationFile, encoded({ schema_version: 1, inputs: performanceRecipes }));
    const evaluatorManifest = structuredClone(resolved.bundle.manifest) as FormalEvaluatorManifest;
    evaluatorManifest.digest_algorithm = FORMAL_EVALUATOR_DIGEST_ALGORITHM;
    evaluatorManifest.correctness.command.measurement_prefix = MEASUREMENT_PREFIX;
    evaluatorManifest.performance.command.measurement_prefix = MEASUREMENT_PREFIX;
    const outputSchemaPath = path.join(root, evaluatorManifest.performance.measurement.output_schema);
    files.set(outputSchemaPath, encoded({ ...json<Record<string, unknown>>(outputSchemaPath), line_prefix: MEASUREMENT_PREFIX }));
    evaluatorManifest.correctness.case_ids = expandedCases.map(item => item.case_id);
    evaluatorManifest.performance.workload_ids = expandedWorkloads.map(item => item.workload_id);
    evaluatorManifest.correctness.tolerance = { ...evaluatorManifest.correctness.tolerance, rule: edit.tolerance_rule,
      absolute: edit.tolerance_absolute, relative: edit.tolerance_relative };
    evaluatorManifest.correctness.definition = edit.oracle_description;
    evaluatorManifest.performance.definition = edit.benchmark_description;
    evaluatorManifest.performance.sampling.warmup_count = testPlan.sampling.warmup_count;
    evaluatorManifest.performance.sampling.sample_count = testPlan.sampling.sample_count;
    evaluatorManifest.resource_requirements.cpu_set = testPlan.execution_matrix?.profiles[0].cpu_set ?? (testPlan.resources.cpu_set || 'UNKNOWN_REVIEW_REQUIRED');
    evaluatorManifest.resource_requirements.numa_node = testPlan.execution_matrix?.profiles[0].numa_node ?? testPlan.resources.numa_node;
    evaluatorManifest.resource_requirements.thread_counts = [...new Set([...expandedCases, ...expandedWorkloads].map(item => item.threads))].sort((a, b) => a - b);
    files.set(path.join(root, 'manifest.json'), encoded(evaluatorManifest));
    const packageManifest = structuredClone(resolved.loaded.manifest) as LibraryPackageManifest;
    const target = packageManifest.targets.find(item => item.target_id === targetId)!;
    target.artifacts.candidate.relative_path = edit.candidate_artifact;
    target.development_benchmark.workload_ids = expandedWorkloads.map(item => item.workload_id);
    const qualification = structuredClone(resolved.bundle.qualification);
    const reviewPath = review ? path.join(packageRoot, 'onboarding', `correctness-plan-review-${review.generation_id}.json`) : null;
    if (reviewPath) files.set(reviewPath, '');
    const removed = before.supporting_files.filter(file => !support.some(next => next.path === file.path)).map(file => path.join(root, file.path));
    const originals = new Map([...files.keys(), ...removed, path.join(root, 'qualification.json'), path.join(packageRoot, 'package.json')]
      .map(filename => [filename, fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : null]));
    try {
      for (const [filename, value] of files) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, value); }
      for (const filename of removed) fs.rmSync(filename);
      evaluatorManifest.digest = evaluatorContentSha256(root);
      fs.writeFileSync(path.join(root, 'manifest.json'), encoded(evaluatorManifest));
      qualification.subject_digest = evaluatorManifest.digest;
      qualification.updated_at = new Date().toISOString();
      fs.writeFileSync(path.join(root, 'qualification.json'), encoded(qualification));
      packageManifest.formal_evaluators.find(item => item.evaluator_id === evaluatorManifest.evaluator_id)!.digest = evaluatorManifest.digest;
      fs.writeFileSync(path.join(packageRoot, 'package.json'), encoded(packageManifest));
      loadFormalEvaluatorBundle(root);
      new LibraryPackageLoader({ catalogRoot: this.catalog }).resolveSelection({ package_id: packageId, package_version: version, target_id: targetId });
      if (reviewPath && review) fs.writeFileSync(reviewPath, encoded({ ...review, decision: 'ADOPT_DRAFT_PLAN',
        reviewed_at: new Date().toISOString(), previous_digest: before.evaluator_digest, accepted_digest: evaluatorManifest.digest }), { mode: 0o600 });
    } catch (error) {
      for (const [filename, value] of originals) { if (value === null) fs.rmSync(filename, { force: true }); else fs.writeFileSync(filename, value); }
      throw error;
    }
    const history = path.join(packageRoot, 'onboarding', `validation-${targetId}.json`);
    fs.writeFileSync(history, encoded({ source: edit.source, updated_at: new Date().toISOString(), evaluator_digest: evaluatorManifest.digest,
      script_sha256: { correctness: sha(edit.correctness_script), performance: sha(edit.performance_script) } }));
    this.snapshot(project, packageId, version, targetId);
    return this.get(project, packageId, version, targetId);
  }

  snapshot(project: ProjectRecord, packageId: string, version: string, targetId: string) {
    const resolved = this.target(project, packageId, version, targetId);
    const destination = path.join(this.dataDir, 'projects', project.project_id, 'validation-versions',
      packageId, version, targetId, resolved.bundle.content_digest);
    return snapshotValidationAssets(resolved.bundle.root, destination, resolved.bundle.content_digest);
  }

  private versionRoot(project: ProjectRecord, packageId: string, version: string, targetId: string, digest?: string) {
    const current = this.get(project, packageId, version, targetId);
    if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid validation version');
    const root = !digest || digest === current.evaluator_digest ? this.snapshot(project, packageId, version, targetId)
      : path.join(this.dataDir, 'projects', project.project_id, 'validation-versions', packageId, version, targetId, digest);
    return root;
  }

  async download(project: ProjectRecord, packageId: string, version: string, targetId: string, digest?: string) {
    const resolved = this.target(project, packageId, version, targetId);
    const current = !digest || digest === resolved.bundle.content_digest;
    return archiveValidationAssets(this.versionRoot(project, packageId, version, targetId, digest), {
      package_id: packageId, package_version: version, target_id: targetId,
      comparison_binding: current ? resolved.target.artifacts.baseline : null,
      note: 'Evaluator content and the selected comparison binding have separate identities. Trial downloads contain the actual submitted binding.' });
  }

  files(project: ProjectRecord, packageId: string, version: string, targetId: string, digest?: string) {
    return validationAssetFiles(this.versionRoot(project, packageId, version, targetId, digest));
  }

  async context(project: ProjectRecord, config: OptimizationConfig, packageId: string, version: string, targetId: string) {
    return validationGenerationContext(project, config, this.target(project, packageId, version, targetId), this.machines);
  }

  /** Freeze one already-built artifact into an unqualified project Package. */
  baselineSelectionKey(project: ProjectRecord, packageId: string, version: string, targetId: string) {
    const resolved = this.target(project, packageId, version, targetId);
    return sha(encoded({ baseline: resolved.target.artifacts.baseline, source: resolved.target.domain_payload.baseline_source ?? null }));
  }

  async bindSingleBaseline(project: ProjectRecord, packageId: string, version: string, targetId: string, input: {
    artifactPath: string; sha256: string; library: string; versionLabel: string;
    source: { kind: 'branch' | 'upload'; detail: string; sourceCommit?: string; machineId?: string | null; trialId?: string };
  }) {
    const resolved = this.target(project, packageId, version, targetId);
    if (!['DRAFT', 'REVIEWED'].includes(resolved.loaded.manifest.qualification.state) || resolved.bundle.qualification.status !== 'DRAFT') {
      throw new Error('只能修改未获资格的项目草稿基线');
    }
    if (!input.library.trim() || !input.versionLabel.trim()) throw new Error('请填写比较库名称和版本');
    if (!fs.statSync(input.artifactPath).isFile()) throw new Error('比较基线必须是普通文件');
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(input.artifactPath)) hash.update(chunk);
    const digest = hash.digest('hex');
    if (digest !== input.sha256.toLowerCase()) throw new Error('比较基线内容在绑定前发生变化');
    const packageManifest = structuredClone(resolved.loaded.manifest) as LibraryPackageManifest;
    const target = packageManifest.targets.find(item => item.target_id === targetId)!;
    target.artifacts.baseline = { id: `baseline-${digest.slice(0, 12)}`, library: input.library.trim(),
      version: input.versionLabel.trim(), sha256: digest };
    target.domain_payload = { ...target.domain_payload, baseline_source: { ...input.source,
      artifact_path: path.resolve(input.artifactPath), imported_at: new Date().toISOString() } };
    const filename = path.join(resolved.loaded.root, 'package.json');
    const before = fs.readFileSync(filename, 'utf8');
    try {
      fs.writeFileSync(filename, encoded(packageManifest));
      this.target(project, packageId, version, targetId);
    } catch (error) { fs.writeFileSync(filename, before); throw error; }
    return { baseline: target.artifacts.baseline, artifact_path: path.resolve(input.artifactPath),
      package_digest: this.target(project, packageId, version, targetId).loaded.content_digest };
  }

  /** Bind an independently checked multi-file package to a DRAFT target. */
  bindBinaryBundle(project: ProjectRecord, packageId: string, version: string, targetId: string, input: {
    library: string; definition: BinaryBundleBaselineDefinition; bundleRoot: string; entryPath: string;
    machineId: string | null; uploadId: string;
  }) {
    const resolved = this.target(project, packageId, version, targetId);
    if (!['DRAFT', 'REVIEWED'].includes(resolved.loaded.manifest.qualification.state) || resolved.bundle.qualification.status !== 'DRAFT') {
      throw new Error('只能修改未获资格的项目草稿基线');
    }
    const definition = validateBinaryBundleBaselineDefinition(input.definition);
    if (definition.state !== 'VERIFIED') throw new Error('依赖闭包尚未在目标机验证通过');
    if (!input.library.trim()) throw new Error('请填写比较库名称');
    const packageRoot = resolved.loaded.root;
    const definitionPath = `baselines/${targetId}-${definition.sha256.slice(0, 12)}.json`;
    const filename = path.join(packageRoot, ...definitionPath.split('/'));
    const manifestPath = path.join(packageRoot, 'package.json');
    const before = fs.readFileSync(manifestPath, 'utf8');
    const existingDefinition = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : null;
    const manifest = structuredClone(resolved.loaded.manifest) as LibraryPackageManifest;
    const target = manifest.targets.find(item => item.target_id === targetId)!;
    target.artifacts.baseline = { id: definition.baseline_id, library: input.library.trim(),
      version: definition.version, sha256: definition.sha256, kind: 'binary_bundle', definition: definitionPath };
    target.domain_payload = { ...target.domain_payload, baseline_source: { kind: 'upload', detail: input.uploadId,
      bundle_root: path.resolve(input.bundleRoot), entry_path: input.entryPath, machine_id: input.machineId,
      imported_at: new Date().toISOString() } };
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    try {
      fs.writeFileSync(filename, encoded(definition));
      fs.writeFileSync(manifestPath, encoded(manifest));
      this.target(project, packageId, version, targetId);
    } catch (error) {
      fs.writeFileSync(manifestPath, before);
      if (existingDefinition === null) fs.rmSync(filename, { force: true });
      else fs.writeFileSync(filename, existingDefinition);
      throw error;
    }
    return { baseline: target.artifacts.baseline,
      artifact_path: path.join(input.bundleRoot, ...input.entryPath.split('/')),
      bundle_root: path.resolve(input.bundleRoot), entry_path: input.entryPath,
      package_digest: this.target(project, packageId, version, targetId).loaded.content_digest };
  }

  startGeneration(project: ProjectRecord, config: OptimizationConfig, packageId: string, version: string, targetId: string, scope: ValidationGenerationScope = 'correctness', purpose: 'TEST_CODE' | 'CORRECTNESS_PLAN' = 'TEST_CODE', instructions = '') {
    if (!['correctness', 'performance', 'both'].includes(scope)) throw new Error('请选择生成正确性、性能或两者的测试代码');
    instructions = content(instructions, 'instructions', 12000).trim();
    const draft = this.get(project, packageId, version, targetId);
    const endpoint = new URL(config.model.endpoint); endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = '';
    const secret = resolveOptimizationApiKey(config).apiKey;
    return this.generations.start({ project_id: project.project_id, package_id: packageId, package_version: version, target_id: targetId,
      evaluator_digest: draft.evaluator_digest, scope, purpose, instructions, model: { endpoint: endpoint.href.replace(/\/$/, ''), requested_model: config.model.model_id, request_count: 0 } },
      control => this.generateCode(project, config, packageId, version, targetId, scope, control, purpose, instructions),
      text => secret ? text.split(secret).join('[redacted]') : text);
  }

  async generate(project: ProjectRecord, config: OptimizationConfig, packageId: string, version: string, targetId: string, scope: ValidationGenerationScope = 'correctness', instructions = ''): Promise<ValidationAssetEdit> {
    const record = this.startGeneration(project, config, packageId, version, targetId, scope, 'TEST_CODE', instructions);
    const result = await this.generations.wait(project.project_id, record.generation_id);
    if ('kind' in result) throw new Error('Expected generated test code');
    return result;
  }

  async proposeCorrectness(project: ProjectRecord, config: OptimizationConfig, packageId: string, version: string, targetId: string, instructions = ''): Promise<CorrectnessPlanProposal> {
    const record = this.startGeneration(project, config, packageId, version, targetId, 'correctness', 'CORRECTNESS_PLAN', instructions);
    const result = await this.generations.wait(project.project_id, record.generation_id);
    if (!('kind' in result)) throw new Error('Expected a correctness plan proposal');
    return result;
  }

  adoptCorrectnessPlan(project: ProjectRecord, packageId: string, version: string, targetId: string, generationId: string, expectedDigest: string): ValidationAssetDraft {
    const record = this.generations.get(project.project_id, generationId);
    if (record.package_id !== packageId || record.package_version !== version || record.target_id !== targetId || record.purpose !== 'CORRECTNESS_PLAN' || record.status !== 'SUCCEEDED' || !record.proposal) throw new Error('请选择当前函数已完成的正确性方案');
    const resolved = this.target(project, packageId, version, targetId);
    const reviewPath = path.join(resolved.loaded.root, 'onboarding', `correctness-plan-review-${generationId}.json`);
    const current = this.get(project, packageId, version, targetId);
    const proposal = record.proposal;
    const sourceCommit = validationSourceCommit(project);
    if (sourceCommit !== proposal.source_commit) throw new Error('源码分支版本已变化，请重新起草方案');
    if (fs.existsSync(reviewPath)) {
      const reviewed = json<{ generation_id: string; accepted_digest: string }>(reviewPath);
      if (reviewed.generation_id === generationId && reviewed.accepted_digest === current.evaluator_digest) return current;
    }
    if (current.evaluator_digest !== expectedDigest || record.evaluator_digest !== current.evaluator_digest) throw new Error('测试条件已变化，请保存当前修改并重新起草方案');
    return this.save(project, packageId, version, targetId, { ...current, source: 'ai', expected_digest: expectedDigest,
      cases: proposal.cases, oracle_description: proposal.oracle_description, tolerance_rule: proposal.tolerance_rule,
      tolerance_absolute: proposal.tolerance_absolute, tolerance_relative: proposal.tolerance_relative },
      { generation_id: generationId, source_commit: sourceCommit });
  }

  private async generateCode(project: ProjectRecord, config: OptimizationConfig, packageId: string, version: string, targetId: string,
    scope: ValidationGenerationScope, control: ValidationGenerationControl, purpose: 'TEST_CODE' | 'CORRECTNESS_PLAN', instructions: string): Promise<ValidationGenerationOutcome> {
    if (!['correctness', 'performance', 'both'].includes(scope)) throw new Error('请选择生成正确性、性能或两者的测试代码');
    const draft = this.get(project, packageId, version, targetId);
    if (draft.qualification !== 'DRAFT') throw new Error('AI can only propose changes to an unqualified draft');
    const planning = purpose === 'CORRECTNESS_PLAN';
    const resolved = this.target(project, packageId, version, targetId);
    const preparation = await this.context(project, config, packageId, version, targetId);
    if (!planning && scope !== 'correctness') {
      if (!preparation.baseline.configured) throw new Error('请先准备并保存比较基线，再生成两库性能测试代码');
      if (!draft.test_plan.execution_matrix && !draft.test_plan.resources.cpu_set) throw new Error('请先保存 CPU 集合、NUMA、负载和采样条件');
      if (!draft.test_plan.baseline_api || !draft.test_plan.candidate_api) throw new Error('请先填写并保存两端 API 名称');
    }
    const inspector = new RepositoryInspector(project.repository_root);
    const inspection = inspector.inspect();
    const functionEvidence = inspection.functions.find(item => item.symbol === draft.function_name);
    const sourceCommit = validationSourceCommit(project);
    const excerpts = validationFunctionEvidence(project, functionEvidence, inspection.tests, inspection.benchmarks, draft.function_name, sourceCommit);
    const paths = excerpts.map(item => item.file);
    const key = resolveOptimizationApiKey(config).apiKey;
    const model = { endpoint: config.model.endpoint, modelId: config.model.model_id, apiKey: key,
      reasoningEffort: config.model.reasoning_effort, maxOutputTokens: config.model.max_output_tokens };
    const models = createPiModels(model);
    const selected = models.getModel(COREPILOT_PI_PROVIDER_ID, model.modelId);
    if (!selected) throw new Error('configured model is unavailable');
    const transport = createModelTransport(resolveOptimizationProxy(config)?.proxy);
    try {
      let submitted: ValidationAssetEdit | null = null;
      let proposedPlan: CorrectnessPlanProposal | null = null;
      let needsInput: string[] | null = null;
      const tool: AgentTool = { name: planning ? 'submit_correctness_plan' : 'submit_validation_draft', label: planning ? '提交正确性方案建议' : '提交测试代码草稿', description: planning ? 'Propose correctness inputs, reference and tolerance for human review; never save or qualify.' : 'Submit a reviewable correctness and benchmark draft, never a qualification decision.',
        parameters: planning ? correctnessPlanToolSchema : Type.Object({
          status: Type.Union([Type.Literal('ready'), Type.Literal('needs_input')]),
          blockers: Type.Optional(Type.Array(Type.String())),
          ...(scope !== 'performance' ? { correctness_script: Type.Optional(Type.String()) } : {}),
          ...(scope !== 'correctness' ? { performance_script: Type.Optional(Type.String()) } : {}),
          setup_script: Type.Optional(Type.String()),
          supporting_files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.String() }))),
          ...(scope !== 'performance' ? generatedCorrectnessSchema : {}),
          ...(scope !== 'correctness' ? generatedPerformanceSchema : {}),
          generation_notes: Type.Optional(Type.String()),
          quality: Type.Optional(Type.Unknown()),
        }),
        execute: async (_id, value) => {
          const proposed = value as Record<string, unknown>;
          control.progress('CHECKING_CODE', '正在检查生成内容与测试协议');
          if (proposed.status === 'needs_input') {
            needsInput = Array.isArray(proposed.blockers) ? proposed.blockers.filter((item): item is string => typeof item === 'string' && !!item.trim()).slice(0, 12) : [];
            if (!needsInput.length) throw new Error('needs_input must identify specific missing evidence or inputs');
            return { content: [{ type: 'text', text: 'Missing inputs recorded; no executable code or PASS has been accepted.' }], details: {} };
          }
          if (planning) {
            const edit = parsedEdit({ ...draft, source: 'ai', expected_digest: draft.evaluator_digest, ...generatedCorrectnessConditions(draft, proposed) });
            const missing = validationGenerationBlockers({ ...draft, ...edit }, 'correctness');
            if (missing.length) throw new Error(missing.join('；'));
            const expanded = expandValidationInputs(edit.cases, draft.test_plan);
            const commands = 2 + expanded.length + expandValidationInputs(draft.workloads, draft.test_plan).length * 2 * (draft.test_plan.sampling.warmup_count + draft.test_plan.sampling.sample_count);
            if (commands > 2048) throw new Error('Propose fewer correctness cases to stay within the 2048-command execution limit');
            const evidenceFiles = Array.isArray(proposed.evidence_files) ? proposed.evidence_files.filter((item): item is string => typeof item === 'string' && excerpts.some(e => e.file === item && !e.content.startsWith('Unavailable'))) : [];
            if (!evidenceFiles.length) throw new Error('Cite at least one supplied source evidence file for the proposed API semantics');
            if (!String(proposed.summary ?? '').trim() || !String(proposed.rationale ?? '').trim()) throw new Error('Include a readable summary and a rationale for the independent reference and tolerance');
            proposedPlan = { kind: 'CORRECTNESS_PLAN', expected_digest: draft.evaluator_digest, source_commit: sourceCommit,
              summary: content(proposed.summary, 'summary', 2000), cases: edit.cases, oracle_description: edit.oracle_description,
              tolerance_rule: edit.tolerance_rule, tolerance_absolute: edit.tolerance_absolute, tolerance_relative: edit.tolerance_relative,
              rationale: content(proposed.rationale, 'rationale', 6000), evidence_files: evidenceFiles,
              assumptions: Array.isArray(proposed.assumptions) ? proposed.assumptions.slice(0, 16).map(item => content(item, 'assumption', 1000)) : [] };
            return { content: [{ type: 'text', text: 'Reviewable plan collected. No conditions saved, no qualification granted.' }], details: {} };
          }
          const code = [proposed.correctness_script, proposed.performance_script, ...((proposed.supporting_files ?? []) as ValidationSourceFile[]).map(item => item.content)].join('\n');
          if (/['"]review_required['"]\s*:\s*(?:True|true)|['"]evaluator_binary_identity['"]\s*:\s*(?:None|null)/.test(code)) {
            throw new Error('Code declares review-required or a missing evaluator identity. Submit needs_input with blockers, or implement an actual reference comparison with valid executable identity.');
          }
          const supporting = new Map(draft.supporting_files.map(file => [file.path, file]));
          if (proposed.supporting_files !== undefined) for (const file of parseSupportingFiles(proposed.supporting_files)) {
            if (file.path === 'support/corepilot_test.py') throw new Error('corepilot_test.py is provided by the platform; implement library/reference logic in test-correctness.py or test-performance.py');
            supporting.set(file.path, file);
          }
          for (const kind of scope === 'both' ? ['correctness', 'performance'] : [scope]) {
            if (!supporting.has(`support/test-${kind}.py`)) throw new Error(`Provide support/test-${kind}.py using the supplied TestContext API. Do not implement protocol plumbing or placeholder scripts.`);
          }
          supporting.set('support/corepilot_test.py', { path: 'support/corepilot_test.py', content: VALIDATION_PYTHON_HARNESS });
          if (scope !== 'correctness' && proposed.setup_script === undefined && supporting.has('support/build-evaluator.sh') && !draft.setup_script.includes('support/build-evaluator.sh')) {
            throw new Error('support/build-evaluator.sh is not the Runner build entrypoint. Provide setup_script that invokes it (or builds the native adapter directly). Runner executes scripts/build-evaluator.sh, generated from setup_script; a supporting file alone will never build the timer.');
          }
          submitted = parsedEdit({ ...draft, source: 'ai', expected_digest: draft.evaluator_digest,
            ...(scope !== 'performance' ? generatedCorrectnessConditions(draft, proposed) : {}),
            ...(scope !== 'correctness' ? generatedPerformanceConditions(draft, proposed) : {}),
            correctness_script: scope === 'performance' ? draft.correctness_script : generatedTestEntrypoint('correctness'),
            performance_script: scope === 'correctness' ? draft.performance_script : generatedTestEntrypoint('performance'),
            setup_script: proposed.setup_script ?? draft.setup_script, supporting_files: [...supporting.values()],
            generation_notes: proposed.generation_notes ?? '' });
          if (scope !== 'performance' && !draft.quality && proposed.quality !== undefined) submitted.quality = parseValidationQuality(proposed.quality, submitted.cases.map(row => row.case_id));
          await checkGeneratedPython([...supporting.values()], scope === 'correctness' ? undefined : { timing_scope: draft.test_plan.timing_scope,
            parameter_names: [...new Set(submitted.workloads.flatMap(item => Object.keys(item.parameters)))] });
          const missing = validationGenerationBlockers({ ...draft, ...submitted }, scope);
          if (missing.length) throw new Error(`Complete the missing draft correctness conditions alongside the code: ${missing.join('；')}`);
          if (scope !== 'correctness' && /No formal benchmark exists|UNKNOWN_REVIEW_REQUIRED/i.test(submitted.benchmark_description)) throw new Error('Provide a concrete benchmark_description explaining the operation, input recipe, timing scope and seconds-per-call normalization alongside the performance code');
          const expanded = expandValidationInputs(submitted.cases, draft.test_plan);
          const commands = 2 + expanded.length + expandValidationInputs(submitted.workloads, draft.test_plan).length * 2 * (draft.test_plan.sampling.warmup_count + draft.test_plan.sampling.sample_count);
          if (commands > 2048) throw new Error('Generated draft exceeds 2048 commands; use fewer new logical inputs while preserving all saved inputs and settings');
          return { content: [{ type: 'text', text: 'Reviewable code collected. User-owned conditions preserved. Nothing saved or qualified.' }], details: { expected_digest: draft.evaluator_digest } };
        },
      };
      const prompt = JSON.stringify({ function_name: draft.function_name, evidence: excerpts, user_instructions: instructions || null,
          source_commit: sourceCommit, build: resolved.build, scope, test_plan: draft.test_plan,
          ...(planning ? { maximum_new_case_count: Math.min(12, Math.floor(200 / (draft.test_plan.execution_matrix ? draft.test_plan.execution_matrix.thread_counts.length * draft.test_plan.execution_matrix.profiles.length : 1))) } : {}),
          input_layout: 'LOGICAL_INPUTS', execution_expansion: { owner: 'COREPILOT', logical_cases: draft.cases.length,
            correctness_executions: resolved.bundle.correctness.cases.length, performance_executions: resolved.bundle.workloads.workloads.length },
          cases: draft.cases, workloads: draft.workloads, oracle: draft.oracle_description,
          benchmark: draft.benchmark_description, tolerance: { rule: draft.tolerance_rule, absolute: draft.tolerance_absolute, relative: draft.tolerance_relative },
          candidate_artifact: draft.candidate_artifact, preparation, baseline_headers: planning || scope === 'correctness' ? [] : validationBaselineHeaders(project, resolved, paths),
          runtime_artifacts: { phase: 'CODE_DRAFTING_BEFORE_EXECUTION', load_from: 'ctx.artifact_path (Runner runtime argument)',
            candidate: 'Runner builds the selected source and passes its produced library path', baseline: 'Runner stages the frozen control-side baseline and passes its target-side path',
            timing_samples: 'Produced only when the generated program is later executed; no samples requested during drafting' },
          ...(planning ? {} : { test_context_api: 'support/corepilot_test.py is supplied by CorePilot. Do not overwrite it.',
          test_context_source: VALIDATION_PYTHON_HARNESS,
          existing_code: { setup_script: draft.setup_script, correctness_script: draft.correctness_script,
            performance_script: draft.performance_script, supporting_files: draft.supporting_files } }) });
      control.signal.throwIfAborted();
      control.progress('CALLING_MODEL', `正在请求 ${config.model.model_id} ${planning ? '起草正确性方案' : '生成测试代码'}`);
      const reply = await runPiAgentRuntime(prompt, { systemPrompt: planning ? correctnessPlanPrompt : validationGenerationPrompt, model: selected, tools: [tool],
        streamFn: createPiToolSubmissionStream(models, observeGenerationModel(transport.fetch, patch => {
          control.observation(patch); if (patch.request_count === undefined) control.progress('RECEIVING', '已连接模型，正在接收生成结果');
        })), thinkingLevel: config.model.reasoning_effort ?? 'off',
        signal: config.model.timeout_ms > 0 ? AbortSignal.any([control.signal, AbortSignal.timeout(config.model.timeout_ms)]) : control.signal,
        maxTurns: 6, maxToolCalls: 6, stopAfterSuccessfulTools: [tool.name], requireSuccessfulStopTool: true,
        textOnlyFollowUp: { maxAttempts: 1, message: planning ? 'Submit the reviewable plan using submit_correctness_plan now. Cite source evidence and explain any assumptions.' : 'Submit the actual code using submit_validation_draft now. Keep the given test conditions unchanged. Prose alone does not deliver a draft.' } });
      if (needsInput) throw new ValidationGenerationNeedsInput(needsInput);
      if (proposedPlan && reply.ok) return proposedPlan;
      if (!submitted || !reply.ok) {
        const reason = reply.error === 'cancelled' ? '已达到配置的模型超时'
          : reply.no_source_mutation ? '只返回了说明文字，尚未提交代码' : reply.error ?? '未调用提交工具';
        throw new Error(`模型未提交${planning ? '可审阅的正确性方案' : '可编辑的测试代码'}：${reason}。请检查模型输出预算或工具调用能力。`.split(key).join('[redacted]'));
      }
      return submitted;
    } finally { await transport.close(); }
  }
}
