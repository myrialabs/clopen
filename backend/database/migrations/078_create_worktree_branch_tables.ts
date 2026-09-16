import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create worktree_branch_bindings and worktree_branches for database branching';

/**
 * Worktree database branching — the binding, and the branches it produced.
 *
 * Two tables, for the same reason the Issues surface has two: one records the
 * decision ("give this project's worktrees their own database"), the other
 * records what that decision actually created and therefore what has to be
 * cleaned up.
 *
 * A SOURCE IS NOT ALWAYS AN ACCOUNT, which is why both tables carry
 * `source_kind` and two nullable parent columns instead of a single
 * `account_id`. Neon cuts a branch through its API and needs an integration
 * account; a Postgres running on the user's laptop needs nothing but the DB
 * Client connection that already reaches it. Tying the feature to accounts made
 * it a Neon feature by accident — a database with no vendor behind it had no
 * way in at all.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating worktree_branch_bindings table...');

	// ONE BINDING PER PROJECT, which is why `project_id` is the whole primary
	// key rather than half of it as in `work_bindings` and `deploy_bindings`.
	//
	// Those two are keyed per (project, account) because a project genuinely can
	// track issues in two places or deploy to two targets. This one cannot: the
	// binding's entire output is a single environment variable inside a single
	// worktree, and two bindings would both claim it. Making the schema hold a
	// state the feature cannot express would only produce a silent last-writer.
	//
	// `parent_name` is cached alongside the ref for the reason `deploy_bindings`
	// caches `display_name`: a Neon project id is `winter-frost-12345678` and
	// answers no question anyone asked.
	//
	// Exactly ONE of `account_id` and `connection_id` is set, and `source_kind`
	// says which. Both cascade: a disconnected account or a deleted connection
	// leaves a binding that points at nothing, and a binding that points at
	// nothing would fail on every worktree create with a message about a thing
	// the user already removed.
	db.exec(`
		CREATE TABLE IF NOT EXISTS worktree_branch_bindings (
			project_id    TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
			source_kind   TEXT NOT NULL DEFAULT 'account',
			account_id    TEXT REFERENCES integration_accounts(id) ON DELETE CASCADE,
			connection_id TEXT REFERENCES db_client_connections(id) ON DELETE CASCADE,
			parent_ref    TEXT NOT NULL,
			parent_name   TEXT NOT NULL,
			config_json   TEXT NOT NULL DEFAULT '{}',
			created_at    TEXT NOT NULL,
			updated_at    TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_worktree_branch_bindings_account
		ON worktree_branch_bindings(account_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_worktree_branch_bindings_connection
		ON worktree_branch_bindings(connection_id)
	`);

	debug.log('migration', 'Creating worktree_branches table...');

	// `worktree_id` is NULLABLE and ON DELETE SET NULL — deliberately NOT a
	// cascade, and this is the load-bearing decision in the whole table.
	//
	// Deleting a worktree deletes its branch at the provider. When that call
	// FAILS — an expired token, a provider outage, a branch the account can no
	// longer reach — the remote branch is still there, costing money and holding
	// data. A cascade would delete the only record of it in the same breath, so
	// the leak would be both silent and unrecoverable: nothing left would know
	// the branch had ever belonged to anything.
	//
	// So the row survives its worktree. `worktree_id IS NULL` is precisely the
	// definition of an orphan, and the orphan list is built from it.
	//
	// `connection_json` holds the branch's own connection string INCLUDING the
	// password, so it is sealed — see `SECRET_COLUMNS`. It lives here rather than
	// only on the projected connection because the projection must be
	// rebuildable from the row alone; a release followed by a re-project would
	// otherwise lose the password and leave a connection that cannot log in.
	// `source_connection_id` deliberately carries NO foreign key, unlike its
	// twin on the binding. The same reasoning as `worktree_id` above: this row
	// is the only record of a real database that exists right now, and deleting
	// the DB Client connection it was copied from must not erase the evidence of
	// the copy. The orphan list is what the user has left to clean it up with.
	db.exec(`
		CREATE TABLE IF NOT EXISTS worktree_branches (
			id                   TEXT PRIMARY KEY,
			worktree_id          TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
			project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			source_kind          TEXT NOT NULL DEFAULT 'account',
			account_id           TEXT REFERENCES integration_accounts(id) ON DELETE CASCADE,
			source_connection_id TEXT,
			parent_ref           TEXT NOT NULL,
			branch_ref           TEXT NOT NULL,
			branch_name          TEXT NOT NULL,
			connection_json      TEXT,
			connection_id        TEXT,
			env_var              TEXT NOT NULL,
			env_file             TEXT NOT NULL,
			env_status           TEXT NOT NULL DEFAULT 'failed',
			env_detail           TEXT,
			status               TEXT NOT NULL DEFAULT 'active',
			error                TEXT,
			strategy             TEXT,
			notice               TEXT,
			created_at           TEXT NOT NULL,
			updated_at           TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_worktree_branches_worktree
		ON worktree_branches(worktree_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_worktree_branches_account
		ON worktree_branches(account_id)
	`);

	// Identity is (source, parent, branch), and the source is whichever of the
	// two columns is set. A table constraint cannot express that — SQLite treats
	// every NULL as distinct, so `UNIQUE (account_id, …)` would stop enforcing
	// anything the moment the source was a connection.
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_branches_identity
		ON worktree_branches(
			source_kind,
			COALESCE(account_id, source_connection_id, ''),
			parent_ref,
			branch_ref
		)
	`);

	debug.log('migration', 'Worktree branching tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping worktree branching tables...');
	db.exec('DROP INDEX IF EXISTS idx_worktree_branches_identity');
	db.exec('DROP INDEX IF EXISTS idx_worktree_branches_account');
	db.exec('DROP INDEX IF EXISTS idx_worktree_branches_worktree');
	db.exec('DROP TABLE IF EXISTS worktree_branches');
	db.exec('DROP INDEX IF EXISTS idx_worktree_branch_bindings_connection');
	db.exec('DROP INDEX IF EXISTS idx_worktree_branch_bindings_account');
	db.exec('DROP TABLE IF EXISTS worktree_branch_bindings');
	// The remote branches themselves are deliberately left alone. A rollback is
	// a schema operation, and destroying someone's databases from one would be
	// the single worst thing this migration could do.
	debug.log('migration', 'Worktree branching tables dropped — remote branches were left untouched');
};
