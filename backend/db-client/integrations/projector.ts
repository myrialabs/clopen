/**
 * The `database` projector: an account owns one `db_client_connections` row per
 * linked remote database.
 *
 * Nothing downstream knows accounts exist. The drivers, the schema tree, the
 * query console and the connection manager read the row exactly as they read a
 * hand-typed one — which is the point of keeping this layer off the path every
 * connection already flows through.
 *
 * The projector is SYNCHRONOUS, so it never talks to a provider. Where a
 * database answers was resolved when the link was created (see `links.ts`) and
 * stored on the link; here it is only copied onto a row. That keeps a token
 * rotation from waiting on a third-party API before the account can be saved.
 *
 * A projected row is created with NO OWNER, which in db-client's access model
 * means admins see it and members do not. That matches who can create it:
 * `integrations:*` is admin-gated, because connecting an account changes what
 * the whole install can reach.
 */

import {
	dbClientConnectionQueries,
	integrationDbLinkQueries,
	integrationProjectionQueries,
	type IntegrationDbLinkRow
} from '$backend/database/queries';
import type { DbClientConnection, DbSslMode } from '$shared/types/db-client';
import type { Projector, ProjectionContext, ProjectionResult } from '$backend/integrations';
import type { DbProviderEndpoint } from '../providers/types';
import { debug } from '$shared/utils/logger';

/**
 * What an adopted connection looked like before we took it over.
 *
 * Only the fields a projection rewrites are snapshotted. The row's name and
 * colour are never touched on an adopted row, so putting them back is not this
 * snapshot's job.
 */
interface DbRestoreSnapshot {
	host: string | null;
	port: number | null;
	username: string | null;
	password: string | null;
	database: string | null;
	sslMode: DbSslMode;
	options: Record<string, unknown>;
}

interface LinkConfig {
	endpoint?: DbProviderEndpoint;
	connectionId?: string;
	[key: string]: unknown;
}

/** The endpoint stored on a link, or null when it was never resolved. */
export function endpointOf(link: IntegrationDbLinkRow): DbProviderEndpoint | null {
	const endpoint = integrationDbLinkQueries.configOf<LinkConfig>(link).endpoint;
	if (!endpoint || typeof endpoint.host !== 'string' || !endpoint.host) return null;
	return endpoint;
}

/** The connection a link currently owns, if it has been projected before. */
export function connectionIdOf(link: IntegrationDbLinkRow): string | null {
	return integrationDbLinkQueries.configOf<LinkConfig>(link).connectionId ?? null;
}

function rememberConnection(link: IntegrationDbLinkRow, connectionId: string): void {
	const config = integrationDbLinkQueries.configOf<LinkConfig>(link);
	if (config.connectionId === connectionId) return;
	integrationDbLinkQueries.update(link.id, { config: { ...config, connectionId } });
}

function snapshotOf(connection: DbClientConnection): DbRestoreSnapshot {
	return {
		host: connection.host,
		port: connection.port,
		username: connection.username,
		password: connection.password,
		database: connection.database,
		sslMode: connection.sslMode,
		options: connection.options
	};
}

/**
 * A hand-typed connection pointing at the same place, if there is one.
 *
 * The database counterpart of adopting an MCP server by slug: a user who typed
 * this connection in before connecting the account must end up with ONE entry,
 * not two rows racing each other's `last_used_at`.
 *
 * Identity INCLUDES THE USERNAME, and that is not a detail. Every Supabase
 * project in one region answers on the same pooler host, the same port and a
 * database called `postgres` — the username (`postgres.<ref>`) is the only part
 * of the endpoint that says which project. Matching without it made a second
 * linked project adopt the first one's row, so an account with production and
 * staging linked projected exactly one connection.
 *
 * Two rows are never adopted:
 *  - one owned by ANOTHER account, which would let two accounts fight over it,
 *    each release handing back the other's credential;
 *  - one already claimed by another link of THIS account, which is the same
 *    collision from the inside.
 */
function findAdoptable(
	link: IntegrationDbLinkRow,
	endpoint: DbProviderEndpoint,
	accountId: string,
	claimed: Set<string>
): DbClientConnection | null {
	for (const connection of dbClientConnectionQueries.list()) {
		if (claimed.has(connection.id)) continue;
		if (connection.driver !== link.driver) continue;
		if ((connection.host ?? '') !== endpoint.host) continue;
		if ((connection.port ?? 0) !== endpoint.port) continue;
		if ((connection.database ?? '') !== endpoint.database) continue;
		if ((connection.username ?? '') !== endpoint.username) continue;

		const owner = integrationProjectionQueries.getByTarget('db_client_connection', connection.id);
		if (owner && owner.account_id !== accountId) continue;
		return connection;
	}
	return null;
}

