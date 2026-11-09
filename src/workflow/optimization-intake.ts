import { createHash } from 'node:crypto';

// Only fields consumed by the public workflow endpoint belong to the intent.
// Authentication and model credentials are headers and are never included.
const fields = ['project_id', 'config_path', 'repository_root', 'function_name', 'entry_file', 'candidate_scope',
  'enable_performance', 'verification_mode', 'source_branch', 'machine_id', 'budget'] as const;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Fingerprint the submitted intent before resolving mutable project defaults. */
export function optimizationInputDigest(body: Record<string, unknown>): string {
  const input = Object.fromEntries(fields.filter(field => Object.hasOwn(body, field)).map(field => [field, body[field]]));
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}
