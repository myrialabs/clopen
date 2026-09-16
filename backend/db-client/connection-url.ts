/**
 * One connection URL, built in one place.
 *
 * Four drivers each assembled their own `scheme://user:pass@host:port/db`, and
 * then DB Client grew a fifth caller — the variable it writes into a project's
 * `.env`. Five hand-rolled builders is five chances to forget to percent-encode
 * a password, and the one the user COPIES has to agree with the one Clopen
 * connects with or the panel is lying about what it is connected to.
 *
 * The differences between callers are real, so they are options rather than
 * forks: the drivers rewrite host and port to the local end of an SSH tunnel,
 * Bun's `SQL` wants the `postgres` scheme where a human expects `postgresql`,
 * and Redis's URL has only ever carried a password. Everything else — encoding,
 * the empty-username case, default ports — is shared, which is the point.
 */

import type { DbClientConnection, DbDriver } from '$shared/types/db-client';

export const DEFAULT_PORTS: Record<DbDriver, number | null> = {
	postgres: 5432,
	mysql: 3306,
	mongodb: 27017,
	redis: 6379,
	mssql: 1433,
	// A SQLite connection is a file path, not an endpoint.
	sqlite: null
};

export interface ConnectionUrlOptions {
	/**
	 * Rewrites host and port to the local end of an open SSH tunnel.
	 *
	 * The DRIVERS pass this; the environment variable must not. A tunnel belongs
	 * to Clopen's own process, so a project's dev server cannot reach it and a
	 * `127.0.0.1` URL in someone's `.env` would fail the moment Clopen closed.
	 */
	tunnelPort?: number;
	/** `postgres` for Bun's `SQL`, `postgresql` for a string a human reads. */
	scheme?: string;
	/** Substituted when the connection names no database. */
	fallbackDatabase?: string;
	/** Redis's URL has only ever carried the password. */
	omitUsername?: boolean;
}

function authOf(
	conn: DbClientConnection,
	options: ConnectionUrlOptions
): string {
	const user = options.omitUsername ? '' : encodeURIComponent(conn.username ?? '');
	const password = conn.password ? `:${encodeURIComponent(conn.password)}` : '';
	// A password with no user is legal in Redis (`redis://:pw@host`) and nowhere
	// else, which is exactly where `omitUsername` is used.
	if (!user && !options.omitUsername) return '';
	if (!user && !password) return '';
	return `${user}${password}@`;
}

function hostOf(conn: DbClientConnection, options: ConnectionUrlOptions): string {
	return options.tunnelPort ? '127.0.0.1' : (conn.host ?? '127.0.0.1');
}

function portOf(conn: DbClientConnection, options: ConnectionUrlOptions): number {
	return options.tunnelPort ?? conn.port ?? DEFAULT_PORTS[conn.driver] ?? 0;
}

function databaseOf(conn: DbClientConnection, options: ConnectionUrlOptions): string {
	if (conn.database) return `/${encodeURIComponent(conn.database)}`;
	return options.fallbackDatabase ? `/${encodeURIComponent(options.fallbackDatabase)}` : '';
}

function withQuery(base: string, params: URLSearchParams): string {
	const query = params.toString();
	return query ? `${base}?${query}` : base;
}

/**
 * The URL for a connection, in whichever dialect the caller needs.
 *
 * SQLite answers with the `file:` form every ORM in common use accepts, because
 * there is no endpoint to describe — and returning an empty string would put a
 * blank `DATABASE_URL` into someone's environment.
 */
export function buildConnectionUrl(
	conn: DbClientConnection,
	options: ConnectionUrlOptions = {}
): string {
	const auth = authOf(conn, options);
	const host = hostOf(conn, options);
	const port = portOf(conn, options);

	switch (conn.driver) {
		case 'postgres': {
			const params = new URLSearchParams();
			if (conn.sslMode && conn.sslMode !== 'disable') params.set('sslmode', conn.sslMode);
			const scheme = options.scheme ?? 'postgresql';
			return withQuery(`${scheme}://${auth}${host}:${port}${databaseOf(conn, options)}`, params);
		}

		case 'mysql':
			return `mysql://${auth}${host}:${port}${databaseOf(conn, options)}`;

		case 'mongodb': {
			const params = new URLSearchParams();
			if (conn.username) {
				const authSource =
					typeof conn.options?.authSource === 'string' ? conn.options.authSource : 'admin';
				params.set('authSource', authSource);
			}
			return withQuery(`mongodb://${auth}${host}:${port}${databaseOf(conn, options)}`, params);
		}

		case 'redis': {
			// Redis's `database` is a numeric index, and a non-numeric value means
			// the connection names no index rather than a database called that.
			const index = conn.database && /^\d+$/.test(conn.database) ? `/${conn.database}` : '';
			return `redis://${authOf(conn, { ...options, omitUsername: true })}${host}:${port}${index}`;
		}

		case 'mssql':
			return `mssql://${auth}${host}:${port}${databaseOf(conn, options)}`;

		case 'sqlite':
			return conn.database ? `file:${conn.database}` : '';
	}
}
