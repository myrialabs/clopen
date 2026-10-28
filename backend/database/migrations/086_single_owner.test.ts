/**
 * Migration 086 takes a multi-user install to a single owner. It runs the real
 * migration chain up to 085 against an in-memory SQLite, seeds the shapes a
 * team install actually had, then checks what 086 keeps and what it removes —
 * above all that no credential of a removed account survives.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { DatabaseConnection } from '$shared/types/database/connection';
import migrations from './index';
import { up, down } from './086_single_owner';

const NOW = '2026-01-01T00:00:00.000Z';

function migratedTo085(): Database {
	const db = new Database(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	for (const migration of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) {
		if (migration.id >= '086') break;
		migration.up(db as unknown as DatabaseConnection);
	}
	return db;
}

function addUser(db: Database, id: string, role: 'admin' | 'member', createdAt: string): void {
	db.prepare(`INSERT INTO users (id, name, color, avatar, role, personal_access_token_hash, created_at, updated_at) VALUES (?, ?, '#000', 'X', ?, ?, ?, ?)`)
		.run(id, id, role, `pat-${id}`, createdAt, createdAt);
	db.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, last_active_at) VALUES (?, ?, ?, '2099-01-01', ?, ?)`)
		.run(`s-${id}`, id, `hash-${id}`, NOW, NOW);
}

function addProject(db: Database, id: string, path: string, kind: 'project' | 'home' = 'project', owner: string | null = null): void {
	db.prepare(`INSERT INTO projects (id, name, path, created_at, last_opened_at, kind, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
		.run(id, id, path, NOW, NOW, kind, owner);
}

function seed(home: string): Database {
	const db = migratedTo085();
	// The oldest admin is the owner; a second admin and a member are removed.
	addUser(db, 'owner', 'admin', '2025-01-01');
	addUser(db, 'admin2', 'admin', '2025-02-01');
	addUser(db, 'member', 'member', '2024-01-01');

	addProject(db, 'shared', '/repo/shared');
	addProject(db, 'removed', '/repo/removed');
	addProject(db, 'home-owner', join(home, 'owner'), 'home', 'owner');
	addProject(db, 'home-member', join(home, 'member'), 'home', 'member');
	mkdirSync(join(home, 'member'), { recursive: true });

	for (const [user, project, state] of [['owner', 'shared', 'owner-layout'], ['owner', 'home-owner', null], ['member', 'shared', 'member-layout'], ['member', 'home-member', null]] as const) {
		db.prepare(`INSERT INTO user_projects (user_id, project_id, joined_at, workspace_state) VALUES (?, ?, ?, ?)`).run(user, project, NOW, state);
	}

	// A chat the member had in the shared project is project history; one in their Home is theirs.
	db.prepare(`INSERT INTO chat_sessions (id, project_id, started_at) VALUES ('chat-shared', 'shared', ?)`).run(NOW);
	db.prepare(`INSERT INTO chat_sessions (id, project_id, started_at) VALUES ('chat-home', 'home-member', ?)`).run(NOW);
	db.prepare(`INSERT INTO user_unread_sessions (user_id, session_id, project_id, marked_at) VALUES ('owner', 'chat-shared', 'shared', ?), ('member', 'chat-shared', 'shared', ?)`).run(NOW, NOW);

	db.prepare(`INSERT INTO invite_tokens (id, token_hash, role, created_by, created_at) VALUES ('inv', 'inv-hash', 'member', 'owner', ?)`).run(NOW);
	db.prepare(`INSERT INTO device_codes (id, code_hash, user_id, expires_at, created_at) VALUES ('dev', 'dev-hash', 'member', '2099-01-01', ?)`).run(NOW);

	for (const [id, owner] of [['db-owner', 'owner'], ['db-member', 'member'], ['db-legacy', null]] as const) {
		db.prepare(`INSERT INTO db_client_connections (id, name, driver, created_at, updated_at, owner_user_id) VALUES (?, ?, 'postgres', ?, ?, ?)`).run(id, id, NOW, NOW, owner);
	}
	for (const [id, owner] of [['ssh-owner', 'owner'], ['ssh-member', 'member']] as const) {
		db.prepare(`INSERT INTO ssh_connections (id, name, host, port, username, auth_method, created_at, updated_at, owner_user_id) VALUES (?, ?, 'h', 22, 'u', 'agent', ?, ?, ?)`).run(id, id, NOW, NOW, owner);
	}
	for (const [id, owner, isDefault] of [['gi-owner', 'owner', 1], ['gi-member', 'member', 1]] as const) {
		db.prepare(`INSERT INTO git_identities (id, owner_user_id, label, name, email, is_default, created_at, updated_at) VALUES (?, ?, 'Work', 'N', 'e@x.y', ?, ?, ?)`).run(id, owner, isDefault, NOW, NOW);
	}
	db.prepare(`INSERT INTO git_identity_bindings (project_id, user_id, identity_id, created_at, updated_at) VALUES ('shared', 'owner', 'gi-owner', ?, ?), ('shared', 'member', 'gi-member', ?, ?)`).run(NOW, NOW, NOW, NOW);

	db.prepare(`INSERT INTO integration_accounts (id, provider, label, auth_method, created_at, updated_at) VALUES ('bot', 'telegram', 'Bot', 'token', ?, ?)`).run(NOW, NOW);
	db.prepare(`INSERT INTO channel_links (id, account_id, user_id, conversation_id, platform_user_id, status, created_at) VALUES ('link-owner', 'bot', 'owner', 'c1', 'p1', 'approved', ?), ('link-member', 'bot', 'member', 'c2', 'p2', 'pending', ?)`).run(NOW, NOW);
	return db;
}

function ids(db: Database, sql: string): string[] {
	return (db.prepare(sql).all() as { id: string }[]).map((row) => row.id);
}

function columns(db: Database, table: string): string[] {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe('migration 086', () => {
	// Homes live under `<data dir>/home/<userId>`; the migration only removes a
	// directory of exactly that shape.
	const dataDir = mkdtempSync(join(tmpdir(), 'clopen-086-'));
	const home = join(dataDir, 'home');

	test('keeps the oldest admin as the only account, and nothing a removed account could sign in with', () => {
		const db = seed(home);
		up(db as unknown as DatabaseConnection);

		expect(ids(db, 'SELECT id FROM users')).toEqual(['owner']);
		expect(ids(db, 'SELECT user_id AS id FROM auth_sessions')).toEqual(['owner']);
		expect(ids(db, 'SELECT id FROM device_codes')).toEqual([]);
		expect(ids(db, 'SELECT id FROM channel_links')).toEqual(['link-owner']);
		expect(columns(db, 'users')).not.toContain('role');
		expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'invite_tokens'`).get()).toBeNull();
		db.close();
	});

	test('removes what was the others alone, keeps shared project history', () => {
		const db = seed(home);
		up(db as unknown as DatabaseConnection);

		expect(ids(db, 'SELECT id FROM projects ORDER BY id')).toEqual(['home-owner', 'removed', 'shared']);
		expect(ids(db, 'SELECT id FROM chat_sessions')).toEqual(['chat-shared']);
		expect(existsSync(join(home, 'member'))).toBe(false);
		expect(ids(db, 'SELECT id FROM db_client_connections ORDER BY id')).toEqual(['db-legacy', 'db-owner']);
		expect(ids(db, 'SELECT id FROM ssh_connections')).toEqual(['ssh-owner']);
		expect(ids(db, 'SELECT id FROM git_identities')).toEqual(['gi-owner']);
		expect(ids(db, 'SELECT identity_id AS id FROM git_identity_bindings')).toEqual(['gi-owner']);
		db.close();
	});

	test("carries the owner's workspace list and state over, without a user key", () => {
		const db = seed(home);
		up(db as unknown as DatabaseConnection);

		const rows = db.prepare('SELECT project_id, workspace_state FROM workspace_projects ORDER BY project_id').all();
		expect(rows).toEqual([
			{ project_id: 'home-owner', workspace_state: null },
			{ project_id: 'shared', workspace_state: 'owner-layout' }
		]);
		// `removed` was never in the owner's list, so it stays removed.
		expect(db.prepare(`SELECT session_id FROM unread_sessions`).all()).toEqual([{ session_id: 'chat-shared' }]);
		for (const [table, column] of [['projects', 'owner_user_id'], ['db_client_connections', 'owner_user_id'], ['ssh_connections', 'owner_user_id'], ['git_identities', 'owner_user_id'], ['git_identity_bindings', 'user_id'], ['chat_sessions', 'sender_id'], ['channel_links', 'status']] as const) {
			expect(columns(db, table)).not.toContain(column);
		}
		db.close();
	});

	test('rolls back to the multi-user schema, the owner as its admin', () => {
		const db = seed(home);
		up(db as unknown as DatabaseConnection);
		down(db as unknown as DatabaseConnection);

		expect(db.prepare('SELECT id, role FROM users').all()).toEqual([{ id: 'owner', role: 'admin' }]);
		expect(db.prepare('SELECT user_id, project_id FROM user_projects ORDER BY project_id').all()).toEqual([
			{ user_id: 'owner', project_id: 'home-owner' },
			{ user_id: 'owner', project_id: 'shared' }
		]);
		expect(db.prepare('SELECT owner_user_id FROM git_identities').all()).toEqual([{ owner_user_id: 'owner' }]);
		expect(columns(db, 'chat_sessions')).toContain('sender_id');
		db.close();
	});

	test('allows one Home and one default identity for the install', () => {
		const db = seed(home);
		up(db as unknown as DatabaseConnection);

		expect(() => addProjectAfter(db, 'home-2')).toThrow();
		expect(() =>
			db.prepare(`INSERT INTO git_identities (id, label, name, email, is_default, created_at, updated_at) VALUES ('gi-2', 'Other', 'N', 'e@x.y', 1, ?, ?)`).run(NOW, NOW)
		).toThrow();
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	});
});

function addProjectAfter(db: Database, id: string): void {
	db.prepare(`INSERT INTO projects (id, name, path, created_at, last_opened_at, kind) VALUES (?, ?, ?, ?, ?, 'home')`).run(id, id, `/${id}`, NOW, NOW);
}
