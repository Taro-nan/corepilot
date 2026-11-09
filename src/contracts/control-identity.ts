export interface ControlIdentity {
  database_id: string;
  data_root_id: string;
}

export const CONTROL_GUARD_HEADER = 'x-corepilot-control-guard';

const identityPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isControlIdentity(value: unknown): value is ControlIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.database_id === 'string' && identityPattern.test(identity.database_id)
    && typeof identity.data_root_id === 'string' && identityPattern.test(identity.data_root_id);
}

export function isControlIdentityId(value: unknown): value is string {
  return typeof value === 'string' && identityPattern.test(value);
}
