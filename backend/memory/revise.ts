/**
 * Belief revision: keeping the graph's opinion of itself up to date.
 *
 * Migration 066 gave memory a place to accumulate. Accumulation alone produces a
 * landfill — the decision made in March and the decision that reversed it in
 * August both sit there, both get retrieved, and the agent re-adjudicates them
 * on every single turn. The schema has carried `supersedes` and `contradicts`
 * since the beginning and nothing ever wrote one.
 *
 * The judgement is made by the model that is ALREADY summarising the turn. That
 * is the design constraint that makes this affordable: extraction is handed the
 * memories the graph already holds about this topic, with their ids, and returns
 * `supersedes` / `duplicateOf` alongside the new memories. No second model call,
 * and the adjudication is better informed than a separate pass would be, because
 * it happens with the transcript in view.
 *
 * Three mechanisms, applied in order of confidence:
 *
 *   1. **Exact identity** (`digest`) — the same claim, same words. Handled by
 *      the upsert in graph-queries; reinforces, never duplicates.
 *   2. **Semantic near-duplicate** (cosine, here) — the same claim, different
 *      words. This is the one that decides whether the graph is still usable
 *      after six months, because a model rephrases the same fact every time it
 *      sees it and exact identity catches none of that.
 *   3. **Contradiction** (the model, here) — a DIFFERENT claim about the same
 *      thing. Only a reader of the turn can tell this from a near-duplicate.
 */

import { entityKeyFor, graphQueries } from '$backend/database/queries/graph-queries';
import { getDatabase } from '$backend/database';
import { debug } from '$shared/utils/logger';
import { cosineToPacked, embedder, unpackVector } from './embedding';
import { EMBEDDING_VERSION } from './embedding/paths';
import { retrieve } from './retrieval';
import type { GraphNode, GraphScope, MemoryVerdict } from '$shared/types/memory';

/**
 * Cosine floor for CANDIDATE GENERATION — not for deciding anything.
 *
 * The threshold this replaces tried to answer "are these the same claim" with a
 * similarity score, and the measurements say no score can. Against the shipped
 * artifact, on labelled pairs:
 *
 *   same claim, reworded      0.63 – 0.77
 *   opposite claim            0.70 – 0.99
 *   different claim           0.11 – 0.92
 *
 * Every genuine duplicate scores BELOW the median opposite. "User prefers to use
 * the agent tool" against "…prefers not to use the agent tool" scores 0.9938,
 * because a mean-pooled static embedding has no representation for negation;
 * "Run bun run check after coding" against "Run bun run lint after coding" scores
 * 0.9202 while making two different claims. On the real graph the shipped 0.85
 * rule matched 2 pairs out of 5,356 — and one of those two was a wrong merge —
 * while five near-identical copies of "Arga is a full-stack developer" sat at
 * 0.76 and were kept, filling the recall budget for months.
 *
 * The same twelve pairs put to the extraction model: 11 of 12 correct on the
 * harder THREE-way question, against 6 of 12 for cosine on the easier two-way
 * one. So cosine keeps the job it is good at — pulling a handful of plausible
 * neighbours out of thousands — and the model, which is already being called to
 * summarise the turn, makes the call.
 */
const CANDIDATE_FLOOR = 0.6;

/** Existing memories shown to the extraction model for adjudication. */
const MAX_RELATED_SHOWN = 12;

/** Neighbours offered per new memory for the same/opposite/different decision. */
const MAX_CANDIDATES_PER_MEMORY = 5;

/** Candidate vectors scanned when looking for neighbours. */
const MAX_DUPLICATE_CANDIDATES = 4_000;

export interface RelatedMemory {
	id: string;
	subkind: string;
	scope: GraphScope;
	label: string;
	body: string;
}

/**
 * Memories the graph already holds that bear on this turn.
 *
 * Retrieved with the same engine agents use, against the transcript rather than
 * against a single message: the point is to surface anything the turn might
 * contradict, and a contradiction can be buried anywhere in it.
 */
