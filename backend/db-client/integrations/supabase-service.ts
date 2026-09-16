/**
 * The Supabase surface, resolved against one DB Client connection.
 *
 * Everything here starts from the same question: given a connection the user is
 * looking at, is this Supabase, and is there an account behind it? There are
 * three answers, and the tabs behave differently for each:
 *
 *   - **Linked**: the connection is a projection of a Supabase account. SQL and
 *     the Management API are both available.
 *   - **Local**: a `supabase start` stack detected from the working tree. SQL
 *     only, and the API-backed tabs say what they need instead of showing empty.
 *   - **Neither**: not a Supabase connection, and the surface does not appear.
 *
 * The project root matters even for a linked project, because migrations and
 * generated types are files in the repository rather than facts about the
 * database.
 */

import { dirname, isAbsolute, join, relative } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import {
	dbClientConnectionQueries,
	integrationAccountQueries
} from '$backend/database/queries';
import type {
	SupabaseAuthUsersPage,
	SupabaseBucket,
	SupabaseConnectionContext,
	SupabaseEdgeFunction,
	SupabaseMigrationsReport,
	SupabaseRlsReport,
	SupabaseTypesResult
} from '$shared/types/db-client';
import { connectionManager } from '../connection-manager';
import type { DbClientDriverAdapter } from '../drivers/types';
import { SUPABASE_PROVIDER_ID, supabaseCredentialsOf } from '../providers/supabase/adapter';
import {
	getSupabaseRateLimit,
	primeSupabaseRateLimit,
	type SupabaseCredentials
} from '../providers/supabase/client';
import { detectLocalSupabase, type SupabaseLocalProject } from '../providers/supabase/local';
import {
	generateTypes,
	readAuthUsers,
	readBuckets,
	readEdgeFunctionBody,
	readEdgeFunctions,
	readMigrations,
	readMigrationSql,
	readRls
} from '../providers/supabase/features';
import { applyMigration } from '../providers/supabase/apply-migration';
import { dbLinks } from './links';
import { debug } from '$shared/utils/logger';

/** Everything the routes need to serve one request about one connection. */
export interface SupabaseScope {
	context: SupabaseConnectionContext;
	adapter: DbClientDriverAdapter;
	/** Null when there is no account — the API-backed tabs check this. */
	remote: { credentials: SupabaseCredentials; ref: string } | null;
	/** Which account owns this connection, for the surface's footer. */
	accountLabel: string | null;
	local: SupabaseLocalProject | null;
	projectRoot: string | null;
}

/**
 * The `supabase` marker on a connection's options.
 *
 * Written by the projector (from the adapter's endpoint) and by the local
 * adoption path. It is what lets db-client recognise a Supabase connection
 * without learning what an integration account is.
 */
function optionsRef(options: Record<string, unknown>): { ref: string; local: boolean } | null {
	const marker = options.supabase;
	if (!marker || typeof marker !== 'object') return null;
	const ref = (marker as { ref?: unknown }).ref;
	if (typeof ref !== 'string' || !ref) return null;
	return { ref, local: (marker as { local?: unknown }).local === true };
}

/**
 * Resolve a connection into a Supabase scope, or null when it is not one.
 *
 * `projectRoot` is passed in rather than looked up: the routes already resolve
 * and access-check a project, and a service that resolved its own would be a
 * second, unchecked path to a user's files.
 */
export async function resolveSupabaseScope(
	connectionId: string,
	projectRoot: string | null
): Promise<SupabaseScope | null> {
	const connection = dbClientConnectionQueries.get(connectionId);
	if (!connection) return null;

	const link = dbLinks.linkForConnection(connectionId);
	const marker = optionsRef(connection.options ?? {});
	const local = projectRoot ? await detectLocalSupabase(projectRoot) : null;

	// A linked account wins over the marker: the marker is derived from it, and
	// on a local connection there is no account to contradict.
	const isSupabaseAccount = link?.account.provider === SUPABASE_PROVIDER_ID;
	const ref = isSupabaseAccount ? link.link.remote_ref : marker?.ref ?? null;
	if (!ref) return null;

	const adapter = await connectionManager.get(connectionId);

	let remote: SupabaseScope['remote'] = null;
	if (isSupabaseAccount && link) {
		const account = integrationAccountQueries.getById(link.account.id);
		if (account && account.is_enabled === 1) {
			try {
				remote = {
					credentials: supabaseCredentialsOf({
						accountId: account.id,
						credentials: integrationAccountQueries.credentialsOf(account)
					}),
					ref
				};
			} catch (error) {
				// A credential the active key could not open. The SQL half still
				// works, so the surface degrades rather than disappears.
				debug.warn('db-client', `Supabase account ${account.id} has no usable token:`, error);
			}
		}
	}

	return {
		context: {
			ref,
			accountId: remote ? link?.account.id ?? null : null,
			projectName: link?.link.label ?? null,
			// Local means "this connection points at a stack on this machine",
			// which the marker records and a linked project never sets.
			isLocal: marker?.local === true
		},
		adapter,
		remote,
		accountLabel: link?.account.label ?? null,
		// Reported whenever the working tree has one, even for a LINKED remote
		// project: the migration files live in the repository either way, and a
		// linked project with no local checkout simply has none to compare
		// against.
		local,
		projectRoot
	};
}

