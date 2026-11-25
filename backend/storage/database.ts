/**
 * Returning the database's free pages to the disk.
 *
 * SQLite never shrinks its file on its own: deleting or slimming chats leaves
 * the freed pages inside `app.db` for reuse. Two ways to give them back:
 *
 *   - VACUUM rebuilds the whole file. It holds the database for as long as that
 *     takes (about a minute per few gigabytes) and needs free disk space about the
 *     size of the database while it runs. Clopen answers nothing that touches the
 *     database in the meantime.
 *   - With `auto_vacuum = INCREMENTAL`, `PRAGMA incremental_vacuum(N)` releases N
 *     free pages at a time — milliseconds per batch, so it can run between other
 *     work. The mode can only be switched on by a VACUUM.
 *
 * So the first compaction is a VACUUM that also switches the mode on, and every
 * later one is incremental. Both refuse to start while a chat is streaming.
 */

import { statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getDatabase } from '$backend/database';
import { DatabaseManager } from '$backend/database/utils/connection';
import { debug } from '$shared/utils/logger';
import { yieldToEventLoop } from './fs-size';

const INCREMENTAL = 2;
const PAGES_PER_STEP = 2_000;

function pragma(name: string): number {
	const row = getDatabase().prepare(`PRAGMA ${name}`).get() as Record<string, number> | null;
	return row ? Number(Object.values(row)[0]) : 0;
}

export function databasePath(): string {
	return DatabaseManager.getInstance().getPath();
}

export function databaseStats(): { fileBytes: number; freeBytes: number; incrementalVacuum: boolean } {
	const path = databasePath();
	let fileBytes = 0;
	for (const suffix of ['', '-wal', '-shm']) {
		try {
			fileBytes += statSync(path + suffix).size;
		} catch { /* absent */ }
	}
	return {
		fileBytes,
		freeBytes: pragma('freelist_count') * pragma('page_size'),
		incrementalVacuum: pragma('auto_vacuum') === INCREMENTAL
	};
}

export async function freeDiskBytes(path: string): Promise<number | null> {
	try {
		const stats = await statfs(dirname(path));
		return Number(stats.bavail) * Number(stats.bsize);
	} catch {
		return null;
	}
}

export interface CompactResult {
	freedBytes: number;
	mode: 'vacuum' | 'incremental';
}

/** Give free pages back. Throws with a readable reason when it cannot run. */
export async function compactDatabase(isBusy: () => boolean): Promise<CompactResult> {
	if (isBusy()) throw new Error('A chat is running. Compacting waits until nothing is streaming.');
	const db = getDatabase();
	const before = databaseStats();

	if (!before.incrementalVacuum) {
		const free = await freeDiskBytes(databasePath());
		if (free !== null && free < before.fileBytes * 1.1) {
			throw new Error('Not enough free disk space to rebuild the database (it needs about its own size).');
		}
		debug.log('storage', 'Rebuilding the database and switching on incremental vacuum');
		db.exec(`PRAGMA auto_vacuum = INCREMENTAL`);
		db.exec('VACUUM');
		db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		const after = databaseStats();
		return { freedBytes: Math.max(0, before.fileBytes - after.fileBytes), mode: 'vacuum' };
	}

	while (pragma('freelist_count') > 0) {
		if (isBusy()) break;
		db.exec(`PRAGMA incremental_vacuum(${PAGES_PER_STEP})`);
		await yieldToEventLoop();
	}
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	const after = databaseStats();
	return { freedBytes: Math.max(0, before.fileBytes - after.fileBytes), mode: 'incremental' };
}

/** Release free pages when that is cheap (incremental mode). A no-op otherwise. */
export async function releaseFreePagesIfCheap(isBusy: () => boolean): Promise<number> {
	if (!databaseStats().incrementalVacuum) return 0;
	try {
		return (await compactDatabase(isBusy)).freedBytes;
	} catch {
		return 0;
	}
}
