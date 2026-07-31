import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create messages_fts (FTS5) index for fast global session content search with snippets';

/**
 * Minimal inline text extraction, mirroring extractMessageText from
 * backend/snapshot/helpers.ts. Duplicated (not imported) so this migration
 * stays runnable standalone and isn't coupled to app code that may change
 * later — the same convention 029_migrate_messages_to_unified.ts uses.
 */
function extractSearchableText(msg: Record<string, unknown>): string {
	if (msg.type === 'reasoning') return (msg.text as string) || '';
	if (msg.type === 'compact_boundary') return '';
	const content = msg.content;
	if (!Array.isArray(content)) return '';
	return (content as Record<string, unknown>[])
		.filter(b => b.type === 'text' && b.text)
		.map(b => b.text as string)
		.join('\n');
}

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating messages_fts virtual table...');

	// project_id/session_id are UNINDEXED (used only to filter/join) — only
	// `text` participates in the FTS index. Kept as our own standalone table
	// (not `content=messages`) since indexed text is derived from JSON, not a
	// plain column.
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
			message_id UNINDEXED,
			session_id UNINDEXED,
			project_id UNINDEXED,
			text
		)
	`);

	debug.log('migration', 'Backfilling messages_fts from existing messages...');

	const rows = db.prepare(`
		SELECT m.id, m.session_id, m.data, cs.project_id
		FROM messages m
		INNER JOIN chat_sessions cs ON cs.id = m.session_id
	`).all() as { id: string; session_id: string; data: string; project_id: string }[];

	const insert = db.prepare(`
		INSERT INTO messages_fts (message_id, session_id, project_id, text)
		VALUES (?, ?, ?, ?)
	`);

	let indexed = 0;
	for (const row of rows) {
		try {
			const msg = JSON.parse(row.data) as Record<string, unknown>;
			const text = extractSearchableText(msg).trim();
			if (!text) continue;
			insert.run(row.id, row.session_id, row.project_id, text);
			indexed++;
		} catch {
			// Skip unparsable rows — same tolerance as other backfills in this file set.
		}
	}

	debug.log('migration', `messages_fts backfilled: ${indexed}/${rows.length} messages indexed`);
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping messages_fts virtual table...');
	db.exec(`DROP TABLE IF EXISTS messages_fts`);
};
