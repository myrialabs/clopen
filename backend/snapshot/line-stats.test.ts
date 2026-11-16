/**
 * Counting each pair of blobs once.
 *
 * A chat open used to re-diff every changed file of every turn, and a single
 * large file made that block the server for minutes. The pair's count is a
 * fact about two content hashes, so it is computed on first use and read back
 * from then on — and dropped when the blobs it describes are deleted.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { initializeDatabase } from '../database';
import { blobLineStatsQueries } from '../database/queries/blob-line-stats-queries';
import { blobStore } from './blob-store';
import { blobLineStats } from './line-stats';

/** Fresh content per test, so its hashes are not shared with any other run. */
async function storePair(oldText: string, newText: string) {
	const salt = randomUUID();
	const oldHash = await blobStore.storeBlob(Buffer.from(`${salt}\n${oldText}`, 'utf8'));
	const newHash = await blobStore.storeBlob(Buffer.from(`${salt}\n${newText}`, 'utf8'));
	return { oldHash, newHash };
}

beforeAll(async () => {
	await initializeDatabase();
});

describe('blobLineStats', () => {
	it('counts a pair on first use and remembers it', async () => {
		const { oldHash, newHash } = await storePair('a\nb\nc\n', 'a\nB\nc\nd\n');

		expect(blobLineStatsQueries.get(oldHash, newHash)).toBeNull();

		const first = await blobLineStats(oldHash, newHash);
		expect(first).toEqual({ insertions: 2, deletions: 1, isBinary: false, contentAvailable: true });
		expect(blobLineStatsQueries.get(oldHash, newHash)).toEqual({ insertions: 2, deletions: 1, isBinary: false });

		expect(await blobLineStats(oldHash, newHash)).toEqual(first);
	});

	it('counts a created file against an empty side', async () => {
		const { newHash } = await storePair('', 'one\ntwo\n');

		// The salt line makes it three.
		expect(await blobLineStats('', newHash)).toEqual({
			insertions: 3,
			deletions: 0,
			isBinary: false,
			contentAvailable: true
		});
	});

	it('shares one computation between concurrent callers', async () => {
		const { oldHash, newHash } = await storePair('x\n', 'y\n');

		const [a, b] = await Promise.all([blobLineStats(oldHash, newHash), blobLineStats(oldHash, newHash)]);
		expect(a).toBe(b);
	});

	it('never stores a pair whose blob is missing', async () => {
		const { newHash } = await storePair('', 'x\n');
		const missing = 'f'.repeat(64);

		const stats = await blobLineStats(missing, newHash);
		expect(stats.contentAvailable).toBe(false);
		expect(blobLineStatsQueries.get(missing, newHash)).toBeNull();
	});

	it('drops the remembered count when its blobs are deleted', async () => {
		const { oldHash, newHash } = await storePair('a\n', 'b\n');
		await blobLineStats(oldHash, newHash);

		await blobStore.deleteBlobs([oldHash, newHash]);

		expect(blobLineStatsQueries.get(oldHash, newHash)).toBeNull();
		expect((await blobLineStats(oldHash, newHash)).contentAvailable).toBe(false);
	});
});
