#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import childProcess from 'child_process';

const { createHash, randomBytes } = crypto;
const { spawnSync } = childProcess;

const DIGEST_PLACEHOLDER = '0'.repeat(64);
const MEASUREMENT_PREFIX = 'PHYOPT_MEASUREMENT ';
const WARMUP_PREFIX = 'PHYOPT_WARMUP ';
const COMMAND_TIMEOUT_MS = Number.parseInt(process.env.PHYOPT_QUALIFICATION_COMMAND_TIMEOUT_MS || '1800000', 10);

const [mode, ...args] = process.argv.slice(2);
if (mode === 'verify-content') {
  if (args.length !== 1) failUsage('verify-content requires BUNDLE_ROOT');
  const result = verifyContent(path.resolve(args[0]));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 2;
} else if (mode === 'run') {
  if (args.length !== 6) failUsage('run requires BUNDLE_ROOT CANDIDATE_LIBRARY BASELINE_LIBRARY OUTPUT_ROOT CANDIDATE_SHA256 BASELINE_SHA256');
  process.exitCode = runQualification({
    bundleRoot: path.resolve(args[0]),
    candidateLibrary: path.resolve(args[1]),
    baselineLibrary: path.resolve(args[2]),
    outputRoot: path.resolve(args[3]),
    candidateSha256: normalizedSha256(args[4], 'candidate SHA-256'),
    baselineSha256: normalizedSha256(args[5], 'baseline SHA-256'),
  });
} else {
  failUsage('expected verify-content or run');
}

function failUsage(detail) {
  throw new Error(`qualification-runner ${detail}`);
}

