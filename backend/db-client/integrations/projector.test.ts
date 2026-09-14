/**
 * Tests for the database projection.
 *
 * The cases here are the ones that destroy something when they are wrong, which
 * is the same reason `mcp-projector.test.ts` covers what it covers:
 *
 *  - ONE account must be able to own SEVERAL connections. That is the whole
 *    point of widening the projection key in migration 077, and a regression
 *    would silently drop every linked database but one.
 *  - Removing one link must release exactly that one. Releasing by capability
 *    would tear down the survivors and rebuild them, which for an adopted row
 *    means handing it back and re-adopting it — snapshotting our own credential
 *    in the process.
 *  - Adopting a hand-typed connection must produce ONE row, and disconnecting
 *    must hand it back with the password its user had on it, not with ours.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

import { initializeDatabase, closeDatabase } from '$backend/database';
import {
	dbClientConnectionQueries,
	integrationAccountQueries,
	integrationDbLinkQueries,
	integrationProjectionQueries
} from '$backend/database/queries';
import { integrationAccounts } from '$backend/integrations/accounts';
import { reproject } from '$backend/integrations';
import '../integrations';

const POOLER_HOST = 'aws-0-eu-west-2.pooler.supabase.com';

/**
 * Create a link the way the link service does, minus the network call.
 *
 * `resolveEndpoint` is what talks to Supabase; storing its result on the link
 * is what lets the projector stay synchronous, so a test can supply that result
 * directly and exercise everything downstream of it.
 */
function linkTo(accountId: string, ref: string, password: string, label?: string) {
	return integrationDbLinkQueries.create({
		accountId,
		remoteRef: ref,
		label: label ?? ref,
		driver: 'postgres',
		mode: 'pooler-session',
		secrets: { password },
		config: {
			endpoint: {
				host: POOLER_HOST,
				port: 5432,
				username: `postgres.${ref}`,
				database: 'postgres',
				sslMode: 'require',
				options: { supabase: { ref, mode: 'pooler-session' } }
			}
		}
	});
}

function connect(label?: string) {
	return integrationAccounts.connect({
		provider: 'supabase',
		label,
		credentials: { accessToken: 'sbp_test' }
	});
}

function clearFixtures(): void {
	for (const account of integrationAccountQueries.getAll()) {
		integrationAccountQueries.remove(account.id);
	}
	for (const connection of dbClientConnectionQueries.list()) {
		dbClientConnectionQueries.delete(connection.id);
	}
}

beforeAll(async () => {
	await initializeDatabase();
});

beforeEach(() => {
	clearFixtures();
});

afterAll(() => {
	clearFixtures();
	closeDatabase();
});

