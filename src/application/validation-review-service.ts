import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectRecord } from '../contracts/project.js';
import type { ValidationReview, ValidationReviewDecision } from '../contracts/validation-review.js';
import type { EvaluatorQualificationRecord } from '../contracts/formal-evaluator.js';
import { ApiError } from '../core/api-error.js';
import { loadOptimizationConfig } from '../config/optimization-config.js';
import { isRegisteredRunner } from '../config/runner-config.js';
import { isolatedWorkspaceBuild } from '../config/build-command.js';
import { LibraryPackageLoader } from '../library-package/loader.js';
import { packageBaselineBinding } from '../library-package/task-definition.js';
import { inspectFormalEvaluatorBundle, loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import { assertGeneratedHarnessResolution } from '../evaluator/generated-harness-compatibility.js';
import { runnerArtifactPathCheckMatches } from '../evaluator/runner-artifact-path-check.js';
import type { ValidationTrialService } from './validation-trial-service.js';

const encoded = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Reuses controlled Runner trials for target qualification; never produces Formal Evidence. */
export class ValidationReviewService {
  private readonly catalog: LibraryPackageLoader;
  constructor(dataDir: string, private readonly trials: ValidationTrialService) {
    this.catalog = new LibraryPackageLoader({ catalogRoot: path.join(dataDir, 'catalog') });
  }

  private selection(project: ProjectRecord, packageId: string, version: string, targetId: string) {
    if (packageId !== `project-${project.project_id.slice(0, 8)}`) throw new ApiError(400, 'INVALID_REVIEW', '只能审阅本项目建立的测试方案');
    return this.catalog.resolveSelection({ package_id: packageId, package_version: version, target_id: targetId });
  }

  private async assess(project: ProjectRecord, packageId: string, version: string, targetId: string) {
    const resolved = this.selection(project, packageId, version, targetId);
    const qualification = resolved.bundle.qualification;
    const preview: ValidationReview = {
      state: qualification.status === 'QUALIFIED' ? 'QUALIFIED' : 'NEEDS_TRIAL',
      evaluator_digest: resolved.bundle.content_digest, package_digest: resolved.loaded.content_digest,
      function_name: resolved.functionDefinition.api, blockers: [], build: resolved.build,
      scope: resolved.target.candidate_scope, acceptance: resolved.target.performance_acceptance,
      baseline: resolved.target.artifacts.baseline, trial: null,
      approval: qualification.reviewer && qualification.approved_at ? { reviewer: qualification.reviewer,
        approved_at: qualification.approved_at, trial_id: qualification.qualification_run.run_id } : null,
    };
    if (qualification.status === 'QUALIFIED') {
      const receipt = path.join(resolved.loaded.root, 'onboarding', `validation-review-${targetId}`, 'report.json');
      if (fs.existsSync(receipt)) {
        const saved = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        if (saved.preview?.evaluator_digest === resolved.bundle.content_digest) preview.quality = saved.preview.quality;
      }
      return { preview, resolved, result: null };
    }
    try { assertGeneratedHarnessResolution(resolved.bundle); }
    catch (error) { preview.blockers.push((error as Error).message); }
    const records = this.trials.list(project).filter(item => item.package_id === packageId && item.package_version === version &&
      item.target_id === targetId && item.purpose === 'VALIDATION_DRAFT' && item.mode === 'comparison');
    const record = records[0];
    if (!record) { preview.blockers.push('请先在 Runner 上试运行两库对比；通过后即可审阅并启用这版测试方案。'); return { preview, resolved, result: null }; }
    if (record.evaluator_digest !== resolved.bundle.content_digest) {
      preview.state = 'BLOCKED'; preview.blockers.push('测试条件或代码在试跑后发生了变化，请保存后对当前版本重新试跑。');
      return { preview, resolved, result: null };
    }
    const config = loadOptimizationConfig(project.config_path).config;
    const selectedMachine = isRegisteredRunner(config.runner) ? config.runner.machine_id : null;
    if (record.machine_id !== selectedMachine) preview.blockers.push('执行机器已改变，请在当前机器上试跑这版测试方案。');
    const binding = packageBaselineBinding(resolved, config.validation.baseline_artifact ?? '');
    if (binding.artifactDigest !== record.baseline_digest) preview.blockers.push('比较基线已改变，请使用当前基线重新试跑。');
    if (JSON.stringify(record.build_definition) !== JSON.stringify(isolatedWorkspaceBuild(resolved.build))) {
      preview.blockers.push('构建命令在试跑后发生变化，请使用当前构建设置重新试跑。');
    }
    const result = await this.trials.status(project, record.trial_id);
    preview.quality = result.summary.quality;
    const observed = 'observed_context' in result.status ? object(result.status.observed_context) : {};
    const machineIdentity = object(observed.machine).machine_identity_sha256;
    const resources = result.commands.filter(command => command.step === 'CORRECTNESS' || command.step === 'PERFORMANCE');
    preview.trial = { trial_id: record.trial_id, source_commit: record.source_commit, source_branch: record.source_branch,
      machine_name: record.machine_name ?? '执行机器', machine_identity_sha256: typeof machineIdentity === 'string' ? machineIdentity : null,
      started_at: 'started_at' in result.status ? result.status.started_at : null,
      ended_at: 'ended_at' in result.status ? result.status.ended_at : null,
      correctness_passed: result.summary.correctness.passed, correctness_planned: result.summary.correctness.planned,
      performance_measured: result.summary.performance.measured, performance_planned: result.summary.performance.planned,
      resource_commands: resources.length };
    if (['PREPARING', 'PENDING', 'RUNNING'].includes(result.status.status)) {
      preview.state = 'WAITING'; preview.blockers.push('这次两库对比仍在执行，请等待试跑完成。');
      return { preview, resolved, result };
    }
    if (!result.passed || !result.summary.correctness.planned || !result.summary.performance.planned) {
      preview.blockers.push('最近一次两库对比尚未完整通过，请查看该次试跑的失败或缺失测量。');
    }
    const measured = result.measurements.filter(row => row.kind === 'CORRECTNESS_CASE' || row.kind === 'PERFORMANCE_SAMPLE' ||
      row.kind === 'OBSERVATION' && row.domain_payload?.classification === 'TEST_SENSITIVITY');
    if (measured.some(row => {
      const payload = object(row.domain_payload), identity = object(payload.artifact_identity);
      return typeof identity.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(identity.sha256) ||
        !runnerArtifactPathCheckMatches(identity, payload.runner_artifact_path_check, resolved.bundle.manifest.domain.api);
    })) preview.blockers.push('试跑缺少有效的 Runner 库路径核对记录，请升级 Runner 并重新试跑；原试跑会保留。');
    if (result.summary.quality.probes.some(probe => !probe.detected)) preview.blockers.push('正确性测试没有识别全部已知错误实现；请检查输入覆盖和结果判断后重新试跑。');
    if (resources.length === 0 || resources.some(command => command.resource_context?.validity !== 'VALID' || command.exit_code !== 0 && !(command.diagnostic_probe && command.exit_code === 1))) {
      preview.blockers.push('试跑缺少有效的线程、CPU 和 NUMA 执行记录，请使用受控 Runner 重新试跑。');
    }
    if (typeof machineIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(machineIdentity)) preview.blockers.push('试跑没有记录可核对的机器身份。');
    if (!preview.trial.started_at || !preview.trial.ended_at) preview.blockers.push('试跑缺少完整的开始与结束时间。');
    const inspection = inspectFormalEvaluatorBundle(resolved.bundle.root);
    for (const check of inspection.checks.filter(item => item.scope === 'STATIC' && item.status !== 'PASS')) preview.blockers.push(check.summary);
    preview.state = preview.blockers.length ? 'BLOCKED' : 'READY_FOR_REVIEW';
    return { preview, resolved, result };
  }

  async preview(project: ProjectRecord, packageId: string, version: string, targetId: string): Promise<ValidationReview> {
    return (await this.assess(project, packageId, version, targetId)).preview;
  }

  async approve(project: ProjectRecord, packageId: string, version: string, targetId: string, input: ValidationReviewDecision) {
    if (input.confirm !== true || typeof input.reviewer !== 'string' || !input.reviewer.trim() || input.reviewer.length > 160) {
      throw new ApiError(400, 'HUMAN_REVIEW_REQUIRED', '请填写审阅人，并明确确认这版测试方案用于正式优化');
    }
    const { preview, resolved, result } = await this.assess(project, packageId, version, targetId);
    if (preview.state === 'QUALIFIED' && resolved.bundle.content_digest === input.expected_digest &&
        resolved.bundle.qualification.qualification_run.run_id === input.trial_id) return preview;
    if (preview.evaluator_digest !== input.expected_digest || preview.package_digest !== input.expected_package_digest ||
        preview.trial?.trial_id !== input.trial_id) throw new ApiError(409, 'REVIEW_CHANGED', '测试方案、基线、构建或试跑记录已变化，请重新打开审阅');
    if (preview.state !== 'READY_FOR_REVIEW' || !result || !preview.trial) throw new ApiError(409, 'TRIAL_NOT_READY', preview.blockers.join('\n'));
    const current = this.selection(project, packageId, version, targetId);
    if (current.loaded.content_digest !== preview.package_digest) throw new ApiError(409, 'REVIEW_CHANGED', '审阅期间接入方案已变化，请重新读取');
    const now = new Date().toISOString(), reviewer = input.reviewer.trim();
    const raw = encoded(result.measurements);
    const report = encoded({ schema_version: 1, classification: 'TARGET_QUALIFICATION', formal_evidence: false,
      preview, commands: result.commands, status: result.status, human_decision: { decision: 'ENABLE_VALIDATION', reviewer, approved_at: now } });
    const checks = inspectFormalEvaluatorBundle(resolved.bundle.root).checks.filter(item => item.scope === 'STATIC');
    const qualification: EvaluatorQualificationRecord = { ...resolved.bundle.qualification, status: 'QUALIFIED',
      target: { ...resolved.bundle.manifest.target, machine_identity_sha256: preview.trial.machine_identity_sha256 },
      qualification_run: { run_id: input.trial_id, result: 'TARGET_EXECUTION_PASSED',
        started_at: preview.trial.started_at!, completed_at: preview.trial.ended_at! },
      evidence: { report_sha256: digest(report), raw_measurements_sha256: digest(raw) },
      reviewer, approved_at: now, updated_at: now, checks: [...checks, { check_id: 'target.controlled-comparison', scope: 'TARGET', status: 'PASS',
        summary: `Runner ${input.trial_id}: build, ${preview.trial.correctness_passed} correctness cases, ${preview.trial.performance_measured} samples and resource observations passed. Development samples are qualification inputs, not Formal Evidence.` }] };
    const manifest = structuredClone(current.loaded.manifest);
    const allQualified = manifest.targets.every(target => target.target_id === targetId ||
      this.catalog.resolveSelection({ package_id: packageId, package_version: version, target_id: target.target_id }).bundle.qualification.status === 'QUALIFIED');
    manifest.qualification = { state: allQualified ? 'QUALIFIED' : 'REVIEWED', reviewer, reviewed_at: now };
    const receiptRoot = path.join(resolved.loaded.root, 'onboarding', `validation-review-${targetId}`);
    const files = new Map([
      [path.join(receiptRoot, 'report.json'), report], [path.join(receiptRoot, 'measurements.json'), raw],
      [path.join(resolved.bundle.root, 'qualification.json'), encoded(qualification)],
      [path.join(resolved.loaded.root, 'package.json'), encoded(manifest)],
    ]);
    const before = new Map([...files.keys()].map(filename => [filename, fs.existsSync(filename) ? fs.readFileSync(filename) : null]));
    try {
      for (const [filename, content] of files) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content, { mode: 0o600 }); }
      loadFormalEvaluatorBundle(resolved.bundle.root, { requireQualified: true });
      this.catalog.resolveSelection({ package_id: packageId, package_version: version, target_id: targetId }, { requireQualified: true });
    } catch (error) {
      for (const [filename, bytes] of before) { if (bytes === null) fs.rmSync(filename, { force: true }); else fs.writeFileSync(filename, bytes); }
      throw error;
    }
    return this.preview(project, packageId, version, targetId);
  }
}
