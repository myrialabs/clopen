import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Map each message to its messages_fts row so saves stop scanning the whole index';

/**
 * Which `messages_fts` row holds a message's text.
 *
 * `messages_fts.message_id` is an UNINDEXED FTS5 column: FTS5 cannot look a
 * row up by it, so `DELETE FROM messages_fts WHERE message_id = ?` walked the
 * entire index. Every message save ran that delete first, on the server's only
 * thread — measured on a 4 GB database (165k indexed messages) at up to 1.8 s
 * per save, 3–5 saves per turn, which stalled every panel, terminal and preview
 * request while any chat was streaming. Deleting by `rowid` is a direct lookup.
 *
 * A separate narrow table rather than a column on `messages`: adding a column
 * to `messages` and filling it rewrites every row, which on the same database
 * took 31 s at startup; filling this table takes under 2 s. `session_id` is
 * kept here so a whole session's or project's rows can be found without
 * depending on the order `messages` rows are deleted in.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating messages_fts_map...');
	db.exec(`
		CREATE TABLE IF NOT EXISTS messages_fts_map (
			message_id  TEXT PRIMARY KEY,
			session_id  TEXT NOT NULL,
			fts_rowid   INTEGER NOT NULL
		) WITHOUT ROWID
	`);
	db.exec('CREATE INDEX IF NOT EXISTS idx_messages_fts_map_session ON messages_fts_map (session_id)');

	// One pass over the index. If a message somehow has more than one row, the
	// newest (highest rowid) wins and the others are dropped below.
	db.exec(`
		INSERT OR REPLACE INTO messages_fts_map (message_id, session_id, fts_rowid)
		SELECT message_id, session_id, rowid FROM messages_fts ORDER BY rowid
	`);

	// Rows the map does not point at (duplicates), and rows whose message no
	// longer exists, were never reachable by a delete before; drop them now.
	db.exec('DELETE FROM messages_fts_map WHERE message_id NOT IN (SELECT id FROM messages)');
	db.exec('DELETE FROM messages_fts WHERE rowid NOT IN (SELECT fts_rowid FROM messages_fts_map)');

	const { count } = db.prepare('SELECT COUNT(*) AS count FROM messages_fts_map').get() as { count: number };
	debug.log('migration', `✅ messages_fts_map created for ${count} messages`);
};

export const down = (db: DatabaseConnection): void => {
	db.exec('DROP INDEX IF EXISTS idx_messages_fts_map_session');
	db.exec('DROP TABLE IF EXISTS messages_fts_map');
};
