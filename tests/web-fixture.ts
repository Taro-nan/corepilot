import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { ControlIdentityGuard } from '../src/storage/control-identity.js';
import { TaskHost } from '../src/core/task-host.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';
import { createHttpServer } from '../src/http/server.js';
import { ProjectService } from '../src/application/project-service.js';
import { TestingService } from '../src/application/testing-service.js';
import { hypothesisProposal } from './hypothesis-fixture.js';
import type { ProjectRecord } from '../src/contracts/project.js';
import type { RemoteValidationTransport } from '../src/workspace/validation-runner.js';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Offline integration fixture: real Git, Pi protocol, commands, SQLite, HTTP and reports.
 * The fixture model and sample timings are never product data or hardware evidence. */
export async function startWebFixture(options: { execute?: boolean; validationTextFirst?: boolean; validationGate?: Promise<void>; validationProposal?: Record<string, unknown>; correctnessPlanProposal?: Record<string, unknown>; validationMissingImportFirst?: boolean; rpcTransport?: RemoteValidationTransport; candidateRewrite?: boolean; candidateRepair?: boolean; candidateOnlyArtifact?: boolean; testingService?: TestingService } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-web-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const dataDir = path.join(root, 'data');
  function git(...args: string[]) {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  }
  git('init', '--initial-branch=main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'CorePilot Fixture');
  fs.writeFileSync(path.join(repo, 'kernel.c'), 'int kernel(void) { return 1 + 1; }\n');
  fs.mkdirSync(path.join(repo, 'include')); fs.writeFileSync(path.join(repo, 'include', 'kernel.h'), 'int kernel(void);\n');
  git('add', '.'); git('commit', '-m', 'fixture baseline');
  let turn = 0;
  const modelRequests = { lists: [] as Array<{ path: string; authorization: string | undefined }>, inference: 0, validationBodies: [] as unknown[], planBodies: [] as unknown[], agentBodies: [] as unknown[] };
  const model = http.createServer((request, response) => {
    if (request.method === 'GET' && ['/v1/models', '/alternate/models'].includes(request.url ?? '')) {
      modelRequests.lists.push({ path: request.url!, authorization: request.headers.authorization });
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: request.url === '/v1/models' ? 'fixture-model' : 'alternate-model' }] })); return;
    }
    modelRequests.inference++;
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.tools?.some((tool: { function?: { name?: string } }) => tool.function?.name === 'run_dev_benchmark')) modelRequests.agentBodies.push(body);
      const probe = body.tools?.some((t: { function?: { name: string } }) => t.function?.name === 'corepilot_probe');
      const validation = body.tools?.some((t: { function?: { name: string } }) => t.function?.name === 'submit_validation_draft');
      const planning = body.tools?.some((t: { function?: { name: string } }) => t.function?.name === 'submit_correctness_plan');
      if (validation) modelRequests.validationBodies.push(body);
      if (planning) modelRequests.planBodies.push(body);
      if ((validation || planning) && options.validationGate) { await options.validationGate; if (response.destroyed) return; }
      if (validation && options.validationTextFirst && modelRequests.validationBodies.length === 1) {
        response.setHeader('content-type', 'text/event-stream');
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'I will prepare the requested verification code.' }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n'); return;
      }
      if (probe) turn = 0;
      const canSubmit = body.tools?.some((t: { function?: { name: string } }) => t.function?.name === 'submit_candidate');
      const repairing = options.candidateRepair && body.tools?.some((t: { function?: { name: string } }) => t.function?.name === 'record_candidate_decision');
      const name = probe ? 'corepilot_probe' : planning ? 'submit_correctness_plan' : validation ? 'submit_validation_draft' : ++turn === 1 ? 'record_hypothesis'
        : options.candidateRewrite && turn === 2 ? 'delete_file' : options.candidateRewrite && turn === 3 ? 'create_file'
          : canSubmit && turn >= 3 ? 'submit_candidate' : 'replace_text';
      let repairName = repairing ? turn === 1 ? 'record_candidate_decision' : turn === 2 ? 'replace_text' : 'submit_candidate' : name;
      let args = planning ? options.correctnessPlanProposal ?? { status: 'ready', summary: '核对常量函数的精确整数结果',
        cases: [{ case_id: 'constant-result', parameters: { expected: 2 } }], oracle_description: '独立数学参考：整数 1 + 1 = 2，逐次核对返回值。',
        tolerance_rule: 'exact integer equality', tolerance_absolute: 0, tolerance_relative: 0,
        rationale: '公开签名无输入参数；常量整数计算应精确相等，零误差。', assumptions: ['这是离线测试夹具方案，不是产品实验结果。'], evidence_files: ['kernel.c'] }
        : validation ? options.validationProposal ?? { status: 'ready', correctness_script: '#!/bin/sh\nprintf "review oracle before use\\n" >&2\nexit 1\n',
        performance_script: '#!/bin/sh\nprintf "review benchmark before use\\n" >&2\nexit 1\n',
        cases: [{ case_id: 'small', parameters: { size: 8 }, threads: 1, input_generation: '无参数常量函数；独立整数参考为 2，无随机输入。' }],
        workloads: [{ workload_id: 'small', parameters: { size: 8 }, threads: 1, critical: true, weight: 1 }],
        oracle_description: 'Fixture draft requires independent review', benchmark_description: 'Fixture benchmark requires review',
        tolerance_rule: 'exact', tolerance_absolute: 0, tolerance_relative: 0, candidate_artifact: 'build/libkernel.so',
        test_plan: { resources: { cpu_set: '999' }, seed: 999 },
        supporting_files: [{ path: 'support/reference.c', content: 'int independent_reference(void) { return 2; }\n' },
          { path: 'support/test-correctness.py', content: 'from corepilot_test import TestContext\nctx = TestContext.for_correctness(__file__)\nlib = ctx.load_library()\nctx.emit_correctness(lib.kernel() == 2)\n' },
          { path: 'support/test-performance.py', content: '# Offline generation fixture; not a measurement result.\n' }] }
        : probe ? { ready: true } : name === 'record_hypothesis'
        ? { ...hypothesisProposal('Fold constant source expression'), parent_hypothesis_id: null }
        : name === 'submit_candidate' ? { summary: 'Completed the constant-folding Candidate.' }
          : name === 'delete_file' ? { path: 'kernel.c' } : name === 'create_file' ? { path: 'kernel.c', content: 'int kernel(void) { return 2; }\n' }
            : { path: 'kernel.c', old_text: 'return 1 + 1', new_text: 'return 2' };
      if (validation && options.validationMissingImportFirst && modelRequests.validationBodies.length === 1) {
        const files = (args as { supporting_files?: Array<{ path: string; content: string }> }).supporting_files;
        const source = files?.find(file => file.path === 'support/test-correctness.py');
        if (source) source.content = 'ctypes.c_int\n' + source.content;
      }
      if (repairing) {
        const record = service.list(1)[0];
        args = turn === 1 ? { candidate_id: record.candidate_id, experiment_id: record.experiment_id, action: 'REPAIR', reason: 'Recheck the observed fixture correctness failure.' }
          : turn === 2 ? { path: 'kernel.c', old_text: 'return 2', new_text: 'return 2 /* fixture repaired */' } : { summary: 'Complete repaired fixture source.' };
      }
      if (options.candidateOnlyArtifact && !probe && !validation && !planning) {
        if (turn === 2) { repairName = 'create_file'; args = { path: 'temporary.o', content: 'not source' }; }
        else if (turn === 3) { repairName = 'submit_candidate'; args = { summary: 'No source was changed.' }; }
        else if (turn >= 4) { repairName = 'finish_optimization'; args = { reason: 'No source change remains.' }; }
      }
      response.setHeader('content-type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ id: `fixture-${turn}`, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${turn}`, type: 'function', function: { name: repairName, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 }, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address(); assert.ok(address && typeof address === 'object');
  const command = (script: string) => ({ executable: process.execPath, args: ['-e', script], cwd: '.', environment: {}, timeout_ms: 10_000 });
  const correctness = command("const s=require('node:fs').readFileSync('kernel.c','utf8');if(!s.includes('return 2'))process.exit(1);console.log('correctness fixture PASS')");
  const testpack = {
    schema_version: 1, testpack_id: 'web-fixture', function_name: 'kernel', function_family: 'fixture', operation: 'fold', data_type: 'int32',
    resources: { cpu_set: '0', numa_nodes: [0], thread_counts: [1] },
    correctness: { command: correctness, cases: [{ case_id: 'c1', parameters: { size: 1 }, threads: 1, critical: true, weight: 1, args: ['c1'] }], pass_required: 1 },
    performance: { command: command('console.log(JSON.stringify([{case_id:"p1",baseline_samples:[10,11,9],candidate_samples:[5,6,4]}]))'),
      cases: [{ case_id: 'p1', parameters: { size: 1 }, threads: 1, critical: true, weight: 1 }], sampling: { warmup: 0, samples: 3, interleave_seed: 1, bootstrap_iterations: 100 },
      baselines: { current: { id: 'current', library: 'fixture', version: '1', sha256: '0'.repeat(64), path: '/fixture/current' }, comparison: { id: 'base', library: 'fixture', version: '1', sha256: '1'.repeat(64), path: '/fixture/baseline' } },
      thresholds: { weighted_geomean_min: 1.1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: 0.95 }, key_cases: ['p1'] },
    revalidation: { formal: { required: true, timeout_ms: 10_000, command: correctness }, independent: { required: true, timeout_ms: 10_000, command: correctness } },
  };
  const testpackPath = path.join(root, 'testpack.json'); fs.writeFileSync(testpackPath, JSON.stringify(testpack));
  const configPath = path.join(root, 'corepilot.yaml');
  fs.writeFileSync(configPath, JSON.stringify({ model: { endpoint: `http://127.0.0.1:${address.port}/v1`, model_id: 'fixture-model', api_key: 'fixture-model-secret', timeout_ms: 10_000 },
    target: { ssh_alias: 'fixture', workspace_root: '/tmp/fixture' }, build: command("console.log('build fixture')"), validation: { testpack: testpackPath }, output_dir: path.join(root, 'reports') }));
  const store = new SqliteTaskStore(path.join(root, 'db.sqlite')); store.init();
  const controlIdentity = ControlIdentityGuard.initialize(store, dataDir);
  const host = new TaskHost(store); await host.start();
  const service = new OptimizationWorkflowService({ store, evidenceRoot: path.join(root, 'evidence'), publicExecution: options.execute === true, publicMaxRounds: 1,
    ...(options.rpcTransport ? { publicValidationTransportFactory: () => options.rpcTransport! } : {}),
    transportFactory: () => ({ transport_type: 'mock', runRemote: () => { throw new Error('offline fixture must not SSH'); } }) });
  const projects = new ProjectService(store, dataDir);
  const testing = options.testingService ?? new TestingService({ dataDir, projects, catalog: projects.packageLoader, machines: projects.machines });
  const token = 'fixture-server-access';
  const server = createHttpServer(host, { host: '127.0.0.1', port: 0, workflowService: service, projectService: projects, testingService: testing, controlIdentity, accessToken: token,
    webRoot: path.join(repositoryRoot, 'web', 'dist') });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const control = server.address(); assert.ok(control && typeof control === 'object');
  const url = `http://127.0.0.1:${control.port}`;
  function readyValidation(project: ProjectRecord, packageId: string, version: string, targetId: string) {
    const draft = projects.validationAssets.get(project, packageId, version, targetId);
    return projects.validationAssets.save(project, packageId, version, targetId, { ...draft, source: 'edited', expected_digest: draft.evaluator_digest,
      cases: [{ case_id: 'kernel-check', parameters: {}, threads: 1 }], oracle_description: 'Independent integer arithmetic reference: the fixture kernel must return 2.',
      tolerance_rule: 'exact integer equality', tolerance_absolute: 0, tolerance_relative: 0 });
  }
  async function close() {
    await service.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await host.stop();
    await new Promise<void>(resolve => model.close(() => resolve()));
    const worktrees = git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
    for (const worktree of worktrees) if (path.resolve(worktree) !== path.resolve(repo)) git('worktree', 'remove', '--force', worktree);
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { root, repo, configPath, dataDir, store, service, projects, testing, controlIdentity, token, url, git, close, modelRequests, readyValidation };
}

export function runFixtureCli(url: string, token: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(repositoryRoot, 'src', 'entry.ts'), ...args], {
      cwd: repositoryRoot, windowsHide: true, env: { ...process.env, COREPILOT_SERVER_URL: url, COREPILOT_SERVER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}
