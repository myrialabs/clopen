/**
 * Vector indexer.
 *
 * Nodes are written the moment they are extracted, but their vectors are filled
 * in behind the write. That separation is deliberate: the embedding artifact
 * installs on demand, so a node created in the first minutes of a fresh install
 * must not have to wait for a 41 MB download to exist. Until vectors land,
 * retrieval runs on BM25 and graph traversal, and the same node becomes
 * semantically searchable later without being rewritten.
 *
 * Work is drained in small batches on a timer rather than per-node so a busy turn
 * that touches forty files does not turn into forty separate passes.
 */

import { graphQueries } from '$backend/database/queries/graph-queries';
import { debug } from '$shared/utils/logger';
import { embedder, packVector, vectorCache } from './embedding';
import { EMBEDDING_VERSION } from './embedding/paths';
import { notifyGraphChanged } from './notify';

/** Nodes embedded per drain. ~0.05 ms each, so a batch is a fraction of a millisecond. */
const BATCH_SIZE = 200;

/** Delay before a drain, so a burst of writes coalesces into one pass. */
const DEBOUNCE_MS = 400;

/**
 * Fewest tokens a node must have to earn a vector.
 *
 * Measured against this artifact: real memories tokenize to 12–30 tokens and
 * path-rich file nodes to ~20, while a bare `index.ts` is 8 and a stray
 * two-token label is 2. Below roughly ten tokens the mean-pooled vector stops
 * describing meaning and starts scoring highly against everything, which is how
 * a filename ends up outranking the decision someone actually asked about.
 *
 * Excluded nodes are still fully searchable — a filename or symbol is what BM25
 * is best at, so nothing is lost by keeping them out of the vector channel.
 */
const MIN_TOKENS_FOR_VECTOR = 10;

let timer: ReturnType<typeof setTimeout> | null = null;
let draining = false;
/** A write arrived mid-drain and still needs a pass. See `scheduleVectorIndexing`. */
let dirty = false;

/**
 * Ask for a drain soon. Cheap and idempotent — call it after any write that adds
 * or changes node text.
 *
 * A request that arrives while a drain is already running is REMEMBERED rather
 * than dropped. Returning early there looks harmless and is not: the running
 * drain has already taken its batch, so a node written a moment later is not in
 * it, nothing is scheduled, and that node stays unvectorized until some
 * unrelated write happens to schedule the next pass — or until a restart. The
 * symptom is a memory that is lexically findable and semantically invisible,
 * which is indistinguishable from the ranker simply not rating it.
 */
export function scheduleVectorIndexing(): void {
	if (draining) {
		dirty = true;
		return;
	}
	if (timer) return;
	timer = setTimeout(() => {
		timer = null;
		void drain();
	}, DEBOUNCE_MS);
}

/**
 * Embed nodes that have no vector for the current artifact version. Returns how
 * many were written. Safe to call directly; concurrent calls collapse into one.
 */
export async function drain(): Promise<number> {
	if (draining) return 0;
	if (!embedder.ready && !(await embedder.load())) return 0;

	draining = true;
	dirty = false;
	let written = 0;
	try {
		// Loop so a large backlog (a freshly installed artifact facing an existing
		// graph) is cleared without waiting for a drain per batch.
		for (;;) {
			const pending = graphQueries.nodesMissingVectors(EMBEDDING_VERSION, BATCH_SIZE);
			if (pending.length === 0) break;

			const vectorized: typeof pending = [];
			for (const node of pending) {
				const vec = embedder.embed(graphQueries.embeddableText(node), {
					minTokens: MIN_TOKENS_FOR_VECTOR
				});
				if (!vec) {
					// Too short to embed meaningfully (or entirely out-of-vocabulary).
					// Store a zero vector: it records that this node was considered, so it
					// is not re-picked on every drain forever, and it scores 0 in
					// similarity so it never competes. The node stays fully reachable
					// through BM25 and the graph.
					const zero = packVector(new Float32Array(embedder.dim ?? 0));
					graphQueries.setVector(node.id, embedder.dim ?? 0, EMBEDDING_VERSION, zero);
					vectorCache.set(node.id, zero);
					continue;
				}
				const packed = packVector(vec);
				graphQueries.setVector(node.id, vec.length, EMBEDDING_VERSION, packed);
				vectorCache.set(node.id, packed);
				vectorized.push(node);
				written++;
			}

			if (pending.length < BATCH_SIZE) break;
			// Yield between batches so a big backfill cannot monopolise the loop.
			await new Promise(resolve => setTimeout(resolve, 0));
		}

	} catch (error) {
		debug.error('memory', 'Vector indexing failed', error);
	} finally {
		draining = false;
	}

	if (written > 0) {
		debug.log('memory', `Indexed ${written} memory vector(s)`);
		notifyGraphChanged('links');
	}

	// A write that landed while this pass was running still needs one.
	if (dirty) {
		dirty = false;
		scheduleVectorIndexing();
	}
	return written;
}

/**
 * Bring the vector index in line with the installed artifact, then backfill.
 * Called once the artifact is known to be ready.
 *
 * Vectors from a different artifact version are deleted rather than kept:
 * cosine between two different embedding spaces is meaningless, and mixing them
 * would silently corrupt ranking in a way that is very hard to notice.
 */
export async function reconcileVectorIndex(): Promise<void> {
	const removed = graphQueries.pruneVectorsForOtherModels(EMBEDDING_VERSION);
	if (removed > 0) {
		debug.log('memory', `Dropped ${removed} vector(s) from a previous embedding artifact`);
	}
	vectorCache.reset();
	await drain();
}
