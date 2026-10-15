import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type {
  LoadedValidationTestpack,
  PerformanceThresholds,
  RevalidationRequirement,
  TrustedEvaluatorBundle,
  ValidationBaseline,
  ValidationCase,
  ValidationCommand,
  ValidationSampling,
  ValidationTestpack,
} from '../contracts/validation-testpack.js';
import { VALIDATION_TESTPACK_SCHEMA_VERSION } from '../contracts/validation-testpack.js';
import { evaluatorBundleSha256 } from '../evaluator/formal-evaluator.js';

export class ValidationTestpackError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'ValidationTestpackError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapping(value: unknown, field: string, problems: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    problems.push(`${field} must be a mapping`);
    return {};
  }
  return value;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], field: string, problems: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${field}.${key} is not supported`);
}

function stringValue(value: Record<string, unknown>, key: string, field: string, problems: string[]): string {
  const raw = value[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    problems.push(`${field}.${key} must be a non-empty string`);
    return '';
  }
  return raw.trim();
}

function integerValue(value: Record<string, unknown>, key: string, field: string, problems: string[], min = 0): number {
  const raw = value[key];
  if (!Number.isInteger(raw) || (raw as number) < min) {
    problems.push(`${field}.${key} must be an integer >= ${min}`);
    return min;
  }
  return raw as number;
}

function numberValue(value: Record<string, unknown>, key: string, field: string, problems: string[], min = 0): number {
  const raw = value[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min) {
    problems.push(`${field}.${key} must be a finite number >= ${min}`);
    return min;
  }
  return raw;
}

function stringArray(value: Record<string, unknown>, key: string, field: string, problems: string[], nonEmpty = false): string[] {
  const raw = value[key];
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    problems.push(`${field}.${key} must be a string array`);
    return [];
  }
  const output = raw.map((item) => (item as string).trim());
  if (nonEmpty && output.length === 0) problems.push(`${field}.${key} must not be empty`);
  return output;
}

function integerArray(value: Record<string, unknown>, key: string, field: string, problems: string[], min = 0): number[] {
  const raw = value[key];
  if (!Array.isArray(raw) || !raw.every((item) => Number.isInteger(item) && (item as number) >= min)) {
    problems.push(`${field}.${key} must be an integer array with values >= ${min}`);
    return [];
  }
  return raw as number[];
}

function mapStrings(value: Record<string, unknown>, key: string, field: string, problems: string[]): Record<string, string> {
  const raw = value[key];
  if (!isRecord(raw)) {
    problems.push(`${field}.${key} must be a string mapping`);
    return {};
  }
  const output: Record<string, string> = {};
  for (const [name, item] of Object.entries(raw)) {
    if (typeof item !== 'string') problems.push(`${field}.${key}.${name} must be a string`);
    else output[name] = item;
  }
  return output;
}

function scalarMap(value: unknown, field: string, problems: string[]): Record<string, string | number | boolean> {
  const raw = mapping(value, field, problems);
  const output: Record<string, string | number | boolean> = {};
  for (const [name, item] of Object.entries(raw)) {
    if (name === 'threads') {
      problems.push(`${field}.threads is reserved; declare it beside parameters`);
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) problems.push(`${field}.${name} must be finite`);
      else output[name] = item;
    } else if (typeof item === 'string' || typeof item === 'boolean') {
      output[name] = item;
    } else {
      problems.push(`${field}.${name} must be a string, number, or boolean`);
    }
  }
  return output;
}

function command(value: unknown, field: string, configDir: string, problems: string[]): ValidationCommand {
  const raw = mapping(value, field, problems);
  unknownKeys(raw, ['executable', 'args', 'cwd', 'environment', 'timeout_ms'], field, problems);
  const cwdRaw = stringValue(raw, 'cwd', field, problems);
  return {
    executable: stringValue(raw, 'executable', field, problems),
    args: stringArray(raw, 'args', field, problems),
    cwd: cwdRaw && !path.isAbsolute(cwdRaw) ? path.resolve(configDir, cwdRaw) : cwdRaw,
    environment: mapStrings(raw, 'environment', field, problems),
    timeout_ms: integerValue(raw, 'timeout_ms', field, problems, 1),
  };
}

function cases(value: unknown, field: string, problems: string[]): ValidationCase[] {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${field} must be a non-empty array`);
    return [];
  }
  const ids = new Set<string>();
  return value.map((item, index) => {
    const name = `${field}[${index}]`;
    const raw = mapping(item, name, problems);
    unknownKeys(raw, ['case_id', 'parameters', 'm', 'n', 'threads', 'seed', 'critical', 'weight', 'args'], name, problems);
    const caseId = stringValue(raw, 'case_id', name, problems);
    if (ids.has(caseId)) problems.push(`${name}.case_id must be unique`);
    ids.add(caseId);
    if (typeof raw.critical !== 'boolean') problems.push(`${name}.critical must be boolean`);
    const explicitParameters = raw.parameters === undefined ? undefined : scalarMap(raw.parameters, `${name}.parameters`, problems);
    if (explicitParameters !== undefined && (raw.m !== undefined || raw.n !== undefined || raw.seed !== undefined)) {
      problems.push(`${name} must not mix parameters with legacy m/n/seed fields`);
    }
    const m = explicitParameters === undefined ? integerValue(raw, 'm', name, problems) : undefined;
    const n = explicitParameters === undefined ? integerValue(raw, 'n', name, problems) : undefined;
    const seed = explicitParameters === undefined ? integerValue(raw, 'seed', name, problems) : undefined;
    return {
      case_id: caseId,
      ...(explicitParameters === undefined ? { m, n, seed, parameters: { m: m as number, n: n as number, seed: seed as number } } : { parameters: explicitParameters }),
      threads: integerValue(raw, 'threads', name, problems, 1),
      critical: raw.critical === true,
      weight: numberValue(raw, 'weight', name, problems, 0),
      ...(raw.args === undefined ? {} : { args: stringArray(raw, 'args', name, problems) }),
    };
  });
}

