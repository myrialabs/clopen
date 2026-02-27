import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
interface Migration {
	id: string;
	description: string;
	up: (db: DatabaseConnection) => void;
	down: (db: DatabaseConnection) => void;
}

export class MigrationRunner {
	private db: DatabaseConnection;
	private migrations: Migration[] = [];

	constructor(db: DatabaseConnection) {
		this.db = db;
		this.ensureMigrationsTable();
	}

	private ensureMigrationsTable(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS migrations (
				id TEXT PRIMARY KEY,
				description TEXT NOT NULL,
				executed_at TEXT NOT NULL
			)
		`);
	}

	addMigration(migration: Migration): void {
		this.migrations.push(migration);
	}

	async runMigrations(): Promise<void> {
		debug.log('database', '🔄 Running database migrations...');

		// Get already executed migrations
		const executedMigrations = this.db.prepare(`
			SELECT id FROM migrations ORDER BY id
		`).all() as { id: string }[];

		const executedIds = new Set(executedMigrations.map(m => m.id));

		// Sort migrations by ID to ensure order
		const sortedMigrations = this.migrations.sort((a, b) => a.id.localeCompare(b.id));

		let executedCount = 0;

		for (const migration of sortedMigrations) {
			if (!executedIds.has(migration.id)) {
				debug.log('database', `📋 Running migration: ${migration.id} - ${migration.description}`);
				
				try {
					// Execute migration
					migration.up(this.db);

					// Record migration as executed
					this.db.prepare(`
						INSERT INTO migrations (id, description, executed_at)
						VALUES (?, ?, ?)
					`).run(migration.id, migration.description, new Date().toISOString());

					executedCount++;
					debug.log('database', `✅ Migration ${migration.id} completed`);
				} catch (error) {
					debug.error('database', `❌ Migration ${migration.id} failed:`, error);
					throw error;
				}
			}
		}

		if (executedCount === 0) {
			debug.log('database', 'ℹ️  No new migrations to run');
		} else {
			debug.log('database', `✅ Executed ${executedCount} migrations successfully`);
		}
	}

	async rollbackMigration(migrationId: string): Promise<void> {
		debug.log('database', `🔄 Rolling back migration: ${migrationId}`);

		const migration = this.migrations.find(m => m.id === migrationId);
		if (!migration) {
			throw new Error(`Migration ${migrationId} not found`);
		}

		try {
			// Execute rollback
			migration.down(this.db);

			// Remove migration record
			this.db.prepare(`
				DELETE FROM migrations WHERE id = ?
			`).run(migrationId);

			debug.log('database', `✅ Migration ${migrationId} rolled back successfully`);
		} catch (error) {
			debug.error('database', `❌ Rollback of ${migrationId} failed:`, error);
			throw error;
		}
	}

	getExecutedMigrations(): string[] {
		const migrations = this.db.prepare(`
			SELECT id FROM migrations ORDER BY id
		`).all() as { id: string }[];

		return migrations.map(m => m.id);
	}

	getPendingMigrations(): string[] {
		const executed = new Set(this.getExecutedMigrations());
		return this.migrations
			.filter(m => !executed.has(m.id))
			.sort((a, b) => a.id.localeCompare(b.id))
			.map(m => m.id);
	}
}