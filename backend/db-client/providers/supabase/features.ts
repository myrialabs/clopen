/**
 * The Supabase surface inside DB Client.
 *
 * ONE RULE decides where each of these reads goes: anything that lives inside
 * the database is read over SQL, through the connection DB Client already
 * holds; only what lives outside it goes to the Management API. That is not a
 * stylistic preference — it is what keeps five of the six tabs working for a
 * `supabase start` stack that has no access token, and it keeps us off
 * `POST /database/query`, which the API document marks as beta.
 *
 * So: policies, applied migrations, storage buckets and auth users are plain
 * Postgres. Edge functions, generated types and the security advisor have no
 * SQL equivalent, and each of those says plainly what it needs when there is no
 * account behind the connection.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import type {
	SupabaseAdvisorLint,
	SupabaseAuthUser,
	SupabaseAuthUsersPage,
	SupabaseBucket,
	SupabaseEdgeFunction,
	SupabaseMigration,
	SupabaseMigrationsReport,
	SupabasePolicy,
	SupabaseRlsReport,
	SupabaseTableRls,
	SupabaseTypesResult
} from '$shared/types/db-client';
import type { DbClientDriverAdapter } from '../../drivers/types';
import type { SupabaseApiAdvisorResponse, SupabaseApiFunction, SupabaseApiTypes } from './api-types';
import { SUPABASE_SLOW_TIMEOUT_MS, SupabaseError, supabaseRequest, type SupabaseCredentials } from './client';
import { debug } from '$shared/utils/logger';

/** Rows out of a read, or an empty list — a missing schema is not an error here. */
async function rows(
	adapter: DbClientDriverAdapter,
	sql: string,
	params: unknown[] = []
): Promise<Record<string, unknown>[]> {
	if (!adapter.executeRead) throw new Error('This connection cannot run queries');
	// `limit` is passed explicitly because the executor's default auto-LIMIT is
	// tuned for the query console. These are catalogue reads, and a truncated
	// policy list would be a wrong answer rather than a short one.
	const result = await adapter.executeRead(sql, params, { limit: 10_000 });
	return result.rows;
}

