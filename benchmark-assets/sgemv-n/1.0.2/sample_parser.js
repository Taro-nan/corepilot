// Frozen sample parser for sgemv_bench_formal.c (BenchmarkAssetVersion 1.0.0).
// Parses the two emitted lines: PHYOPT_DLADDR (runtime identity, emitted
// BEFORE timing) and PHYOPT_RESULT (timed result).

/**
 * Parse a PHYOPT_RESULT line into { role, m, n, threads, loops, seconds, gflops }.
 */
export function parseResult(stdout) {
  const lines = String(stdout).trim().split('\n');
  const line = lines.find((l) => l.startsWith('PHYOPT_RESULT '));
  if (!line) return null;

  const fields = {};
  for (const part of line.slice('PHYOPT_RESULT '.length).split(' ')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    fields[part.slice(0, eq)] = part.slice(eq + 1);
  }

  if (!fields.seconds || !fields.gflops) return null;
  return {
    role: fields.role ?? null,
    m: Number(fields.m),
    n: Number(fields.n),
    threads: Number(fields.threads),
    loops: Number(fields.loops),
    seconds: Number(fields.seconds),
    gflops: Number(fields.gflops),
  };
}

/**
 * Parse a PHYOPT_DLADDR line into a dladdr probe record.
 */
export function parseDladdr(stdout) {
  const lines = String(stdout).trim().split('\n');
  const line = lines.find((l) => l.startsWith('PHYOPT_DLADDR '));
  if (!line) return null;

  const fields = {};
  for (const part of line.slice('PHYOPT_DLADDR '.length).split(' ')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    fields[part.slice(0, eq)] = part.slice(eq + 1);
  }

  return {
    proof_method: fields.proof_method ?? null,
    symbol: fields.symbol ?? null,
    resolved_path: fields.resolved_path ?? null,
    realpath: fields.realpath ?? null,
    benchmark_role: fields.benchmark_role ?? null,
    benchmark_binary_sha256: fields.benchmark_binary_sha256 ?? null,
    test_plan_version: fields.test_plan_version ?? null,
    test_plan_digest: fields.test_plan_digest ?? null,
  };
}

/**
 * Parse both lines. The dladdr probe must appear before the result line
 * (it is emitted before any timed work).
 */
export function parseBenchFormal(stdout) {
  return { dladdr: parseDladdr(stdout), result: parseResult(stdout) };
}
