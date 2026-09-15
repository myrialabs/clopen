/**
 * Tests for guessing which database a project's worktrees should copy.
 *
 * The cases here are the two failure directions, and they are not symmetric.
 * A MISSED suggestion costs a checkbox the user could have had; a WRONG one
 * offers to copy the wrong database, and the user finds out when their worktree
 * points somewhere unexpected. So the matching is tested for what it refuses as
 * carefully as for what it finds.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { closeDatabase, initializeDatabase } from '$backend/database';
import { dbClientConnectionQueries } from '$backend/database/queries';
import type { DbClientConnectionInput } from '$shared/types/db-client';
import { suggestBranchSource } from './suggest';

let root: string;

function addConnection(overrides: Partial<DbClientConnectionInput> = {}) {
	return dbClientConnectionQueries.create({
		name: 'Local Postgres',
		driver: 'postgres',
		host: 'localhost',
		port: 5432,
		username: 'app',
		password: 'pw',
		database: 'shop',
		sslMode: 'disable',
		...overrides
	} as DbClientConnectionInput);
}

beforeAll(async () => {
	await initializeDatabase();
});

afterAll(() => {
	closeDatabase();
});

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'clopen-suggest-'));
	for (const connection of dbClientConnectionQueries.list()) {
		dbClientConnectionQueries.delete(connection.id);
	}
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe('suggestBranchSource', () => {
	it('matches the project’s DATABASE_URL to a saved connection', async () => {
		addConnection();
		await fs.writeFile(
			path.join(root, '.env'),
			'APP_NAME=shop\nDATABASE_URL=postgres://app:pw@localhost:5432/shop\n'
		);

		const suggestion = await suggestBranchSource(root);

		expect(suggestion).toMatchObject({
			sourceKind: 'connection',
			sourceLabel: 'Local Postgres',
			parentRef: 'shop',
			envVar: 'DATABASE_URL',
			envFile: '.env'
		});
	});

	it('treats localhost and 127.0.0.1 as the same machine', async () => {
		// They are, and a project that writes one while the connection was saved
		// with the other is the ordinary case rather than an edge one.
		addConnection({ host: '127.0.0.1' });
		await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL=postgres://app@localhost/shop\n');

		expect((await suggestBranchSource(root))?.parentRef).toBe('shop');
	});

	it('reads the most-precedent file first', async () => {
		// The same order the project's own framework reads them in, which is the
		// only order that can be right.
		addConnection();
		addConnection({ name: 'Other Postgres', port: 5433 });
		await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL=postgres://app@localhost:5433/legacy\n');
		await fs.writeFile(path.join(root, '.env.local'), 'DATABASE_URL=postgres://app@localhost:5432/shop\n');

		const suggestion = await suggestBranchSource(root);
		expect(suggestion?.envFile).toBe('.env.local');
		expect(suggestion?.parentRef).toBe('shop');
	});

	it('suggests nothing when no connection reaches that server', async () => {
		// Clopen would have the address but not the password, so the offer would
		// fail at the moment of use — worse than no offer.
		addConnection({ host: 'db.example.com' });
		await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL=postgres://app@localhost:5432/shop\n');

		expect(await suggestBranchSource(root)).toBe(null);
	});

	it('does not match a different engine on the same host and port', async () => {
		addConnection({ driver: 'mysql', port: 5432 });
		await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL=postgres://app@localhost:5432/shop\n');

		expect(await suggestBranchSource(root)).toBe(null);
	});

	it('ignores a URL that is not a database', async () => {
		addConnection();
		await fs.writeFile(
			path.join(root, '.env'),
			'NEXT_PUBLIC_API_URL=https://api.example.com\nSENTRY_DSN=https://x@sentry.io/1\n'
		);

		expect(await suggestBranchSource(root)).toBe(null);
	});

	it('never reads a live value out of a template', async () => {
		// `.env.example` holds placeholders, and a placeholder that happens to
		// parse would bind the project to a database nobody uses.
		addConnection();
		await fs.writeFile(
			path.join(root, '.env.example'),
			'DATABASE_URL=postgres://app@localhost:5432/shop\n'
		);

		expect(await suggestBranchSource(root)).toBe(null);
	});

	it('resolves a relative SQLite path against the project, not the cwd', async () => {
		const file = path.join(root, 'data', 'dev.db');
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, '');
		addConnection({ driver: 'sqlite', host: undefined, port: undefined, database: file });
		await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL=file:./data/dev.db\n');

		const suggestion = await suggestBranchSource(root);
		expect(suggestion?.parentRef).toBe(file);
		expect(suggestion?.parentName).toBe('dev.db');
	});

	it('will not copy a copy', async () => {
		// A worktree's own database is already disposable; nesting one inside
		// another is a tree nobody can reason about.
		addConnection({ options: { worktreeBranch: { branchId: 'b1', worktreeId: 'w1' } } });
		await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL=postgres://app@localhost:5432/shop\n');

		expect(await suggestBranchSource(root)).toBe(null);
	});
});