export function gatherRelatedMemories(options: {
	transcript: string;
	projectId: string | null;
	sessionId: string | null;
}): RelatedMemory[] {
	// The tail carries the turn's conclusions, which is where a reversal lives.
	const query = options.transcript.slice(-4_000);

	const { hits } = retrieve({
		query,
		projectId: options.projectId,
		sessionId: options.sessionId ?? undefined,
		kinds: ['episodic'],
		limit: MAX_RELATED_SHOWN,
		expandHops: 0
	});

	return hits
		// A memory the graph is barely confident in is not worth asking the model to
		// adjudicate against, and every line shown costs prompt budget.
		.filter(hit => hit.node.confidence >= 0.25)
		.map(hit => ({
			id: hit.node.id,
			subkind: hit.node.subkind,
			scope: hit.node.scope,
			label: hit.node.label,
			body: hit.node.body.split('\n')[0].slice(0, 200)
		}));
}

/** Render the related memories for the extraction prompt. */
export function renderRelatedMemories(related: RelatedMemory[]): string {
	if (related.length === 0) return '- (nothing related is stored yet)';
	return related
		.map(memory => `- [${memory.id}] (${memory.subkind}, ${memory.scope}) ${memory.label}${memory.body ? ` — ${memory.body}` : ''}`)
		.join('\n');
}

/**
 * Neighbours a new memory might be restating or contradicting.
 *
 * RECALL, not precision. Everything above `CANDIDATE_FLOOR` is offered to the
 * model, which decides what each of them actually is; a candidate that turns out
 * to be unrelated costs a line of prompt, while a missed one costs a duplicate
 * or an undetected contradiction.
 *
 * `extra` carries memories written EARLIER IN THE SAME EXTRACTION. Vector
 * indexing is scheduled rather than synchronous, so a memory written moments ago
 * has no row in `graph_vectors` yet and was invisible to the check meant to
 * catch it. Measured: one turn about a Svelte gotcha produced three memories
 * stating the same rule, two of them at cosine 0.8955 — above even the old
 * threshold — and all three were stored, because none of them could see the
 * others.
 *
 * Returns an empty list when the embedder is not loaded. Without vectors there
 * is no way to recognise a rephrasing, and guessing from string overlap would
 * offer memories that share vocabulary but not meaning.
 */
export function findRelatedCandidates(options: {
	text: string;
	subkind: string;
	projectId: string | null;
	excludeId?: string;
	/** Nodes not yet in `graph_vectors` — this extraction's own earlier writes. */
	extra?: { node: GraphNode; vector: Float32Array }[];
}): { node: GraphNode; score: number }[] {
	const query = embedder.embed(options.text, { minTokens: 6 });
	if (!query) return [];

	const scored: { node: GraphNode; score: number }[] = [];

	for (const candidate of options.extra ?? []) {
		if (candidate.node.id === options.excludeId) continue;
		if (candidate.node.subkind !== options.subkind) continue;
		const score = cosine(query, candidate.vector);
		if (score >= CANDIDATE_FLOOR) scored.push({ node: candidate.node, score });
	}

	try {
		const rows = getDatabase()
			.prepare(
				`SELECT v.node_id AS id, v.vec AS vec
				 FROM graph_vectors v
				 INNER JOIN graph_nodes n ON n.id = v.node_id
				 WHERE v.model = ? AND v.dim = ?
				   AND n.kind = 'episodic' AND n.subkind = ?
				   AND n.archived_at IS NULL AND n.superseded_by IS NULL
				   AND COALESCE(n.project_id, '') = COALESCE(?, '')
				 ORDER BY n.weight DESC, n.updated_at DESC
				 LIMIT ?`
			)
			.all(EMBEDDING_VERSION, query.length, options.subkind, options.projectId, MAX_DUPLICATE_CANDIDATES) as {
			id: string;
			vec: Uint8Array;
		}[];

		const seen = new Set(scored.map(entry => entry.node.id));
		for (const row of rows) {
			if (row.id === options.excludeId || seen.has(row.id)) continue;
			const score = cosineToPacked(query, row.vec);
			if (score < CANDIDATE_FLOOR) continue;
			const node = graphQueries.getById(row.id);
			if (node) scored.push({ node, score });
		}
	} catch (error) {
		debug.warn('memory', 'Candidate lookup failed', error);
	}

	return scored.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES_PER_MEMORY);
}

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

