/**
 * The migration's guarantees are in the SQL, so this runs it against a real
 * in-memory SQLite rather than asserting over a mock.
 *
 * Two of them are easy to write and easy to get wrong: the partial unique index
 * that allows at most one default per user, and the cascades that stop a
 * deleted user or project from leaving rows pointing at nothing.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { DatabaseConnection } from '$shared/types/database/connection';
import { up, down } from './082_create_git_identities';

/** Only the columns the new tables reference. */
function freshDb(): Database {
	const db = new Database(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
	db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
	db.exec(`CREATE TABLE integration_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL)`);
	db.exec(`INSERT INTO users (id, name) VALUES ('u1', 'Ada'), ('u2', 'Grace')`);
	db.exec(`INSERT INTO projects (id, name) VALUES ('p1', 'Proj')`);
	up(db as unknown as DatabaseConnection);
	return db;
}

function insertIdentity(db: Database, id: string, userId: string, isDefault = 0): void {
	db.prepare(
		`INSERT INTO git_identities (id, owner_user_id, label, name, email, is_default, created_at, updated_at)
		 VALUES (?, ?, ?, 'Ada', 'ada@example.com', ?, '2026-01-01', '2026-01-01')`
	).run(id, userId, `label-${id}`, isDefault);
}

describe('migration 082', () => {
	test('a user can hold at most one default identity', () => {
		const db = freshDb();
		insertIdentity(db, 'i1', 'u1', 1);
		expect(() => insertIdentity(db, 'i2', 'u1', 1)).toThrow();
		// Non-defaults are unconstrained — the index is partial, not global.
		expect(() => insertIdentity(db, 'i3', 'u1', 0)).not.toThrow();
		expect(() => insertIdentity(db, 'i4', 'u1', 0)).not.toThrow();
		db.close();
	});

	test('the default is per user, not per install', () => {
		const db = freshDb();
		insertIdentity(db, 'i1', 'u1', 1);
		expect(() => insertIdentity(db, 'i2', 'u2', 1)).not.toThrow();
		db.close();
	});

	test('one user cannot reuse a label', () => {
		const db = freshDb();
		insertIdentity(db, 'i1', 'u1');
		expect(() =>
			db
				.prepare(
					`INSERT INTO git_identities (id, owner_user_id, label, name, email, created_at, updated_at)
					 VALUES ('i2', 'u1', 'label-i1', 'A', 'a@b.c', '2026-01-01', '2026-01-01')`
				)
				.run()
		).toThrow();
		db.close();
	});

	test('auth_method is constrained to the methods the code handles', () => {
		const db = freshDb();
		expect(() =>
			db
				.prepare(
					`INSERT INTO git_identities (id, owner_user_id, label, name, email, auth_method, created_at, updated_at)
					 VALUES ('i9', 'u1', 'l9', 'A', 'a@b.c', 'carrier-pigeon', '2026-01-01', '2026-01-01')`
				)
				.run()
		).toThrow();
		db.close();
	});

	test('deleting a user takes their identities and bindings with them', () => {
		const db = freshDb();
		insertIdentity(db, 'i1', 'u1');
		db.prepare(
			`INSERT INTO git_identity_bindings (project_id, user_id, identity_id, created_at, updated_at)
			 VALUES ('p1', 'u1', 'i1', '2026-01-01', '2026-01-01')`
		).run();

		db.prepare(`DELETE FROM users WHERE id = 'u1'`).run();

		expect(db.prepare('SELECT COUNT(*) as c FROM git_identities').get()).toEqual({ c: 0 });
		expect(db.prepare('SELECT COUNT(*) as c FROM git_identity_bindings').get()).toEqual({ c: 0 });
		db.close();
	});

	test('deleting an identity clears the bindings that pointed at it', () => {
		const db = freshDb();
		insertIdentity(db, 'i1', 'u1');
		db.prepare(
			`INSERT INTO git_identity_bindings (project_id, user_id, identity_id, created_at, updated_at)
			 VALUES ('p1', 'u1', 'i1', '2026-01-01', '2026-01-01')`
		).run();

		db.prepare(`DELETE FROM git_identities WHERE id = 'i1'`).run();
		expect(db.prepare('SELECT COUNT(*) as c FROM git_identity_bindings').get()).toEqual({ c: 0 });
		db.close();
	});

	test('one project holds one binding per user', () => {
		const db = freshDb();
		insertIdentity(db, 'i1', 'u1');
		insertIdentity(db, 'i2', 'u1');
		const bind = (identityId: string) =>
			db
				.prepare(
					`INSERT INTO git_identity_bindings (project_id, user_id, identity_id, created_at, updated_at)
					 VALUES ('p1', 'u1', ?, '2026-01-01', '2026-01-01')
					 ON CONFLICT(project_id, user_id) DO UPDATE SET identity_id = excluded.identity_id`
				)
				.run(identityId);

		bind('i1');
		bind('i2');
		const rows = db.prepare('SELECT identity_id FROM git_identity_bindings').all();
		expect(rows).toEqual([{ identity_id: 'i2' }]);
		db.close();
	});

	test('a disconnected integration account leaves the identity intact', () => {
		// The account is where a borrowed token lives; losing it must not delete
		// the identity, which still carries the user's name and email.
		const db = freshDb();
		db.prepare(`INSERT INTO integration_accounts (id, label) VALUES ('a1', 'GitHub')`).run();
		db.prepare(
			`INSERT INTO git_identities (id, owner_user_id, label, name, email, auth_method, integration_account_id, created_at, updated_at)
			 VALUES ('i1', 'u1', 'l1', 'Ada', 'ada@example.com', 'https-account', 'a1', '2026-01-01', '2026-01-01')`
		).run();

		db.prepare(`DELETE FROM integration_accounts WHERE id = 'a1'`).run();

		const row = db.prepare('SELECT integration_account_id FROM git_identities WHERE id = ?').get('i1');
		expect(row).toEqual({ integration_account_id: null });
		db.close();
	});

	test('a user holds at most one mirrored machine identity', () => {
		// The import runs on every list read, so without this a machine config
		// change would append a second copy instead of updating the first.
		const db = freshDb();
		const insertLocal = (id: string, userId: string) =>
			db
				.prepare(
					`INSERT INTO git_identities (id, owner_user_id, label, name, email, source, created_at, updated_at)
					 VALUES (?, ?, ?, 'A', 'a@b.c', 'local-machine', '2026-01-01', '2026-01-01')`
				)
				.run(id, userId, `l-${id}`);

		insertLocal('m1', 'u1');
		expect(() => insertLocal('m2', 'u1')).toThrow();
		// Still per user, not per install.
		expect(() => insertLocal('m3', 'u2')).not.toThrow();
		db.close();
	});

	test('source is constrained to the two the code knows', () => {
		const db = freshDb();
		expect(() =>
			db
				.prepare(
					`INSERT INTO git_identities (id, owner_user_id, label, name, email, source, created_at, updated_at)
					 VALUES ('x', 'u1', 'lx', 'A', 'a@b.c', 'imported-from-space', '2026-01-01', '2026-01-01')`
				)
				.run()
		).toThrow();
		db.close();
	});

	test('down() removes both tables', () => {
		const db = freshDb();
		down(db as unknown as DatabaseConnection);
		const tables = db
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'git_identit%'`)
			.all();
		expect(tables).toEqual([]);
		db.close();
	});
});