function baseline(value: unknown, field: string, configDir: string, problems: string[]): ValidationBaseline {
  const raw = mapping(value, field, problems);
  unknownKeys(raw, ['id', 'library', 'version', 'sha256', 'path'], field, problems);
  const pathRaw = stringValue(raw, 'path', field, problems);
  const sha = stringValue(raw, 'sha256', field, problems);
  if (sha && !/^[0-9a-f]{64}$/i.test(sha)) problems.push(`${field}.sha256 must be a 64-character hexadecimal digest`);
  const preserveRuntimePath = pathRaw.includes('${PHYOPT_CANDIDATE_ROOT}');
  return {
    id: stringValue(raw, 'id', field, problems),
    library: stringValue(raw, 'library', field, problems),
    version: stringValue(raw, 'version', field, problems),
    sha256: sha,
    path: pathRaw && !preserveRuntimePath && !path.isAbsolute(pathRaw) ? path.resolve(configDir, pathRaw) : pathRaw,
  };
}

function sampling(value: unknown, field: string, problems: string[]): ValidationSampling {
  const raw = mapping(value, field, problems);
  unknownKeys(raw, ['warmup', 'samples', 'interleave_seed', 'bootstrap_iterations'], field, problems);
  return {
    warmup: integerValue(raw, 'warmup', field, problems),
    samples: integerValue(raw, 'samples', field, problems, 1),
    interleave_seed: integerValue(raw, 'interleave_seed', field, problems),
    bootstrap_iterations: integerValue(raw, 'bootstrap_iterations', field, problems, 1),
  };
}

function thresholds(value: unknown, field: string, problems: string[]): PerformanceThresholds {
  const raw = mapping(value, field, problems);
  unknownKeys(raw, ['weighted_geomean_min', 'overall_ci_lower_min', 'key_case_ci_lower_min', 'confidence_level'], field, problems);
  const confidence = numberValue(raw, 'confidence_level', field, problems, 0);
  if (confidence <= 0 || confidence >= 1) problems.push(`${field}.confidence_level must be greater than 0 and less than 1`);
  return {
    weighted_geomean_min: numberValue(raw, 'weighted_geomean_min', field, problems, 0),
    overall_ci_lower_min: numberValue(raw, 'overall_ci_lower_min', field, problems, 0),
    key_case_ci_lower_min: numberValue(raw, 'key_case_ci_lower_min', field, problems, 0),
    confidence_level: confidence,
  };
}