/**
 * Record the disagreements the model found, without acting on them.
 *
 * This used to call `supersede`, which removed the older memory from every
 * future recall on the strength of one model reading one turn. Measured, that
 * retired a hand-written standing prohibition in one run out of two, on the
 * basis of a task-local exception whose own body said it might be "a specific
 * exception for this task". The judgement was not obviously wrong — the evidence
 * genuinely was ambiguous — but the ACTION was irreversible in practice, because
 * nobody audits a store that appears to be working.
 *
 * A `contradicts` edge keeps the same information and defers the decision to the
 * read path, which re-makes it every turn under a rule with no model in it (see
 * `resolveConflicts` in retrieval.ts). The write path's job is to notice; the
 * read path's job is to choose.
 *
 * `candidateIds` is the set the model was actually shown. An id outside it was
 * hallucinated or copied from somewhere else, and acting on it would draw a
 * relation to a memory the model never read.
 */
export function recordContradictions(newNodeId: string, contradictedIds: string[], candidateIds: Set<string>): number {
	let applied = 0;
	for (const oldId of contradictedIds) {
		if (!candidateIds.has(oldId) || oldId === newNodeId) continue;
		try {
			if (graphQueries.contradict(newNodeId, oldId)) applied++;
		} catch (error) {
			debug.warn('memory', `Failed to record contradiction with ${oldId}`, error);
		}
	}
	if (applied > 0) debug.log('memory', `Recorded ${applied} contradiction(s)`);
	return applied;
}

/**
 * Record what the turn did with the memories it was given.
 *
 * Same containment rule as supersession: only ids that were genuinely injected
 * are accepted, so a model cannot down-rank a memory it was never shown.
 */
export function applyFeedback(verdicts: { id: string; verdict: MemoryVerdict }[], injectedIds: Set<string>): number {
	let applied = 0;
	for (const entry of verdicts) {
		if (!entry?.id || !injectedIds.has(entry.id)) continue;
		if (entry.verdict !== 'used' && entry.verdict !== 'wrong' && entry.verdict !== 'ignored') continue;
		try {
			graphQueries.recordFeedback(entry.id, entry.verdict);
			applied++;
		} catch (error) {
			debug.warn('memory', `Failed to record feedback for ${entry.id}`, error);
		}
	}
	return applied;
}

/**
 * Record the people, tools and systems a memory is about.
 *
 * The purpose is unchanged and still right: "Arga prefers Svelte", "Arga works
 * in TypeScript" and "Arga is based in Indonesia" must be findable together
 * rather than being three islands that cosine has to rediscover — and cosine
 * between two short sentences about the same person is not reliably higher than
 * between two about different people.
 *
 * WHAT CHANGED is that they are an ATTRIBUTE now rather than a node, and the
 * measurements are not close. On a graph built by asking "what is this project?"
 * in 84 repositories, 115 of 208 episodic nodes were entity stubs with an empty
 * body, and `about` pointed at a stub 220 times against 6 times at a file — so
 * the graph was not "memories about code", it was "memories about the names of
 * technologies". They duplicated on spelling ("Myria Labs" / "MyriaLabs",
 * "Express" / "Express.js", "Vue" / "Vue 3"). And an empty body is below
 * `MIN_TOKENS_FOR_VECTOR`, so a stub could never be found semantically while
 * still being offered to the model to adjudicate against — which produced a
 * `contradicts` edge between a real memory and the bare string "ClickTrainer
 * Platform". A name is not a claim; it cannot agree or disagree with one.
 *
 * As a row in `graph_node_entities` joined into the FTS text, "what do we know
 * about Bun" is an index lookup that returns the memories directly, instead of a
 * hop through a hub whose forty edges made it contribute almost nothing anyway
 * (see `SPREAD_DAMPING` in retrieval.ts).
 */
