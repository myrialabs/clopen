import type { DatabaseConnection } from '$shared/types/database/connection';
import { DatabaseManager, MigrationRunner, SeederRunner } from './utils';
import { migrations } from './migrations';
import { seeders } from './seeders';
import { debug } from '$shared/utils/logger';

// Database manager instance
let dbManager: DatabaseManager | null = null;

export async function initializeDatabase(): Promise<DatabaseConnection> {
	debug.log('database', '🔧 Initializing database system...');

	try {
		// Get database manager instance
		dbManager = DatabaseManager.getInstance();

		// Connect to database
		const db = await dbManager.connect();

		// Run migrations
		await runMigrations(db);

		// Run seeders
		await runSeeders(db);

		debug.log('database', '✅ Database system initialized successfully');
		return db;

	} catch (error) {
		debug.error('database', '❌ Failed to initialize database:', error);
		throw error;
	}
}

async function runMigrations(db: DatabaseConnection): Promise<void> {
	debug.log('database', '📋 Setting up migrations...');

	const migrationRunner = new MigrationRunner(db);

	// Add all migrations
	for (const migration of migrations) {
		migrationRunner.addMigration(migration);
	}

	// Run migrations
	await migrationRunner.runMigrations();

	debug.log('database', '✅ Migrations completed');
}

async function runSeeders(db: DatabaseConnection): Promise<void> {
	debug.log('database', '🌱 Setting up seeders...');

	const seederRunner = new SeederRunner(db);

	// Add all seeders
	for (const seeder of seeders) {
		seederRunner.addSeeder(seeder);
	}

	// Run seeders (only if not already executed)
	await seederRunner.runSeeders();

	debug.log('database', '✅ Seeders completed');
}

/**
 * Connect to an EXISTING database without migrating or seeding it.
 *
 * For short-lived side processes that only read a row — the git credential and
 * askpass helpers git spawns mid-command. `initializeDatabase()` is wrong for
 * them twice over: it would run migrations from a process nobody is watching,
 * racing the schema of the server that is already running, and it would pay for
 * seeders on every single authentication.
 *
 * Sets the same module-level manager `getDatabase()` reads, which is the part
 * that makes the queries usable — connecting the manager alone does not.
 */
export async function connectExistingDatabase(): Promise<DatabaseConnection> {
	if (dbManager?.isConnected()) return dbManager.getConnection();
	dbManager = DatabaseManager.getInstance();
	return await dbManager.connect();
}

export function getDatabase(): DatabaseConnection {
	if (!dbManager || !dbManager.isConnected()) {
		throw new Error('Database not initialized. Call initializeDatabase() first.');
	}
	return dbManager.getConnection();
}

export function closeDatabase(): void {
	if (dbManager) {
		dbManager.close();
		dbManager = null;
		debug.log('database', '✅ Database system shutdown');
	}
}

export async function resetDatabase(): Promise<void> {
	debug.log('database', '⚠️ Resetting database system...');

	if (!dbManager) {
		throw new Error('Database not initialized');
	}

	// Reset database (drop all tables)
	await dbManager.resetDatabase();

	// Re-run migrations and seeders
	const db = dbManager.getConnection();
	await runMigrations(db);
	await runSeeders(db);

	debug.log('database', '✅ Database system reset completed');
}

export async function getDatabaseInfo(): Promise<object> {
	if (!dbManager) {
		throw new Error('Database not initialized');
	}

	return dbManager.getDatabaseInfo();
}

export async function vacuumDatabase(): Promise<void> {
	if (!dbManager) {
		throw new Error('Database not initialized');
	}

	await dbManager.vacuum();
}

// Export utilities for advanced usage
export { DatabaseManager, MigrationRunner, SeederRunner } from './utils';
export { migrations } from './migrations';
export { seeders } from './seeders';