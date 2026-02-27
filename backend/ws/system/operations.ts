/**
 * System Operations
 *
 * HTTP endpoints for system-level operations:
 * - Clear all database data
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { initializeDatabase, getDatabase } from '../../lib/database';
import { debug } from '$shared/utils/logger';

export const operationsHandler = createRouter()
	// Clear all database data
	.http('system:clear-data', {
		data: t.Object({}),
		response: t.Object({
			cleared: t.Boolean(),
			tablesCount: t.Number()
		})
	}, async () => {
		debug.log('server', 'Clearing all database data...');

		// Initialize database first to ensure it exists
		await initializeDatabase();

		// Get database connection
		const db = getDatabase();

		// Get all table names
		const tables = db.prepare(`
			SELECT name FROM sqlite_master
			WHERE type='table'
			AND name NOT LIKE 'sqlite_%'
		`).all() as { name: string }[];

		// Delete all data from each table
		for (const table of tables) {
			db.prepare(`DELETE FROM ${table.name}`).run();
			debug.log('server', `Cleared table: ${table.name}`);
		}

		debug.log('server', 'Database cleared successfully');

		return {
			cleared: true,
			tablesCount: tables.length
		};
	});
