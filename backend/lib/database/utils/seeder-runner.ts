import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
interface Seeder {
	name: string;
	description: string;
	seed: (db: DatabaseConnection) => void;
}

export class SeederRunner {
	private db: DatabaseConnection;
	private seeders: Seeder[] = [];

	constructor(db: DatabaseConnection) {
		this.db = db;
		this.ensureSeedersTable();
	}

	private ensureSeedersTable(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS seeders (
				name TEXT PRIMARY KEY,
				description TEXT NOT NULL,
				executed_at TEXT NOT NULL
			)
		`);
	}

	addSeeder(seeder: Seeder): void {
		this.seeders.push(seeder);
	}

	async runSeeders(force: boolean = false): Promise<void> {
		debug.log('database', '🌱 Running database seeders...');

		// Get already executed seeders
		const executedSeeders = this.db.prepare(`
			SELECT name FROM seeders
		`).all() as { name: string }[];

		const executedNames = new Set(executedSeeders.map(s => s.name));

		let executedCount = 0;

		for (const seeder of this.seeders) {
			if (!executedNames.has(seeder.name) || force) {
				debug.log('database', `🌱 Running seeder: ${seeder.name} - ${seeder.description}`);
				
				try {
					// Execute seeder
					seeder.seed(this.db);

					// Record seeder as executed (replace if force)
					if (force && executedNames.has(seeder.name)) {
						this.db.prepare(`
							UPDATE seeders 
							SET description = ?, executed_at = ?
							WHERE name = ?
						`).run(seeder.description, new Date().toISOString(), seeder.name);
					} else {
						this.db.prepare(`
							INSERT OR REPLACE INTO seeders (name, description, executed_at)
							VALUES (?, ?, ?)
						`).run(seeder.name, seeder.description, new Date().toISOString());
					}

					executedCount++;
					debug.log('database', `✅ Seeder ${seeder.name} completed`);
				} catch (error) {
					debug.error('database', `❌ Seeder ${seeder.name} failed:`, error);
					throw error;
				}
			}
		}

		if (executedCount === 0) {
			debug.log('database', 'ℹ️  No new seeders to run');
		} else {
			debug.log('database', `✅ Executed ${executedCount} seeders successfully`);
		}
	}

	async runSpecificSeeder(seederName: string, force: boolean = false): Promise<void> {
		const seeder = this.seeders.find(s => s.name === seederName);
		if (!seeder) {
			throw new Error(`Seeder ${seederName} not found`);
		}

		debug.log('database', `🌱 Running specific seeder: ${seederName}`);

		try {
			seeder.seed(this.db);

			// Record seeder as executed
			this.db.prepare(`
				INSERT OR REPLACE INTO seeders (name, description, executed_at)
				VALUES (?, ?, ?)
			`).run(seeder.name, seeder.description, new Date().toISOString());

			debug.log('database', `✅ Seeder ${seederName} completed`);
		} catch (error) {
			debug.error('database', `❌ Seeder ${seederName} failed:`, error);
			throw error;
		}
	}

	getExecutedSeeders(): string[] {
		const seeders = this.db.prepare(`
			SELECT name FROM seeders ORDER BY executed_at
		`).all() as { name: string }[];

		return seeders.map(s => s.name);
	}

	getPendingSeeders(): string[] {
		const executed = new Set(this.getExecutedSeeders());
		return this.seeders
			.filter(s => !executed.has(s.name))
			.map(s => s.name);
	}
}