function revalidation(value: unknown, field: string, configDir: string, problems: string[]): RevalidationRequirement {
  const raw = mapping(value, field, problems);
  unknownKeys(raw, ['required', 'timeout_ms', 'command'], field, problems);
  if (typeof raw.required !== 'boolean') problems.push(`${field}.required must be boolean`);
  return {
    required: raw.required === true,
    timeout_ms: integerValue(raw, 'timeout_ms', field, problems, 1),
    command: command(raw.command, `${field}.command`, configDir, problems),
  };
}

function evaluator(value: unknown, configDir: string, problems: string[]): TrustedEvaluatorBundle | undefined {
  if (value === undefined) return undefined;
  const raw = mapping(value, 'evaluator', problems);
  unknownKeys(raw, ['id', 'version', 'owner', 'root', 'sha256'], 'evaluator', problems);
  const rootRaw = stringValue(raw, 'root', 'evaluator', problems);
  const digest = stringValue(raw, 'sha256', 'evaluator', problems).toLowerCase();
  if (digest && !/^[0-9a-f]{64}$/.test(digest)) problems.push('evaluator.sha256 must be a 64-character hexadecimal digest');
  return {
    id: stringValue(raw, 'id', 'evaluator', problems),
    version: stringValue(raw, 'version', 'evaluator', problems),
    owner: stringValue(raw, 'owner', 'evaluator', problems),
    root: rootRaw && !path.isAbsolute(rootRaw) ? path.resolve(configDir, rootRaw) : rootRaw,
    sha256: digest,
  };
}

