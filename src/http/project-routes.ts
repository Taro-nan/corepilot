import type http from 'node:http';
import { ApiError } from '../core/api-error.js';
import type { ProjectService } from '../application/project-service.js';
import type { OptimizationWorkflowService } from '../workflow/optimization-workflow-service.js';
import { readJson, sendJson } from './json.js';
import { InvalidTargetSelectionError, MAX_ONBOARDING_TARGETS } from '../onboarding/onboarding-agent.js';
import { loadOptimizationConfig } from '../config/optimization-config.js';
import type { ValidationGenerationScope } from '../contracts/validation-assets.js';
import { ValidationInputError } from '../evaluator/validation-inputs.js';
import type { ValidationReviewDecision } from '../contracts/validation-review.js';

function downloadTestPackage(res: http.ServerResponse, body: Buffer, filename: string) {
  res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${filename}"`,
    'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

export async function projectRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL, service: ProjectService, workflows: OptimizationWorkflowService, assertOwnership: () => void): Promise<boolean> {
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  if (pathname === '/v1/projects') {
    if (method === 'GET') { sendJson(res, 200, { projects: service.list() }); return true; }
    if (method === 'POST') {
      const body = await readJson(req);
      if (body.source_branch !== undefined && typeof body.source_branch !== 'string') throw new ApiError(400, 'INVALID_ARGUMENT', 'source_branch must be a string');
      sendJson(res, 201, { project: service.add({ name: String(body.name ?? ''), repository_root: String(body.repository_root ?? ''), ...(body.config_path ? { config_path: String(body.config_path) } : {}), ...(body.source_branch === undefined ? {} : { source_branch: body.source_branch as string }) }) }); return true;
    }
  }
  if (pathname === '/v1/catalog' && method === 'GET') { sendJson(res, 200, { packages: service.catalog() }); return true; }
  if (pathname === '/v1/directories' && method === 'GET') { sendJson(res, 200, await service.directories(url.searchParams.get('path') ?? '')); return true; }
  if (pathname === '/v1/repository' && method === 'GET') { sendJson(res, 200, await service.inspectRepository(url.searchParams.get('path') ?? '')); return true; }
  const trialRequest = pathname.match(/^\/v1\/projects\/([^/]+)\/validation-trial-request(?:\/(close))?$/);
  if (trialRequest) {
    const requestId = req.headers['idempotency-key'];
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw new ApiError(400, 'INVALID_REQUEST_ID', '请提供有效的请求标识。');
    const project = service.get(decodeURIComponent(trialRequest[1]));
    if (method === 'GET' && !trialRequest[2]) { sendJson(res, 200, service.validationTrials.requestStatus(project, requestId)); return true; }
    if (method === 'POST' && trialRequest[2] === 'close') { await readJson(req); assertOwnership(); sendJson(res, 200, service.validationTrials.closeRequest(project, requestId)); return true; }
  }
  const trial = pathname.match(/^\/v1\/projects\/([^/]+)\/validation-trials(?:\/([^/]+))?$/);
  if (trial) {
    const id = decodeURIComponent(trial[1]);
    if (method === 'GET' && !trial[2]) { sendJson(res, 200, { trials: service.validationTrials.list(service.get(id)) }); return true; }
    if (method === 'POST' && !trial[2]) {
      const body = await readJson(req);
      assertOwnership();
      const requestId = req.headers['idempotency-key'];
      if (requestId !== undefined && (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200)) throw new ApiError(400, 'INVALID_REQUEST_ID', '请提供有效的请求标识。');
      for (const key of ['package_id', 'package_version', 'target_id'] as const) {
        if (typeof body[key] !== 'string' || !body[key].trim()) throw new ApiError(400, 'INVALID_ARGUMENT', `${key} is required`);
      }
      if (body.source_branch !== undefined && typeof body.source_branch !== 'string') throw new ApiError(400, 'INVALID_ARGUMENT', 'source_branch must be a string');
      if (body.purpose !== undefined && body.purpose !== 'VALIDATION_DRAFT' && body.purpose !== 'BASELINE_BUILD') {
        throw new ApiError(400, 'INVALID_ARGUMENT', 'purpose must be VALIDATION_DRAFT or BASELINE_BUILD');
      }
      if (body.mode !== undefined && !['correctness', 'comparison', 'smoke', 'calibration'].includes(String(body.mode))) throw new ApiError(400, 'INVALID_ARGUMENT', 'mode must be correctness, comparison, calibration or smoke');
      if (body.expected_digest !== undefined && (typeof body.expected_digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.expected_digest))) throw new ApiError(400, 'INVALID_ARGUMENT', 'invalid expected_digest');
      sendJson(res, 202, await service.validationTrials.start(service.get(id), body.package_id as string,
        body.package_version as string, body.target_id as string, body.source_branch as string | undefined,
        body.purpose as 'VALIDATION_DRAFT' | 'BASELINE_BUILD' | undefined,
        { mode: body.mode as 'correctness' | 'comparison' | 'smoke' | 'calibration' | undefined, expected_digest: body.expected_digest as string | undefined,
          build: body.build, expected_package_digest: body.expected_package_digest, ...(typeof requestId === 'string' ? { requestId } : {}) })); return true;
    }
    if (method === 'GET' && trial[2]) {
      sendJson(res, 200, await service.validationTrials.status(service.get(id), decodeURIComponent(trial[2]))); return true;
    }
  }
  const trialDownload = pathname.match(/^\/v1\/projects\/([^/]+)\/validation-trials\/([^/]+)\/(download|files)$/);
  if (trialDownload && method === 'GET') {
    const id = decodeURIComponent(trialDownload[1]), trialId = decodeURIComponent(trialDownload[2]);
    if (trialDownload[3] === 'files') sendJson(res, 200, service.validationTrials.files(service.get(id), trialId));
    else downloadTestPackage(res, await service.validationTrials.download(service.get(id), trialId), 'corepilot-trial-tests.tar.gz'); return true;
  }
  const freezeBaseline = pathname.match(/^\/v1\/projects\/([^/]+)\/validation-trials\/([^/]+)\/freeze-baseline$/);
  if (freezeBaseline && method === 'POST') {
    const body = await readJson(req);
    assertOwnership();
    if (body.artifact_relative_path !== undefined && typeof body.artifact_relative_path !== 'string') throw new ApiError(400, 'INVALID_ARGUMENT', 'artifact_relative_path must be a string');
    sendJson(res, 200, await service.freezeBranchBaseline(decodeURIComponent(freezeBaseline[1]), decodeURIComponent(freezeBaseline[2]), body.artifact_relative_path as string | undefined));
    return true;
  }
  const uploadBaseline = pathname.match(/^\/v1\/projects\/([^/]+)\/baseline-upload$/);
  if (uploadBaseline && method === 'PUT') {
    const query = url.searchParams;
    const required = (key: string) => {
      const value = query.get(key)?.trim();
      if (!value) throw new ApiError(400, 'INVALID_ARGUMENT', `${key} is required`);
      return value;
    };
    sendJson(res, 200, await service.uploadSingleBaseline(decodeURIComponent(uploadBaseline[1]), {
      packageId: required('package_id'), version: required('package_version'), targetId: required('target_id'),
      library: required('library'), versionLabel: required('library_version'), filename: required('filename'),
    }, req as AsyncIterable<Buffer>));
    return true;
  }
  const bundles = pathname.match(/^\/v1\/projects\/([^/]+)\/baseline-bundles(?:\/([^/]+)(?:\/(files|check|bind|finalize))?)?$/);
  if (bundles) {
    const id = decodeURIComponent(bundles[1]);
    const project = service.get(id);
    if (method === 'GET' && !bundles[2]) {
      const required = (key: string) => { const value = url.searchParams.get(key); if (!value) throw new ApiError(400, 'INVALID_ARGUMENT', `${key} is required`); return value; };
      sendJson(res, 200, { imports: await service.baselineBundles.list(project, required('package_id'), required('package_version'), required('target_id')) }); return true;
    }
    if (method === 'POST' && !bundles[2]) {
      const body = await readJson(req);
      const required = (key: string) => {
        if (typeof body[key] !== 'string' || !(body[key] as string).trim()) throw new ApiError(400, 'INVALID_ARGUMENT', `${key} is required`);
        return body[key] as string;
      };
      sendJson(res, 201, service.baselineBundles.create(project, { packageId: required('package_id'),
        version: required('package_version'), targetId: required('target_id'), library: required('library'),
        libraryVersion: required('library_version') })); return true;
    }
    if (bundles[2]) {
      const bundleId = decodeURIComponent(bundles[2]);
      if (method === 'GET' && !bundles[3]) { sendJson(res, 200, await service.baselineBundles.status(project, bundleId)); return true; }
      if (method === 'PUT' && bundles[3] === 'files') {
        const relative = url.searchParams.get('path');
        if (!relative) throw new ApiError(400, 'INVALID_ARGUMENT', 'path is required');
        sendJson(res, 200, await service.baselineBundles.upload(project, bundleId, relative, req as AsyncIterable<Buffer>)); return true;
      }
      if (method === 'POST' && ['check', 'bind', 'finalize'].includes(bundles[3])) {
        const body = await readJson(req);
        assertOwnership();
        if (typeof body.entry_path !== 'string' || !body.entry_path.trim()) throw new ApiError(400, 'INVALID_ARGUMENT', 'entry_path is required');
        const result = bundles[3] === 'check' ? await service.baselineBundles.check(project, bundleId, body.entry_path)
          : bundles[3] === 'bind' ? await service.bindBundleBaseline(id, bundleId, body.entry_path)
          : await service.finalizeBundleBaseline(id, bundleId, body.entry_path);
        sendJson(res, 200, result); return true;
      }
    }
  }
  const generation = pathname.match(/^\/v1\/projects\/([^/]+)\/validation-assets\/([^/]+)\/([^/]+)\/([^/]+)\/generations(?:\/([^/]+)(?:\/(cancel|adopt))?)?$/);
  if (generation) {
    const [id, packageId, version, targetId, generationId] = generation.slice(1, 6).map(item => item ? decodeURIComponent(item) : '');
    service.get(id);
    const runs = service.validationAssets.generations;
    const matches = (item: { package_id: string; package_version: string; target_id: string }) => item.package_id === packageId && item.package_version === version && item.target_id === targetId;
    if (method === 'GET' && !generationId) { sendJson(res, 200, { generations: runs.list(id).filter(matches).map(({ result: _result, ...record }) => record) }); return true; }
    if (generationId) {
      const record = runs.get(id, generationId);
      if (!matches(record)) throw new ApiError(404, 'GENERATION_NOT_FOUND', '生成记录不属于当前函数');
      if (method === 'GET' && !generation[6]) { sendJson(res, 200, record); return true; }
      if (method === 'POST' && generation[6] === 'cancel') { sendJson(res, 200, runs.cancel(id, generationId)); return true; }
      if (method === 'POST' && generation[6] === 'adopt') {
        const body = await readJson(req);
        if (typeof body.expected_digest !== 'string') throw new ApiError(400, 'INVALID_ARGUMENT', '请提供正在查看的测试版本');
        sendJson(res, 200, service.validationAssets.adoptCorrectnessPlan(service.get(id), packageId, version, targetId, generationId, body.expected_digest)); return true;
      }
    }
  }
  const assets = pathname.match(/^\/v1\/projects\/([^/]+)\/validation-assets\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(generate|context|download|files|build|review))?$/);
  if (assets) {
    const [id, packageId, version, targetId] = assets.slice(1, 5).map(decodeURIComponent);
    const project = service.get(id);
    if (method === 'GET' && assets[5] === 'review') { sendJson(res, 200, await service.validationReview.preview(project, packageId, version, targetId)); return true; }
    if (method === 'POST' && assets[5] === 'review') {
      sendJson(res, 200, await service.validationReview.approve(project, packageId, version, targetId, await readJson(req) as unknown as ValidationReviewDecision)); return true;
    }
    if (method === 'GET' && !assets[5]) { sendJson(res, 200, service.validationAssets.get(project, packageId, version, targetId)); return true; }
    if (method === 'PUT' && !assets[5]) {
      try { sendJson(res, 200, service.validationAssets.save(project, packageId, version, targetId, await readJson(req))); }
      catch (error) {
        if (error instanceof ValidationInputError) throw new ApiError(422, 'INVALID_VALIDATION_INPUT', error.message);
        throw error;
      }
      return true;
    }
    if (method === 'GET' && assets[5] === 'context') { sendJson(res, 200, await service.validationAssets.context(project,
      loadOptimizationConfig(project.config_path).config, packageId, version, targetId)); return true; }
    if (method === 'GET' && assets[5] === 'download') { downloadTestPackage(res,
      await service.validationAssets.download(project, packageId, version, targetId, url.searchParams.get('digest') ?? undefined),
      'corepilot-test-package.tar.gz'); return true; }
    if (method === 'GET' && assets[5] === 'files') { sendJson(res, 200, service.validationAssets.files(project, packageId, version, targetId,
      url.searchParams.get('digest') ?? undefined)); return true; }
    if (method === 'POST' && assets[5] === 'generate') {
      const body = await readJson(req);
      assertOwnership();
      if (body.scope !== undefined && !['correctness', 'performance', 'both'].includes(String(body.scope))) throw new ApiError(400, 'INVALID_ARGUMENT', 'scope must be correctness, performance or both');
      if (body.purpose !== undefined && !['CORRECTNESS_PLAN', 'TEST_CODE'].includes(String(body.purpose))) throw new ApiError(400, 'INVALID_ARGUMENT', 'purpose must be TEST_CODE or CORRECTNESS_PLAN');
      if (body.instructions !== undefined && (typeof body.instructions !== 'string' || body.instructions.length > 12000)) throw new ApiError(400, 'INVALID_ARGUMENT', '生成提示词必须是 12000 字符以内的文本');
      if (body.background === true) {
        sendJson(res, 202, service.validationAssets.startGeneration(project, loadOptimizationConfig(project.config_path).config,
          packageId, version, targetId, body.purpose === 'CORRECTNESS_PLAN' ? 'correctness' : body.scope as ValidationGenerationScope | undefined,
          body.purpose as 'CORRECTNESS_PLAN' | 'TEST_CODE' | undefined, body.instructions as string | undefined)); return true;
      }
      if (body.purpose === 'CORRECTNESS_PLAN') { sendJson(res, 200, await service.validationAssets.proposeCorrectness(project, loadOptimizationConfig(project.config_path).config, packageId, version, targetId, body.instructions as string | undefined)); return true; }
      sendJson(res, 200, await service.validationAssets.generate(project,
        loadOptimizationConfig(project.config_path).config,
        packageId, version, targetId, body.scope as ValidationGenerationScope | undefined, body.instructions as string | undefined)); return true;
    }
  }
  const project = pathname.match(/^\/v1\/projects\/([^/]+)(?:\/(config|defaults|machine|check|models|model-test|runner-test|target-test|discover|setup|source-inspection|build-options|validation-plans))?$/);
  if (project) {
    const id = decodeURIComponent(project[1]);
    if (method === 'GET' && !project[2]) { sendJson(res, 200, { project: service.get(id) }); return true; }
    if (method === 'GET' && project[2] === 'setup') { sendJson(res, 200, await service.setupStatus(id)); return true; }
    if (method === 'GET' && project[2] === 'validation-plans') {
      const name = url.searchParams.get('function_name');
      if (!name?.trim() || name.length > 512) throw new ApiError(400, 'INVALID_ARGUMENT', '请输入目标函数名称。');
      sendJson(res, 200, await service.validationPlans(id, name)); return true;
    }
    if (method === 'GET' && project[2] === 'build-options') {
      sendJson(res, 200, await service.buildPlanning.options(service.get(id), url.searchParams.get('machine_id') || undefined)); return true;
    }
    if (project[2] === 'config') {
      if (method === 'GET') { sendJson(res, 200, { config: service.config(id) }); return true; }
      if (method === 'PUT') { const body = await readJson(req); sendJson(res, 200, { config: service.saveConfig(id, body.config) }); return true; }
    }
    if (project[2] === 'defaults' && method === 'PUT') {
      const body = await readJson(req);
      if (body.source_branch !== undefined && (typeof body.source_branch !== 'string' || !body.source_branch.trim())) throw new ApiError(400, 'INVALID_ARGUMENT', '请选择要优化的 Git 分支');
      if (body.function_name !== undefined && (typeof body.function_name !== 'string' || !body.function_name.trim())) throw new ApiError(400, 'INVALID_ARGUMENT', '请填写目标函数');
      if (body.source_branch === undefined && body.function_name === undefined) throw new ApiError(400, 'INVALID_ARGUMENT', '请选择要更新的项目默认条件');
      sendJson(res, 200, { project: service.updateDefaults(id, { source_branch: body.source_branch as string | undefined, function_name: body.function_name as string | undefined }) }); return true;
    }
    if (project[2] === 'machine' && method === 'PUT') {
      const body = await readJson(req);
      if (typeof body.machine_id !== 'string' || !body.machine_id.trim()) throw new ApiError(400, 'INVALID_ARGUMENT', 'machine_id is required');
      sendJson(res, 200, { config: service.bindMachine(id, body.machine_id) }); return true;
    }
    if (method === 'POST') {
      if (project[2] === 'source-inspection') {
        await readJson(req);
        await service.setup.inspect(service.get(id));
        sendJson(res, 200, await service.setupStatus(id)); return true;
      }
      if (project[2] === 'check') {
        const body = await readJson(req);
        if (body.function_name !== undefined && typeof body.function_name !== 'string') throw new ApiError(400, 'INVALID_ARGUMENT', 'function_name must be a string');
        if (body.source_branch !== undefined && typeof body.source_branch !== 'string') throw new ApiError(400, 'INVALID_ARGUMENT', 'source_branch must be a string');
        if (body.machine_id !== undefined && (typeof body.machine_id !== 'string' || !body.machine_id.trim())) throw new ApiError(400, 'INVALID_ARGUMENT', '请选择有效的执行机器');
        if (body.verification_mode !== undefined && !['verified', 'source_only'].includes(String(body.verification_mode))) throw new ApiError(400, 'INVALID_ARGUMENT', '请选择仅生成代码或自动验证。');
        sendJson(res, 200, await service.check(id, body.function_name as string | undefined, body.source_branch as string | undefined, body.machine_id as string | undefined, body.verification_mode as 'verified' | 'source_only' | undefined, body.candidate_scope as import('../contracts/library-package.js').CandidateSourceScope | undefined)); return true;
      }
      if (project[2] === 'models') { const body = await readJson(req); sendJson(res, 200, await service.discoverModels(id, body.model)); return true; }
      if (project[2] === 'model-test') { assertOwnership(); sendJson(res, 200, await service.modelTest(id)); return true; }
      if (project[2] === 'target-test') { sendJson(res, 200, await service.targetTest(id)); return true; }
      if (project[2] === 'runner-test') { const body = await readJson(req); sendJson(res, 200, await service.runnerTest(id, body.runner)); return true; }
      if (project[2] === 'discover') {
        const body = await readJson(req);
        assertOwnership();
        if (body.symbol !== undefined && typeof body.symbol !== 'string') throw new ApiError(400, 'INVALID_ARGUMENT', 'symbol must be a string');
        if (body.symbols !== undefined && (!Array.isArray(body.symbols) || body.symbols.some((item: unknown) => typeof item !== 'string' || !item.trim()) || body.symbols.length > MAX_ONBOARDING_TARGETS || new Set(body.symbols).size !== body.symbols.length)) {
          throw new ApiError(400, 'INVALID_ARGUMENT', `symbols must contain at most ${MAX_ONBOARDING_TARGETS} unique, non-empty strings`);
        }
        if (body.symbol !== undefined && body.symbols !== undefined) throw new ApiError(400, 'INVALID_ARGUMENT', 'use symbol or symbols, not both');
        if (body.build_command !== undefined && (typeof body.build_command !== 'string' || !body.build_command.trim())) throw new ApiError(400, 'INVALID_ARGUMENT', 'build_command must be a non-empty string');
        if (body.build_cwd !== undefined && (typeof body.build_cwd !== 'string' || !body.build_cwd.trim() || body.build_cwd.split(/[\\/]/).includes('..') || /^(?:\/|[A-Za-z]:|\\)/.test(body.build_cwd))) throw new ApiError(400, 'INVALID_ARGUMENT', 'build_cwd must be relative to the source workspace');
        try {
          sendJson(res, 200, await service.discover(id, body.symbol as string | undefined,
            typeof body.build_command === 'string' ? { command: body.build_command, cwd: (body.build_cwd as string | undefined) ?? '.' } : undefined,
            body.symbols as string[] | undefined));
        } catch (error) {
          if (error instanceof InvalidTargetSelectionError) throw new ApiError(400, 'INVALID_ARGUMENT', error.message);
          throw error;
        }
        return true;
      }
    }
  }
  const diff = pathname.match(/^\/v1\/workflows\/([^/]+)\/candidates\/([^/]+)\/diff$/);
  if (method === 'GET' && diff) {
    const report = workflows.report(decodeURIComponent(diff[1]));
    const c = report?.report.candidates.find(item => item.candidate.candidate_id === decodeURIComponent(diff[2]))?.candidate;
    const baseline = report?.report.workflow.baseline_commit;
    if (!c || !baseline) throw new ApiError(404, 'CANDIDATE_NOT_FOUND', 'candidate or baseline identity not found');
    sendJson(res, 200, { diff: await service.diff(report!.report.workflow.repository_root ?? c.source.repository, baseline, c.source.commit) }); return true;
  }
  return false;
}
