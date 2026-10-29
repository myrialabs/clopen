import { rmSync } from 'fs';
import { basename, dirname } from 'path';
import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';

export const description = 'Collapse multi-user collaboration into a single owner';

/**
 * Clopen is one owner reaching their own machine from any number of devices.
 * Multi-user collaboration (roles, invites, per-project membership, per-user
 * scoping) is removed, and this migration takes an existing install there.
 *
 * The owner is the oldest admin — the account the setup wizard created — or,
 * failing that, the oldest user. Everyone else is deleted together with the
 * credentials and personal data that belonged to them. That part is a security
 * requirement, not tidiness: once role checks are gone, any token a former
 * member still holds would otherwise sign in as someone with full control.
 *
 * Shared history stays. Chats a member had in a regular project are project
 * history and remain in that project; only what was theirs alone (their Home,
 * their saved DB/SSH connections, git identities, paired chat apps, file
 * shares, push subscriptions, sessions) goes.
 *
 * The per-user columns that only existed to separate people are dropped:
 * `users.role`, `projects.owner_user_id`, `db_client_connections.owner_user_id`,
 * `ssh_connections.owner_user_id`, `git_identities.owner_user_id`,
 * `git_identity_bindings.user_id`, `chat_sessions.sender_*`,
 * `channel_links.status` (a member's chat waited for an admin), and the user key
 * of `user_projects` / `user_unread_sessions`, which become `workspace_projects`
 * / `unread_sessions`. Columns that record WHO authenticated (auth sessions,
 * device codes, push subscriptions, chat-app links, audit logs, `created_by`)
 * keep their user id — the owner still has one.
 */

function tableExists(db: DatabaseConnection, name: string): boolean {
	return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

function hasColumn(db: DatabaseConnection, table: string, column: string): boolean {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	return columns.some((c) => c.name === column);
}

/** Every chat session of a project and everything hanging off it, mirroring `sessionQueries.deleteAllByProjectId`. */
function deleteProjectSessions(db: DatabaseConnection, projectId: string): void {
	const inProject = 'SELECT id FROM chat_sessions WHERE project_id = ?';
	if (tableExists(db, 'branches')) db.prepare(`DELETE FROM branches WHERE session_id IN (${inProject})`).run(projectId);
	if (tableExists(db, 'message_snapshots')) db.prepare('DELETE FROM message_snapshots WHERE project_id = ?').run(projectId);
	if (tableExists(db, 'session_relationships')) {
		db.prepare(`DELETE FROM session_relationships WHERE parent_session_id IN (${inProject}) OR child_session_id IN (${inProject})`)
			.run(projectId, projectId);
	}
	db.prepare(`DELETE FROM messages WHERE session_id IN (${inProject})`).run(projectId);
	if (tableExists(db, 'messages_fts')) db.prepare('DELETE FROM messages_fts WHERE project_id = ?').run(projectId);
	db.prepare('DELETE FROM user_unread_sessions WHERE project_id = ?').run(projectId);
	db.prepare('UPDATE user_projects SET current_session_id = NULL WHERE project_id = ?').run(projectId);
	db.prepare('DELETE FROM chat_sessions WHERE project_id = ?').run(projectId);
}

/** Remove a project and every row that names it. FK cascades cover most tables; the rest are swept by column. */
function deleteProject(db: DatabaseConnection, projectId: string): void {
	deleteProjectSessions(db, projectId);
	const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
	for (const { name } of tables) {
		if (name === 'projects' || name === 'chat_sessions') continue;
		if (!hasColumn(db, name, 'project_id')) continue;
		db.prepare(`DELETE FROM ${name} WHERE project_id = ?`).run(projectId);
	}
	db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
}

/**
 * A Home directory is `<data dir>/home/<userId>`. Only a path of exactly that
 * shape for the deleted user is removed, so a hand-edited row can never point
 * this at somebody's repository.
 */
function removeHomeDirectory(path: string, userId: string): void {
	if (basename(path) !== userId || basename(dirname(path)) !== 'home') return;
	try {
		rmSync(path, { recursive: true, force: true });
	} catch (error) {
		debug.warn('migration', `Could not remove Home directory ${path}:`, error);
	}
}

function pickOwner(db: DatabaseConnection): string | null {
	const row = db.prepare(`
		SELECT id FROM users
		ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at ASC, id ASC
		LIMIT 1
	`).get() as { id: string } | undefined;
	return row?.id ?? null;
}

function removeOtherUsers(db: DatabaseConnection, ownerId: string): string[] {
	const others = (db.prepare('SELECT id FROM users WHERE id != ?').all(ownerId) as { id: string }[]).map((u) => u.id);
	if (others.length === 0) return [];
	const homeDirs: Array<{ path: string; userId: string }> = [];

	for (const userId of others) {
		const homes = db.prepare(`SELECT id, path FROM projects WHERE kind = 'home' AND owner_user_id = ?`).all(userId) as { id: string; path: string }[];
		for (const home of homes) {
			deleteProject(db, home.id);
			homeDirs.push({ path: home.path, userId });
		}

		db.prepare('DELETE FROM db_client_connections WHERE owner_user_id = ?').run(userId);
		db.prepare('DELETE FROM ssh_connections WHERE owner_user_id = ?').run(userId);
		db.prepare('DELETE FROM user_projects WHERE user_id = ?').run(userId);
		db.prepare('DELETE FROM user_unread_sessions WHERE user_id = ?').run(userId);
		if (tableExists(db, 'push_subscriptions')) db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
		// Cascades: auth_sessions, device_codes, invite_tokens, file_shares,
		// git_identities (+ bindings), git_identity_bindings, channel_links (+ messages).
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);
	}

	// Rows a member could still reach through a cascade that did not fire
	// (an older schema without the FK) are swept explicitly.
	db.prepare('DELETE FROM auth_sessions WHERE user_id != ?').run(ownerId);
	db.prepare('DELETE FROM device_codes WHERE user_id != ?').run(ownerId);
	if (tableExists(db, 'channel_links')) db.prepare('DELETE FROM channel_links WHERE user_id != ?').run(ownerId);
	if (tableExists(db, 'file_shares')) db.prepare('DELETE FROM file_shares WHERE created_by != ?').run(ownerId);

	for (const { path, userId } of homeDirs) removeHomeDirectory(path, userId);
	return others;
}

