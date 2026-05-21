/**
 * Migration 037: Repair auth_audit_log schema for early-applied databases
 *
 * Some databases applied an early version of migration 036 that did not
 * include the actor_user_id column. The original CREATE statement uses
 * IF NOT EXISTS, so a re-run won't alter the existing table. This
 * migration adds the missing column when absent.
 */

import type { DatabaseConnection } from '$shared/types/database/connection';

export const description = 'Repair auth_audit_log schema (add missing actor_user_id column)';

interface SqliteColumnInfo {
	name: string;
}

export function up(db: DatabaseConnection): void {
	const columns = db
		.prepare(`PRAGMA table_info(auth_audit_log)`)
		.all() as SqliteColumnInfo[];

	if (columns.length === 0) {
		// Table doesn't exist yet — migration 036 will create it with the
		// correct schema. Nothing to repair.
		return;
	}

	const hasActorUserId = columns.some((c) => c.name === 'actor_user_id');
	if (!hasActorUserId) {
		db.exec(`ALTER TABLE auth_audit_log ADD COLUMN actor_user_id TEXT;`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_audit_actor_user_id ON auth_audit_log(actor_user_id);`);
	}
}

export function down(_db: DatabaseConnection): void {
	// Non-destructive repair — no reversal needed.
}
