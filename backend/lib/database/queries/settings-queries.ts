import { getDatabase } from '../index';
import type { Setting } from '$shared/types/database/schema';

export const settingsQueries = {
	getAll(): Setting[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM settings 
			ORDER BY key
		`).all() as Setting[];
	},

	get(key: string): Setting | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM settings WHERE key = ?
		`).get(key) as Setting | null;
	},

	set(key: string, value: string): void {
		const db = getDatabase();
		const now = new Date().toISOString();
		
		db.prepare(`
			INSERT OR REPLACE INTO settings (key, value, updated_at)
			VALUES (?, ?, ?)
		`).run(key, value, now);
	},

	delete(key: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM settings WHERE key = ?').run(key);
	}
};