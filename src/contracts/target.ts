import { SCHEMA_VERSION } from './schema.js';

export interface Target {
  schema_version: number;
  name: string;
  repo?: string;
  function?: string;
  machine?: string;
}

export function makeTarget(
  name: string,
  extra: Partial<Omit<Target, 'schema_version' | 'name'>> = {},
): Target {
  return { schema_version: SCHEMA_VERSION, name, ...extra };
}