function runQualification(input) {
  fs.mkdirSync(input.outputRoot, { recursive: true });
  const files = {
    commands: path.join(input.outputRoot, 'commands.jsonl'),
    correctness: path.join(input.outputRoot, 'correctness-measurements.jsonl'),
    warmups: path.join(input.outputRoot, 'warmup-observations.jsonl'),
    performance: path.join(input.outputRoot, 'performance-raw-measurements.jsonl'),
    report: path.join(input.outputRoot, 'qualification-result.json'),
  };
  for (const file of [files.commands, files.correctness, files.warmups, files.performance]) fs.writeFileSync(file, '');

  const startedAt = new Date().toISOString();
  const configuredRunId = process.env.PHYOPT_QUALIFICATION_RUN_ID;
  const runId = (configuredRunId && configuredRunId.trim()) || `qualification-run:${randomUuid()}`;
  const errors = [];
  const warnings = [];
  const machine = machineContext();
  const machineIdentity = sha256Text(stableJson(machine));
  let manifest = null;
  let attestation = null;
  let verification = null;
  let initialContentDigest = null;
  let finalContentDigest = null;
  let contentChecks = 0;
  let artifactChecks = 0;
  const candidateIdentity = artifactIdentity(input.candidateLibrary, input.candidateSha256);
  const baselineIdentity = artifactIdentity(input.baselineLibrary, input.baselineSha256);
  let harnessIdentities = null;
  const correctnessByRole = {
    CANDIDATE: { executed_case_ids: [], passed_case_ids: [], resolved_artifact_paths: new Set() },
    BASELINE: { executed_case_ids: [], passed_case_ids: [], resolved_artifact_paths: new Set() },
  };
  const warmupKeys = [];
  const rawSamples = [];
  let benchmarkIdentity = null;

  const assertContent = (label) => {
    const observed = evaluatorContentDigest(input.bundleRoot);
    contentChecks += 1;
    if (initialContentDigest !== null && observed !== initialContentDigest) {
      throw new Error(`evaluator content changed ${label}: expected ${initialContentDigest}, observed ${observed}`);
    }
    return observed;
  };
  const assertArtifact = (artifactPath, expected, label) => {
    const observed = sha256File(artifactPath);
    artifactChecks += 1;
    if (observed !== expected) throw new Error(`${label} artifact changed: expected ${expected}, observed ${observed}`);
    return observed;
  };
  const execute = (label, script, commandArgs, artifact = null) => {
    assertContent(`before ${label}`);
    if (artifact) assertArtifact(artifact.path, artifact.sha256, `before ${label}`);
    const commandStarted = new Date();
    const result = spawnSync('bash', [script, ...commandArgs.map(String)], {
      encoding: 'utf8',
      env: process.env,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    const commandEnded = new Date();
    appendJsonLine(files.commands, {
      label,
      executable: 'bash',
      args: [script, ...commandArgs.map(String)],
      started_at: commandStarted.toISOString(),
      completed_at: commandEnded.toISOString(),
      duration_ms: commandEnded.getTime() - commandStarted.getTime(),
      exit_code: result.status,
      signal: result.signal,
      timed_out: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
      stdout: result.stdout == null ? '' : result.stdout,
      stderr: result.stderr == null ? '' : result.stderr,
      error: result.error ? result.error.message : null,
    });
    assertContent(`after ${label}`);
    if (artifact) assertArtifact(artifact.path, artifact.sha256, `after ${label}`);
    return result;
  };

  try {
    verification = verifyContent(input.bundleRoot);
    if (!verification.valid) throw new Error(`evaluator content verification failed: ${verification.problems.join('; ')}`);
    manifest = readJson(path.join(input.bundleRoot, 'manifest.json'));
    attestation = readJson(path.join(input.bundleRoot, 'qualification.json'));
    initialContentDigest = verification.observed_content_digest;
    assertArtifact(input.candidateLibrary, input.candidateSha256, 'initial Candidate');
    assertArtifact(input.baselineLibrary, input.baselineSha256, 'initial Baseline');

    const cases = readJson(path.join(input.bundleRoot, manifest.correctness.inventory)).cases;
    const workloads = readJson(path.join(input.bundleRoot, manifest.performance.inventory)).workloads;
    const runtimeRoot = path.join(input.outputRoot, 'runtime');
    const buildScript = path.join(input.bundleRoot, 'scripts', 'build-evaluator.sh');
    const correctnessScript = path.join(input.bundleRoot, manifest.correctness.command.script);
    const performanceScript = path.join(input.bundleRoot, manifest.performance.command.script);

    const build = execute('build evaluator binaries', buildScript, [runtimeRoot]);
    requireCommandSuccess(build, 'evaluator build');
    const correctnessHarness = path.join(runtimeRoot, 'sgemv_correctness_formal');
    const benchmarkHarness = path.join(runtimeRoot, 'sgemv_bench_formal');
    harnessIdentities = {
      correctness: { path: correctnessHarness, sha256: sha256File(correctnessHarness) },
      benchmark: { path: benchmarkHarness, sha256: sha256File(benchmarkHarness) },
    };
    benchmarkIdentity = harnessIdentities.benchmark.sha256;

    for (const [role, artifact] of [
      ['CANDIDATE', candidateIdentity],
      ['BASELINE', baselineIdentity],
    ]) {
      for (const item of cases) {
        const result = execute(`correctness ${role} ${item.case_id}`, correctnessScript, [
          item.case_id, artifact.path, item.m, item.n, item.lda, item.incx, item.incy,
          item.alpha, item.beta, item.threads, item.seed, runtimeRoot,
        ], artifact);
        const measurement = parseSinglePrefixed(result.stdout == null ? '' : result.stdout, MEASUREMENT_PREFIX, `correctness ${role} ${item.case_id}`);
        appendJsonLine(files.correctness, { qualification_role: role, ...measurement });
        validateCorrectnessMeasurement(measurement, item, artifact, harnessIdentities.correctness.sha256);
        correctnessByRole[role].executed_case_ids.push(measurement.subject_id);
        if (measurement.value === 'PASS' && measurement.validity === 'VALID') correctnessByRole[role].passed_case_ids.push(measurement.subject_id);
        correctnessByRole[role].resolved_artifact_paths.add(measurement.domain_payload.artifact_identity.resolved_cblas_sgemv_path);
        requireCommandSuccess(result, `correctness ${role} ${item.case_id}`);
      }
      assertExactIds(cases.map((item) => item.case_id), correctnessByRole[role].executed_case_ids, `${role} correctness inventory`);
      if (correctnessByRole[role].passed_case_ids.length !== cases.length) throw new Error(`${role} correctness did not pass all ${cases.length} cases`);
    }

    for (const workload of workloads) {
      for (let index = 0; index < manifest.performance.sampling.warmup_count; index += 1) {
        for (const [role, artifact] of [['BASELINE', baselineIdentity], ['CANDIDATE', candidateIdentity]]) {
          const result = execute(`warmup ${workload.workload_id} ${role} ${index}`, performanceScript, [
            'warmup', role, workload.workload_id, artifact.path, ...workloadArguments(workload), index, runtimeRoot,
          ], artifact);
          requireCommandSuccess(result, `warmup ${workload.workload_id} ${role} ${index}`);
          const observation = parseSinglePrefixed(result.stdout == null ? '' : result.stdout, WARMUP_PREFIX, `warmup ${workload.workload_id} ${role} ${index}`);
          validateWarmup(observation, workload, role, index);
          appendJsonLine(files.warmups, observation);
          warmupKeys.push(`${workload.workload_id}\0${role}\0${index}`);
        }
      }
      for (let index = 0; index < manifest.performance.sampling.sample_count; index += 1) {
        for (const [role, artifact] of [['BASELINE', baselineIdentity], ['CANDIDATE', candidateIdentity]]) {
          const result = execute(`sample ${workload.workload_id} ${role} ${index}`, performanceScript, [
            'sample', role, workload.workload_id, artifact.path, ...workloadArguments(workload), index, runtimeRoot,
          ], artifact);
          const measurement = parseSinglePrefixed(result.stdout == null ? '' : result.stdout, MEASUREMENT_PREFIX, `sample ${workload.workload_id} ${role} ${index}`);
          appendJsonLine(files.performance, measurement);
          validatePerformanceMeasurement(measurement, workload, role, index, artifact, benchmarkIdentity);
          rawSamples.push(measurement);
          requireCommandSuccess(result, `sample ${workload.workload_id} ${role} ${index}`);
        }
      }
    }

    const expectedWarmups = workloads.length * 2 * manifest.performance.sampling.warmup_count;
    const expectedSamples = workloads.length * 2 * manifest.performance.sampling.sample_count;
    if (warmupKeys.length !== expectedWarmups) throw new Error(`expected ${expectedWarmups} warmups, observed ${warmupKeys.length}`);
    if (rawSamples.length !== expectedSamples) throw new Error(`expected ${expectedSamples} raw performance samples, observed ${rawSamples.length}`);
    const rereadSamples = readJsonLines(files.performance);
    if (rereadSamples.length !== expectedSamples) throw new Error('saved raw performance sample file is incomplete');
    assertPerformanceInventory(rereadSamples, workloads, manifest.performance.sampling.sample_count);

    finalContentDigest = assertContent('after qualification execution');
    assertArtifact(input.candidateLibrary, input.candidateSha256, 'final Candidate');
    assertArtifact(input.baselineLibrary, input.baselineSha256, 'final Baseline');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    try { finalContentDigest = evaluatorContentDigest(input.bundleRoot); } catch { finalContentDigest = null; }
  }

  const completedAt = new Date().toISOString();
  const savedCorrectness = readJsonLines(files.correctness);
  const savedWarmups = readJsonLines(files.warmups);
  const savedSamples = readJsonLines(files.performance);
  const medians = deriveMedians(savedSamples);
  const contentUnchanged = initialContentDigest !== null && finalContentDigest === initialContentDigest;
  const correctnessComplete = manifest !== null && ['CANDIDATE', 'BASELINE'].every((role) =>
    correctnessByRole[role].executed_case_ids.length === manifest.correctness.case_ids.length &&
    correctnessByRole[role].passed_case_ids.length === manifest.correctness.case_ids.length);
  const expectedSampleCount = manifest === null ? 0 : manifest.performance.workload_ids.length * 2 * manifest.performance.sampling.sample_count;
  const expectedWarmupCount = manifest === null ? 0 : manifest.performance.workload_ids.length * 2 * manifest.performance.sampling.warmup_count;
  const performanceComplete = savedSamples.length === expectedSampleCount && savedWarmups.length === expectedWarmupCount;
  const targetValidated = errors.length === 0 && contentUnchanged && correctnessComplete && performanceComplete;
  if (manifest && manifest.resource_requirements && manifest.resource_requirements.enforcement && Object.values(manifest.resource_requirements.enforcement).some((item) => item === 'NOT_ENFORCED')) {
    warnings.push('CPU, NUMA, or thread resource declarations include NOT_ENFORCED; no binding is claimed.');
  }

  const rawIdentities = {
    commands: fileIdentity(files.commands),
    correctness_measurements: fileIdentity(files.correctness),
    warmup_observations: fileIdentity(files.warmups),
    performance_raw_measurements: fileIdentity(files.performance),
  };
  const rawMeasurementsSha256 = sha256Text(`${fs.readFileSync(files.correctness, 'utf8')}\0${fs.readFileSync(files.performance, 'utf8')}`);
  const report = {
    schema_version: 1,
    qualification_run: { run_id: runId, started_at: startedAt, completed_at: completedAt },
    evaluator_identity: manifest ? { evaluator_id: manifest.evaluator_id, version: manifest.version } : null,
    subject_digest: initialContentDigest,
    declared_subject_digest: manifest ? manifest.digest : null,
    attestation_subject_digest: attestation ? attestation.subject_digest : null,
    attestation_status: attestation ? attestation.status : null,
    target_qualification_status: targetValidated ? 'TARGET_VALIDATED' : 'TARGET_EXECUTION_FAILED',
    qualification_result: targetValidated ? 'TARGET_EXECUTION_PASSED' : 'TARGET_EXECUTION_FAILED',
    owner_approval_required: true,
    auto_promoted_to_qualified: false,
    machine_context: machine,
    machine_identity_sha256: machineIdentity,
    artifact_identities: {
      candidate: candidateIdentity,
      baseline: baselineIdentity,
      evaluator_binaries: harnessIdentities,
    },
    correctness: {
      declared_case_count: manifest ? manifest.correctness.case_ids.length : 0,
      declared_case_ids: manifest ? manifest.correctness.case_ids : [],
      candidate: roleSummary(correctnessByRole.CANDIDATE),
      baseline: roleSummary(correctnessByRole.BASELINE),
      saved_measurement_count: savedCorrectness.length,
      complete: correctnessComplete,
      reference: manifest ? manifest.correctness.reference : null,
      tolerance: manifest ? manifest.correctness.tolerance : null,
    },
    performance: {
      workload_count: manifest ? manifest.performance.workload_ids.length : 0,
      workload_ids: manifest ? manifest.performance.workload_ids : [],
      warmup_count_per_role_workload: manifest ? manifest.performance.sampling.warmup_count : 0,
      sample_count_per_role_workload: manifest ? manifest.performance.sampling.sample_count : 0,
      expected_warmups: expectedWarmupCount,
      observed_warmups: savedWarmups.length,
      expected_raw_samples: expectedSampleCount,
      observed_raw_samples: savedSamples.length,
      raw_samples_complete: performanceComplete,
      warmups_in_raw_measurements: false,
      benchmark_binary_sha256: benchmarkIdentity,
      same_benchmark_binary: benchmarkIdentity !== null,
      medians_from_saved_raw_samples: medians,
      candidate_performance_is_qualification_criterion: false,
    },
    resource_context: {
      declared: manifest ? manifest.resource_requirements : null,
      observed: observedResources(savedCorrectness, savedSamples),
      enforcement: manifest ? manifest.resource_requirements.enforcement : null,
    },
    evaluator_immutability: {
      initial_content_digest: initialContentDigest,
      final_content_digest: finalContentDigest,
      unchanged: contentUnchanged,
      checks_performed: contentChecks,
    },
    artifact_immutability: { checks_performed: artifactChecks },
    evidence: { ...rawIdentities, raw_measurements_sha256: rawMeasurementsSha256 },
    errors,
    warnings,
  };
  fs.writeFileSync(files.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    qualification_result: report.qualification_result,
    target_qualification_status: report.target_qualification_status,
    subject_digest: report.subject_digest,
    report: files.report,
    owner_approval_required: true,
  })}\n`);
  return targetValidated ? 0 : 1;
}

function verifyContent(bundleRoot) {
  const problems = [];
  let manifest = null;
  let qualification = null;
  let observed = null;
  try { manifest = readJson(path.join(bundleRoot, 'manifest.json')); } catch (error) { problems.push(error.message); }
  try { qualification = readJson(path.join(bundleRoot, 'qualification.json')); } catch (error) { problems.push(error.message); }
  try { observed = evaluatorContentDigest(bundleRoot); } catch (error) { problems.push(error.message); }
  if (manifest && observed && manifest.digest !== observed) problems.push(`manifest content digest mismatch: expected ${manifest.digest}, observed ${observed}`);
  if (qualification && observed && qualification.subject_digest !== observed) problems.push(`qualification subject_digest mismatch: expected ${observed}, got ${qualification.subject_digest}`);
  if (manifest && qualification) {
    if (qualification.evaluator_id !== manifest.evaluator_id || qualification.version !== manifest.version) problems.push('qualification evaluator identity mismatch');
    if (!qualification.target || !manifest.target || qualification.target.platform !== manifest.target.platform || qualification.target.build_target !== manifest.target.build_target || qualification.target.compatibility_scope !== manifest.target.compatibility_scope) problems.push('qualification target identity mismatch');
  }
  return {
    schema_version: 1,
    evaluator_id: manifest ? manifest.evaluator_id : null,
    version: manifest ? manifest.version : null,
    declared_content_digest: manifest ? manifest.digest : null,
    observed_content_digest: observed,
    qualification_subject_digest: qualification ? qualification.subject_digest : null,
    qualification_status: qualification ? qualification.status : null,
    valid: problems.length === 0,
    problems,
  };
}

function evaluatorContentDigest(root) {
  const manifest = readJson(path.join(root, 'manifest.json'));
  const hash = createHash('sha256');
  for (const relative of listFiles(root).filter((item) => item !== 'qualification.json')) {
    hash.update(relative);
    hash.update('\0');
    const absolute = path.join(root, ...relative.split('/'));
    if (relative === 'manifest.json') hash.update(stableJson({ ...manifest, digest: DIGEST_PLACEHOLDER }));
    else hash.update(fs.readFileSync(absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function listFiles(root, current = root) {
  const output = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed in evaluator content: ${absolute}`);
    if (entry.isDirectory()) output.push(...listFiles(root, absolute));
    else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`unsupported evaluator content entry: ${absolute}`);
  }
  return output.sort();
}

