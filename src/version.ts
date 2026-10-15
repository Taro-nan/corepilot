/**
 * Single source of truth for the product version and the wire API version.
 *
 * `VERSION` must stay in sync with package.json "version"; `PHYOPT_API_VERSION`
 * is the backend protocol version the CLI/IDE client requires. A client may only
 * reuse a backend whose reported api_version equals this value — no silent
 * downgrade, no Mock fallback.
 */
export const VERSION = '0.4.0';

export const PHYOPT_API_VERSION = 1;