function rebuildGitIdentities(db: DatabaseConnection): void {
	db.exec(`
		CREATE TABLE git_identities_new (
			id                     TEXT PRIMARY KEY,
			label                  TEXT NOT NULL UNIQUE,
			name                   TEXT NOT NULL,
			email                  TEXT NOT NULL,
			auth_method            TEXT NOT NULL DEFAULT 'none'
			                       CHECK (auth_method IN ('none','ssh-key','https-token','https-account')),
			ssh_private_key        TEXT,
			ssh_public_key         TEXT,
			ssh_passphrase         TEXT,
			https_username         TEXT,
			https_token            TEXT,
			integration_account_id TEXT REFERENCES integration_accounts(id) ON DELETE SET NULL,
			hosts                  TEXT NOT NULL DEFAULT '[]',
			is_default             INTEGER NOT NULL DEFAULT 0,
			source                 TEXT NOT NULL DEFAULT 'manual'
			                       CHECK (source IN ('manual','local-machine')),
			created_at             TEXT NOT NULL,
			updated_at             TEXT NOT NULL
		)
	`);
	db.exec(`
		INSERT INTO git_identities_new (
			id, label, name, email, auth_method, ssh_private_key, ssh_public_key, ssh_passphrase,
			https_username, https_token, integration_account_id, hosts, is_default, source, created_at, updated_at
		)
		SELECT
			id, label, name, email, auth_method, ssh_private_key, ssh_public_key, ssh_passphrase,
			https_username, https_token, integration_account_id, hosts, is_default, source, created_at, updated_at
		FROM git_identities
	`);

	db.exec(`
		CREATE TABLE git_identity_bindings_new (
			project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
			identity_id TEXT NOT NULL REFERENCES git_identities_new(id) ON DELETE CASCADE,
			created_at  TEXT NOT NULL,
			updated_at  TEXT NOT NULL
		)
	`);
	db.exec(`
		INSERT OR IGNORE INTO git_identity_bindings_new (project_id, identity_id, created_at, updated_at)
		SELECT project_id, identity_id, created_at, updated_at FROM git_identity_bindings
	`);

	db.exec('DROP TABLE git_identity_bindings');
	db.exec('DROP TABLE git_identities');
	db.exec('ALTER TABLE git_identities_new RENAME TO git_identities');
	db.exec('ALTER TABLE git_identity_bindings_new RENAME TO git_identity_bindings');

	db.exec('CREATE INDEX idx_git_identity_bindings_identity ON git_identity_bindings (identity_id)');
	// At most one default and one mirrored machine identity, now install-wide.
	db.exec('CREATE UNIQUE INDEX idx_git_identities_one_default ON git_identities (is_default) WHERE is_default = 1');
	db.exec(`CREATE UNIQUE INDEX idx_git_identities_one_local ON git_identities (source) WHERE source = 'local-machine'`);
}

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Collapsing collaboration into a single owner...');

	db.exec('BEGIN');
	try {
		const ownerId = pickOwner(db);
		if (ownerId) {
			const removed = removeOtherUsers(db, ownerId);
			if (removed.length > 0) debug.log('migration', `Removed ${removed.length} non-owner account(s) and their data`);
		}

		// Invites only ever created members.
		db.exec('DROP TABLE IF EXISTS invite_tokens');

		db.exec('ALTER TABLE users DROP COLUMN role');

		// Projects in the workspace list, with their saved workspace state. A
		// project absent from here was "removed" (kept so its chats can be
		// restored by adding the same folder again).
		db.exec(`
			CREATE TABLE workspace_projects (
				project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
				joined_at TEXT NOT NULL,
				current_session_id TEXT,
				files_panel_state TEXT,
				workspace_state TEXT
			)
		`);
		if (ownerId) {
			db.prepare(`
				INSERT OR IGNORE INTO workspace_projects (project_id, joined_at, current_session_id, files_panel_state, workspace_state)
				SELECT project_id, joined_at, current_session_id, files_panel_state, workspace_state
				FROM user_projects
				WHERE user_id = ? AND project_id IN (SELECT id FROM projects)
			`).run(ownerId);
		}
		db.exec('DROP TABLE user_projects');

		db.exec(`
			CREATE TABLE unread_sessions (
				session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
				project_id TEXT NOT NULL,
				marked_at TEXT NOT NULL
			)
		`);
		db.exec('CREATE INDEX idx_unread_sessions_project ON unread_sessions(project_id)');
		db.exec(`
			INSERT OR IGNORE INTO unread_sessions (session_id, project_id, marked_at)
			SELECT session_id, project_id, MAX(marked_at) FROM user_unread_sessions
			WHERE session_id IN (SELECT id FROM chat_sessions)
			GROUP BY session_id
		`);
		db.exec('DROP TABLE user_unread_sessions');

		// One Home for the install.
		db.exec('DROP INDEX IF EXISTS idx_projects_home_owner');
		db.exec('ALTER TABLE projects DROP COLUMN owner_user_id');
		db.exec(`CREATE UNIQUE INDEX idx_projects_single_home ON projects (kind) WHERE kind = 'home'`);

		db.exec('DROP INDEX IF EXISTS idx_db_client_conn_owner');
		db.exec('ALTER TABLE db_client_connections DROP COLUMN owner_user_id');
		db.exec('DROP INDEX IF EXISTS idx_ssh_conn_owner');
		db.exec('ALTER TABLE ssh_connections DROP COLUMN owner_user_id');

		if (hasColumn(db, 'chat_sessions', 'sender_id')) db.exec('ALTER TABLE chat_sessions DROP COLUMN sender_id');
		if (hasColumn(db, 'chat_sessions', 'sender_name')) db.exec('ALTER TABLE chat_sessions DROP COLUMN sender_name');

		rebuildGitIdentities(db);

		if (tableExists(db, 'channel_links') && hasColumn(db, 'channel_links', 'status')) {
			// Only a member's chat could still be waiting for approval.
			db.exec(`DELETE FROM channel_links WHERE status != 'approved'`);
			db.exec('ALTER TABLE channel_links DROP COLUMN status');
		}

		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}

	debug.log('migration', '✅ Single owner in place');
};