function validateCorrectnessMeasurement(measurement, item, artifact, harnessSha256) {
  if (measurement.kind !== 'CORRECTNESS_CASE' || measurement.role !== 'EVALUATOR' || measurement.subject_id !== item.case_id || measurement.sample_index !== null) throw new Error(`correctness measurement identity mismatch for ${item.case_id}`);
  if (measurement.value !== 'PASS' || measurement.validity !== 'VALID') throw new Error(`correctness ${item.case_id} reported ${measurement.value}/${measurement.validity}`);
  if (stableJson(measurement.domain_payload && measurement.domain_payload.parameters) !== stableJson(caseParameters(item))) throw new Error(`correctness parameters mismatch for ${item.case_id}`);
  validateArtifactMeasurement(measurement, artifact, 'evaluator_binary_identity', harnessSha256);
  if (!measurement.domain_payload || !measurement.domain_payload.resource_observation || measurement.domain_payload.resource_observation.thread_environment !== item.threads) throw new Error(`correctness thread observation mismatch for ${item.case_id}`);
}

function validatePerformanceMeasurement(measurement, workload, role, index, artifact, benchmarkSha256) {
  if (measurement.kind !== 'PERFORMANCE_SAMPLE' || measurement.role !== role || measurement.subject_id !== workload.workload_id || measurement.sample_index !== index) throw new Error(`performance measurement identity mismatch for ${workload.workload_id}/${role}/${index}`);
  if (measurement.validity !== 'VALID' || measurement.unit !== 'seconds' || !(measurement.value > 0)) throw new Error(`invalid performance sample for ${workload.workload_id}/${role}/${index}`);
  if (stableJson(measurement.domain_payload && measurement.domain_payload.parameters) !== stableJson(workloadParameters(workload))) throw new Error(`performance parameters mismatch for ${workload.workload_id}/${role}/${index}`);
  if (!measurement.domain_payload || !(measurement.domain_payload.elapsed_seconds > 0) || !(measurement.domain_payload.latency_seconds > 0) || !(measurement.domain_payload.gflops > 0)) throw new Error(`performance payload is incomplete for ${workload.workload_id}/${role}/${index}`);
  validateArtifactMeasurement(measurement, artifact, 'benchmark_identity', benchmarkSha256);
  if (!measurement.domain_payload || !measurement.domain_payload.resource_observation || measurement.domain_payload.resource_observation.thread_environment !== workload.threads) throw new Error(`performance thread observation mismatch for ${workload.workload_id}/${role}/${index}`);
}

