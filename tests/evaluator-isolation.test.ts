import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  parseOptimizationConfig,
  redactOptimizationConfig,
  resolveRunnerConfig,
} from '../src/config/optimization-config.js';
import { evaluatorBundleSha256 } from '../src/evaluator/formal-evaluator.js';
import { summarizeValidationTestpack } from '../src/testpack/validation-freeze.js';
import { loadValidationTestpack, ValidationTestpackError } from '../src/testpack/validation-yaml.js';
import { loadPublicOptimizationPreflight } from '../src/workflow/public-optimization.js';
import { stageRemoteBaseline } from '../src/workspace/validation-runner.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';

const samplePath = path.resolve('testpacks/sgemv-n.yaml');

test('loads a content-addressed evaluator bundle and rejects command escape or content drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-evaluator-contract-'));
  const evaluatorRoot = path.join(root, 'evaluator');
  fs.mkdirSync(evaluatorRoot);
  createFormalEvaluatorFixture(evaluatorRoot);
  const raw = parseYaml(fs.readFileSync(samplePath, 'utf8')) as Record<string, unknown>;
  raw.evaluator = {
    id: 'evaluator:test',
    version: '1.0.0',
    owner: 'performance-validation-team',
    root: evaluatorRoot,
    sha256: evaluatorBundleSha256(evaluatorRoot),
  };
  const commands = [
    (raw.correctness as Record<string, unknown>).command,
    (raw.performance as Record<string, unknown>).command,
    ((raw.revalidation as Record<string, unknown>).formal as Record<string, unknown>).command,
    ((raw.revalidation as Record<string, unknown>).independent as Record<string, unknown>).command,
  ] as Array<Record<string, unknown>>;
  for (const command of commands) command.cwd = evaluatorRoot;
  const currentBaseline = (((raw.performance as Record<string, unknown>).baselines as Record<string, unknown>).current as Record<string, unknown>);
  currentBaseline.path = '${PHYOPT_CANDIDATE_ROOT}/candidate.so';
  const testpackPath = path.join(root, 'testpack.yaml');
  fs.writeFileSync(testpackPath, stringifyYaml(raw));

  const loaded = loadValidationTestpack(testpackPath);
  assert.equal(loaded.testpack.evaluator?.owner, 'performance-validation-team');
  assert.equal(loaded.testpack.performance.baselines.current.path, '${PHYOPT_CANDIDATE_ROOT}/candidate.so');
  assert.equal((summarizeValidationTestpack(loaded.testpack).evaluator as { id: string }).id, 'evaluator:test');

  commands[1].cwd = root;
  fs.writeFileSync(testpackPath, stringifyYaml(raw));
  assert.throws(
    () => loadValidationTestpack(testpackPath),
    (error: unknown) => error instanceof ValidationTestpackError && /outside evaluator\.root/.test(error.message),
  );

  commands[1].cwd = evaluatorRoot;
  fs.writeFileSync(testpackPath, stringifyYaml(raw));
  fs.writeFileSync(path.join(evaluatorRoot, 'oracle.txt'), 'candidate-controlled oracle\n');
  assert.throws(
    () => loadValidationTestpack(testpackPath),
    (error: unknown) => error instanceof ValidationTestpackError && /evaluator bundle digest mismatch/.test(error.message),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('stages a known remote Baseline outside Candidate with source and destination identity checks', async () => {
  const digest = 'a'.repeat(64);
  const stagedPath = `/srv/phyopt/run/baselines/openblas/1/${digest}/artifact.so`;
  const calls: string[][] = [];
  const staged = await stageRemoteBaseline({
    sourceArtifact: '/opt/baselines/libopenblas.so',
    expectedDigest: digest,
    remoteWorkspace: `/srv/phyopt/run/baselines/openblas/1/${digest}`,
    transport: {
      runRemote(argv) {
        calls.push(argv);
        if (calls.length === 1) return { command: 'ssh', argv, stdout: `${digest}  /opt/baselines/libopenblas.so\n`, stderr: '', exit_code: 0 };
        if (calls.length === 2) return { command: 'ssh', argv, stdout: '', stderr: '', exit_code: 0 };
        return { command: 'ssh', argv, stdout: `${digest}  ${stagedPath}\n`, stderr: '', exit_code: 0 };
      },
    },
  });
  assert.deepEqual(staged, { remote_artifact: stagedPath, digest });
  assert.equal(calls.length, 3);
  assert.match(calls[1][2], /mkdir -p/);
  assert.doesNotMatch(calls[1][2], /rm -rf/);

  await assert.rejects(
    () => stageRemoteBaseline({
      sourceArtifact: '/opt/baselines/libopenblas.so',
      expectedDigest: digest,
      remoteWorkspace: '/srv/phyopt/run/baselines/mismatch',
      transport: {
        runRemote(argv) {
          return { command: 'ssh', argv, stdout: `${'b'.repeat(64)}  /opt/baselines/libopenblas.so\n`, stderr: '', exit_code: 0 };
        },
      },
    }),
    /baseline source digest mismatch/,
  );
});

test('RPC preflight rejects a legacy testpack without a trusted evaluator before external calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-public-rpc-preflight-'));
  const config = path.join(root, 'phyopt.yaml');
  const testpack = samplePath.replace(/\\/g, '/');
  fs.writeFileSync(config, `model:\n  model_id: test-model\n  api_key: test-key\n  endpoint: https://example.invalid/v1\n  timeout_ms: 1000\ntarget:\n  ssh_alias: target\n  workspace_root: /tmp/phyopt\nbuild:\n  executable: make\n  args: []\n  cwd: .\n  environment: {}\n  timeout_ms: 1000\nvalidation:\n  testpack: ${testpack}\nrunner:\n  mode: rpc\n  endpoint: http://127.0.0.1:4318\n  token: runner-token\noutput_dir: ./.phyopt/runs\n`);
  assert.throws(
    () => loadPublicOptimizationPreflight({ function_name: 'cblas_sgemv', config_path: config, repository_root: root }, { env: {} }),
    /RPC formal execution requires testpack\.evaluator/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolves RPC credentials only at execution time and redacts direct secrets', () => {
  const base = {
    model: { model_id: 'test-model', api_key: 'test-key', endpoint: 'https://example.invalid/v1', timeout_ms: 1_000 },
    target: { ssh_alias: 'target', workspace_root: '/tmp/phyopt' },
    build: { executable: 'make', args: [], cwd: '.', environment: {}, timeout_ms: 1_000 },
    validation: { testpack: './testpack.yaml' },
    output_dir: './runs',
  };
  const referenced = parseOptimizationConfig({
    ...base,
    runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:4318/', token: '${PHYOPT_RUNNER_TOKEN}', request_timeout_ms: 12_000, poll_interval_ms: 50 },
  });
  assert.deepEqual(resolveRunnerConfig(referenced, { env: { PHYOPT_RUNNER_TOKEN: 'runner-secret' } }), {
    mode: 'rpc', endpoint: 'http://127.0.0.1:4318', token: 'runner-secret', requestTimeoutMs: 12_000, pollIntervalMs: 50,
  });
  assert.equal((redactOptimizationConfig(referenced).runner as { token: string }).token, '${PHYOPT_RUNNER_TOKEN}');
  assert.throws(() => resolveRunnerConfig(referenced, { env: {} }), /PHYOPT_RUNNER_TOKEN/);

  const direct = parseOptimizationConfig({ ...base, runner: { mode: 'rpc', endpoint: 'https://runner.example', token: 'direct-secret' } });
  assert.equal((redactOptimizationConfig(direct).runner as { token: string }).token, '[redacted]');
  assert.doesNotMatch(JSON.stringify(redactOptimizationConfig(direct)), /direct-secret/);
  assert.throws(
    () => parseOptimizationConfig({ ...base, runner: { mode: 'rpc', endpoint: 'ssh://runner.example', token: 'secret' } }),
    /runner\.endpoint must use http or https/,
  );
});

test('accepts zero model timeout as an explicit unbounded model-call setting', () => {
  const config = parseOptimizationConfig({
    model: {
      model_id: 'test-model',
      endpoint: 'https://example.invalid/v1',
      max_output_tokens: 4_096,
      timeout_ms: 0,
      inactivity_timeout_ms: 120_000,
    },
    target: { ssh_alias: 'target', workspace_root: '/tmp/phyopt' },
    build: { executable: 'make', args: [], cwd: '.', environment: {}, timeout_ms: 1_000 },
    validation: { testpack: './testpack.yaml' },
    output_dir: './runs',
  });
  assert.equal(config.model.timeout_ms, 0);
  assert.equal(config.model.max_output_tokens, 4_096);
  assert.equal(config.model.inactivity_timeout_ms, 120_000);
});
