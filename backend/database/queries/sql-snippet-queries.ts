import { getDatabase } from '../index';
import type { SqlSnippet, SqlSnippetCreateInput, SqlSnippetUpdateInput } from '$shared/types/sql-snippets';

interface RawSnippetRow {
	id: string;
	title: string;
	description: string;
	sql: string;
	tags: string;
	is_public: number;
	share_token: string | null;
	created_by: string;
	created_by_name: string;
	created_at: string;
	updated_at: string;
}

function toSnippet(row: RawSnippetRow): SqlSnippet {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		sql: row.sql,
		tags: JSON.parse(row.tags) as string[],
		isPublic: row.is_public === 1,
		shareToken: row.share_token,
		createdBy: row.created_by,
		createdByName: row.created_by_name,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export const sqlSnippetQueries = {
	create(id: string, userId: string, userName: string, input: SqlSnippetCreateInput): SqlSnippet {
		const db = getDatabase();
		const now = new Date().toISOString();
		db.prepare(`
			INSERT INTO sql_snippets (id, title, description, sql, tags, is_public, share_token, created_by, created_by_name, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
		`).run(
			id,
			input.title,
			input.description,
			input.sql,
			JSON.stringify(input.tags),
			input.isPublic ? 1 : 0,
			userId,
			userName,
			now,
			now
		);
		return this.getById(id)!;
	},

	getById(id: string): SqlSnippet | null {
		const db = getDatabase();
		const row = db.prepare('SELECT * FROM sql_snippets WHERE id = ?').get(id) as RawSnippetRow | undefined;
		return row ? toSnippet(row) : null;
	},

	getByShareToken(token: string): SqlSnippet | null {
		const db = getDatabase();
		const row = db.prepare('SELECT * FROM sql_snippets WHERE share_token = ? AND is_public = 1').get(token) as RawSnippetRow | undefined;
		return row ? toSnippet(row) : null;
	},

	/**
	 * List snippets visible to the given user:
	 * - All snippets created by the user
	 * - All public snippets
	 */
	listForUser(userId: string): SqlSnippet[] {
		const db = getDatabase();
		const rows = db.prepare(`
			SELECT * FROM sql_snippets
			WHERE created_by = ? OR is_public = 1
			ORDER BY
				CASE WHEN created_by = ? THEN 0 ELSE 1 END,
				updated_at DESC
		`).all(userId, userId) as RawSnippetRow[];
		return rows.map(toSnippet);
	},

	update(userId: string, input: SqlSnippetUpdateInput): SqlSnippet | null {
		const db = getDatabase();
		const now = new Date().toISOString();
		const result = db.prepare(`
			UPDATE sql_snippets
			SET title = ?, description = ?, sql = ?, tags = ?, is_public = ?, updated_at = ?
			WHERE id = ? AND created_by = ?
		`).run(
			input.title,
			input.description,
			input.sql,
			JSON.stringify(input.tags),
			input.isPublic ? 1 : 0,
			now,
			input.id,
			userId
		);
		if ((result as { changes: number }).changes === 0) return null;
		return this.getById(input.id);
	},

	delete(id: string, userId: string): boolean {
		const db = getDatabase();
		const result = db.prepare('DELETE FROM sql_snippets WHERE id = ? AND created_by = ?').run(id, userId);
		return (result as { changes: number }).changes > 0;
	},

	setShareToken(id: string, userId: string, token: string | null): SqlSnippet | null {
		const db = getDatabase();
		const now = new Date().toISOString();
		const result = db.prepare(`
			UPDATE sql_snippets
			SET share_token = ?, is_public = CASE WHEN ? IS NOT NULL THEN 1 ELSE is_public END, updated_at = ?
			WHERE id = ? AND created_by = ?
		`).run(token, token, now, id, userId);
		if ((result as { changes: number }).changes === 0) return null;
		return this.getById(id);
	}
};