function validateArtifactMeasurement(measurement, artifact, binaryField, binarySha256) {
  const identity = measurement.domain_payload && measurement.domain_payload.artifact_identity;
  if (!identity || identity.sha256 !== artifact.sha256) throw new Error(`measurement artifact SHA-256 mismatch for ${measurement.subject_id}`);
  if (fs.realpathSync(identity.input_path) !== fs.realpathSync(artifact.path)) throw new Error(`measurement artifact input path mismatch for ${measurement.subject_id}`);
  if (identity.resolved_cblas_sgemv_path === 'unresolved' || fs.realpathSync(identity.resolved_cblas_sgemv_path) !== fs.realpathSync(artifact.path)) throw new Error(`dladdr resolved path mismatch for ${measurement.subject_id}`);
  if (!measurement.domain_payload || !measurement.domain_payload[binaryField] || measurement.domain_payload[binaryField].sha256 !== binarySha256) throw new Error(`${binaryField} mismatch for ${measurement.subject_id}`);
}

function validateWarmup(value, workload, role, index) {
  if (value.role !== role || value.workload_id !== workload.workload_id || value.warmup_index !== index || !(value.latency_seconds > 0)) throw new Error(`warmup identity mismatch for ${workload.workload_id}/${role}/${index}`);
}

function assertPerformanceInventory(samples, workloads, sampleCount) {
  for (const workload of workloads) {
    for (const role of ['BASELINE', 'CANDIDATE']) {
      const observed = samples.filter((item) => item.subject_id === workload.workload_id && item.role === role).sort((left, right) => left.sample_index - right.sample_index);
      if (observed.length !== sampleCount || observed.some((item, index) => item.sample_index !== index)) throw new Error(`saved raw sample inventory mismatch for ${workload.workload_id}/${role}`);
    }
  }
}

