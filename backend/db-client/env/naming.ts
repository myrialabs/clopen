/**
 * What a connection is called in a dotenv file.
 *
 * TWO SHAPES AND A PREFIX, and nothing else. An earlier version shipped a
 * dropdown of frameworks — Laravel, Prisma, libpq, Vercel/Supabase, Neon — and
 * every entry in it was the same assertion: *this* is what a project of that
 * kind calls its database. Which is a guess about a project whose files are
 * right there on disk.
 *
 * So the frameworks are gone and `detect.ts` answers instead. It reads the
 * project's own `.env`, its `.env.example` and its ORM config, and hands back
 * the ACTUAL key names with a role attached to each — which is what `keyMap`
 * carries here. A project using `DB_USERNAME` gets `DB_USERNAME` written; one
 * using `POSTGRES_URL` gets that; and the two generic shapes below are what a
 * project with nothing in it is offered.
 *
 * What remains here is DRIVER vocabulary, not framework vocabulary: Mongo's
 * variable has always been `MONGODB_URI` and not `MONGODB_URL`, and a Redis
 * connection has no user to name. That is a fact about the driver, so it lives
 * with the driver rather than in a list of frameworks.
 */

import type {
	DbClientConnection,
	DbDriver,
	DbEnvRole,
	DbEnvShape,
	DbEnvShapeInfo,
	DbEnvVar
} from '$shared/types/db-client';
import { DEFAULT_PORTS } from '../connection-url';

/** How each driver's own ecosystem spells things. */
const DRIVER_NAMING: Record<DbDriver, { prefix: string; urlSuffix: string }> = {
	postgres: { prefix: 'DATABASE', urlSuffix: '_URL' },
	mysql: { prefix: 'DATABASE', urlSuffix: '_URL' },
	mssql: { prefix: 'DATABASE', urlSuffix: '_URL' },
	sqlite: { prefix: 'DATABASE', urlSuffix: '_URL' },
	// Every Mongo driver looks for `MONGODB_URI`. `MONGODB_URL` is not a variant
	// of it, it is a variable nothing reads.
	mongodb: { prefix: 'MONGODB', urlSuffix: '_URI' },
	redis: { prefix: 'REDIS', urlSuffix: '_URL' }
};

/** `DATABASE_HOST` is nobody's convention; `DB_HOST` is everybody's. */
const SPLIT_PREFIX = 'DB';

/** The suffix a second endpoint's variable carries, when the provider has one. */
export const DEFAULT_ALT_SUFFIX = '_UNPOOLED';

export interface EnvNaming {
	shape: DbEnvShape;
	prefix: string;
	/** Exact names, overriding what the prefix would produce. */
	keyMap?: Partial<Record<DbEnvRole, string>>;
	/** From the provider, for the second endpoint — `_UNPOOLED`, `_NON_POOLING`. */
	altSuffix?: string;
}

export function defaultPrefixFor(driver: DbDriver, shape: DbEnvShape): string {
	return shape === 'split' ? SPLIT_PREFIX : DRIVER_NAMING[driver].prefix;
}

/** The variable a role lands in, unless the project already calls it something. */
export function keyFor(role: DbEnvRole, driver: DbDriver, naming: EnvNaming): string {
	const named = naming.keyMap?.[role];
	if (named) return named;

	const prefix = naming.prefix;
	switch (role) {
		case 'url':
			return `${prefix}${DRIVER_NAMING[driver].urlSuffix}`;
		case 'altUrl':
			return `${prefix}${DRIVER_NAMING[driver].urlSuffix}${naming.altSuffix ?? DEFAULT_ALT_SUFFIX}`;
		case 'host':
			return `${prefix}_HOST`;
		case 'port':
			return `${prefix}_PORT`;
		case 'user':
			return `${prefix}_USER`;
		case 'password':
			return `${prefix}_PASSWORD`;
		case 'database':
			// A SQLite connection is a file path, so the field is not a name.
			return driver === 'sqlite' ? `${prefix}_PATH` : `${prefix}_NAME`;
		case 'sslMode':
			return `${prefix}_SSLMODE`;
	}
}

