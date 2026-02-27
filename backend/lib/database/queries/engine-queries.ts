import { getDatabase } from '../index';

export interface ClaudeAccount {
	id: number;
	name: string;
	oauth_token: string;
	is_active: number;
	created_at: string;
}

export const engineQueries = {
	getClaudeAccounts(): ClaudeAccount[] {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM claude_accounts
			ORDER BY created_at ASC
		`).all() as ClaudeAccount[];
	},

	getActiveClaudeAccount(): ClaudeAccount | null {
		const db = getDatabase();
		return db.prepare(`
			SELECT * FROM claude_accounts WHERE is_active = 1
		`).get() as ClaudeAccount | null;
	},

	createClaudeAccount(name: string, token: string): ClaudeAccount {
		const db = getDatabase();

		// Check if this is the first account
		const count = (db.prepare('SELECT COUNT(*) as count FROM claude_accounts').get() as { count: number }).count;
		const isActive = count === 0 ? 1 : 0;

		db.prepare(`
			INSERT INTO claude_accounts (name, oauth_token, is_active)
			VALUES (?, ?, ?)
		`).run(name, token, isActive);

		const inserted = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
		const id = inserted.id;

		return db.prepare('SELECT * FROM claude_accounts WHERE id = ?').get(id) as ClaudeAccount;
	},

	switchClaudeAccount(id: number): void {
		const db = getDatabase();
		db.prepare('UPDATE claude_accounts SET is_active = 0').run();
		db.prepare('UPDATE claude_accounts SET is_active = 1 WHERE id = ?').run(id);
	},

	deleteClaudeAccount(id: number): void {
		const db = getDatabase();

		// Check if the account being deleted is active
		const account = db.prepare('SELECT * FROM claude_accounts WHERE id = ?').get(id) as ClaudeAccount | null;
		if (!account) return;

		const wasActive = account.is_active === 1;

		db.prepare('DELETE FROM claude_accounts WHERE id = ?').run(id);

		// If the deleted account was active, activate the first remaining account
		if (wasActive) {
			const remaining = db.prepare('SELECT id FROM claude_accounts ORDER BY created_at ASC LIMIT 1').get() as { id: number } | null;
			if (remaining) {
				db.prepare('UPDATE claude_accounts SET is_active = 1 WHERE id = ?').run(remaining.id);
			}
		}
	},

	renameClaudeAccount(id: number, name: string): void {
		const db = getDatabase();
		db.prepare('UPDATE claude_accounts SET name = ? WHERE id = ?').run(name, id);
	}
};
