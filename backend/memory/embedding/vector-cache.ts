/**
 * The vector index, resident.
 *
 * Retrieval brute-forces cosine over every candidate vector, and that part is
 * genuinely cheap: 256 int8 multiply-adds is nothing, and even a hundred
 * thousand of them is a few milliseconds. What is NOT cheap is getting the
 * vectors out of SQLite. Reading twenty thousand rows of BLOB per query means
 * five megabytes copied out of the page cache, allocated as Uint8Arrays and
 * handed to the GC — on EVERY turn, because injection retrieves on every turn.
 * At a hundred thousand memories that read dominates the query by an order of
 * magnitude over the arithmetic it feeds.
 *
 * So the vectors live here instead, in one contiguous buffer with a fixed
 * stride, and SQLite is asked only for CANDIDATE IDS — an index-covered scan
 * over columns, no blobs. The database stays the source of truth for which nodes
 * exist and which filters they pass; this is only the arithmetic surface.
 *
 * ── what happens when it is wrong ──
 * A cache of derived data is a correctness risk exactly in proportion to how
 * hard it is to notice it drifting, so this one is built so that drift cannot
 * produce a wrong answer:
 *
 *   - A node the cache has never heard of is scored from the database instead
 *     (`scoreMissing`), so a cold or partial cache degrades in latency, never in
 *     results.
 *   - A node the cache still holds after its row is gone is never ASKED about,
 *     because candidate ids come from SQL. It wastes a slot until the next
 *     rebuild; it cannot be returned.
 *   - `reset()` is called by every path that removes rows in bulk.
 *
 * ── when it declines ──
 * Above `MAX_CACHED` vectors the resident cost stops being obviously worth it
 * (65 MB at 250k × 260 bytes), so the cache refuses to load and retrieval falls
 * back to streaming from SQLite. That is a slower query on a graph far larger
 * than anything this feature is expected to reach, rather than an instance that
 * runs out of memory in the background.
 */

import { getDatabase } from '$backend/database';
import { debug } from '$shared/utils/logger';
import { cosineToPacked } from './embedder';
import { EMBEDDING_VERSION } from './paths';

/**
 * Ceiling on resident vectors. 250k × 260 bytes ≈ 65 MB — past the point where a
 * background index should be quietly holding memory on a small VPS.
 */
const MAX_CACHED = 250_000;

/** Vectors read per statement when scoring ids the cache does not hold. */
const MISSING_BATCH = 500;

class VectorCache {
	private data: Uint8Array | null = null;
	private slots = new Map<string, number>();
	private free: number[] = [];
	private used = 0;
	private stride = 0;
	private loaded = false;
	private refused = false;

	get ready(): boolean {
		return this.loaded && this.data !== null;
	}

	get size(): number {
		return this.slots.size;
	}

	/**
	 * Load every vector for the current artifact version, once.
	 *
	 * Returns false when there is nothing to cache or the corpus is past the
	 * ceiling — callers treat that as "score from the database" rather than as an
	 * error.
	 */
	ensure(): boolean {
		if (this.loaded) return this.data !== null;
		if (this.refused) return false;

		try {
			const db = getDatabase();
			const count = (
				db.prepare(`SELECT COUNT(*) AS c FROM graph_vectors WHERE model = ?`).get(EMBEDDING_VERSION) as {
					c: number;
				}
			).c;
			if (count === 0) {
				// Nothing to hold yet. Not marked loaded, so the first indexed vector
				// brings the cache up on the next query.
				return false;
			}
			if (count > MAX_CACHED) {
				this.refused = true;
				debug.log('memory', `Vector cache declined: ${count} vectors exceeds the ${MAX_CACHED} ceiling`);
				return false;
			}

			const rows = db
				.prepare(`SELECT node_id AS id, vec FROM graph_vectors WHERE model = ?`)
				.all(EMBEDDING_VERSION) as { id: string; vec: Uint8Array }[];
			if (rows.length === 0) return false;

			// Headroom so a growing graph does not reallocate on every write.
			this.stride = rows[0].vec.length;
			const capacity = Math.min(MAX_CACHED, Math.max(rows.length * 2, 1024));
			this.data = new Uint8Array(capacity * this.stride);
			this.slots.clear();
			this.free = [];
			this.used = 0;

			for (const row of rows) {
				if (row.vec.length !== this.stride) continue;
				this.write(row.id, row.vec);
			}

			this.loaded = true;
			debug.log(
				'memory',
				`Vector cache resident: ${this.slots.size} vector(s), ${((this.slots.size * this.stride) / 1e6).toFixed(1)} MB`
			);
			return true;
		} catch (error) {
			debug.warn('memory', 'Vector cache load failed; scoring from the database', error);
			this.data = null;
			this.loaded = false;
			return false;
		}
	}

