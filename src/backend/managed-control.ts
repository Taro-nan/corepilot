/**
 * Private control-plane constants shared by the managed backend process and
 * the CLI process that owns it. The token is generated per managed process,
 * passed through the environment, and persisted only in the user's backend
 * state file.
 */
export const MANAGED_BACKEND_TOKEN_ENV = 'PHYOPT_MANAGED_BACKEND_TOKEN';
export const MANAGED_SHUTDOWN_PATH = '/v1/admin/shutdown';
export const MANAGED_SHUTDOWN_TOKEN_HEADER = 'x-phyopt-shutdown-token';
