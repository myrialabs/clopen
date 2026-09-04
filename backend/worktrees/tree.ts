/**
 * Hashing a tree into the Checkpoints blob store.
 *
 * Worktree merges are three-way, so the base content has to outlive the tree it
 * came from — the blobs are what make a merge base recoverable after both sides
 * have moved on.
 */

import fs from 'fs/promises';
import path from 'path';
import { blobStore, type TreeMap } from '../snapshot/blob-store';
import { getSnapshotFiles } from '../snapshot/gitignore';
import { debug } from '$shared/utils/logger';

/** Mirrors the snapshot service cap — larger files are never tracked. */
export const MAX_TRACKED_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Hash every snapshot-eligible file under `root`.
 * When `storeBlobs` is set, contents are written to the blob store so they can
 * be read back as a merge base later.
 */
export async function hashTree(root: string, storeBlobs = false): Promise<TreeMap> {
	if (storeBlobs) await blobStore.init();

	const files = await getSnapshotFiles(root);
	const tree: TreeMap = {};

	for (const absolute of files) {
		try {
			const stat = await fs.stat(absolute);
			if (stat.size > MAX_TRACKED_FILE_SIZE) continue;

			const relativePath = path.relative(root, absolute).replace(/\\/g, '/');
			const result = await blobStore.hashFile(relativePath, absolute);
			tree[relativePath] = result.hash;

			if (storeBlobs && !(await blobStore.hasBlob(result.hash))) {
				const content = result.content ?? (await fs.readFile(absolute));
				await blobStore.storeBlob(content);
			}
		} catch {
			// Unreadable file — leave it out of the tree
		}
	}

	debug.log('worktree', `Hashed ${Object.keys(tree).length} files under ${root}`);
	return tree;
}

/** Read a blob back as text, or null when it is missing or not decodable. */
export async function readBlobText(hash: string): Promise<string | null> {
	try {
		const buffer = await blobStore.readBlob(hash);
		return buffer.toString('utf-8');
	} catch {
		return null;
	}
}