function deriveMedians(samples) {
  const groups = new Map();
  for (const item of samples) {
    const key = `${item.subject_id}\0${item.role}`;
    const values = groups.get(key) || [];
    values.push(item.value);
    groups.set(key, values);
  }
  return [...groups.entries()].map(([key, values]) => {
    const [workloadId, role] = key.split('\0');
    const ordered = [...values].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    const value = ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
    return { workload_id: workloadId, role, sample_count: values.length, median_latency_seconds: value };
  });
}

function observedResources(correctness, performance) {
  const observations = [...correctness, ...performance].map((item) => item.domain_payload && item.domain_payload.resource_observation).filter(Boolean);
  const procStatus = readProcStatus();
  return {
    thread_environment_values: [...new Set(observations.map((item) => item.thread_environment).filter(Number.isInteger))].sort((a, b) => a - b),
    active_threads: null,
    cpu_set: procStatus.Cpus_allowed_list || null,
    numa_nodes: procStatus.Mems_allowed_list || null,
  };
}

function machineContext() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    architecture: os.arch(),
    cpu_model: cpus[0] ? cpus[0].model : null,
    cpu_count: cpus.length,
    numa_topology: { online_nodes: readText('/sys/devices/system/node/online'), lscpu: probe('lscpu', ['--json']) },
    os: parseOsRelease(),
    kernel: probe('uname', ['-srvmo']),
    compiler: probe(process.env.CC || 'gcc', ['--version']),
    linker: probe('ld', ['--version']),
    libc: probe('ldd', ['--version']),
    node: process.version,
    runner_version: (process.env.PHYOPT_RUNNER_VERSION && process.env.PHYOPT_RUNNER_VERSION.trim()) || 'phyopt qualification-runner sgemv-n/1.0.0',
  };
}