/** 严格解析运行时 testpack，确保远端调用前所有测量口径已经固定。 */
export function parseValidationTestpack(value: unknown, configDir = process.cwd()): ValidationTestpack {
  const problems: string[] = [];
  const root = mapping(value, 'testpack', problems);
  unknownKeys(root, ['schema_version', 'testpack_id', 'function_name', 'function_family', 'operation', 'data_type', 'evaluator', 'resources', 'correctness', 'performance', 'revalidation'], 'testpack', problems);
  if (root.schema_version !== VALIDATION_TESTPACK_SCHEMA_VERSION) problems.push(`testpack.schema_version must be ${VALIDATION_TESTPACK_SCHEMA_VERSION}`);

  const resources = mapping(root.resources, 'resources', problems);
  unknownKeys(resources, ['cpu_set', 'numa_nodes', 'thread_counts'], 'resources', problems);
  const correctness = mapping(root.correctness, 'correctness', problems);
  unknownKeys(correctness, ['command', 'cases', 'pass_required'], 'correctness', problems);
  const performance = mapping(root.performance, 'performance', problems);
  unknownKeys(performance, ['command', 'cases', 'sampling', 'baselines', 'thresholds', 'key_cases'], 'performance', problems);
  const baselines = mapping(performance.baselines, 'performance.baselines', problems);
  unknownKeys(baselines, ['current', 'comparison'], 'performance.baselines', problems);
  const revalidationValue = mapping(root.revalidation, 'revalidation', problems);
  unknownKeys(revalidationValue, ['formal', 'independent'], 'revalidation', problems);

  const correctnessCases = cases(correctness.cases, 'correctness.cases', problems);
  const performanceCases = cases(performance.cases, 'performance.cases', problems);
  const keyCases = stringArray(performance, 'key_cases', 'performance', problems, true);
  const performanceIds = new Set(performanceCases.map((item) => item.case_id));
  for (const id of keyCases) if (!performanceIds.has(id)) problems.push(`performance.key_cases references unknown case '${id}'`);
  const allThreads = new Set([...correctnessCases, ...performanceCases].map((item) => item.threads));
  const declaredThreads = integerArray(resources, 'thread_counts', 'resources', problems, 1);
  if (declaredThreads.length === 0) problems.push('resources.thread_counts must not be empty');
  const numaNodes = integerArray(resources, 'numa_nodes', 'resources', problems);
  if (numaNodes.length === 0) problems.push('resources.numa_nodes must not be empty');
  const cpuSet = stringValue(resources, 'cpu_set', 'resources', problems);
  if (cpuSet && !/^[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*$/.test(cpuSet)) problems.push('resources.cpu_set must be a CPU list such as 0-15');
  for (const threads of allThreads) if (!declaredThreads.includes(threads)) problems.push(`resources.thread_counts is missing case thread count ${threads}`);
  const passRequired = integerValue(correctness, 'pass_required', 'correctness', problems, 1);
  if (passRequired > correctnessCases.length) problems.push('correctness.pass_required cannot exceed correctness.cases length');

  const result: ValidationTestpack = {
    schema_version: VALIDATION_TESTPACK_SCHEMA_VERSION,
    testpack_id: stringValue(root, 'testpack_id', 'testpack', problems),
    function_name: stringValue(root, 'function_name', 'testpack', problems),
    function_family: stringValue(root, 'function_family', 'testpack', problems),
    operation: stringValue(root, 'operation', 'testpack', problems),
    data_type: stringValue(root, 'data_type', 'testpack', problems),
    ...(root.evaluator === undefined ? {} : { evaluator: evaluator(root.evaluator, configDir, problems) as TrustedEvaluatorBundle }),
    resources: {
      cpu_set: cpuSet,
      numa_nodes: numaNodes,
      thread_counts: declaredThreads,
    },
    correctness: {
      command: command(correctness.command, 'correctness.command', configDir, problems),
      cases: correctnessCases,
      pass_required: passRequired,
    },
    performance: {
      command: command(performance.command, 'performance.command', configDir, problems),
      cases: performanceCases,
      sampling: sampling(performance.sampling, 'performance.sampling', problems),
      baselines: {
        current: baseline(baselines.current, 'performance.baselines.current', configDir, problems),
        comparison: baseline(baselines.comparison, 'performance.baselines.comparison', configDir, problems),
      },
      thresholds: thresholds(performance.thresholds, 'performance.thresholds', problems),
      key_cases: keyCases,
    },
    revalidation: {
      formal: revalidation(revalidationValue.formal, 'revalidation.formal', configDir, problems),
      independent: revalidation(revalidationValue.independent, 'revalidation.independent', configDir, problems),
    },
  };
  if (problems.length > 0) throw new ValidationTestpackError(problems);
  return result;
}

export function loadValidationTestpack(testpackPath: string): LoadedValidationTestpack {
  const absolutePath = path.resolve(testpackPath);
  let raw: string;
  try {
    raw = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new ValidationTestpackError([`cannot read testpack ${absolutePath}: ${(error as Error).message}`]);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new ValidationTestpackError([`invalid YAML in ${absolutePath}: ${(error as Error).message}`]);
  }
  const testpack = parseValidationTestpack(parsed, path.dirname(absolutePath));
  if (testpack.evaluator) {
    let observed: string;
    try {
      observed = evaluatorBundleSha256(testpack.evaluator.root);
    } catch (error) {
      throw new ValidationTestpackError([`cannot read evaluator bundle ${testpack.evaluator.root}: ${(error as Error).message}`]);
    }
    if (observed !== testpack.evaluator.sha256) {
      throw new ValidationTestpackError([
        `evaluator bundle digest mismatch: expected ${testpack.evaluator.sha256}, got ${observed}`,
      ]);
    }
    const evaluatorRoot = path.resolve(testpack.evaluator.root);
    const commands: Array<[string, ValidationCommand]> = [
      ['correctness.command', testpack.correctness.command],
      ['performance.command', testpack.performance.command],
      ['revalidation.formal.command', testpack.revalidation.formal.command],
      ['revalidation.independent.command', testpack.revalidation.independent.command],
    ];
    const escaped = commands
      .filter(([, item]) => !pathIsInside(path.resolve(item.cwd), evaluatorRoot))
      .map(([name, item]) => `${name} cwd ${item.cwd} is outside evaluator.root ${evaluatorRoot}`);
    if (escaped.length > 0) throw new ValidationTestpackError(escaped);
  }
  return {
    testpack,
    testpackPath: absolutePath,
    testpackDir: path.dirname(absolutePath),
    rawSha256: createHash('sha256').update(raw).digest('hex'),
  };
}

function pathIsInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