export interface EnvRenderInput {
	connection: DbClientConnection;
	naming: EnvNaming;
	/** The URL for the connection exactly as DB Client reaches it. */
	url: string;
	/** The provider's direct/unpooled counterpart, when one was resolved. */
	alternateUrl: string | null;
}

/**
 * Render the variables.
 *
 * An empty value is DROPPED rather than written, because `DB_HOST=` reads as a
 * configured empty host and fails later than not being there at all. The
 * password is the exception: a local database with no password is a real
 * configuration, and a project whose `.env` ships `DB_PASSWORD=` empty needs
 * that line to keep existing.
 */
export function renderEnvVars(input: EnvRenderInput): DbEnvVar[] {
	const { connection, naming } = input;
	const driver = connection.driver;
	const vars: DbEnvVar[] = [];

	const push = (
		role: DbEnvRole,
		value: string | null | undefined,
		options?: { secret?: boolean; keepEmpty?: boolean; note?: string }
	): void => {
		const text = value ?? '';
		if (!text && !options?.keepEmpty) return;
		vars.push({
			key: keyFor(role, driver, naming),
			value: text,
			isSecret: Boolean(options?.secret),
			note: options?.note ?? null
		});
	};

	if (naming.shape === 'url') {
		push('url', input.url, { secret: Boolean(connection.password) });
		if (input.alternateUrl) {
			push('altUrl', input.alternateUrl, {
				secret: Boolean(connection.password),
				note: 'The direct endpoint, which migrations need.'
			});
		}
		return vars;
	}

	// SQLite has no endpoint, so the split shape is one variable: the path.
	// Writing a host and a port for it would be inventing an endpoint.
	if (driver === 'sqlite') {
		push('database', connection.database);
		return vars;
	}

	push('host', connection.host);
	const port = connection.port ?? DEFAULT_PORTS[driver];
	push('port', port ? String(port) : '');
	// Redis's URL has only ever carried a password, so there is no user to name.
	if (driver !== 'redis') push('user', connection.username);
	push('password', connection.password, { secret: true, keepEmpty: true });
	push('database', connection.database);
	if (connection.sslMode && connection.sslMode !== 'disable') {
		push('sslMode', connection.sslMode);
	}

	return vars;
}

/** Both shapes, with the keys each would actually write for this connection. */
export function shapeInfos(input: {
	connection: DbClientConnection;
	naming: EnvNaming;
	url: string;
	hasAlternate: boolean;
}): DbEnvShapeInfo[] {
	const describe = (shape: DbEnvShape, label: string, description: string): DbEnvShapeInfo => {
		// The keys shown are the keys that WOULD be written, built by rendering —
		// not a second hard-coded list that can drift from the first.
		const naming: EnvNaming = {
			...input.naming,
			shape,
			prefix:
				input.naming.shape === shape
					? input.naming.prefix
					: defaultPrefixFor(input.connection.driver, shape),
			// A key map belongs to the shape it was detected in; carrying a split
			// project's `DB_HOST` into the URL preview would show a name that
			// shape never writes.
			keyMap: input.naming.shape === shape ? input.naming.keyMap : undefined
		};
		return {
			id: shape,
			label,
			description,
			sampleKeys: renderEnvVars({
				connection: input.connection,
				naming,
				url: input.url,
				// Presence only: the sample has to include the second variable when
				// there is a second endpoint to put in it.
				alternateUrl: shape === 'url' && input.hasAlternate ? 'pending' : null
			}).map((entry) => entry.key)
		};
	};

	return [
		describe('url', 'Single URL', 'One variable holding the whole connection string.'),
		describe('split', 'Separate variables', 'Host, port, user, password and database, one each.')
	];
}
