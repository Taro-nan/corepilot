import fs from 'node:fs';
import path from 'node:path';
import type { EvaluatorQualificationState, TargetQualificationResult } from '../src/contracts/formal-evaluator.js';
import { evaluatorContentSha256 } from '../src/evaluator/formal-evaluator.js';

export interface FormalEvaluatorFixtureOptions {
  domain?: 'sgemv' | 'saxpy';
  state?: EvaluatorQualificationState;
  targetResult?: TargetQualificationResult;
  tamperOnCorrectness?: boolean;
  correctnessValue?: 'PASS' | 'FAIL';
  warmupCount?: number;
  sampleCount?: number;
  reportedCaseId?: string;
  omitThreads?: 'CORRECTNESS' | 'PERFORMANCE';
  omitParameter?: { phase: 'CORRECTNESS' | 'PERFORMANCE'; name: string };
  reportedThreads?: { phase: 'CORRECTNESS' | 'PERFORMANCE'; value: number };
  correctnessExitCode?: number;
  correctnessHang?: boolean;
  omitCorrectnessValue?: boolean;
}

export function createFormalEvaluatorFixture(root: string, options: FormalEvaluatorFixtureOptions = {}) {
  const domain = options.domain ?? 'sgemv';
  const state = options.state ?? 'QUALIFIED';
  const warmupCount = options.warmupCount ?? 1;
  const sampleCount = options.sampleCount ?? 3;
  const caseDefinition = domain === 'saxpy'
    ? { case_id: 'case-1', parameters: { n: 17, incx: 1, incy: 2, alpha: 0.5, seed: 1 }, threads: 1 }
    : { case_id: 'case-1', m: 1, n: 1, lda: 1, incx: 1, incy: 1, alpha: 1, beta: 0, threads: 1, seed: 1 };
  const workload = domain === 'saxpy'
    ? { workload_id: 'workload-1', parameters: { n: 4096, incx: 1, incy: 1, alpha: 0.75, loops: 20, seed: 2 }, threads: 1, critical: true, weight: 1 }
    : { workload_id: 'workload-1', m: 2, n: 3, lda: 2, incx: 1, incy: 1, alpha: 1, beta: 0, threads: 1, loops: 1, seed: 2, critical: true, weight: 1 };
  const correctnessArguments = domain === 'saxpy'
    ? ['case_id', 'artifact_path', 'n', 'incx', 'incy', 'alpha', 'threads', 'seed', 'runtime_root']
    : ['case_id', 'artifact_path', 'm', 'n', 'lda', 'incx', 'incy', 'alpha', 'beta', 'threads', 'seed', 'runtime_root'];
  const performanceArguments = domain === 'saxpy'
    ? ['phase', 'role', 'workload_id', 'artifact_path', 'n', 'incx', 'incy', 'alpha', 'threads', 'loops', 'seed', 'iteration_index', 'runtime_root']
    : ['phase', 'role', 'workload_id', 'artifact_path', 'm', 'n', 'lda', 'incx', 'incy', 'alpha', 'beta', 'threads', 'loops', 'seed', 'iteration_index', 'runtime_root'];
  const api = domain === 'saxpy' ? 'cblas_saxpy' : 'cblas_sgemv';
  const resolvedPathField = `resolved_${api}_path`;
  const correctnessParameterSource = domain === 'saxpy'
    ? 'const p={n:+a[2],incx:+a[3],incy:+a[4],alpha:+a[5],threads:+a[6],seed:+a[7]};'
    : 'const p={m:+a[2],n:+a[3],lda:+a[4],incx:+a[5],incy:+a[6],alpha:+a[7],beta:+a[8],threads:+a[9],seed:+a[10]};';
  const performanceParameterSource = domain === 'saxpy'
    ? 'const p={n:+a[4],incx:+a[5],incy:+a[6],alpha:+a[7],threads:+a[8],loops:+a[9],seed:+a[10]};'
    : 'const p={m:+a[4],n:+a[5],lda:+a[6],incx:+a[7],incy:+a[8],alpha:+a[9],beta:+a[10],threads:+a[11],loops:+a[12],seed:+a[13]};';
  const performanceIndex = domain === 'saxpy' ? 11 : 14;
  const requiredFiles = [
    'qualification.json',
    'correctness/cases.json',
    'correctness/policy.json',
    'benchmark/workloads.json',
    'benchmark/policy.json',
    'benchmark/output-schema.json',
    'scripts/build-evaluator.sh',
    'scripts/run-correctness.sh',
    'scripts/run-performance.sh',
    'oracle.txt',
  ];
  fs.mkdirSync(path.join(root, 'correctness'), { recursive: true });
  fs.mkdirSync(path.join(root, 'benchmark'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeJson(path.join(root, 'correctness/cases.json'), { schema_version: 1, cases: [caseDefinition] });
  writeJson(path.join(root, 'correctness/policy.json'), { schema_version: 1, argument_contract: correctnessArguments });
  writeJson(path.join(root, 'benchmark/workloads.json'), { schema_version: 1, workloads: [workload] });
  writeJson(path.join(root, 'benchmark/policy.json'), { schema_version: 1, argument_contract: performanceArguments });
  writeJson(path.join(root, 'benchmark/output-schema.json'), {
    schema_version: 1,
    line_prefix: 'PHYOPT_MEASUREMENT',
    required_fields: ['kind', 'role', 'subject_id', 'sample_index', 'value', 'unit', 'validity', 'domain_payload'],
  });
  fs.writeFileSync(path.join(root, 'oracle.txt'), 'fixture oracle\n');

  fs.writeFileSync(path.join(root, 'scripts/build-evaluator.sh'), `#!/usr/bin/env node
require('node:fs').mkdirSync(process.argv[2],{recursive:true});
`);
  fs.writeFileSync(path.join(root, 'scripts/run-correctness.sh'), `#!/usr/bin/env node
// PHYOPT_ARGUMENT_CONTRACT: ${correctnessArguments.join(',')}
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
${options.correctnessHang ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);' : ''}
${options.correctnessExitCode !== undefined ? `process.stderr.write('fixture evaluator execution failed');process.exit(${options.correctnessExitCode});` : ''}
${options.tamperOnCorrectness ? "fs.writeFileSync(path.join(__dirname,'tampered.txt'),'tampered');" : "fs.readFileSync(path.join(__dirname,'..','oracle.txt'));"}
const a=process.argv.slice(2);${correctnessParameterSource}const artifactSha=crypto.createHash('sha256').update(fs.readFileSync(a[1])).digest('hex');
${options.omitThreads === 'CORRECTNESS' ? 'delete p.threads;' : ''}
${options.omitParameter?.phase === 'CORRECTNESS' ? `delete p[${JSON.stringify(options.omitParameter.name)}];` : ''}
${options.reportedThreads?.phase === 'CORRECTNESS' ? `p.threads=${options.reportedThreads.value};` : ''}
console.log('PHYOPT_MEASUREMENT '+JSON.stringify({kind:'CORRECTNESS_CASE',role:'EVALUATOR',subject_id:${JSON.stringify(options.reportedCaseId ?? null)}??a[0],sample_index:null,value:${options.omitCorrectnessValue ? 'undefined' : JSON.stringify(options.correctnessValue ?? 'PASS')},unit:null,validity:'VALID',domain_payload:{parameters:p,error_reason:null,observed_summary:{max_abs_error:0},reference_summary:{implementation:'fixture'},artifact_identity:{input_path:a[1],sha256:artifactSha,${resolvedPathField}:a[1]},evaluator_binary_identity:{sha256:'${'b'.repeat(64)}'}}}));
`);
  fs.writeFileSync(path.join(root, 'scripts/run-performance.sh'), `#!/usr/bin/env node
// PHYOPT_ARGUMENT_CONTRACT: ${performanceArguments.join(',')}
const fs=require('node:fs'),crypto=require('node:crypto');const a=process.argv.slice(2);const phase=a[0],role=a[1],index=+a[${performanceIndex}];
if(phase==='sample'){const values=role==='BASELINE'?[9,3,6,12,15,18,21]:[4,2,8,10,12,14,16];${performanceParameterSource}${options.omitThreads === 'PERFORMANCE' ? 'delete p.threads;' : ''}${options.omitParameter?.phase === 'PERFORMANCE' ? `delete p[${JSON.stringify(options.omitParameter.name)}];` : ''}${options.reportedThreads?.phase === 'PERFORMANCE' ? `p.threads=${options.reportedThreads.value};` : ''}const artifactSha=crypto.createHash('sha256').update(fs.readFileSync(a[3])).digest('hex');console.log('PHYOPT_MEASUREMENT '+JSON.stringify({kind:'PERFORMANCE_SAMPLE',role,subject_id:a[2],sample_index:index,value:values[index]??index+1,unit:'seconds',validity:'VALID',domain_payload:{parameters:p,elapsed_seconds:values[index]??index+1,latency_seconds:values[index]??index+1,gflops:1,artifact_identity:{input_path:a[3],sha256:artifactSha,${resolvedPathField}:a[3]},benchmark_identity:{sha256:'${'e'.repeat(64)}'}}}));}
`);

  writeJson(path.join(root, 'qualification.json'), {});

  const manifest = {
    schema_version: 1,
    evaluator_id: 'evaluator:test',
    version: '1.0.0',
    owner: 'test-owner',
    domain: domain === 'saxpy'
      ? { name: 'SAXPY', api, layout: 'strided-vectors', operation: 'y=alpha*x+y', datatype: 'float32' }
      : { name: 'SGEMV-N', api, layout: 'column-major', operation: 'NoTrans', datatype: 'float32' },
    target: { platform: 'S5000C', build_target: 'FT2000', compatibility_scope: 'test fixture' },
    digest_algorithm: 'phyopt-evaluator-content-sha256-v1',
    digest: '0'.repeat(64),
    qualification: { record: 'qualification.json', requires_target_qualification: true, requires_owner_approval: true },
    correctness: {
      definition: 'fixture correctness', inventory: 'correctness/cases.json', case_ids: ['case-1'],
      command: { executable: process.execPath, script: 'scripts/run-correctness.sh', arguments: correctnessArguments, measurement_prefix: 'PHYOPT_MEASUREMENT' },
      reference: { implementation: 'oracle.txt', accumulation: 'float64', qualification_required: true },
      tolerance: { rule: 'fixture exact', absolute: 0, relative: 0, qualification_required: true },
    },
    performance: {
      definition: 'fixture live symmetric benchmark', inventory: 'benchmark/workloads.json', workload_ids: ['workload-1'],
      command: { executable: process.execPath, script: 'scripts/run-performance.sh', arguments: performanceArguments, measurement_prefix: 'PHYOPT_MEASUREMENT' },
      sampling: { warmup_count: warmupCount, sample_count: sampleCount, statistic: 'median', process_model: 'one-process-per-sample' },
      measurement: { unit: 'seconds', value: 'latency_seconds', derived: ['median'], raw_samples_retained: true, output_schema: 'benchmark/output-schema.json' },
    },
    resource_requirements: { cpu_set: '0', numa_node: 0, thread_counts: [1], enforcement: { threads: 'NOT_ENFORCED', cpu_set: 'NOT_ENFORCED', numa_node: 'NOT_ENFORCED' } },
    baseline_definition: { mode: 'live-symmetric-execution', historical_measurements_are_formal_evidence: false, identity_required: ['sha256'], symmetry_required: ['workload', 'sampling'] },
    acceptance_policy: { correctness: 'all pass', performance: 'median', regression: 'live baseline only' },
    artifact_identity_policy: {
      required_files: requiredFiles,
      source_files: ['scripts/run-correctness.sh', 'scripts/run-performance.sh'],
      benchmark_binary: 'record sha256', candidate_binary: 'record sha256', baseline_binary: 'record sha256', runtime_resolution: 'fixture path',
      mutable_dependencies: 'explicit-artifact-inputs-only',
    },
  };
  writeJson(path.join(root, 'manifest.json'), manifest);
  manifest.digest = evaluatorContentSha256(root);
  writeJson(path.join(root, 'manifest.json'), manifest);
  const targetResult = options.targetResult ?? (state === 'QUALIFIED' || state === 'TARGET_VALIDATED' ? 'TARGET_EXECUTION_PASSED' : 'NOT_RUN');
  const targetPassed = targetResult === 'TARGET_EXECUTION_PASSED';
  writeJson(path.join(root, 'qualification.json'), {
    schema_version: 1,
    evaluator_id: 'evaluator:test',
    version: '1.0.0',
    subject_digest: manifest.digest,
    status: state,
    target: {
      platform: 'S5000C',
      build_target: 'FT2000',
      compatibility_scope: 'test fixture',
      machine_identity_sha256: targetPassed ? 'c'.repeat(64) : null,
    },
    qualification_run: {
      run_id: targetPassed ? 'qualification-run:test' : null,
      result: targetResult,
      started_at: targetPassed ? '2026-09-28T00:00:00.000Z' : null,
      completed_at: targetPassed ? '2026-09-28T00:01:00.000Z' : null,
    },
    owner: 'test-owner',
    reviewer: state === 'QUALIFIED' ? 'test-reviewer' : null,
    approved_at: state === 'QUALIFIED' ? '2026-09-28T00:02:00.000Z' : null,
    evidence: {
      report_sha256: targetPassed ? 'd'.repeat(64) : null,
      raw_measurements_sha256: targetPassed ? 'e'.repeat(64) : null,
    },
    updated_at: '2026-09-28T00:00:00.000Z',
    checks: [
      { check_id: 'static', scope: 'STATIC', status: 'PASS', summary: 'fixture static checks' },
      { check_id: 'target', scope: 'TARGET', status: targetPassed ? 'PASS' : 'REQUIRES_TARGET_QUALIFICATION', summary: 'fixture target checks' },
    ],
  });
  return { root, digest: manifest.digest, manifest, caseDefinition, workload };
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