describe('database projection', () => {
	it('projects one connection per linked database from a single account', () => {
		const account = connect();
		linkTo(account.id, 'prodprojectref00000', 'prod-pw', 'Production');
		linkTo(account.id, 'stageprojectref0000', 'stage-pw', 'Staging');
		reproject(account.id);

		const connections = dbClientConnectionQueries.list();
		expect(connections).toHaveLength(2);
		expect(connections.map((entry) => entry.name).sort()).toEqual(['Production', 'Staging']);

		// The narrow key this replaced could only hold one of these.
		const projections = integrationProjectionQueries.getForAccount(account.id);
		expect(projections).toHaveLength(2);
	});

	it('carries the endpoint and the password onto the row', () => {
		const account = connect();
		linkTo(account.id, 'prodprojectref00000', 'prod-pw');
		reproject(account.id);

		const connection = dbClientConnectionQueries.list()[0];
		expect(connection.host).toBe(POOLER_HOST);
		expect(connection.port).toBe(5432);
		expect(connection.username).toBe('postgres.prodprojectref00000');
		expect(connection.sslMode).toBe('require');
		expect(connection.password).toBe('prod-pw');
		// The marker is what lets DB Client recognise a Supabase connection
		// without learning that accounts exist.
		expect((connection.options.supabase as { ref: string }).ref).toBe('prodprojectref00000');
	});

	it('releases only the link that was removed', () => {
		const account = connect();
		const keep = linkTo(account.id, 'keepprojectref00000', 'keep-pw', 'Keep');
		const drop = linkTo(account.id, 'dropprojectref00000', 'drop-pw', 'Drop');
		reproject(account.id);
		expect(dbClientConnectionQueries.list()).toHaveLength(2);

		const keptId = integrationDbLinkQueries.configOf<{ connectionId?: string }>(
			integrationDbLinkQueries.getById(keep.id)!
		).connectionId;

		integrationDbLinkQueries.remove(drop.id);
		reproject(account.id);

		const remaining = dbClientConnectionQueries.list();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].name).toBe('Keep');
		// The survivor keeps its identity: a rebuild would give it a new id and
		// orphan every saved view and query-history row keyed to the old one.
		expect(remaining[0].id).toBe(keptId!);
	});

	it('rewrites the password when the link rotates it', () => {
		const account = connect();
		const link = linkTo(account.id, 'prodprojectref00000', 'old-pw');
		reproject(account.id);

		integrationDbLinkQueries.update(link.id, { secrets: { password: 'new-pw' } });
		reproject(account.id);

		expect(dbClientConnectionQueries.list()[0].password).toBe('new-pw');
	});

	it('adopts a hand-typed connection instead of creating a sibling', () => {
		const mine = dbClientConnectionQueries.create({
			name: 'My Supabase',
			driver: 'postgres',
			host: POOLER_HOST,
			port: 5432,
			username: 'postgres.prodprojectref00000',
			password: 'typed-by-hand',
			database: 'postgres',
			sslMode: 'require'
		});

		const account = connect();
		linkTo(account.id, 'prodprojectref00000', 'from-account', 'Production');
		reproject(account.id);

		const connections = dbClientConnectionQueries.list();
		expect(connections).toHaveLength(1);
		expect(connections[0].id).toBe(mine.id);
		// An adopted row keeps the name its user gave it.
		expect(connections[0].name).toBe('My Supabase');
		expect(connections[0].password).toBe('from-account');

		const projection = integrationProjectionQueries.getByTarget('db_client_connection', mine.id);
		expect(projection?.adopted).toBe(1);
	});

	it('hands an adopted connection back with the password it arrived with', () => {
		const mine = dbClientConnectionQueries.create({
			name: 'My Supabase',
			driver: 'postgres',
			host: POOLER_HOST,
			port: 5432,
			username: 'postgres.prodprojectref00000',
			password: 'typed-by-hand',
			database: 'postgres',
			sslMode: 'require'
		});

		const account = connect();
		linkTo(account.id, 'prodprojectref00000', 'from-account');
		reproject(account.id);
		integrationAccounts.disconnect(account.id);

		const survivor = dbClientConnectionQueries.get(mine.id);
		expect(survivor).not.toBe(null);
		// Not ours, and not empty. Leaving our password behind would let a
		// disconnected account keep working; clearing it would break a connection
		// the user set up themselves.
		expect(survivor!.password).toBe('typed-by-hand');
	});

	it('deletes a connection it created when the account is disconnected', () => {
		const account = connect();
		linkTo(account.id, 'prodprojectref00000', 'prod-pw');
		reproject(account.id);
		expect(dbClientConnectionQueries.list()).toHaveLength(1);

		integrationAccounts.disconnect(account.id);
		expect(dbClientConnectionQueries.list()).toHaveLength(0);
	});

	it('projects nothing for a link whose endpoint is not resolved yet, and keeps its secret', () => {
		const account = connect();
		// The shape `createDatabase` writes: the secret is durable before the
		// database is answering, because a generated password that is lost while
		// provisioning is one only a reset can recover.
		const link = integrationDbLinkQueries.create({
			accountId: account.id,
			remoteRef: 'freshprojectref0000',
			label: 'Fresh',
			driver: 'postgres',
			mode: 'pooler-session',
			secrets: { password: 'generated-pw' },
			config: {}
		});

		reproject(account.id);
		expect(dbClientConnectionQueries.list()).toHaveLength(0);
		expect(integrationDbLinkQueries.secretsOf(integrationDbLinkQueries.getById(link.id)!).password)
			.toBe('generated-pw');

		// Once the endpoint lands the same link projects normally, with the
		// password it has been holding all along.
		integrationDbLinkQueries.update(link.id, {
			config: {
				endpoint: {
					host: POOLER_HOST,
					port: 5432,
					username: 'postgres.freshprojectref0000',
					database: 'postgres',
					sslMode: 'require',
					options: { supabase: { ref: 'freshprojectref0000', mode: 'pooler-session' } }
				}
			}
		});
		reproject(account.id);

		const connections = dbClientConnectionQueries.list();
		expect(connections).toHaveLength(1);
		expect(connections[0].password).toBe('generated-pw');
	});

	it('re-adopting does not re-snapshot our own credential', () => {
		const mine = dbClientConnectionQueries.create({
			name: 'My Supabase',
			driver: 'postgres',
			host: POOLER_HOST,
			port: 5432,
			username: 'postgres.prodprojectref00000',
			password: 'typed-by-hand',
			database: 'postgres',
			sslMode: 'require'
		});

		const account = connect();
		linkTo(account.id, 'prodprojectref00000', 'from-account');
		reproject(account.id);
		// A second pass — a capability toggle, a rename, any account mutation.
		reproject(account.id);
		integrationAccounts.disconnect(account.id);

		expect(dbClientConnectionQueries.get(mine.id)!.password).toBe('typed-by-hand');
	});
});
