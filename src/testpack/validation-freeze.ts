import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FrozenValidationTestpack, ValidationTestpack } from '../contracts/validation-testpack.js';
import { VALIDATION_TESTPACK_SCHEMA_VERSION } from '../contracts/validation-testpack.js';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) output[key] = sortKeys((value as Record<string, unknown>)[key]);
    return output;
  }
  return value;
}

export function canonicalValidationTestpack(value: ValidationTestpack): string {
  return JSON.stringify(sortKeys(value));
}

export function validationTestpackDigest(value: ValidationTestpack): string {
  return createHash('sha256').update(canonicalValidationTestpack(value)).digest('hex');
}

/** 在运行开始时复制不可变 testpack 快照；可选目录用于写入审计文件。 */
export function freezeValidationTestpack(testpack: ValidationTestpack, outputDir?: string): FrozenValidationTestpack {
  const frozen: FrozenValidationTestpack = {
    schema_version: VALIDATION_TESTPACK_SCHEMA_VERSION,
    frozen_at: new Date().toISOString(),
    digest: validationTestpackDigest(testpack),
    testpack: structuredClone(testpack),
  };
  if (outputDir) {
    const absolute = path.resolve(outputDir);
    fs.mkdirSync(absolute, { recursive: true });
    fs.writeFileSync(path.join(absolute, 'validation-testpack.json'), `${JSON.stringify(frozen, null, 2)}\n`);
  }
  return frozen;
}

export function readFrozenValidationTestpack(fileOrDir: string): FrozenValidationTestpack {
  const candidate = path.resolve(fileOrDir);
  const file = fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
    ? path.join(candidate, 'validation-testpack.json')
    : candidate;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as FrozenValidationTestpack;
  if (value.schema_version !== VALIDATION_TESTPACK_SCHEMA_VERSION) throw new Error(`unsupported frozen testpack schema_version ${value.schema_version}`);
  const digest = validationTestpackDigest(value.testpack);
  if (digest !== value.digest) throw new Error(`frozen testpack digest mismatch: expected ${value.digest}, got ${digest}`);
  return value;
}

export function summarizeValidationTestpack(testpack: ValidationTestpack): Record<string, unknown> {
  return {
    schema_version: testpack.schema_version,
    testpack_id: testpack.testpack_id,
    function_name: testpack.function_name,
    digest: validationTestpackDigest(testpack),
    evaluator: testpack.evaluator ? {
      id: testpack.evaluator.id,
      version: testpack.evaluator.version,
      owner: testpack.evaluator.owner,
      sha256: testpack.evaluator.sha256,
    } : null,
    correctness_cases: testpack.correctness.cases.length,
    correctness_pass_required: testpack.correctness.pass_required,
    performance_cases: testpack.performance.cases.length,
    performance_samples: testpack.performance.sampling.samples,
    cpu_set: testpack.resources.cpu_set,
    numa_nodes: [...testpack.resources.numa_nodes],
    thread_counts: [...testpack.resources.thread_counts],
    baselines: {
      current: { id: testpack.performance.baselines.current.id, sha256: testpack.performance.baselines.current.sha256 },
      comparison: { id: testpack.performance.baselines.comparison.id, sha256: testpack.performance.baselines.comparison.sha256 },
    },
    thresholds: { ...testpack.performance.thresholds },
  };
}
