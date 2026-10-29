/**
 * db-client — account-backed connections.
 *
 *   db-client:providers         database providers, for the link dialog
 *   db-client:accounts          connected accounts that can supply one
 *   db-client:remote-databases  what an account can reach
 *   db-client:create-options    organisations and regions, for creating one
 *   db-client:create-group      create the owning organisation
 *   db-client:create-database   provision a new database and link it
 *   db-client:rename-database   rename it at the provider
 *   db-client:delete-database   destroy it at the provider, and unlink
 *   db-client:link              bring one in
 *   db-client:update-link       relabel / change mode / rotate the password
 *   db-client:unlink            drop it, releasing the projected connection
 *   db-client:detect-local      a `supabase start` stack in the working tree
 *   db-client:adopt-local       turn that into an ordinary connection
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { initializeDatabase } from '../../database';
import { dbClientConnectionQueries } from '../../database/queries';
import { dbLinks, supabaseSurface } from '../../db-client/integrations';
import { localConnectionInput } from '../../db-client/providers/supabase/local';
import { ws as wsServer } from '$backend/utils/ws';
import { resolveDbClientProject } from './context';
import { debug } from '$shared/utils/logger';

/**
 * Tell every client the connection list changed.
 *
 * Global: a client that only watched its own request would miss a connection
 * linked from another device.
 */
function announce(): void {
	wsServer.emit.global('db-client:connections-changed', {});
}

export const accountsHandler = createRouter()
	.http('db-client:providers', {
		data: t.Object({}),
		response: t.Object({
			providers: t.Array(t.Any()),
			accounts: t.Array(t.Any()),
			links: t.Array(t.Any())
		})
	}, async () => {
		await initializeDatabase();
		return {
			providers: dbLinks.providers(),
			accounts: dbLinks.accounts(),
			links: dbLinks.allLinks()
		};
	})

	.http('db-client:remote-databases', {
		data: t.Object({ accountId: t.String({ minLength: 1 }) }),
		response: t.Array(t.Any())
	}, async ({ data }) => {
		return dbLinks.remoteDatabases(data.accountId);
	})

	.http('db-client:create-options', {
		data: t.Object({ accountId: t.String({ minLength: 1 }) }),
		response: t.Nullable(t.Any())
	}, async ({ data }) => {
		return dbLinks.createOptions(data.accountId);
	})

	.http('db-client:create-group', {
		data: t.Object({
			accountId: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1 })
		}),
		response: t.Object({ value: t.String(), label: t.String() })
	}, async ({ data }) => {
		await initializeDatabase();
		return dbLinks.createGroup(data.accountId, data.name);
	})

	.http('db-client:create-database', {
		data: t.Object({
			accountId: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1 }),
			group: t.String({ minLength: 1 }),
			region: t.String({ minLength: 1 })
		}),
		response: t.Object({ link: t.Any(), ready: t.Boolean() })
	}, async ({ data }) => {
		await initializeDatabase();
		// Provisioning plus the readiness wait runs past the default socket
		// budget by design, so the call carries its own — a long budget, not an
		// unbounded one, for the reason the Deployments surface settled on.
		const result = await dbLinks.createDatabase(data);
		announce();
		return result;
	})

	.http('db-client:rename-database', {
		data: t.Object({
			accountId: t.String({ minLength: 1 }),
			remoteRef: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		await dbLinks.renameDatabase(data.accountId, data.remoteRef, data.name);
		return { ok: true };
	})

	.http('db-client:delete-database', {
		data: t.Object({
			accountId: t.String({ minLength: 1 }),
			remoteRef: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		await dbLinks.deleteDatabase(data.accountId, data.remoteRef);
		announce();
		return { ok: true };
	})

	.http('db-client:link', {
		data: t.Object({
			accountId: t.String({ minLength: 1 }),
			remoteRef: t.String({ minLength: 1 }),
			label: t.Optional(t.String()),
			mode: t.Optional(t.String()),
			secrets: t.Record(t.String(), t.String())
		}),
		response: t.Any()
	}, async ({ data }) => {
		await initializeDatabase();
		const link = await dbLinks.create({
			accountId: data.accountId,
			remoteRef: data.remoteRef,
			label: data.label,
			mode: data.mode,
			secrets: data.secrets
		});
		announce();
		return link;
	})

	.http('db-client:update-link', {
		data: t.Object({
			linkId: t.String({ minLength: 1 }),
			label: t.Optional(t.String()),
			mode: t.Optional(t.String()),
			secrets: t.Optional(t.Record(t.String(), t.String())),
			refreshEndpoint: t.Optional(t.Boolean())
		}),
		response: t.Any()
	}, async ({ data }) => {
		const link = await dbLinks.update(data.linkId, {
			label: data.label,
			mode: data.mode,
			secrets: data.secrets,
			refreshEndpoint: data.refreshEndpoint
		});
		announce();
		return link;
	})

	.http('db-client:unlink', {
		data: t.Object({ linkId: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		await dbLinks.remove(data.linkId);
		announce();
		return { ok: true };
	})

	.http('db-client:detect-local', {
		data: t.Object({ projectId: t.Optional(t.String()) }),
		response: t.Nullable(t.Any())
	}, async ({ data, conn }) => {
		const project = resolveDbClientProject(conn, data.projectId);
		if (!project) return null;
		const local = await supabaseSurface.detectLocal(project.root);
		if (!local) return null;
		return {
			ref: local.ref,
			configPath: local.configPath,
			dbPort: local.dbPort,
			// True when a connection to this stack already exists, so the panel
			// offers "open" rather than "add" and never creates a duplicate.
			alreadyAdded: dbClientConnectionQueries
				.list()
				.some((connection) => {
					const marker = connection.options?.supabase as { ref?: string } | undefined;
					return marker?.ref === local.ref;
				})
		};
	})

	.http('db-client:adopt-local', {
		data: t.Object({ projectId: t.Optional(t.String()) }),
		response: t.Any()
	}, async ({ data, conn }) => {
		await initializeDatabase();
		const project = resolveDbClientProject(conn, data.projectId);
		if (!project) throw new Error('No project is open');

		const local = await supabaseSurface.detectLocal(project.root);
		if (!local) throw new Error('No supabase/config.toml in this project');

		// An ordinary saved connection, NOT a projection: a local stack is
		// created from the project rather than from an account, and nothing
		// re-derives it.
		const created = dbClientConnectionQueries.createRedacted(localConnectionInput(local));
		debug.log('db-client', `Adopted local Supabase stack ${local.ref} as ${created.id}`);
		announce();
		return created;
	});