	/** Store or replace one node's vector. Silently ignored before the cache loads. */
	set(nodeId: string, packed: Uint8Array): void {
		if (!this.loaded || !this.data) return;
		if (this.stride === 0) this.stride = packed.length;
		if (packed.length !== this.stride) return;
		this.write(nodeId, packed);
	}

	/** Forget specific nodes — an edit dropped their vector, or they were deleted. */
	drop(nodeIds: string[]): void {
		if (!this.loaded) return;
		for (const id of nodeIds) {
			const slot = this.slots.get(id);
			if (slot === undefined) continue;
			this.slots.delete(id);
			this.free.push(slot);
		}
	}

	/**
	 * Throw the whole thing away.
	 *
	 * Called by every bulk removal — purge, batch delete, a model change that
	 * invalidates the index. Rebuilding is one sequential read; reconciling would
	 * be a second implementation of the same truth.
	 */
	reset(): void {
		this.data = null;
		this.slots.clear();
		this.free = [];
		this.used = 0;
		this.loaded = false;
		this.refused = false;
	}

	/**
	 * Score `ids` against `query`, best first.
	 *
	 * Ids the cache does not hold are scored from the database in batches, so a
	 * result set is never silently short. `minScore` filters during the scan
	 * rather than after it — at a hundred thousand candidates the array the caller
	 * would otherwise sort is most of the corpus.
	 */
	score(query: Float32Array, ids: string[], minScore = 0): { id: string; score: number }[] {
		const scored: { id: string; score: number }[] = [];
		const missing: string[] = [];

		if (this.loaded && this.data) {
			for (const id of ids) {
				const slot = this.slots.get(id);
				if (slot === undefined) {
					missing.push(id);
					continue;
				}
				const offset = slot * this.stride;
				const packed = this.data.subarray(offset, offset + this.stride);
				const score = cosineToPacked(query, packed);
				if (score > minScore) scored.push({ id, score });
			}
		} else {
			missing.push(...ids);
		}

		if (missing.length > 0) scored.push(...this.scoreMissing(query, missing, minScore));

		scored.sort((a, b) => b.score - a.score);
		return scored;
	}

	/** One node's packed vector, from wherever it is. */
	get(nodeId: string): Uint8Array | null {
		if (this.loaded && this.data) {
			const slot = this.slots.get(nodeId);
			if (slot !== undefined) {
				const offset = slot * this.stride;
				return this.data.subarray(offset, offset + this.stride);
			}
		}
		try {
			const row = getDatabase()
				.prepare(`SELECT vec FROM graph_vectors WHERE node_id = ? AND model = ?`)
				.get(nodeId, EMBEDDING_VERSION) as { vec: Uint8Array } | null;
			return row?.vec ?? null;
		} catch {
			return null;
		}
	}

	private scoreMissing(query: Float32Array, ids: string[], minScore: number): { id: string; score: number }[] {
		const out: { id: string; score: number }[] = [];
		try {
			const db = getDatabase();
			for (let i = 0; i < ids.length; i += MISSING_BATCH) {
				const chunk = ids.slice(i, i + MISSING_BATCH);
				const placeholders = chunk.map(() => '?').join(',');
				const rows = db
					.prepare(
						`SELECT node_id AS id, vec FROM graph_vectors
						 WHERE model = ? AND node_id IN (${placeholders})`
					)
					.all(EMBEDDING_VERSION, ...chunk) as { id: string; vec: Uint8Array }[];
				for (const row of rows) {
					const score = cosineToPacked(query, row.vec);
					if (score > minScore) out.push({ id: row.id, score });
				}
			}
		} catch (error) {
			debug.warn('memory', 'Vector fallback scoring failed', error);
		}
		return out;
	}

	private write(nodeId: string, packed: Uint8Array): void {
		if (!this.data) return;

		let slot = this.slots.get(nodeId);
		if (slot === undefined) {
			slot = this.free.pop();
			if (slot === undefined) {
				const capacity = this.data.length / this.stride;
				if (this.used >= capacity) {
					if (capacity * 2 > MAX_CACHED) {
						// Past the ceiling mid-flight. Drop the cache rather than growing
						// past what it promised to hold; the next query rebuilds or declines.
						this.reset();
						return;
					}
					const grown = new Uint8Array(this.data.length * 2);
					grown.set(this.data);
					this.data = grown;
				}
				slot = this.used++;
			}
			this.slots.set(nodeId, slot);
		}
		this.data.set(packed, slot * this.stride);
	}
}

export const vectorCache = new VectorCache();