function requireRemote(scope: SupabaseScope): { credentials: SupabaseCredentials; ref: string } {
	if (!scope.remote) {
		throw new Error(
			'This needs a connected Supabase account — a local stack has no Management API to ask.'
		);
	}
	return scope.remote;
}

export const supabaseSurface = {
	context(scope: SupabaseScope): SupabaseConnectionContext {
		return scope.context;
	},

	/**
	 * The latest rate-limit reading for this scope's account, or null.
	 *
	 * Takes one if the account has never produced one, so the footer is correct
	 * the first time a connection is opened rather than only after some other tab
	 * happened to call the API.
	 */
	async rateLimit(scope: SupabaseScope) {
		if (!scope.remote) return null;
		await primeSupabaseRateLimit(scope.remote.credentials, scope.remote.ref);
		return getSupabaseRateLimit(scope.remote.credentials);
	},

	migrations(scope: SupabaseScope): Promise<SupabaseMigrationsReport> {
		return readMigrations(scope.adapter, scope.local?.migrationsDir ?? null);
	},

	migrationSql(path: string): Promise<string> {
		return readMigrationSql(path);
	},

	/**
	 * Apply one pending migration.
	 *
	 * The path is re-derived from the report rather than taken from the client:
	 * a caller that could name any file would turn this into "run arbitrary SQL
	 * from anywhere on disk against the production database".
	 */
	async apply(scope: SupabaseScope, version: string): Promise<{ version: string; durationMs: number }> {
		const report = await readMigrations(scope.adapter, scope.local?.migrationsDir ?? null);
		const migration = report.migrations.find((entry) => entry.version === version);
		if (!migration) throw new Error(`Migration ${version} is not in this project`);
		if (migration.isApplied) throw new Error(`Migration ${version} is already applied`);
		if (!migration.path) throw new Error(`Migration ${version} has no local file to apply`);

		const sql = await readMigrationSql(migration.path);
		return applyMigration({ adapter: scope.adapter, version, name: migration.name, sql });
	},

	rls(scope: SupabaseScope): Promise<SupabaseRlsReport> {
		return readRls(scope.adapter, scope.remote);
	},

	buckets(scope: SupabaseScope): Promise<SupabaseBucket[]> {
		return readBuckets(scope.adapter);
	},

	authUsers(
		scope: SupabaseScope,
		options: { search?: string; limit?: number; offset?: number }
	): Promise<SupabaseAuthUsersPage> {
		return readAuthUsers(scope.adapter, options);
	},

	functions(scope: SupabaseScope): Promise<SupabaseEdgeFunction[]> {
		return readEdgeFunctions(scope.remote, scope.local?.functionsDir ?? null);
	},

	functionBody(scope: SupabaseScope, slug: string): Promise<string> {
		return readEdgeFunctionBody(scope.remote, slug, scope.local?.functionsDir ?? null);
	},

	async types(scope: SupabaseScope, schemas: string[]): Promise<SupabaseTypesResult> {
		const remote = requireRemote(scope);
		return generateTypes(remote.credentials, remote.ref, schemas);
	},

	/**
	 * Write generated types into the project.
	 *
	 * The path is resolved against the project root and refused if it escapes —
	 * this is a client-supplied path that ends in a file write, so "somewhere
	 * inside this project" has to be enforced rather than assumed.
	 */
	async writeTypes(
		scope: SupabaseScope,
		relativePath: string,
		contents: string
	): Promise<{ path: string; bytes: number }> {
		if (!scope.projectRoot) throw new Error('No project is open to write types into');

		// Containment is checked with `relative()` rather than a string prefix:
		// a prefix test has to know the platform's separator, and on Windows
		// `join` returns backslashes, so `startsWith(root + '/')` refuses every
		// legitimate path. `relative` normalises both sides first.
		const target = join(scope.projectRoot, relativePath);
		const inside = relative(scope.projectRoot, target);
		if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
			throw new Error('That path is outside the project');
		}

		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf-8');
		debug.log('db-client', `Wrote Supabase types to ${target}`);
		return { path: target, bytes: Buffer.byteLength(contents, 'utf-8') };
	},

	/** The local stack a project has, for the "adopt this" entry point. */
	detectLocal(projectRoot: string) {
		return detectLocalSupabase(projectRoot);
	}
};
