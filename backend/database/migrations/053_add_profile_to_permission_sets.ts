import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add profile_id + profile scope to permission_sets (per-profile allow/deny overlay)';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding profile_id to permission_sets...');
	// A Profile can carry its OWN per-engine allow/deny overlay ("restricted
	// mode"), stored as ordinary `permission_sets` rows with `scope = 'profile'`
	// and this `profile_id` set. The resolver unions them in as a third layer:
	//   deny  = global.deny ∪ project.deny ∪ profile.deny
	// so a profile can only ADD restrictions, never loosen the base policy.
	db.exec(`ALTER TABLE permission_sets ADD COLUMN profile_id INTEGER DEFAULT NULL`);

	// The old UNIQUE index keyed on (scope, COALESCE(project_id,''), engine) would
	// collide for two different profiles (both scope='profile', project_id NULL,
	// same engine). Rebuild it to include the profile dimension. Legacy rows have
	// profile_id NULL → COALESCE '' → identical key as before, so global/project
	// rows are unaffected and no duplicates are introduced.
	db.exec(`DROP INDEX IF EXISTS idx_permission_sets_scope`);
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_sets_scope
		ON permission_sets (scope, COALESCE(project_id, ''), COALESCE(profile_id, ''), engine)
	`);
	debug.log('migration', 'permission_sets profile_id added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Reverting permission_sets profile scope...');
	db.exec(`DELETE FROM permission_sets WHERE scope = 'profile'`);
	db.exec(`DROP INDEX IF EXISTS idx_permission_sets_scope`);
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_sets_scope
		ON permission_sets (scope, COALESCE(project_id, ''), engine)
	`);
	debug.log('migration', 'permission_sets profile scope reverted');
};