/** The connection fields a link derives, minus the password (written separately). */
function fieldsFor(link: IntegrationDbLinkRow, endpoint: DbProviderEndpoint) {
	return {
		driver: link.driver,
		host: endpoint.host,
		port: endpoint.port,
		username: endpoint.username,
		database: endpoint.database,
		sslMode: endpoint.sslMode,
		options: { ...(endpoint.options ?? {}) }
	};
}

/**
 * Write the derived state onto one row.
 *
 * The password goes through `replacePassword` rather than the patch, because a
 * patch treats an empty password as "keep what is there" — right for a form,
 * wrong for a derived row, which must equal what it was derived from even when
 * that is nothing.
 */
function writeRow(
	connectionId: string,
	link: IntegrationDbLinkRow,
	endpoint: DbProviderEndpoint,
	options: { rename: boolean }
): void {
	const patch = fieldsFor(link, endpoint);
	dbClientConnectionQueries.update(connectionId, options.rename ? { name: link.label, ...patch } : patch);
	dbClientConnectionQueries.replacePassword(connectionId, integrationDbLinkQueries.secretsOf(link).password ?? null);
}

export const dbConnectionProjector: Projector = {
	capability: 'database',
	targetKind: 'db_client_connection',

	project(context: ProjectionContext): ProjectionResult[] {
		const links = integrationDbLinkQueries.getForAccount(context.account.id);
		const results: ProjectionResult[] = [];
		// Rows this pass has already handed to a link. Two links of one account
		// must never land on the same connection.
		const claimed = new Set<string>(
			links.map((entry) => connectionIdOf(entry)).filter((id): id is string => id !== null)
		);

		for (const link of links) {
			const endpoint = endpointOf(link);
			if (!endpoint) {
				// A link whose endpoint was never resolved projects nothing. The link
				// dialog resolves before it saves, so this is only reachable for a
				// row written by a provider that resolves lazily — and skipping it
				// beats writing a connection that points nowhere.
				debug.warn('db-client', `Link ${link.id} has no resolved endpoint — nothing to project`);
				continue;
			}

			const ownedId = connectionIdOf(link);
			const owned = ownedId ? dbClientConnectionQueries.get(ownedId) : null;
			const target = owned ?? findAdoptable(link, endpoint, context.account.id, claimed);

			if (!target) {
				const created = dbClientConnectionQueries.create({
					name: link.label,
					password: integrationDbLinkQueries.secretsOf(link).password ?? '',
					...fieldsFor(link, endpoint)
				});
				rememberConnection(link, created.id);
				claimed.add(created.id);
				results.push({
					targetKind: 'db_client_connection',
					targetId: created.id,
					adopted: false,
					restore: null
				});
				continue;
			}

			const prior = integrationProjectionQueries.getByTarget('db_client_connection', target.id);
			// Re-projecting a row we already own must not re-snapshot it: the second
			// snapshot would capture OUR credential, and release would then hand the
			// user back the password we are about to delete.
			const adopted = prior ? prior.adopted === 1 : !owned;
			const restore = prior
				? integrationProjectionQueries.restoreOf<DbRestoreSnapshot>(prior)
				: adopted ? snapshotOf(target) : null;

			if (!prior && adopted) {
				debug.log('db-client', `Adopting existing connection ${target.id} for ${context.provider.id}`);
			}

			// An adopted row keeps the name its user gave it. A row we created is
			// ours to name, and follows the link's label.
			writeRow(target.id, link, endpoint, { rename: !adopted });
			rememberConnection(link, target.id);
			claimed.add(target.id);

			results.push({
				targetKind: 'db_client_connection',
				targetId: target.id,
				adopted,
				restore
			});
		}

		return results;
	},

	release(context: ProjectionContext, targetId: string, adopted: boolean, restore: unknown | null): void {
		if (!adopted) {
			dbClientConnectionQueries.delete(targetId);
			return;
		}

		// The row was the user's before it was ours. Put back exactly what we
		// found, so what is left behind is their connection rather than a husk
		// pointing at a password that no longer exists.
		const snapshot = restore as DbRestoreSnapshot | null;
		if (!snapshot || !dbClientConnectionQueries.get(targetId)) return;

		dbClientConnectionQueries.update(targetId, {
			host: snapshot.host ?? '',
			port: snapshot.port ?? undefined,
			username: snapshot.username ?? '',
			database: snapshot.database ?? '',
			sslMode: snapshot.sslMode ?? 'disable',
			options: snapshot.options ?? {}
		});
		dbClientConnectionQueries.replacePassword(targetId, snapshot.password);
		debug.log('db-client', `Released adopted connection ${targetId} back to the user (${context.provider.id})`);
	}
};
