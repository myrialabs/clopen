/**
 * db-client — shared connection-pool tuning.
 *
 * A DB browser has a low-concurrency workload: at most a running query plus a
 * reserved transaction connection. The library defaults (Bun.sql `max: 10`,
 * `idleTimeout: 0` = never release) let a single browsed connection hold up to
 * 10 server-side sessions and keep them open indefinitely — so a few
 * connections, database switches, or dev-mode restarts quickly exhaust the
 * server's `max_connections` ("too many clients already"). These bounds keep
 * the socket footprint small and let idle sockets drop on their own.
 */

/** Max concurrent server connections a single adapter's pool may open. */
export const POOL_MAX = 3;

/** Seconds an idle pooled socket is kept before the driver closes it. */
export const POOL_IDLE_TIMEOUT_SEC = 20;

/** Seconds to wait for a new connection before failing. */
export const POOL_CONNECTION_TIMEOUT_SEC = 30;

/**
 * Pool options for Bun.sql-based adapters (Postgres, MySQL).
 * `maxLifetime: 0` keeps healthy connections; idle release is handled by
 * `idleTimeout` instead.
 */
export const BUN_SQL_POOL_OPTIONS = {
	max: POOL_MAX,
	idleTimeout: POOL_IDLE_TIMEOUT_SEC,
	maxLifetime: 0,
	connectionTimeout: POOL_CONNECTION_TIMEOUT_SEC
} as const;
