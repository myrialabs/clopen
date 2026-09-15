/**
 * Tests for copying a database.
 *
 * SQLite is the one engine whose whole copy is exercisable without a server, so
 * it carries the cases that are about the FEATURE rather than about a dialect:
 * a copy is a real copy, "schema only" empties the copy and never the original,
 * and deleting one takes its journal files with it. Getting that last pair
 * wrong destroys the user's actual database, which is why they are here rather
 * than left to runtime QA.
 *
 * The per-driver SQL is not mocked. A fake server that answers `CREATE DATABASE
 * … TEMPLATE` however the test wants proves the test agrees with itself; the
 * things worth checking about those paths — whether Postgres refuses while a
 * session is open, whether `CREATE TABLE LIKE` carries a foreign key — are
 * facts about real servers, so they are declared in `cloneSupport` and shown to
 * the user instead of asserted here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { DbClientConnection } from '$shared/types/db-client';
import { canBranchFrom, cloneDatabase, cloneSupport, dropClonedDatabase } from './cloning';

let root: string;
let source: string;

function connection(overrides: Partial<DbClientConnection> = {}): DbClientConnection {
	return {
		id: 'conn-clone-test',
		name: 'Local',
		driver: 'sqlite',
		host: null,
		port: null,
		username: null,
		password: null,
		database: source,
		sslMode: 'disable',
		sslCa: null,
		ssh: {
			enabled: false,
			connectionId: null,
			host: '',
			port: 22,
			username: '',
			authMethod: 'password'
		},
		options: {},
		color: null,
		createdAt: '',
		updatedAt: '',
		lastUsedAt: null,
		...overrides
	};
}

function rowsIn(file: string): number {
	const db = new Database(file);
	try {
		const row = db.query('SELECT COUNT(*) AS n FROM notes').get() as { n: number };
		return row.n;
	} finally {
		db.close();
	}
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'clopen-clone-'));
	source = path.join(root, 'app.db');

	const db = new Database(source);
	db.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
	db.run("INSERT INTO notes (body) VALUES ('one'), ('two')");
	db.close();
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe('cloneSupport', () => {
	it('says what a copy will not carry, per engine, before it runs', () => {
		// The user decides whether a worktree's database is usable, and they can
		// only decide that if the missing parts are named up front.
		expect(cloneSupport('mysql').notice).toContain('foreign keys');
		expect(cloneSupport('mssql').notice).toContain('indexes');
		expect(cloneSupport('redis').notice).toContain('logical database');
		// Postgres and SQLite copy whole, so there is nothing to apologise for.
		expect(cloneSupport('postgres').notice).toBe(null);
		expect(cloneSupport('sqlite').notice).toBe(null);
	});
});

describe('canBranchFrom', () => {
	it('refuses a connection that only exists inside an SSH tunnel', () => {
		// The tunnel belongs to Clopen's process, so a copy made through one is
		// reachable from Clopen and from nowhere the project runs.
		expect(canBranchFrom(connection())).toBe(true);
		expect(
			canBranchFrom(
				connection({
					ssh: { enabled: true, connectionId: null, host: 'jump', port: 22, username: 'x', authMethod: 'key' }
				})
			)
		).toBe(false);
	});
});

describe('cloneDatabase — sqlite', () => {
	it('copies the file, data and all', async () => {
		const target = path.join(root, 'copy.db');
		const result = await cloneDatabase({
			connection: connection(),
			source,
			target,
			mode: 'schema-data'
		});

		expect(result.strategy).toBe('file-copy');
		expect(result.notice).toBe(null);
		expect(rowsIn(target)).toBe(2);
	});

	it('empties the COPY for schema-only and leaves the original alone', async () => {
		// The direction matters more than the result: emptying the wrong file
		// here would delete the user's development data.
		const target = path.join(root, 'copy.db');
		await cloneDatabase({ connection: connection(), source, target, mode: 'schema' });

		expect(rowsIn(target)).toBe(0);
		expect(rowsIn(source)).toBe(2);
	});

	it('writes an empty file for an empty copy', async () => {
		const target = path.join(root, 'copy.db');
		const result = await cloneDatabase({ connection: connection(), source, target, mode: 'empty' });

		expect(result.strategy).toBe('empty');
		expect((await fs.stat(target)).size).toBe(0);
	});

	it('takes the journal files with it when the copy is dropped', async () => {
		// A `-wal` left behind is not debris: SQLite reads it on next open, so an
		// orphaned one can resurrect a database that was supposed to be gone.
		const target = path.join(root, 'copy.db');
		await cloneDatabase({ connection: connection(), source, target, mode: 'schema-data' });
		await fs.writeFile(`${target}-wal`, '');
		await fs.writeFile(`${target}-shm`, '');

		await dropClonedDatabase({ connection: connection(), database: target });

		for (const suffix of ['', '-wal', '-shm']) {
			await expect(fs.access(`${target}${suffix}`)).rejects.toThrow();
		}
		// The parent is untouched, which is the whole point of passing the copy's
		// own name rather than the connection's.
		expect(rowsIn(source)).toBe(2);
	});
});
