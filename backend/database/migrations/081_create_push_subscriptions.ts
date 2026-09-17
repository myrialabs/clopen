import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Create push_subscriptions table for Web Push (mobile background notifications)';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating push_subscriptions table...');

	db.exec(`
		CREATE TABLE push_subscriptions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL,
			endpoint TEXT NOT NULL UNIQUE,
			p256dh TEXT NOT NULL,
			auth TEXT NOT NULL,
			user_agent TEXT,
			created_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE INDEX idx_push_subscriptions_user_id ON push_subscriptions (user_id)
	`);

	debug.log('migration', '✅ push_subscriptions table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Dropping push_subscriptions table...');
	db.exec('DROP TABLE IF EXISTS push_subscriptions');
	debug.log('migration', '✅ push_subscriptions table dropped');
};