export function linkEntities(memoryNodeId: string, names: string[]): number {
	const entities: { key: string; name: string }[] = [];
	for (const raw of names.slice(0, 8)) {
		const name = String(raw ?? '').trim();
		const key = entityKeyFor(name);
		if (!key) continue;
		if (entities.some(entry => entry.key === key)) continue;
		entities.push({ key, name: name.slice(0, 140) });
	}
	if (entities.length === 0) return 0;

	try {
		return graphQueries.setEntities(memoryNodeId, entities);
	} catch (error) {
		debug.warn('memory', `Failed to record entities for ${memoryNodeId}`, error);
		return 0;
	}
}

/**
 * Pairs of live memories that MIGHT be saying the same thing, for a model to
 * adjudicate on the maintenance timer.
 *
 * This replaces a pass that merged them itself, by cosine, keeping whichever was
 * updated more recently. Every part of that was wrong at once: cosine cannot
 * tell a restatement from a reversal (the reversal scores HIGHER — 0.99 against
 * 0.76 for a genuine duplicate), and "most recently updated wins" meant a rule
 * and its opposite could be silently collapsed into whichever had been touched
 * last, with no record that the other had existed. On the real graph the pass
 * matched two pairs out of 5,356 and one of the two was a wrong merge, so what
 * it actually did was nothing, occasionally destructively.
 *
 * Returning candidates instead moves the decision to `consolidate.ts`, which
 * already has a model call on the maintenance path.
 *
 * Bounded per call, because it is O(n²) and runs on a timer rather than on any
 * path a user waits on.
 */
export function findDuplicateCandidates(limit = 200): { a: GraphNode; b: GraphNode; score: number }[] {
	if (!embedder.ready) return [];

	const pairs: { a: GraphNode; b: GraphNode; score: number }[] = [];
	try {
		const rows = getDatabase()
			.prepare(
				`SELECT n.id AS id, n.subkind AS subkind, n.project_id AS project_id, v.vec AS vec
				 FROM graph_nodes n
				 INNER JOIN graph_vectors v ON v.node_id = n.id AND v.model = ?
				 WHERE n.kind = 'episodic' AND n.archived_at IS NULL AND n.superseded_by IS NULL
				   AND n.entity_key IS NULL AND n.pinned = 0
				 ORDER BY n.updated_at DESC
				 LIMIT ?`
			)
			.all(EMBEDDING_VERSION, limit) as {
			id: string;
			subkind: string;
			project_id: string | null;
			vec: Uint8Array;
		}[];

		const paired = new Set<string>();
		for (let i = 0; i < rows.length; i++) {
			const a = rows[i];
			if (paired.has(a.id)) continue;

			for (let j = i + 1; j < rows.length; j++) {
				const b = rows[j];
				if (paired.has(b.id)) continue;
				if (b.subkind !== a.subkind) continue;
				if ((b.project_id ?? '') !== (a.project_id ?? '')) continue;

				// Both are packed int8 vectors; unpack one side to score them.
				const score = cosineToPacked(unpackVector(a.vec), b.vec);
				if (score < CANDIDATE_FLOOR) continue;

				const nodeA = graphQueries.getById(a.id);
				const nodeB = graphQueries.getById(b.id);
				if (!nodeA || !nodeB) continue;
				pairs.push({ a: nodeA, b: nodeB, score });
				paired.add(a.id);
				paired.add(b.id);
				break;
			}
		}
	} catch (error) {
		debug.warn('memory', 'Duplicate candidate scan failed', error);
	}

	return pairs;
}

/**
 * Merge `loser` into `winner` after something has decided they state the same
 * claim.
 *
 * Uses `supersede`, so the authority and durability guards apply: a merge that
 * would retire a person's memory behind a model's is refused there rather than
 * here, and the pair simply stays as two memories.
 */
export function mergeDuplicate(winnerId: string, loserId: string): boolean {
	try {
		return graphQueries.supersede(loserId, winnerId);
	} catch (error) {
		debug.warn('memory', `Failed to merge ${loserId} into ${winnerId}`, error);
		return false;
	}
}
