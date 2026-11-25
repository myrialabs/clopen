import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description =
	'Add storage bookkeeping: per-session size index, engine transcript aliases, cleanup history, slimmed chats';

/**
 * What Settings → Storage needs to know without re-reading the message table.
 *
 * `storage_session_index` — one row per chat: the bytes its messages take and the
 * engine session ids they reference. Measuring that is a read of every row of a
 * table that reaches gigabytes, so it is done once per chat and redone only when
 * the chat's `message_count` or `last_message_at` moved. Empty here on purpose:
 * filling it in a migration would hold startup for as long as the scan takes.
 * The storage scanner builds it in the background, a chat at a time.
 *
 * `engine_transcript_aliases` — a deduplicated engine transcript. Claude forks
 * every turn into a new file that repeats the whole conversation; once a later
 * fork holds every entry of an earlier one, the earlier file is redundant. It is
 * removed and remembered here as "resume `target_session_id` cut at `resume_at`",
 * which is the same conversation state.
 *
 * `storage_cleanup_runs` — what each manual or automatic cleanup removed.
 *
 * `chat_sessions.slimmed_at` — the chat was slimmed: its heavy payloads, file
 * checkpoints and engine transcripts are gone, its conversation is kept.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating storage tables...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS storage_session_index (
			session_id       TEXT    PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
			bytes            INTEGER NOT NULL DEFAULT 0,
			engine_refs      TEXT    NOT NULL DEFAULT '[]',
			message_count    INTEGER NOT NULL DEFAULT 0,
			last_message_at  TEXT,
			measured_at      TEXT    NOT NULL
		) WITHOUT ROWID
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS engine_transcript_aliases (
			engine             TEXT NOT NULL,
			session_id         TEXT NOT NULL,
			target_session_id  TEXT NOT NULL,
			resume_at          TEXT NOT NULL,
			created_at         TEXT NOT NULL,
			PRIMARY KEY (engine, session_id)
		) WITHOUT ROWID
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_engine_transcript_aliases_target ON engine_transcript_aliases (engine, target_session_id)`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS storage_cleanup_runs (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			action       TEXT    NOT NULL,
			trigger      TEXT    NOT NULL,
			started_at   TEXT    NOT NULL,
			finished_at  TEXT,
			freed_bytes  INTEGER NOT NULL DEFAULT 0,
			items        INTEGER NOT NULL DEFAULT 0,
			error        TEXT
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_storage_cleanup_runs_started ON storage_cleanup_runs (started_at)`);

	const columns = db.prepare(`PRAGMA table_info(chat_sessions)`).all() as { name: string }[];
	if (!columns.some(column => column.name === 'slimmed_at')) {
		db.exec(`ALTER TABLE chat_sessions ADD COLUMN slimmed_at TEXT`);
	}

	debug.log('migration', 'Storage tables ready');
};

export const down = (db: DatabaseConnection): void => {
	db.exec(`DROP INDEX IF EXISTS idx_storage_cleanup_runs_started`);
	db.exec(`DROP TABLE IF EXISTS storage_cleanup_runs`);
	db.exec(`DROP INDEX IF EXISTS idx_engine_transcript_aliases_target`);
	db.exec(`DROP TABLE IF EXISTS engine_transcript_aliases`);
	db.exec(`DROP TABLE IF EXISTS storage_session_index`);
	db.exec(`ALTER TABLE chat_sessions DROP COLUMN slimmed_at`);
};
