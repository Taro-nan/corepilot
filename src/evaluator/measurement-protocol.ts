import type { ValidationCommand } from '../contracts/validation-testpack.js';

export const MEASUREMENT_PREFIX = 'COREPILOT_MEASUREMENT';

/** The namespace belongs to the producer; payload semantics are independent. */
export function isMeasurementPrefix(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]*_MEASUREMENT$/.test(value);
}

export function measurementPayload(line: string, prefix?: string): string | null {
  if (prefix !== undefined) return line.startsWith(prefix + ' ') ? line.slice(prefix.length + 1) : null;
  const marker = line.match(/^[A-Z][A-Z0-9_]*_MEASUREMENT /)?.[0];
  return marker ? line.slice(marker.length) : null;
}

/** Adapt only an execution copy, leaving frozen plans and evaluator files intact. */
export function evaluatorCommandEnvironment(command: ValidationCommand, prefix: string): ValidationCommand {
  if (!isMeasurementPrefix(prefix)) throw new Error('Invalid evaluator measurement prefix');
  const namespace = prefix.slice(0, -'_MEASUREMENT'.length);
  if (namespace === 'COREPILOT') return command;
  const environment = { ...command.environment };
  for (const [name, value] of Object.entries(command.environment)) {
    if (name.startsWith('COREPILOT_')) environment[namespace + name.slice('COREPILOT'.length)] = value;
  }
  return { ...command, environment };
}
