import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Create git_identities and git_identity_bindings for per-project git accounts';

/**
 * Who a commit is authored by, and which credential reaches the remote.
 *
 * Until now Clopen ran `git` with whatever the machine's `.git/config` or
 * `~/.gitconfig` said. On a laptop that silently works; on a VPS or in Docker
 * it means commits carry a fabricated identity, or fail outright, and an HTTPS
 * push dies against `GIT_TERMINAL_PROMPT=0` with no way to ask for a password.
 *
 * ── Two tables, not one ──
 * An identity is a reusable account: a name, an email, and the credential that
 * proves it to a host. A binding is a per-project, per-user choice of which one
 * to use. They are split for the same reason `deploy_bindings` is separate from
 * `integration_accounts`: one identity normally serves many projects, and
 * folding the choice into the account would make a user re-enter (and re-rotate)
 * the same key for every repository.
 *
 * ── Why identities belong to a user ──
 * Clopen is multi-user. An identity is a claim about who a person is, so it is
 * owned by `users.id` and a teammate's commits can never be attributed to
 * someone else. The binding is keyed `(project_id, user_id)` for the same
 * reason: two people sharing a project each commit as themselves.
 *
 * ── `hosts` ──
 * A JSON array of hostnames this identity's credential is valid for
 * (`["github.com"]`). Resolution is per project first, but a repository can
 * have `origin` and `upstream` on different accounts, so the credential is
 * chosen by matching the remote URL's host. An empty array means "no host
 * claim" — usable for attribution, never selected for credentials.
 *
 * ── `source` ──
 * `local-machine` marks the identity mirrored from the machine's own
 * `git config --global`. It exists so a fresh install already lists the account
 * the user has been committing with rather than showing an empty page, and it is
 * NOT deletable: the machine's config is the thing it reflects, so deleting the
 * row would only make it reappear. Everything else about it is editable — a user
 * who wants a different email on it is expressing a preference, not a mistake,
 * and Clopen stops mirroring once they do.
 *
 * Secrets (`ssh_private_key`, `ssh_passphrase`, `https_token`) are stored
 * through the AES-256-GCM envelope in `backend/database/crypto`, the same way
 * `ssh_connections` stores its keys.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating git_identities table...');

	db.exec(`
		CREATE TABLE git_identities (
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
		CREATE INDEX idx_git_identities_owner ON git_identities (owner_user_id)
	`);

	// At most one default per user. A partial index is the only way SQLite can
	// state that rule, and stating it here means a bug in the service layer
	// surfaces as a constraint error rather than as two defaults and a coin flip
	// over which identity a project inherits.
	db.exec(`
		CREATE UNIQUE INDEX idx_git_identities_one_default
		ON git_identities (owner_user_id) WHERE is_default = 1
	`);

	// One mirrored row per user. The import runs whenever the list is read, so
	// without this a machine config change would append a second copy instead of
	// updating the first.
	db.exec(`
		CREATE UNIQUE INDEX idx_git_identities_one_local
		ON git_identities (owner_user_id) WHERE source = 'local-machine'
	`);

	debug.log('migration', '📋 Creating git_identity_bindings table...');

	db.exec(`
		CREATE TABLE git_identity_bindings (
			project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			identity_id TEXT NOT NULL REFERENCES git_identities(id) ON DELETE CASCADE,
			created_at  TEXT NOT NULL,
			updated_at  TEXT NOT NULL,
			PRIMARY KEY (project_id, user_id)
		)
	`);

	db.exec(`
		CREATE INDEX idx_git_identity_bindings_identity ON git_identity_bindings (identity_id)
	`);

	debug.log('migration', '✅ git_identities and git_identity_bindings created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Dropping git identity tables...');
	db.exec('DROP TABLE IF EXISTS git_identity_bindings');
	db.exec('DROP TABLE IF EXISTS git_identities');
	debug.log('migration', '✅ git identity tables dropped');
};
