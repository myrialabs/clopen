import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create blob_line_stats to count each pair of file versions once';

/**
 * The +/- line counts of one pair of snapshot blobs.
 *
 * Blobs are content-addressed (sha256), so the count for a given
 * (old_hash, new_hash) can never change — it is computed the first time any
 * surface asks and read from here ever after. Every chat open used to re-diff
 * every changed file of every turn, twice; on a chat that touched a large
 * generated file that recomputation alone could block the server for minutes.
 *
 * An empty hash is a side that does not exist (a created or deleted file).
 * Rows are pruned together with the blobs they describe.
 */
export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating blob_line_stats table...');
	db.exec(`
		CREATE TABLE IF NOT EXISTS blob_line_stats (
			old_hash    TEXT NOT NULL,
			new_hash    TEXT NOT NULL,
			insertions  INTEGER NOT NULL,
			deletions   INTEGER NOT NULL,
			is_binary   INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (old_hash, new_hash)
		) WITHOUT ROWID
	`);
	db.exec('CREATE INDEX IF NOT EXISTS idx_blob_line_stats_new_hash ON blob_line_stats (new_hash)');
	debug.log('migration', '✅ blob_line_stats table created');
};

export const down = (db: DatabaseConnection): void => {
	db.exec('DROP INDEX IF EXISTS idx_blob_line_stats_new_hash');
	db.exec('DROP TABLE IF EXISTS blob_line_stats');
};