/**
 * Restores the multi-user SCHEMA so older code can boot. The removed accounts
 * and their data are gone for good; the remaining user becomes the admin.
 */
export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Restoring multi-user schema...');
	const owner = db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get() as { id: string } | undefined;

	db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'member'))`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS invite_tokens (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
			label TEXT,
			created_by TEXT NOT NULL,
			max_uses INTEGER NOT NULL DEFAULT 1,
			use_count INTEGER NOT NULL DEFAULT 0,
			expires_at TEXT,
			created_at TEXT NOT NULL,
			project_ids TEXT,
			FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE TABLE user_projects (
			user_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			joined_at TEXT NOT NULL,
			current_session_id TEXT,
			files_panel_state TEXT,
			workspace_state TEXT,
			PRIMARY KEY (user_id, project_id),
			FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
		)
	`);
	db.exec('CREATE INDEX IF NOT EXISTS idx_user_projects_user_id ON user_projects(user_id)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_user_projects_project_id ON user_projects(project_id)');
	if (owner) {
		db.prepare(`
			INSERT INTO user_projects (user_id, project_id, joined_at, current_session_id, files_panel_state, workspace_state)
			SELECT ?, project_id, joined_at, current_session_id, files_panel_state, workspace_state FROM workspace_projects
		`).run(owner.id);
	}
	db.exec('DROP TABLE workspace_projects');

	db.exec(`
		CREATE TABLE user_unread_sessions (
			user_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			marked_at TEXT NOT NULL,
			PRIMARY KEY (user_id, session_id),
			FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
		)
	`);
	db.exec('CREATE INDEX IF NOT EXISTS idx_user_unread_sessions_user_project ON user_unread_sessions(user_id, project_id)');
	if (owner) {
		db.prepare(`
			INSERT INTO user_unread_sessions (user_id, session_id, project_id, marked_at)
			SELECT ?, session_id, project_id, marked_at FROM unread_sessions
		`).run(owner.id);
	}
	db.exec('DROP TABLE unread_sessions');

	db.exec('DROP INDEX IF EXISTS idx_projects_single_home');
	db.exec('ALTER TABLE projects ADD COLUMN owner_user_id TEXT');
	if (owner) db.prepare(`UPDATE projects SET owner_user_id = ? WHERE kind = 'home'`).run(owner.id);
	db.exec(`CREATE UNIQUE INDEX idx_projects_home_owner ON projects (owner_user_id) WHERE kind = 'home'`);

	db.exec('ALTER TABLE db_client_connections ADD COLUMN owner_user_id TEXT');
	db.exec('CREATE INDEX IF NOT EXISTS idx_db_client_conn_owner ON db_client_connections(owner_user_id)');
	db.exec('ALTER TABLE ssh_connections ADD COLUMN owner_user_id TEXT');
	db.exec('CREATE INDEX IF NOT EXISTS idx_ssh_conn_owner ON ssh_connections(owner_user_id)');
	if (owner) {
		db.prepare('UPDATE db_client_connections SET owner_user_id = ?').run(owner.id);
		db.prepare('UPDATE ssh_connections SET owner_user_id = ?').run(owner.id);
	}

	db.exec(`ALTER TABLE channel_links ADD COLUMN status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved'))`);

	db.exec('ALTER TABLE chat_sessions ADD COLUMN sender_id TEXT');
	db.exec('ALTER TABLE chat_sessions ADD COLUMN sender_name TEXT');

	// Git identities need an owner; without one there is nobody to give them to.
	db.exec(`
		CREATE TABLE git_identities_old (
			id                     TEXT PRIMARY KEY,
			owner_user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			label                  TEXT NOT NULL,
			name                   TEXT NOT NULL,
			email                  TEXT NOT NULL,
			auth_method            TEXT NOT NULL DEFAULT 'none'
			                       CHECK (auth_method IN ('none','ssh-key','https-token','https-account')),
			ssh_private_key        TEXT,
			ssh_public_key         TEXT,
			ssh_passphrase         TEXT,
			https_username         TEXT,
			https_token            TEXT,
			integration_account_id TEXT REFERENCES integration_accounts(id) ON DELETE SET NULL,
			hosts                  TEXT NOT NULL DEFAULT '[]',
			is_default             INTEGER NOT NULL DEFAULT 0,
			source                 TEXT NOT NULL DEFAULT 'manual'
			                       CHECK (source IN ('manual','local-machine')),
			created_at             TEXT NOT NULL,
			updated_at             TEXT NOT NULL,
			UNIQUE (owner_user_id, label)
		)
	`);
	db.exec(`
		CREATE TABLE git_identity_bindings_old (
			project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			identity_id TEXT NOT NULL REFERENCES git_identities_old(id) ON DELETE CASCADE,
			created_at  TEXT NOT NULL,
			updated_at  TEXT NOT NULL,
			PRIMARY KEY (project_id, user_id)
		)
	`);
	if (owner) {
		db.prepare(`
			INSERT INTO git_identities_old (
				id, owner_user_id, label, name, email, auth_method, ssh_private_key, ssh_public_key, ssh_passphrase,
				https_username, https_token, integration_account_id, hosts, is_default, source, created_at, updated_at
			)
			SELECT
				id, ?, label, name, email, auth_method, ssh_private_key, ssh_public_key, ssh_passphrase,
				https_username, https_token, integration_account_id, hosts, is_default, source, created_at, updated_at
			FROM git_identities
		`).run(owner.id);
		db.prepare(`
			INSERT INTO git_identity_bindings_old (project_id, user_id, identity_id, created_at, updated_at)
			SELECT project_id, ?, identity_id, created_at, updated_at FROM git_identity_bindings
		`).run(owner.id);
	}
	db.exec('DROP TABLE git_identity_bindings');
	db.exec('DROP TABLE git_identities');
	db.exec('ALTER TABLE git_identities_old RENAME TO git_identities');
	db.exec('ALTER TABLE git_identity_bindings_old RENAME TO git_identity_bindings');
	db.exec('CREATE INDEX idx_git_identities_owner ON git_identities (owner_user_id)');
	db.exec('CREATE UNIQUE INDEX idx_git_identities_one_default ON git_identities (owner_user_id) WHERE is_default = 1');
	db.exec(`CREATE UNIQUE INDEX idx_git_identities_one_local ON git_identities (owner_user_id) WHERE source = 'local-machine'`);
	db.exec('CREATE INDEX idx_git_identity_bindings_identity ON git_identity_bindings (identity_id)');

	debug.log('migration', '✅ Multi-user schema restored');
};
