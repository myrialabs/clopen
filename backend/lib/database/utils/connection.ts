import { join } from 'path';
import { homedir } from 'os';
import { Database } from 'bun:sqlite';
import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export class DatabaseManager {
	private static instance: DatabaseManager | null = null;
	private db: DatabaseConnection | null = null;
	private readonly dbPath: string;

	private constructor() {
		const clopenDir = join(homedir(), '.clopen');
		this.dbPath = join(clopenDir, 'app.db');
	}

	static getInstance(): DatabaseManager {
		if (!DatabaseManager.instance) {
			DatabaseManager.instance = new DatabaseManager();
		}
		return DatabaseManager.instance;
	}

	async connect(): Promise<DatabaseConnection> {
		if (this.db) {
			return this.db;
		}

		debug.log('database', '🔗 Connecting to database...');

		try {
			// Create ~/.clopen directory if it doesn't exist
			const clopenDir = join(homedir(), '.clopen');
			const dirFile = Bun.file(clopenDir);

			// Check if directory exists, if not create it
			try {
				await dirFile.stat();
			} catch {
				// Directory doesn't exist, create using Bun.write workaround
				const tempFile = join(clopenDir, '.init');
				await Bun.write(tempFile, '');
				// Remove the temp file
				try {
					const tempFileHandle = Bun.file(tempFile);
					if (await tempFileHandle.exists()) {
						if (process.platform === 'win32') {
							await Bun.spawn(['cmd', '/c', 'del', '/f', '/q', tempFile.replace(/\//g, '\\')], {
								stdout: 'ignore',
								stderr: 'ignore'
							}).exited;
						} else {
							await Bun.spawn(['rm', '-f', tempFile], {
								stdout: 'ignore',
								stderr: 'ignore'
							}).exited;
						}
					}
				} catch {
					// Ignore cleanup errors
				}
			}

			// Use Bun's native SQLite exclusively
			this.db = new Database(this.dbPath);

			// Configure database for optimal performance
			this.configurePragmas();

			debug.log('database', `✅ Connected to database at: ${this.dbPath}`);
			return this.db;

		} catch (error) {
			debug.error('database', '❌ Failed to connect to database:', error);
			throw error;
		}
	}

	private configurePragmas(): void {
		if (!this.db) return;

		debug.log('database', '⚙️  Configuring database pragmas...');

		// Bun SQLite uses exec for pragmas
		this.db.exec('PRAGMA journal_mode = WAL');
		this.db.exec('PRAGMA synchronous = NORMAL');
		this.db.exec('PRAGMA cache_size = 1000000');
		this.db.exec('PRAGMA temp_store = memory');
		this.db.exec('PRAGMA foreign_keys = ON');

		debug.log('database', '✅ Database pragmas configured');
	}

	getConnection(): DatabaseConnection {
		if (!this.db) {
			throw new Error('Database not connected. Call connect() first.');
		}
		return this.db;
	}

	isConnected(): boolean {
		return this.db !== null;
	}

	close(): void {
		if (this.db) {
			debug.log('database', '🔗 Closing database connection...');
			this.db.close();
			this.db = null;
			debug.log('database', '✅ Database connection closed');
		}
	}

	getPath(): string {
		return this.dbPath;
	}

	async resetDatabase(): Promise<void> {
		debug.log('database', '⚠️ Resetting database (dropping all tables)...');
		
		if (!this.db) {
			throw new Error('Database not connected');
		}

		// Drop all tables
		const tables = this.db.prepare(`
			SELECT name FROM sqlite_master 
			WHERE type='table' AND name NOT LIKE 'sqlite_%'
		`).all() as { name: string }[];

		for (const table of tables) {
			debug.log('database', `🗑️ Dropping table: ${table.name}`);
			this.db.exec(`DROP TABLE IF EXISTS ${table.name}`);
		}

		debug.log('database', '✅ Database reset completed');
	}

	async vacuum(): Promise<void> {
		debug.log('database', '🧹 Running database vacuum...');
		
		if (!this.db) {
			throw new Error('Database not connected');
		}

		this.db.exec('VACUUM');
		debug.log('database', '✅ Database vacuum completed');
	}

	getDatabaseInfo(): object {
		if (!this.db) {
			throw new Error('Database not connected');
		}

		// Helper to get pragma values with Bun SQLite
		const getPragma = (name: string) => {
			const result = this.db!.query(`PRAGMA ${name}`).get() as any;
			return result ? Object.values(result)[0] : null;
		};
		
		return {
			path: this.dbPath,
			journalMode: getPragma('journal_mode'),
			synchronous: getPragma('synchronous'),
			cacheSize: getPragma('cache_size'),
			tempStore: getPragma('temp_store'),
			foreignKeys: getPragma('foreign_keys'),
			userVersion: getPragma('user_version'),
			pageSize: getPragma('page_size'),
			pageCount: getPragma('page_count'),
			freelistCount: getPragma('freelist_count')
		};
	}
}