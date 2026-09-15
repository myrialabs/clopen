/**
 * Tests for the worktree-branch projection.
 *
 * The cases here are the ones that destroy something when they are wrong:
 *
 *  - One account must own a connection per LIVE worktree branch, and an orphan
 *    must own none. An orphan's remote database may well still exist — that is
 *    what makes it an orphan — but its worktree is gone, and leaving a
 *    connection behind clutters every admin's list with rows nobody is using.
 *  - Neon accounts carry BOTH `database` and `worktree-branching`, so the two
 *    projectors write to the same table for the same account. Migration 077
 *    widened the projection key with `target_id` precisely so they can; if
 *    either released by capability alone it would tear down the other's rows.
 *  - Releasing must DELETE. Nothing here is ever adopted — a host the provider
 *    minted seconds ago cannot have been typed in by anyone — so there is no
 *    snapshot to restore and a "hand it back" path would leave a husk.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

import { initializeDatabase, closeDatabase } from '$backend/database';
import {
	dbClientConnectionQueries,
	integrationAccountQueries,
	integrationProjectionQueries,
	projectQueries,
	worktreeBranchQueries,
	worktreeQueries
} from '$backend/database/queries';
import { integrationAccounts } from '$backend/integrations/accounts';
import { reproject } from '$backend/integrations';
import type { BranchConnection } from '$shared/types/worktree-branching';
import './index';

const CONNECTION: BranchConnection = {
	uri: 'postgresql://owner:pw@ep-one.eu-central-1.aws.neon.tech/neondb?sslmode=require',
	host: 'ep-one.eu-central-1.aws.neon.tech',
	port: 5432,
	username: 'neondb_owner',
	password: 'pw',
	database: 'neondb',
	sslMode: 'require'
};

let projectId: string;

function connect(label?: string) {
	return integrationAccounts.connect({
		provider: 'neon',
		label,
		credentials: { apiKey: 'napi_test' }
	});
}

function makeWorktree(name: string) {
	return worktreeQueries.create({
		project_id: projectId,
		name,
		slug: name.toLowerCase().replace(/\s+/g, '-'),
		path: `/tmp/clopen-test/${name}`,
		clone_mode: 'copy',
		base_tree: {}
	});
}

function cutBranch(
	accountId: string,
	worktreeId: string,
	branchRef: string,
	connection: BranchConnection = CONNECTION
) {
	return worktreeBranchQueries.create({
		worktreeId,
		projectId,
		sourceKind: 'account',
		sourceId: accountId,
		parentRef: 'winter-frost-12345678',
		branchRef,
		branchName: `clopen/acme/${branchRef}`,
		connection,
		envVar: 'DATABASE_URL',
		envFile: '.env',
		strategy: 'native',
		notice: null
	});
}

function clearFixtures(): void {
	for (const account of integrationAccountQueries.getAll()) {
		integrationAccountQueries.remove(account.id);
	}
	for (const connection of dbClientConnectionQueries.list()) {
		dbClientConnectionQueries.delete(connection.id);
	}
	for (const worktree of worktreeQueries.getByProjectId(projectId)) {
		worktreeQueries.delete(worktree.id);
	}
}

beforeAll(async () => {
	await initializeDatabase();
	const now = new Date().toISOString();
	projectId = projectQueries.create({
		name: 'Branch Fixture',
		path: '/tmp/clopen-test/branch-fixture',
		created_at: now,
		last_opened_at: now
	}).id;
});

beforeEach(() => {
	clearFixtures();
});

afterAll(() => {
	clearFixtures();
	projectQueries.deleteProject(projectId);
	closeDatabase();
});

describe('worktree branch projection', () => {
	it('projects one connection per live branch', () => {
		const account = connect();
		cutBranch(account.id, makeWorktree('fix login').id, 'br-one');
		cutBranch(account.id, makeWorktree('fix signup').id, 'br-two');

		reproject(account.id);

		expect(dbClientConnectionQueries.list()).toHaveLength(2);
		expect(integrationProjectionQueries.getForAccount(account.id)).toHaveLength(2);
	});

	it('carries the endpoint and the password onto the row', () => {
		const account = connect();
		cutBranch(account.id, makeWorktree('fix login').id, 'br-one');
		reproject(account.id);

		const connection = dbClientConnectionQueries.list()[0];
		expect(connection.host).toBe(CONNECTION.host);
		expect(connection.port).toBe(5432);
		expect(connection.username).toBe('neondb_owner');
		expect(connection.database).toBe('neondb');
		expect(connection.sslMode).toBe('require');
		// The password comes from the sealed blob on the branch row, which is the
		// only place it exists — the provider generated it and nobody typed it.
		expect(connection.password).toBe('pw');
	});

	it('names the connection after the WORKTREE, not the branch', () => {
		// The connection list is global, so "fix login (branch)" is the question
		// someone actually has — `clopen/acme/br-one` is not.
		const account = connect();
		cutBranch(account.id, makeWorktree('fix login').id, 'br-one');
		reproject(account.id);

		expect(dbClientConnectionQueries.list()[0].name).toBe('fix login (branch)');
	});

	it('re-projecting an existing branch does not create a second row', () => {
		const account = connect();
		cutBranch(account.id, makeWorktree('fix login').id, 'br-one');

		reproject(account.id);
		const first = dbClientConnectionQueries.list()[0].id;
		reproject(account.id);

		const connections = dbClientConnectionQueries.list();
		expect(connections).toHaveLength(1);
		expect(connections[0].id).toBe(first);
	});

	it('releases exactly the branch that was orphaned, and keeps the other', () => {
		const account = connect();
		const kept = cutBranch(account.id, makeWorktree('fix login').id, 'br-one');
		const lost = cutBranch(account.id, makeWorktree('fix signup').id, 'br-two');
		reproject(account.id);
		expect(dbClientConnectionQueries.list()).toHaveLength(2);

		// What `detach` does when the remote delete fails: the row survives so the
		// leak can be reported, and it stops being live.
		worktreeBranchQueries.markOrphaned(lost.id, 'Neon is unreachable');
		reproject(account.id);

		const connections = dbClientConnectionQueries.list();
		expect(connections).toHaveLength(1);
		expect(connections[0].id).toBe(worktreeBranchQueries.getById(kept.id)!.connection_id!);
	});

	it('deletes rather than hands back — nothing here is ever adopted', () => {
		const account = connect();
		const branch = cutBranch(account.id, makeWorktree('fix login').id, 'br-one');
		reproject(account.id);
		const connectionId = worktreeBranchQueries.getById(branch.id)!.connection_id!;

		worktreeBranchQueries.remove(branch.id);
		reproject(account.id);

		expect(dbClientConnectionQueries.get(connectionId)).toBeNull();
		expect(integrationProjectionQueries.getForAccount(account.id)).toHaveLength(0);
	});

	it('projects nothing when the sealed connection cannot be read', () => {
		// What a database restored without its key looks like. The branch stays
		// listed and stays deletable; only the projection is skipped, which is the
		// same degradation every other read path in the secrets layer takes.
		const account = connect();
		const worktree = makeWorktree('fix login');
		const branch = cutBranch(account.id, worktree.id, 'br-one');

		// `connectionOf` reads the opened column, so an unreadable blob is the
		// same shape as one that never existed.
		worktreeBranchQueries.setConnectionId(branch.id, null);
		const row = worktreeBranchQueries.getById(branch.id)!;
		expect(worktreeBranchQueries.connectionOf({ ...row, connection_json: null })).toBeNull();
	});

	it('lets one account own rows under both capabilities at once', () => {
		// Neon declares `database` AND `worktree-branching`. Migration 077's
		// `target_id` in the projection key is what allows it; without it the
		// second projector's write would collide with the first's row.
		const account = connect();
		cutBranch(account.id, makeWorktree('fix login').id, 'br-one');
		reproject(account.id);

		const projections = integrationProjectionQueries.getForAccount(account.id);
		expect(projections.every((entry) => entry.target_kind === 'db_client_connection')).toBe(true);
		expect(projections.some((entry) => entry.capability === 'worktree-branching')).toBe(true);
	});
});
