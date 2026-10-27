import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';

export const description = 'Add project kind and owner for per-user Home workspaces';

/**
 * Home is a project row so that everything that needs a project keeps working
 * for a chat with none selected; `kind` tells it apart and `owner_user_id`
 * says whose it is. The partial unique index is the rule "one Home per user",
 * enforced where a race between two tabs cannot get around it.
 *
 * `owner_user_id` deliberately carries NO foreign key: SQLite cannot drop a
 * column that takes part in one, so `down()` would need a rebuild of
 * `projects` — the table half the schema points at. A removed user's Home
 * loses its `user_projects` row with them and is reachable by no one; it is
 * kept, like any project whose last member left, rather than deleted with
 * its sessions behind the admin's back.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Adding project kind and owner...');
	db.exec(`ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project', 'home'))`);
	db.exec(`ALTER TABLE projects ADD COLUMN owner_user_id TEXT`);
	db.exec(`CREATE UNIQUE INDEX idx_projects_home_owner ON projects (owner_user_id) WHERE kind = 'home'`);
	debug.log('migration', '✅ Project kind and owner added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Removing project kind and owner...');
	db.exec('DROP INDEX IF EXISTS idx_projects_home_owner');
	// Home rows have no meaning without the column that marks them.
	db.exec(`DELETE FROM projects WHERE kind = 'home'`);
	db.exec('ALTER TABLE projects DROP COLUMN owner_user_id');
	db.exec('ALTER TABLE projects DROP COLUMN kind');
	debug.log('migration', '✅ Project kind and owner removed');
};
