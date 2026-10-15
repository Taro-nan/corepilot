const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const [bundleRoot, baselinePath, outputRoot] = process.argv.slice(2);
if (!bundleRoot || !baselinePath || !outputRoot) {
  process.stderr.write('usage: node qualify-self-baseline.cjs EVALUATOR_ROOT BASELINE_SO OUTPUT_ROOT\n');
  process.exit(64);
}

const evaluator = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'manifest.json')));
const cases = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'correctness/cases.json'))).cases;
const workloads = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'benchmark/workloads.json'))).workloads;
const expectedBaselineHash = '87805e10942159d8cf28b2cc48efe0cc690c1297631ee8f302d16f2e23c57b6a';
const runtimeRoot = path.join(outputRoot, 'evaluator-runtime');
const rawPath = path.join(outputRoot, 'raw-measurements.jsonl');
const reportPath = path.join(outputRoot, 'report.json');
const environment = { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', GOTO_NUM_THREADS: '1', OMP_DYNAMIC: 'FALSE' };

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function execute(executable, args) {
  const result = childProcess.spawnSync(executable, args, { encoding: 'utf8', env: environment, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${executable} failed: ${result.error || result.status}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

function constrained(script, args) {
  if (sha256(baselinePath) !== expectedBaselineHash) throw new Error('baseline identity changed before step');
  const output = execute('numactl', ['--cpunodebind=0', '--membind=0', 'taskset', '--cpu-list', '0', 'bash', path.join(bundleRoot, script), ...args]);
  if (sha256(baselinePath) !== expectedBaselineHash) throw new Error('baseline identity changed after step');
  const measurements = output.split(/\r?\n/).filter(line => line.startsWith('PHYOPT_MEASUREMENT '));
  if (measurements.length !== (script.includes('correctness') ? 1 : args[0] === 'sample' ? 1 : 0)) throw new Error(`unexpected measurements from ${script}: ${output}`);
  if (!measurements.length) return null;
  const observation = JSON.parse(measurements[0].slice('PHYOPT_MEASUREMENT '.length));
  const identity = observation.domain_payload.artifact_identity;
  if (identity.sha256 !== expectedBaselineHash || fs.realpathSync(identity.input_path) !== fs.realpathSync(baselinePath) ||
      fs.realpathSync(identity.resolved_symbol_path) !== fs.realpathSync(baselinePath)) throw new Error('loaded artifact identity mismatch');
  const binary = observation.domain_payload[script.includes('correctness') ? 'evaluator_binary_identity' : 'benchmark_identity'];
  if (binary.sha256 !== harnessHash) throw new Error('evaluator harness identity mismatch');
  fs.appendFileSync(rawPath, `${JSON.stringify(observation)}\n`);
  return observation;
}

fs.mkdirSync(outputRoot, { recursive: true });
if (fs.existsSync(rawPath) || fs.existsSync(reportPath)) throw new Error('qualification output already exists');
if (sha256(baselinePath) !== expectedBaselineHash) throw new Error('baseline identity is not the declared frozen build');
const startedAt = new Date().toISOString();
const resourceOutput = execute('numactl', ['--cpunodebind=0', '--membind=0', 'taskset', '--cpu-list', '0', 'bash', '-c', 'awk "/^Cpus_allowed_list:|^Mems_allowed_list:|^Threads:/ {print}" /proc/self/status; numactl --show; env | grep OMP_NUM_THREADS']);
if (!resourceOutput.includes('Cpus_allowed_list:\t0') || !resourceOutput.includes('policy: bind') || !resourceOutput.includes('OMP_NUM_THREADS=1')) {
  throw new Error(`resource enforcement observation failed: ${resourceOutput}`);
}
const buildOutput = execute('bash', [path.join(bundleRoot, 'scripts/build-evaluator.sh'), runtimeRoot]);
const harnessHash = sha256(path.join(runtimeRoot, 'dilate_evaluator'));
if (!buildOutput.includes(harnessHash)) throw new Error('evaluator build hash output mismatch');
const correctnessResults = [];
for (const item of cases) {
  const values = evaluator.correctness.command.arguments.slice(2, -1).map(name => name === 'threads' ? item.threads : item.parameters[name]);
  const observation = constrained('scripts/run-correctness.sh', [item.case_id, baselinePath, ...values.map(String), runtimeRoot]);
  if (observation.subject_id !== item.case_id || observation.value !== 'PASS' || observation.validity !== 'VALID' ||
      JSON.stringify(observation.domain_payload.parameters) !== JSON.stringify(item.parameters)) throw new Error(`correctness failure: ${item.case_id}`);
  correctnessResults.push({ case_id: item.case_id, result: observation.value });
}
const performanceResults = [];
for (const item of workloads) {
  const parameterValues = evaluator.performance.command.arguments.slice(4, -2).map(name => name === 'threads' ? item.threads : item.parameters[name]);
  for (let warmup = 0; warmup < evaluator.performance.sampling.warmup_count; ++warmup) {
    constrained('scripts/run-performance.sh', ['warmup', 'BASELINE', item.workload_id, baselinePath, ...parameterValues.map(String), String(warmup), runtimeRoot]);
  }
  const samples = [];
  for (let index = 0; index < evaluator.performance.sampling.sample_count; ++index) {
    const observation = constrained('scripts/run-performance.sh', ['sample', 'BASELINE', item.workload_id, baselinePath, ...parameterValues.map(String), String(index), runtimeRoot]);
    if (observation.subject_id !== item.workload_id || observation.role !== 'BASELINE' || observation.sample_index !== index ||
        observation.validity !== 'VALID' || !Number.isFinite(observation.value) || observation.value <= 0 ||
        JSON.stringify(observation.domain_payload.parameters) !== JSON.stringify(item.parameters)) throw new Error(`performance failure: ${item.workload_id}/${index}`);
    samples.push(observation.value);
  }
  const ordered = samples.slice().sort((left, right) => left - right);
  performanceResults.push({ workload_id: item.workload_id, samples_seconds: samples, median_seconds: ordered[Math.floor(ordered.length / 2)] });
}
const report = {
  schema_version: 1,
  run_id: 'ippi-dilate-self-baseline-2026-10-10-owner-policy-v4',
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  status: 'TARGET_EXECUTION_PASSED',
  baseline_path: fs.realpathSync(baselinePath),
  baseline_sha256: sha256(baselinePath),
  evaluator_digest: evaluator.digest,
  harness_sha256: harnessHash,
  resource_observation: resourceOutput,
  correctness: correctnessResults,
  performance: performanceResults,
  raw_measurements_sha256: sha256(rawPath),
  artifact_immutable: sha256(baselinePath) === expectedBaselineHash
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ report_path: reportPath, report_sha256: sha256(reportPath), raw_path: rawPath, raw_sha256: report.raw_measurements_sha256, correctness_count: correctnessResults.length, workload_count: performanceResults.length })}\n`);
