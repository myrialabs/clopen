import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create work_bindings and work_links for the Issues & PRs surface';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating work_bindings table...');

	// Which remote project a Clopen project is looking at, through one account.
	//
	// This belongs to the SURFACE, not to the account layer: an account is
	// instance-wide (one GitHub token), while "which repo is this project" is
	// per project. Two projects sharing one token is the normal case, and it is
	// exactly the case a column on `integration_accounts` could not express.
	//
	// `locator` is provider-specific and opaque here — `owner/repo` for GitHub,
	// a team key for a tracker. `detected` records that nobody chose it; it was
	// read off the git remote. Keeping that flag is what lets the UI say "from
	// your origin remote" instead of presenting a guess as a decision.
	//
	// `config_json` holds the per-binding behaviour: which state to move an item
	// to on start-work and on PR open, and the branch template. It is NOT a
	// secret and is stored in plain JSON.
	db.exec(`
		CREATE TABLE IF NOT EXISTS work_bindings (
			project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			account_id     TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
			locator        TEXT NOT NULL,
			detected       INTEGER NOT NULL DEFAULT 0,
			default_branch TEXT,
			config_json    TEXT NOT NULL DEFAULT '{}',
			created_at     TEXT NOT NULL,
			updated_at     TEXT NOT NULL,
			PRIMARY KEY (project_id, account_id)
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_work_bindings_account
		ON work_bindings(account_id)
	`);

	debug.log('migration', 'Creating work_links table...');

	// The link between a remote work item and the local work started for it.
	//
	// This is the ONLY thing about a work item that is persisted. Titles, bodies
	// and comments are never copied into the database: they go stale, they turn
	// a read-only surface into a cache that has to be invalidated, and the
	// provider is always the truthful answer. What cannot be re-derived is which
	// worktree and session someone opened for issue 123 — so that, and only
	// that, is stored.
	//
	// Both foreign keys are ON DELETE SET NULL rather than CASCADE: deleting the
	// worktree after applying its changes must not erase the record that this
	// branch belongs to that issue, because the PR composer reads it to prefill
	// "Closes #123" long after the worktree is gone.
	db.exec(`
		CREATE TABLE IF NOT EXISTS work_links (
			id              TEXT PRIMARY KEY,
			project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			account_id      TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
			item_kind       TEXT NOT NULL CHECK (item_kind IN ('issue','pull-request')),
			item_identifier TEXT NOT NULL,
			item_title      TEXT,
			item_url        TEXT,
			worktree_id     TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
			session_id      TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
			branch          TEXT,
			created_at      TEXT NOT NULL,
			UNIQUE (project_id, account_id, item_kind, item_identifier)
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_work_links_project
		ON work_links(project_id)
	`);

	// The PR composer's lookup is "which item does this branch belong to", so
	// that is the index it gets.
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_work_links_branch
		ON work_links(project_id, branch)
	`);

	debug.log('migration', 'Work tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping work tables...');
	db.exec('DROP TABLE IF EXISTS work_links');
	db.exec('DROP TABLE IF EXISTS work_bindings');
};
