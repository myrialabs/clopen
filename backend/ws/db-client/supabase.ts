/**
 * db-client — the Supabase surface.
 *
 * Every route starts by resolving a SCOPE: is this connection Supabase, and is
 * there an account behind it or only a local stack. A connection that is
 * neither answers `null` rather than an error, because the panel asks
 * speculatively when a connection is selected and "this is not Supabase" is an
 * ordinary answer.
 *
 * Access is checked the way the rest of this router checks it — the caller must
 * be able to reach the CONNECTION — plus a project-access check inside
 * `resolveDbClientProject` for the routes that touch the working tree. Reads
 * are open to whoever can use the connection; applying a migration and writing
 * types are not, and say so.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { resolveSupabaseScope, supabaseSurface, type SupabaseScope } from '../../db-client/integrations';
import { getDbClientPrincipal, requireDbClientConnectionAccess } from './access';
import { resolveDbClientProject } from './context';
import type { WSConnection } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';

async function scopeFor(
	conn: WSConnection,
	connectionId: string,
	projectId?: string
): Promise<SupabaseScope | null> {
	requireDbClientConnectionAccess(conn, connectionId);
	const project = resolveDbClientProject(conn, projectId);
	return resolveSupabaseScope(connectionId, project?.root ?? null);
}

/**
 * A scope, or a readable failure.
 *
 * Used by every route that only makes sense for Supabase: reaching one of these
 * on a plain Postgres connection means the panel offered a tab it should not
 * have, and saying so beats returning an empty list that reads like "nothing
 * here".
 */
async function requireScope(
	conn: WSConnection,
	connectionId: string,
	projectId?: string
): Promise<SupabaseScope> {
	const scope = await scopeFor(conn, connectionId, projectId);
	if (!scope) throw new Error('This connection is not a Supabase project');
	return scope;
}

/**
 * Writes are admin-only.
 *
 * Applying a migration changes a schema everyone shares, and writing generated
 * types writes a file into the repository. Both are outward-facing in the sense
 * `Task 3` uses: the consequence outlives the request.
 */
function requireAdmin(conn: WSConnection, action: string): void {
	const { isAdmin } = getDbClientPrincipal(conn);
	if (!isAdmin) throw new Error(`Only an admin can ${action}`);
}

const connectionTarget = {
	connectionId: t.String({ minLength: 1 }),
	projectId: t.Optional(t.String())
};

export const supabaseHandler = createRouter()
	.http('db-client:supabase-context', {
		data: t.Object(connectionTarget),
		response: t.Nullable(t.Any())
	}, async ({ data, conn }) => {
		const scope = await scopeFor(conn, data.connectionId, data.projectId);
		if (!scope) return null;
		return {
			...supabaseSurface.context(scope),
			hasLocalProject: scope.local !== null,
			hasAccount: scope.remote !== null,
			accountLabel: scope.accountLabel,
			// Only meaningful for an account-backed connection; a local stack never
			// touches the Management API, so it has no budget to report.
			rateLimit: await supabaseSurface.rateLimit(scope)
		};
	})

	.http('db-client:supabase-migrations', {
		data: t.Object(connectionTarget),
		response: t.Any()
	}, async ({ data, conn }) => {
		const scope = await requireScope(conn, data.connectionId, data.projectId);
		return supabaseSurface.migrations(scope);
	})

	.http('db-client:supabase-migration-sql', {
		data: t.Object({ ...connectionTarget, version: t.String({ minLength: 1 }) }),
		response: t.Object({ sql: t.String() })
	}, async ({ data, conn }) => {
		const scope = await requireScope(conn, data.connectionId, data.projectId);
		const report = await supabaseSurface.migrations(scope);
		const migration = report.migrations.find((entry) => entry.version === data.version);
		// The path is looked up rather than accepted, so this cannot be used to
		// read a file outside the project's migrations directory.
		if (!migration?.path) throw new Error(`Migration ${data.version} has no local file`);
		return { sql: await supabaseSurface.migrationSql(migration.path) };
	})

	.http('db-client:supabase-apply-migration', {
		data: t.Object({ ...connectionTarget, version: t.String({ minLength: 1 }) }),
		response: t.Object({ version: t.String(), durationMs: t.Number() })
	}, async ({ data, conn }) => {
		requireAdmin(conn, 'apply a migration');
		const scope = await requireScope(conn, data.connectionId, data.projectId);
		const result = await supabaseSurface.apply(scope, data.version);
		debug.log('db-client', `Supabase migration ${result.version} applied to ${scope.context.ref}`);
		return result;
	})

	.http('db-client:supabase-rls', {
		data: t.Object(connectionTarget),
		response: t.Any()
	}, async ({ data, conn }) => {
		const scope = await requireScope(conn, data.connectionId, data.projectId);
		return supabaseSurface.rls(scope);
	})

	.http('db-client:supabase-buckets', {
		data: t.Object(connectionTarget),
		response: t.Array(t.Any())
	}, async ({ data, conn }) => {
		const scope = await requireScope(conn, data.connectionId, data.projectId);
		return supabaseSurface.buckets(scope);
	})

	.http('db-client:supabase-auth-users', {
		data: t.Object({
			...connectionTarget,
			search: t.Optional(t.String()),
			limit: t.Optional(t.Number()),
			offset: t.Optional(t.Number())
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		const scope = await requireScope(conn, data.connectionId, data.projectId);
		return supabaseSurface.authUsers(scope, {
			search: data.search,
			limit: data.limit,
			offset: data.offset
		});
	})

	.http('db-client:supabase-functions', {
		data: t.Object(connectionTarget),
		response: t.Array(t.Any())
	}, async ({ data, conn }) => {
		const scope = await requireScope(conn, data.connectionId, data.projectId);
		return supabaseSurface.functions(scope);
	})

	.http('db-client:supabase-function-body', {
		data: t.Object({ ...connectionTarget, slug: t.String({ minLength: 1 }) }),
		response: t.Object({ body: t.String() })
	}, async ({ data, conn }) => {
		const scope = await requireScope(conn, data.connectionId, data.projectId);
		return { body: await supabaseSurface.functionBody(scope, data.slug) };
	})

	.http('db-client:supabase-types', {
		data: t.Object({ ...connectionTarget, schemas: t.Optional(t.Array(t.String())) }),
		response: t.Object({ types: t.String(), suggestedPath: t.String() })
	}, async ({ data, conn }) => {
		const scope = await requireScope(conn, data.connectionId, data.projectId);
		return supabaseSurface.types(scope, data.schemas ?? ['public']);
	})

	.http('db-client:supabase-write-types', {
		data: t.Object({
			...connectionTarget,
			path: t.String({ minLength: 1 }),
			contents: t.String()
		}),
		response: t.Object({ path: t.String(), bytes: t.Number() })
	}, async ({ data, conn }) => {
		requireAdmin(conn, 'write generated types into the project');
		const scope = await requireScope(conn, data.connectionId, data.projectId);
		return supabaseSurface.writeTypes(scope, data.path, data.contents);
	});
