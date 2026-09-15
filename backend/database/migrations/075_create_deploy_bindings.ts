import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create deploy_bindings for the Deployments surface';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating deploy_bindings table...');

	// Which remote project a Clopen project deploys to, through one account.
	//
	// Belongs to the SURFACE, not to the account layer, for the same reason
	// `work_bindings` does: an account is one Vercel token, while "which Vercel
	// project is this" is per project, and two projects sharing one token is the
	// normal case.
	//
	// This is a sibling of `work_bindings` rather than a generalisation of it.
	// The columns differ where it matters: `display_name` exists because a
	// deployment locator is an opaque `prj_8Qc…` that means nothing to a reader,
	// unlike an `owner/repo` that describes itself, and `team_id` exists because
	// one token reaches several teams and the team is a property of which
	// project you picked — not of the credential.
	//
	// Nothing about a deployment itself is stored. The provider is the truthful
	// answer for state, logs and URLs, all three go stale within seconds, and
	// there is no local artifact (no worktree, no branch) that would survive the
	// remote record — so unlike the Issues surface there is not even a link
	// table here.
	db.exec(`
		CREATE TABLE IF NOT EXISTS deploy_bindings (
			project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			account_id   TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
			locator      TEXT NOT NULL,
			display_name TEXT NOT NULL DEFAULT '',
			team_id      TEXT,
			detected     INTEGER NOT NULL DEFAULT 0,
			config_json  TEXT NOT NULL DEFAULT '{}',
			created_at   TEXT NOT NULL,
			updated_at   TEXT NOT NULL,
			PRIMARY KEY (project_id, account_id)
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_deploy_bindings_account
		ON deploy_bindings(account_id)
	`);

	debug.log('migration', 'Deploy bindings table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping deploy_bindings table...');
	db.exec('DROP TABLE IF EXISTS deploy_bindings');
};