function probe(executable, commandArgs) {
  const result = spawnSync(executable, commandArgs, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  return { available: result.status === 0, exit_code: result.status, output: `${result.stdout == null ? '' : result.stdout}${result.stderr == null ? '' : result.stderr}`.trim().slice(0, 64 * 1024) };
}

function parseOsRelease() {
  const text = readText('/etc/os-release');
  if (text === null) return null;
  return Object.fromEntries(text.split(/\r?\n/).filter((line) => line.includes('=')).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, '')];
  }));
}

function readProcStatus() {
  const text = readText('/proc/self/status') || '';
  return Object.fromEntries(text.split(/\r?\n/).filter((line) => line.includes(':')).map((line) => {
    const index = line.indexOf(':');
    return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
}

function roleSummary(value) {
  return {
    executed_case_count: value.executed_case_ids.length,
    executed_case_ids: value.executed_case_ids,
    passed_case_count: value.passed_case_ids.length,
    passed_case_ids: value.passed_case_ids,
    resolved_artifact_paths: [...value.resolved_artifact_paths],
  };
}

function artifactIdentity(artifactPath, expectedSha256) {
  const observed = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile() ? sha256File(artifactPath) : null;
  return { path: artifactPath, expected_sha256: expectedSha256, sha256: expectedSha256, observed_sha256: observed };
}

function fileIdentity(file) {
  return { path: file, sha256: sha256File(file), bytes: fs.statSync(file).size };
}

function requireCommandSuccess(result, label) {
  const status = result.status != null ? result.status : (result.signal != null ? result.signal : 'unknown');
  const errorMessage = result.error ? result.error.message : '';
  if (result.status !== 0) throw new Error(`${label} failed (${status}): ${(result.stderr || result.stdout || errorMessage || '').trim()}`);
}

function parseSinglePrefixed(stdout, prefix, label) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error(`${label} must emit exactly one ${prefix.trim()} record; observed ${lines.length}`);
  try { return JSON.parse(lines[0].slice(prefix.length)); }
  catch (error) { throw new Error(`${label} emitted invalid JSON: ${error.message}`); }
}

function assertExactIds(expected, observed, label) {
  if (stableJson(expected) !== stableJson(observed) || new Set(observed).size !== observed.length) throw new Error(`${label} differs from declared inventory`);
}

function caseParameters(item) {
  return { m: item.m, n: item.n, lda: item.lda, incx: item.incx, incy: item.incy, alpha: item.alpha, beta: item.beta, threads: item.threads, seed: item.seed };
}

function workloadParameters(item) {
  return { m: item.m, n: item.n, lda: item.lda, incx: item.incx, incy: item.incy, alpha: item.alpha, beta: item.beta, threads: item.threads, loops: item.loops, seed: item.seed };
}

function workloadArguments(item) {
  return [item.m, item.n, item.lda, item.incx, item.incy, item.alpha, item.beta, item.threads, item.loops, item.seed];
}

function appendJsonLine(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function randomUuid() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizedSha256(value, label) {
  const output = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(output)) throw new Error(`${label} must be a SHA-256 digest`);
  return output;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
