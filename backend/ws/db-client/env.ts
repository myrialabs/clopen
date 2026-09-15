/**
 * db-client — the connection as environment variables.
 *
 * THESE ROUTES HAND BACK A PASSWORD, which no other db-client route does:
 * `db-client:list` redacts every secret before it crosses the wire. That is not
 * an oversight being reversed, it is a different question — a connection string
 * the user cannot copy solves nothing, and the whole feature is "put this into
 * my project's `.env`". So the secret is gated at the ROUTE instead of stripped
 * from the payload.
 *
 * Two gates, both already load-bearing elsewhere:
 *
 *  - `requireDbClientConnectionAccess` is the owner-or-admin check the rest of
 *    the surface uses. A projected connection has NO owner, which in
 *    db-client's access model means only an admin can reach it — the same
 *    reason `db-client:link` is admin-only, arrived at without a second rule.
 *  - `requireProjectWorkspace` decides which tree a write lands in, and it is
 *    worktree-aware. A user looking at a worktree gets the worktree's `.env`,
 *    because that is the checkout their dev server is running from.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import type { WSConnection } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { worktreeQueries } from '$backend/database/queries';
import { dbClientEnv, type EnvScope } from '../../db-client/env';
import type { DbEnvRequest } from '$shared/types/db-client';
import { requireProjectWorkspace } from '../access';
import { requireDbClientConnectionAccess } from './access';

const requestSchema = t.Object({
	connectionId: t.String({ minLength: 1 }),
	projectId: t.Optional(t.String()),
	database: t.Optional(t.String()),
	shape: t.Union([t.Literal('url'), t.Literal('split')]),
	prefix: t.Optional(t.String()),
	keyMap: t.Optional(t.Record(t.String(), t.String())),
	fileName: t.Optional(t.String()),
	includeAlternate: t.Optional(t.Boolean()),
	allowTracked: t.Optional(t.Boolean())
});

/**
 * The tree a write would land in, or null.
 *
 * Null rather than an error when no project is in scope: the panel still shows
 * the variables and still lets them be copied, which is most of the value. A
 * route that refused would turn "no project open" into "this feature is
 * broken".
 */
function resolveScope(conn: WSConnection, projectId?: string): EnvScope | null {
	const target = (projectId ?? '').trim() || safeCurrentProject(conn);
	if (!target) return null;

	const { project, root, worktreeId } = requireProjectWorkspace(conn, target);
	const worktree = worktreeId ? worktreeQueries.getById(worktreeId) : null;

	return {
		projectId: project.id,
		// Named so the panel can say WHERE it is about to write. A worktree is a
		// different checkout with its own dotenv file, and not saying so is how a
		// user ends up looking for a variable in the main project.
		projectName: worktree ? `${project.name} / ${worktree.name}` : project.name,
		root
	};
}

function safeCurrentProject(conn: WSConnection): string | null {
	try {
		return ws.getProjectId(conn);
	} catch {
		return null;
	}
}

function requireScope(conn: WSConnection, projectId?: string): EnvScope {
	const scope = resolveScope(conn, projectId);
	if (!scope) throw new Error('Open a project before writing to its environment file.');
	return scope;
}

export const envHandler = createRouter()
	.http('db-client:env-state', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			projectId: t.Optional(t.String()),
			database: t.Optional(t.String())
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		const connection = requireDbClientConnectionAccess(conn, data.connectionId);
		return dbClientEnv.state(connection, resolveScope(conn, data.projectId), data.database);
	})

	.http('db-client:env-preview', {
		data: requestSchema,
		response: t.Any()
	}, async ({ data, conn }) => {
		const connection = requireDbClientConnectionAccess(conn, data.connectionId);
		return dbClientEnv.plan(connection, resolveScope(conn, data.projectId), toRequest(data));
	})

	.http('db-client:env-apply', {
		data: requestSchema,
		response: t.Any()
	}, async ({ data, conn }) => {
		const connection = requireDbClientConnectionAccess(conn, data.connectionId);
		return dbClientEnv.apply(connection, requireScope(conn, data.projectId), toRequest(data));
	})

	.http('db-client:env-remove', {
		data: requestSchema,
		response: t.Any()
	}, async ({ data, conn }) => {
		const connection = requireDbClientConnectionAccess(conn, data.connectionId);
		return dbClientEnv.remove(connection, requireScope(conn, data.projectId), toRequest(data));
	});

function toRequest(data: {
	connectionId: string;
	projectId?: string;
	database?: string;
	shape: string;
	prefix?: string;
	keyMap?: Record<string, string>;
	fileName?: string;
	includeAlternate?: boolean;
	allowTracked?: boolean;
}): DbEnvRequest {
	return {
		connectionId: data.connectionId,
		projectId: data.projectId,
		database: data.database,
		shape: data.shape as DbEnvRequest['shape'],
		prefix: data.prefix ?? '',
		keyMap: data.keyMap as DbEnvRequest['keyMap'],
		fileName: data.fileName,
		includeAlternate: data.includeAlternate,
		allowTracked: data.allowTracked
	};
}
