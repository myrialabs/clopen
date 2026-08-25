/**
 * The revision counter is the only thing that notices a config edit now.
 *
 * Removing the "Restart Server" button removed the manual way to make an edit
 * take effect, so a trigger that silently stops firing is no longer a small bug —
 * it is config that never applies, with nothing in the UI to work around it. The
 * two properties worth pinning down are that watched writes DO bump (or the
 * feature is dead) and that bookkeeping writes DON'T (or every unrelated update
 * respawns a server).
 *
 * Runs against a real in-memory SQLite rather than a mocked handle: the whole
 * mechanism IS the SQL, and a mock that returns what the test expects would
 * assert nothing about whether `UPDATE OF` scopes the way it is supposed to.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { DatabaseConnection } from '$shared/types/database/connection';
import { up } from './068_create_engine_config_revision';

/** Only the columns the triggers name — enough to exercise them faithfully. */
function freshDb(): Database {
	const db = new Database(':memory:');
	db.exec(`
		CREATE TABLE mcp_servers (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			slug          TEXT NOT NULL,
			name          TEXT NOT NULL,
			transport     TEXT NOT NULL DEFAULT 'stdio',
			command       TEXT,
			args          TEXT NOT NULL DEFAULT '[]',
			env           TEXT NOT NULL DEFAULT '{}',
			url           TEXT,
			headers       TEXT NOT NULL DEFAULT '{}',
			is_enabled    INTEGER NOT NULL DEFAULT 1,
			config_schema TEXT,
			oauth         TEXT,
			tool_overrides TEXT,
			created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	db.exec(`
		CREATE TABLE engine_accounts (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			provider_id INTEGER NOT NULL,
			name        TEXT NOT NULL,
			credential  TEXT NOT NULL,
			is_active   INTEGER NOT NULL DEFAULT 0
		)
	`);
	up(db as unknown as DatabaseConnection);
	return db;
}

function revision(db: Database): number {
	return (db.prepare('SELECT revision FROM engine_config_revision WHERE id = 1').get() as { revision: number }).revision;
}

describe('engine config revision triggers', () => {
	test('installing, toggling and removing a connector each bump the revision', () => {
		const db = freshDb();
		const start = revision(db);

		db.exec(`INSERT INTO mcp_servers (slug, name, transport) VALUES ('playwright', 'Playwright', 'stdio')`);
		const afterInsert = revision(db);
		expect(afterInsert).toBeGreaterThan(start);

		db.exec(`UPDATE mcp_servers SET is_enabled = 0 WHERE slug = 'playwright'`);
		const afterToggle = revision(db);
		expect(afterToggle).toBeGreaterThan(afterInsert);

		db.exec(`DELETE FROM mcp_servers WHERE slug = 'playwright'`);
		expect(revision(db)).toBeGreaterThan(afterToggle);
	});

	test('a refreshed OAuth token bumps, because it changes the header the connector is spawned with', () => {
		const db = freshDb();
		db.exec(`INSERT INTO mcp_servers (slug, name, transport) VALUES ('linear', 'Linear', 'http')`);
		const before = revision(db);

		db.exec(`UPDATE mcp_servers SET oauth = '{"access_token":"new"}' WHERE slug = 'linear'`);
		expect(revision(db)).toBeGreaterThan(before);
	});

	test('bookkeeping columns do NOT bump — otherwise every unrelated write respawns a server', () => {
		const db = freshDb();
		db.exec(`INSERT INTO mcp_servers (slug, name, transport) VALUES ('github', 'GitHub', 'http')`);
		const before = revision(db);

		// `created_at` is not in the trigger's UPDATE OF list.
		db.exec(`UPDATE mcp_servers SET created_at = '2020-01-01 00:00:00' WHERE slug = 'github'`);
		expect(revision(db)).toBe(before);
	});

	test('switching the active account bumps, renaming it does not', () => {
		const db = freshDb();
		db.exec(`INSERT INTO engine_accounts (provider_id, name, credential, is_active) VALUES (1, 'Work', 'sk-a', 1)`);
		db.exec(`INSERT INTO engine_accounts (provider_id, name, credential, is_active) VALUES (1, 'Personal', 'sk-b', 0)`);
		const before = revision(db);

		db.exec(`UPDATE engine_accounts SET is_active = 1 WHERE name = 'Personal'`);
		const afterSwitch = revision(db);
		expect(afterSwitch).toBeGreaterThan(before);

		// A display name is not part of any engine's spawn config.
		db.exec(`UPDATE engine_accounts SET name = 'Personal (old)' WHERE name = 'Personal'`);
		expect(revision(db)).toBe(afterSwitch);
	});

	test('a watched table that does not exist yet is skipped, not fatal', () => {
		// freshDb() creates two of the ten watched tables; `up()` already ran over
		// the rest without throwing, and the counter is still usable.
		const db = freshDb();
		expect(revision(db)).toBeGreaterThan(0);
	});

	test('the counter cannot grow a second row', () => {
		const db = freshDb();
		expect(() => db.exec(`INSERT INTO engine_config_revision (id, revision) VALUES (2, 1)`)).toThrow();
	});
});