function text(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return String(value);
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * The CLI's own bookkeeping table.
 *
 * `supabase_migrations.schema_migrations` is what `supabase db push` writes,
 * and reading it directly is what lets this tab tell the truth for a local
 * stack. A project that has never had a migration pushed has no such table, so
 * its absence means "none applied" rather than a failure.
 */
async function appliedVersions(adapter: DbClientDriverAdapter): Promise<Map<string, string | null>> {
	const applied = new Map<string, string | null>();
	try {
		const result = await rows(
			adapter,
			`SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version ASC`
		);
		for (const row of result) {
			const version = text(row.version);
			if (version) applied.set(version, text(row.name));
		}
	} catch (error) {
		debug.log('db-client', `No supabase_migrations table: ${error instanceof Error ? error.message : error}`);
	}
	return applied;
}

/** `20240101120000_create_widgets.sql` → version and name. */
function parseMigrationFile(fileName: string): { version: string; name: string | null } | null {
	const match = /^(\d+)(?:_(.*))?\.sql$/i.exec(fileName);
	if (!match) return null;
	return { version: match[1], name: match[2] ? match[2].replace(/_/g, ' ') : null };
}

export async function readMigrations(
	adapter: DbClientDriverAdapter,
	migrationsDir: string | null
): Promise<SupabaseMigrationsReport> {
	const applied = await appliedVersions(adapter);
	const byVersion = new Map<string, SupabaseMigration>();

	for (const [version, name] of applied) {
		byVersion.set(version, { version, name, isApplied: true, path: null, size: null });
	}

	if (migrationsDir) {
		let entries: string[] = [];
		try {
			entries = await readdir(migrationsDir);
		} catch {
			// No migrations directory is an ordinary state for a project that has
			// only ever been changed through the dashboard.
			entries = [];
		}

		for (const entry of entries) {
			const parsed = parseMigrationFile(entry);
			if (!parsed) continue;
			const path = join(migrationsDir, entry);
			let size: number | null = null;
			try {
				size = (await stat(path)).size;
			} catch {
				size = null;
			}
			const existing = byVersion.get(parsed.version);
			byVersion.set(parsed.version, {
				version: parsed.version,
				name: parsed.name ?? existing?.name ?? null,
				isApplied: existing?.isApplied ?? false,
				path,
				size
			});
		}
	}

	const migrations = [...byVersion.values()].sort((a, b) => a.version.localeCompare(b.version));
	return {
		migrations,
		localDir: migrationsDir,
		// A version applied remotely with no local file means someone pushed from
		// elsewhere. Worth saying out loud before anyone applies anything.
		hasRemoteOnly: migrations.some((migration) => migration.isApplied && migration.path === null)
	};
}

/** The SQL of one pending migration, read from the working tree. */
export async function readMigrationSql(path: string): Promise<string> {
	return readFile(path, 'utf-8');
}

// ---------------------------------------------------------------------------
// RLS
// ---------------------------------------------------------------------------

/**
 * Which tables have row-level security on, and every policy on them.
 *
 * `pg_policies` is a view over `pg_policy` that renders the expressions back as
 * SQL text, which is what makes a policy readable without a parser. The table
 * list comes from `pg_class` because a table with RLS enabled and NO policies
 * is the dangerous case, and it does not appear in `pg_policies` at all.
 *
 * Supabase's internal schemas are excluded: `auth`, `storage` and friends carry
 * dozens of policies the user did not write and cannot change, and they bury the
 * handful that belong to the application.
 */
const USER_SCHEMA_FILTER = `
	n.nspname NOT IN (
		'pg_catalog','information_schema','auth','storage','graphql','graphql_public',
		'realtime','supabase_functions','supabase_migrations','vault','extensions','pgbouncer','net','cron'
	)
	AND n.nspname NOT LIKE 'pg_%'
`;

async function readTableRls(adapter: DbClientDriverAdapter): Promise<SupabaseTableRls[]> {
	const result = await rows(adapter, `
		SELECT
			n.nspname AS schema_name,
			c.relname AS table_name,
			c.relrowsecurity AS rls_enabled,
			(SELECT COUNT(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind IN ('r','p') AND ${USER_SCHEMA_FILTER}
		ORDER BY n.nspname, c.relname
	`);

	return result.map((row) => ({
		schema: String(row.schema_name),
		table: String(row.table_name),
		rlsEnabled: row.rls_enabled === true || row.rls_enabled === 't' || row.rls_enabled === 1,
		policyCount: Number(row.policy_count ?? 0)
	}));
}

async function readPolicies(adapter: DbClientDriverAdapter): Promise<SupabasePolicy[]> {
	const result = await rows(adapter, `
		SELECT
			n.nspname AS schema_name,
			c.relname AS table_name,
			pol.polname AS policy_name,
			CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS permissive,
			CASE pol.polcmd
				WHEN 'r' THEN 'SELECT'
				WHEN 'a' THEN 'INSERT'
				WHEN 'w' THEN 'UPDATE'
				WHEN 'd' THEN 'DELETE'
				ELSE 'ALL'
			END AS command,
			COALESCE(
				(SELECT array_agg(rolname ORDER BY rolname) FROM pg_roles WHERE oid = ANY(pol.polroles)),
				ARRAY['public']::name[]
			) AS roles,
			pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
			pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
		FROM pg_policy pol
		JOIN pg_class c ON c.oid = pol.polrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE ${USER_SCHEMA_FILTER}
		ORDER BY n.nspname, c.relname, pol.polname
	`);

	return result.map((row) => ({
		schema: String(row.schema_name),
		table: String(row.table_name),
		name: String(row.policy_name),
		permissive: String(row.permissive),
		command: String(row.command),
		roles: Array.isArray(row.roles) ? row.roles.map(String) : [],
		using: text(row.using_expr),
		withCheck: text(row.check_expr)
	}));
}

/**
 * The security advisor.
 *
 * Account-only: there is no SQL behind it, it is Supabase's own lint set. The
 * findings that matter most here — a public table with RLS off, RLS on with no
 * policy, a policy on a table where RLS is disabled — are exactly the mistakes
 * a policy list alone cannot show, which is why the tab is worth the extra call.
 */
async function readAdvisorLints(
	credentials: SupabaseCredentials,
	ref: string
): Promise<SupabaseAdvisorLint[]> {
	const response = await supabaseRequest<SupabaseApiAdvisorResponse>(
		credentials,
		`/v1/projects/${encodeURIComponent(ref)}/advisors/security`
	);

	return (response?.lints ?? []).map((lint) => {
		const metadata = lint.metadata ?? {};
		const entity = typeof metadata.entity === 'string' ? metadata.entity : null;
		const name = typeof metadata.name === 'string' ? metadata.name : null;
		return {
			name: lint.name ?? 'lint',
			title: lint.title ?? lint.name ?? 'Finding',
			level: lint.level ?? 'info',
			facing: lint.facing ?? 'unknown',
			description: lint.description ?? '',
			detail: lint.detail ?? null,
			remediation: lint.remediation ?? null,
			target: entity ?? name
		};
	});
}

export async function readRls(
	adapter: DbClientDriverAdapter,
	remote: { credentials: SupabaseCredentials; ref: string } | null
): Promise<SupabaseRlsReport> {
	const [tables, policies] = await Promise.all([readTableRls(adapter), readPolicies(adapter)]);

	if (!remote) {
		return {
			tables,
			policies,
			lints: [],
			advisorError: 'Connect a Supabase account to run the security advisor — it has no SQL equivalent.'
		};
	}

	try {
		return { tables, policies, lints: await readAdvisorLints(remote.credentials, remote.ref), advisorError: null };
	} catch (error) {
		// The advisor failing must not take the policy list with it: the SQL half
		// is the substance of this tab, and the lints are the bonus.
		const message = error instanceof SupabaseError ? error.message : error instanceof Error ? error.message : String(error);
		return { tables, policies, lints: [], advisorError: message };
	}
}

// ---------------------------------------------------------------------------
// Storage buckets — `storage.buckets` is an ordinary table
// ---------------------------------------------------------------------------

export async function readBuckets(adapter: DbClientDriverAdapter): Promise<SupabaseBucket[]> {
	const result = await rows(adapter, `
		SELECT
			b.id, b.name, b.public, b.file_size_limit, b.allowed_mime_types,
			b.created_at, b.updated_at,
			(SELECT COUNT(*) FROM storage.objects o WHERE o.bucket_id = b.id) AS object_count
		FROM storage.buckets b
		ORDER BY b.name
	`);

	return result.map((row) => ({
		id: String(row.id),
		name: String(row.name),
		isPublic: row.public === true || row.public === 't' || row.public === 1,
		fileSizeLimit: row.file_size_limit === null || row.file_size_limit === undefined
			? null
			: Number(row.file_size_limit),
		allowedMimeTypes: Array.isArray(row.allowed_mime_types) ? row.allowed_mime_types.map(String) : null,
		objectCount: row.object_count === null || row.object_count === undefined ? null : Number(row.object_count),
		createdAt: text(row.created_at),
		updatedAt: text(row.updated_at)
	}));
}

// ---------------------------------------------------------------------------
// Auth users — `auth.users` is an ordinary table too
// ---------------------------------------------------------------------------

/**
 * Read users over SQL rather than through the GoTrue admin API.
 *
 * The admin API would need the project's SERVICE ROLE key, which is a key that
 * bypasses every policy in the database. Storing one to render a read-only list
 * would be a poor trade, and `auth.users` answers the same question with the
 * credential this connection already has.
 *
 * `encrypted_password` and the token columns are never selected.
 */
export async function readAuthUsers(
	adapter: DbClientDriverAdapter,
	options: { search?: string; limit?: number; offset?: number } = {}
): Promise<SupabaseAuthUsersPage> {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
	const offset = Math.max(options.offset ?? 0, 0);
	const search = (options.search ?? '').trim();

	// Interpolated into a LIKE pattern rather than passed as a parameter because
	// the driver's parameter style differs per database and this file must stay
	// driver-agnostic; the value is escaped for quotes and wildcards first.
	const escaped = search.replace(/'/g, "''").replace(/[%_]/g, (char) => `\\${char}`);
	const filter = search
		? `WHERE (u.email ILIKE '%${escaped}%' ESCAPE '\\' OR u.phone ILIKE '%${escaped}%' ESCAPE '\\')`
		: '';

	const countRows = await rows(adapter, `SELECT COUNT(*) AS total FROM auth.users u ${filter}`);
	const total = Number(countRows[0]?.total ?? 0);

	const result = await rows(adapter, `
		SELECT
			u.id, u.email, u.phone, u.created_at, u.last_sign_in_at,
			u.confirmed_at, u.banned_until,
			u.raw_app_meta_data ->> 'provider' AS provider,
			u.raw_app_meta_data -> 'providers' AS providers
		FROM auth.users u
		${filter}
		ORDER BY u.created_at DESC
		LIMIT ${limit} OFFSET ${offset}
	`);

	const users: SupabaseAuthUser[] = result.map((row) => {
		const list = row.providers;
		const providers = Array.isArray(list)
			? list.map(String)
			: text(row.provider)
				? [String(row.provider)]
				: [];
		const bannedUntil = text(row.banned_until);
		return {
			id: String(row.id),
			email: text(row.email),
			phone: text(row.phone) || null,
			providers,
			createdAt: text(row.created_at),
			lastSignInAt: text(row.last_sign_in_at),
			confirmedAt: text(row.confirmed_at),
			// `banned_until` is a timestamp, not a flag: a ban that has expired is
			// not a ban, and rendering it as one would accuse the wrong accounts.
			isBanned: bannedUntil !== null && new Date(bannedUntil).getTime() > Date.now()
		};
	});

	return { users, total };
}

// ---------------------------------------------------------------------------
// Edge functions — remote through the API, local from the working tree
// ---------------------------------------------------------------------------

export async function readEdgeFunctions(
	remote: { credentials: SupabaseCredentials; ref: string } | null,
	functionsDir: string | null
): Promise<SupabaseEdgeFunction[]> {
	if (remote) {
		const functions = await supabaseRequest<SupabaseApiFunction[]>(
			remote.credentials,
			`/v1/projects/${encodeURIComponent(remote.ref)}/functions`
		);
		return (functions ?? []).map((fn) => ({
			id: fn.id,
			slug: fn.slug,
			name: fn.name,
			status: fn.status,
			version: fn.version ?? null,
			// Epoch MILLISECONDS, not an ISO string and not seconds — the API
			// document is explicit about it, and reading it as seconds dates every
			// function to 1970.
			createdAt: fn.created_at ? new Date(fn.created_at).toISOString() : null,
			updatedAt: fn.updated_at ? new Date(fn.updated_at).toISOString() : null,
			verifyJwt: fn.verify_jwt ?? null,
			entrypointPath: fn.entrypoint_path ?? null,
			isLocal: false
		}));
	}

	if (!functionsDir) return [];

	// No account: list what the working tree has, so a local stack still shows
	// something true rather than an empty tab with no explanation.
	let entries: { name: string; isDirectory(): boolean }[] = [];
	try {
		entries = await readdir(functionsDir, { withFileTypes: true });
	} catch {
		return [];
	}

	return entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
		.map((entry) => ({
			id: entry.name,
			slug: entry.name,
			name: entry.name,
			status: 'LOCAL',
			version: null,
			createdAt: null,
			updatedAt: null,
			verifyJwt: null,
			entrypointPath: join(functionsDir, entry.name, 'index.ts'),
			isLocal: true
		}));
}

/** The source of one function — the deployed body, or the local entrypoint. */
export async function readEdgeFunctionBody(
	remote: { credentials: SupabaseCredentials; ref: string } | null,
	slug: string,
	functionsDir: string | null
): Promise<string> {
	if (remote) {
		// The body endpoint answers with the bundled source as text rather than
		// JSON, so it cannot go through `supabaseRequest`.
		const response = await fetch(
			`https://api.supabase.com/v1/projects/${encodeURIComponent(remote.ref)}/functions/${encodeURIComponent(slug)}/body`,
			{
				headers: { Authorization: `Bearer ${remote.credentials.accessToken}`, 'User-Agent': 'clopen' },
				signal: AbortSignal.timeout(SUPABASE_SLOW_TIMEOUT_MS)
			}
		);
		if (!response.ok) {
			throw new SupabaseError(
				`Could not read ${slug}: ${response.statusText || `HTTP ${response.status}`}`,
				response.status,
				response.status === 401 ? 'auth' : 'error'
			);
		}
		return response.text();
	}

	if (!functionsDir) throw new Error('No Supabase account and no local functions directory');
	return readFile(join(functionsDir, slug, 'index.ts'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Generated types — API only, and there is no local equivalent
// ---------------------------------------------------------------------------

export async function generateTypes(
	credentials: SupabaseCredentials,
	ref: string,
	schemas: string[]
): Promise<SupabaseTypesResult> {
	const response = await supabaseRequest<SupabaseApiTypes>(
		credentials,
		`/v1/projects/${encodeURIComponent(ref)}/types/typescript`,
		{
			query: { included_schemas: schemas.join(',') || 'public' },
			// Generating types for a large schema is real work upstream, and
			// aborting it at the read budget reports a timeout for something that
			// completed.
			timeoutMs: SUPABASE_SLOW_TIMEOUT_MS
		}
	);

	return {
		types: response?.types ?? '',
		suggestedPath: 'src/lib/database.types.ts'
	};
}
