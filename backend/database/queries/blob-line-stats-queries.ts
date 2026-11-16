/**
 * Cached +/- line counts per pair of snapshot blobs (see migration 087).
 *
 * Keyed by content hashes, so a row is true forever: the only writes are the
 * first computation of a pair and the prune that follows its blobs out.
 */

import { getDatabase } from '../index';

export interface BlobLineStatsRow {
	insertions: number;
	deletions: number;
	isBinary: boolean;
}

export const blobLineStatsQueries = {
	get(oldHash: string, newHash: string): BlobLineStatsRow | null {
		const row = getDatabase()
			.prepare('SELECT insertions, deletions, is_binary FROM blob_line_stats WHERE old_hash = ? AND new_hash = ?')
			.get(oldHash, newHash) as { insertions: number; deletions: number; is_binary: number } | null;
		return row ? { insertions: row.insertions, deletions: row.deletions, isBinary: row.is_binary === 1 } : null;
	},

	save(oldHash: string, newHash: string, stats: BlobLineStatsRow): void {
		getDatabase()
			.prepare(`
				INSERT OR IGNORE INTO blob_line_stats (old_hash, new_hash, insertions, deletions, is_binary)
				VALUES (?, ?, ?, ?, ?)
			`)
			.run(oldHash, newHash, stats.insertions, stats.deletions, stats.isBinary ? 1 : 0);
	},

	/** Drop every pair that names one of these blobs — they are gone from the store. */
	deleteByHashes(hashes: string[]): void {
		const db = getDatabase();
		const byOld = db.prepare('DELETE FROM blob_line_stats WHERE old_hash = ?');
		const byNew = db.prepare('DELETE FROM blob_line_stats WHERE new_hash = ?');
		const prune = () => {
			for (const hash of hashes) {
				if (!hash) continue;
				byOld.run(hash);
				byNew.run(hash);
			}
		};
		if (db.transaction) db.transaction(prune)();
		else prune();
	}
};
