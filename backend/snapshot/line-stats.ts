/**
 * The production `LineStatsSource`: every pair of blobs is counted once.
 *
 * Blobs are content-addressed, so the +/- count of (oldHash, newHash) is a
 * fact that never changes. It used to be recomputed on every chat open, every
 * reconnect and every pending-changes poll — twice per request, once for the
 * turn list and once for the net total — and a single large file made each of
 * those block the server. Now the first caller computes it and every later
 * one, on any surface, reads the same row (migration 087).
 *
 * The count itself is `countPairFromBlobs`; this module only remembers it.
 */

import { blobLineStatsQueries } from '../database/queries/blob-line-stats-queries';
import { blobStore } from './blob-store';
import { countPairFromBlobs } from './turn-changes';
import type { LineStatsSource, PairLineStats } from './turn-changes';
import { debug } from '$shared/utils/logger';

/** Pairs being counted right now, so concurrent callers share one computation. */
const inFlight = new Map<string, Promise<PairLineStats>>();

const readBlob = (hash: string) => blobStore.readBlob(hash);

/** Whether both sides of a pair can still be read — the diff view needs them. */
async function contentAvailable(oldHash: string, newHash: string): Promise<boolean> {
	const [hasOld, hasNew] = await Promise.all([
		oldHash ? blobStore.hasBlob(oldHash) : true,
		newHash ? blobStore.hasBlob(newHash) : true
	]);
	return hasOld && hasNew;
}

async function computeAndRemember(oldHash: string, newHash: string): Promise<PairLineStats> {
	const stats = await countPairFromBlobs(oldHash, newHash, readBlob);
	// A missing blob yields a non-answer, not a count — never store it.
	if (stats.contentAvailable) {
		try {
			blobLineStatsQueries.save(oldHash, newHash, stats);
		} catch (error) {
			debug.warn('snapshot', 'Failed to cache line stats:', error);
		}
	}
	return stats;
}

export const blobLineStats: LineStatsSource = async (oldHash, newHash) => {
	try {
		const cached = blobLineStatsQueries.get(oldHash, newHash);
		if (cached) {
			return { ...cached, contentAvailable: await contentAvailable(oldHash, newHash) };
		}
	} catch (error) {
		debug.warn('snapshot', 'Failed to read cached line stats:', error);
	}

	const key = `${oldHash}:${newHash}`;
	const pending = inFlight.get(key);
	if (pending) return pending;

	const computation = computeAndRemember(oldHash, newHash).finally(() => inFlight.delete(key));
	inFlight.set(key, computation);
	return computation;
};
