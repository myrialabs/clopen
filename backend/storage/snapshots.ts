/**
 * Checkpoint blobs: `snapshots/blobs/<2-char prefix>/<sha>.gz`, content-addressed
 * and shared by every chat that saw the same file content.
 *
 * A blob is in use when a snapshot row's `session_changes` names it or a live
 * session baseline holds it — the same two sources chat deletion has always
 * checked. Anything else on disk is an orphan (a crash between writing a blob and
 * its row, or a baseline from a process that has since restarted).
 *
 * Attribution: a blob only one project's snapshots name is that project's; a
 * blob several projects name is counted as shared, because deleting any one of
 * those projects would not free it.
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';
import { getClopenDir } from '$backend/utils/paths';
import { getDatabase } from '$backend/database';
import { snapshotQueries } from '$backend/database/queries';
import { snapshotService } from '$backend/snapshot/snapshot-service';
import { blobStore } from '$backend/snapshot/blob-store';
import { allocatedBytes } from './fs-size';
import { yieldToEventLoop } from './fs-size';

const blobsDir = () => join(getClopenDir(), 'snapshots', 'blobs');

/** Every blob on disk and the bytes it occupies. */
export async function blobSizes(signal?: AbortSignal): Promise<Map<string, number>> {
	const sizes = new Map<string, number>();
	let prefixes: string[];
	try {
		prefixes = await fs.readdir(blobsDir());
	} catch {
		return sizes;
	}
	for (const prefix of prefixes) {
		if (signal?.aborted) break;
		const dir = join(blobsDir(), prefix);
		let files: string[];
		try {
			files = await fs.readdir(dir);
		} catch {
			continue;
		}
		const stats = await Promise.all(files.filter(f => f.endsWith('.gz')).map(file =>
			fs.lstat(join(dir, file)).then(stat => ({ hash: file.slice(0, -3), bytes: allocatedBytes(stat) }), () => null)
		));
		for (const item of stats) if (item) sizes.set(item.hash, item.bytes);
	}
	return sizes;
}

function hashesOf(sessionChanges: string | null, into: Set<string>): void {
	if (!sessionChanges) return;
	try {
		const changes = JSON.parse(sessionChanges) as Record<string, { oldHash?: string; newHash?: string }>;
		for (const change of Object.values(changes)) {
			if (change.oldHash) into.add(change.oldHash);
			if (change.newHash) into.add(change.newHash);
		}
	} catch { /* malformed row — names nothing */ }
}

/** Which project's snapshots name each blob. Read a project at a time. */
export async function blobOwners(): Promise<Map<string, Set<string>>> {
	const db = getDatabase();
	const projects = db.prepare('SELECT DISTINCT project_id FROM message_snapshots').all() as { project_id: string }[];
	const owners = new Map<string, Set<string>>();
	const select = db.prepare('SELECT session_changes FROM message_snapshots WHERE project_id = ? AND session_changes IS NOT NULL');
	for (const { project_id } of projects) {
		const hashes = new Set<string>();
		for (const row of select.all(project_id) as { session_changes: string }[]) hashesOf(row.session_changes, hashes);
		for (const hash of hashes) {
			let set = owners.get(hash);
			if (!set) owners.set(hash, set = new Set());
			set.add(project_id);
		}
		await yieldToEventLoop();
	}
	return owners;
}

/** Blobs on disk nothing refers to. */
export function orphanBlobs(sizes: Map<string, number>): { hashes: string[]; bytes: number } {
	const referenced = snapshotQueries.getAllReferencedBlobHashes();
	const live = snapshotService.getAllBaselineHashes();
	const hashes: string[] = [];
	let bytes = 0;
	for (const [hash, size] of sizes) {
		if (referenced.has(hash) || live.has(hash)) continue;
		hashes.push(hash);
		bytes += size;
	}
	return { hashes, bytes };
}

export async function deleteBlobs(hashes: string[]): Promise<number> {
	return hashes.length > 0 ? blobStore.deleteBlobs(hashes) : 0;
}
