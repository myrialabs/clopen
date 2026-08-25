/**
 * Hybrid retrieval over the Memory Graph.
 *
 * Three signals, combined on **every** query — this is not a fallback chain:
 *
 *   1. **Lexical (BM25 over FTS5)** finds identifiers, paths and error names.
 *      Embeddings are weakest exactly here, because a rare symbol like
 *      `EngineNotReadyError` has no semantic neighbourhood to sit in.
 *   2. **Vector (local static embeddings)** finds paraphrase and cross-language
 *      matches — an Indonesian question reaching an English memory with no shared
 *      word. BM25 is blind to that.
 *   3. **Graph expansion** pulls in what the direct matches are connected to,
 *      which is the whole point of storing memory as a graph: the best answer is
 *      often adjacent to the match rather than the match itself.
 *
 * The two ranked lists are merged with Reciprocal Rank Fusion. RRF is used
 * instead of blending raw scores because BM25 and cosine are not comparable
 * quantities — one is unbounded and corpus-relative, the other is bounded — so
 * any weighted sum of the two would need per-corpus calibration to mean
 * anything. Ranks need none.
 *
 * A conditional "use vectors only if lexical found nothing" design was
 * considered and rejected: identical queries would take different code paths as
 * the corpus grew, making results feel arbitrary. Both channels always run;
 * whichever has signal contributes it. What DOES vary is how much each is
 * trusted — see `profileQuery`.
 *
 * No LLM is involved and no network call is made. Target is well under 30 ms so
 * this can run on every turn.
 */

import { getDatabase } from '$backend/database';
import { graphQueries } from '$backend/database/queries/graph-queries';
import { debug } from '$shared/utils/logger';
import { embedder, vectorCache } from './embedding';
import { EMBEDDING_VERSION } from './embedding/paths';
import { ageInDays } from './time';
import { AUTHORITY_RANK } from '$shared/types/memory';
import type {
	GraphNode,
	QueryProfile,
	RetrievalChannel,
	RetrievalHit,
	RetrievalOptions,
	RetrievalResult
} from '$shared/types/memory';

/**
 * RRF damping constant. 60 is the value from the original Cormack et al.
 * formulation and is deliberately large relative to our result sizes: it keeps
 * rank 1 from dominating rank 2, so a node both channels rank modestly outranks
 * one channel's confident-but-lonely top hit. That is the behaviour we want —
 * agreement between a lexical and a semantic match is the strongest signal here.
 */
const RRF_K = 60;

/** How many candidates each channel contributes before fusion. */
const CHANNEL_DEPTH = 60;

/**
 * Ceiling on vectors scored per query. Similarity is a brute-force scan (no ANN
 * index), which is the right trade at this scale: 20k packed vectors is ~5 MB and
 * scores in a few milliseconds, while an ANN index would add a dependency and a
 * rebuild step for a corpus that fits in cache. Should a graph ever exceed this,
 * the cap keeps latency bounded rather than degrading silently — and it is
 * ordered so the most reinforced, most recent memories are the ones scored.
 */
const MAX_VECTORS_SCANNED = 20_000;

/** Seeds that spreading activation starts from, strongest fused rank first. */
const MAX_SEEDS = 6;

/**
 * Precise-mode gating for the vector channel (see `RetrievalOptions.precise`).
 *
 * The z is lower than `relate.ts` uses, because linking creates a permanent edge
 * while a search result is disposable — the cost of being slightly too generous
 * here is one extra row on screen, not a corrupted graph.
 */
const PRECISE_Z = 1.0;
const PRECISE_FLOOR = 0.35;

/** Below this many candidates a distribution is too small to gate against. */
const PRECISE_MIN_SAMPLE = 8;

/**
 * How much a memory learned in ANOTHER project is discounted here.
 *
 * MEASURED, on a seeded three-project corpus with deliberate per-project
 * disagreements (each project deploys somewhere different, uses a different
 * database, runs tests differently). The curve is flat where it matters and
 * falls off a cliff below it:
 *
 *   ×1.00   transfer recall@3 7/7, locality 4/4 — but nothing separates a
 *           travelling insight from another project's answer
 *   ×0.85   transfer 6/7, locality 4/4          <- shipped
 *   ×0.80   transfer 6/7, locality 4/4
 *   ×0.50   transfer 0/7 — the discount swallows the feature whole
 *
 * 0.85 sits in the middle of the flat band rather than at either edge, so a
 * corpus that grows in one direction does not fall off it. It is a tie-break,
 * not a gate: what actually keeps another project's answer out is `reach`, and
 * this only decides the order when both are eligible.
 */
const FOREIGN_PROJECT_PENALTY = 0.85;

/**
 * Fraction of a seed's activation that flows to each neighbour per hop.
 *
 * This is personalized-PageRank-shaped rather than a flat bonus: activation is
 * divided by the neighbour count, so a hub node with forty edges passes almost
 * nothing to any one of them while a memory with two edges passes a real amount.
 * A flat per-hop score — what a plain BFS expansion gives — has the opposite
 * behaviour, and hubs are exactly the nodes a memory graph accumulates.
 */
const SPREAD_DAMPING = 0.45;

interface Candidate {
	node: GraphNode;
	lexicalRank: number | null;
	vectorRank: number | null;
	snippet: string | null;
	hops: number;
	/** Accumulated spreading-activation mass, for graph-reached candidates. */
	activation: number;
}

interface FilterSql {
	clause: string;
	params: unknown[];
}

/**
 * How a query should be read.
 *
 * The two channels are not equally good at the two kinds of question, and which
 * kind a query is can be told from its surface without a model. `getByPath` and
 * `backend/memory/relate.ts` are identifiers: BM25 matches them exactly, while a
 * mean-pooled static embedding of a path fragment lands in the crowded middle of
 * the space and mostly adds noise. "kenapa kita pakai SQLite" is the reverse —
 * it shares no token with the English memory that answers it, and only the vector
 * channel can cross that gap.
 *
 * The weights are deliberately mild (0.6 / 1.4 rather than 0 / 2). A query that
 * looks like code often still has a prose answer, so this tilts the fusion
 * rather than disabling half of it.
 */
export function profileQuery(query: string): QueryProfile {
	const tokens = query.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { shape: 'prose', lexicalWeight: 1, vectorWeight: 1 };

	const codey = tokens.filter(token =>
		// A path separator, a file extension, snake_case, camelCase, or a call.
		/[/\\]/.test(token) ||
		/\.[a-z]{1,4}\b/i.test(token) ||
		/[a-z0-9]_[a-z0-9]/i.test(token) ||
		/[a-z][A-Z]/.test(token) ||
		/\(\)/.test(token)
	).length;

	const ratio = codey / tokens.length;
	// A short query that is ENTIRELY an identifier is the clearest signal there
	// is: someone pasted a symbol and wants what is known about it.
	if (ratio >= 0.6) return { shape: 'code', lexicalWeight: 1.4, vectorWeight: 0.6 };
	if (ratio >= 0.2) return { shape: 'mixed', lexicalWeight: 1.15, vectorWeight: 0.85 };
	return { shape: 'prose', lexicalWeight: 0.8, vectorWeight: 1.2 };
}

/**
 * Shared WHERE fragment so both channels see the same corpus. Without this the
 * two rank lists could be drawn from different populations and fusion would be
 * comparing incomparable sets.
 *
 * `projectId: undefined` means "every project" — the cross-project case that
 * backs global chat. A concrete project also admits global-scope nodes, because
 * user-level conventions apply inside every project.
 */
function buildFilter(options: RetrievalOptions, alias: string): FilterSql {
	const where: string[] = [];
	const params: unknown[] = [];

	// `reach = 'anywhere'` is what a memory learned elsewhere needs to be admitted
	// here. Structural nodes are excluded by construction — their reach is written
	// as `here` on insert — so another repository's file paths can never arrive,
	// which is the leak the blanket project filter was originally added to stop.
	const travelling = options.crossProject ? ` OR ${alias}.reach = 'anywhere'` : '';

	if (options.projectIds !== undefined) {
		if (options.projectIds.length === 0) {
			where.push(`(${alias}.project_id IS NULL${travelling})`);
		} else {
			where.push(
				`(${alias}.project_id IN (${options.projectIds.map(() => '?').join(',')}) OR ${alias}.project_id IS NULL${travelling})`
			);
			params.push(...options.projectIds);
		}
	} else if (options.projectId !== undefined) {
		if (options.projectId === null) {
			where.push(`(${alias}.project_id IS NULL${travelling})`);
		} else {
			where.push(`(${alias}.project_id = ? OR ${alias}.project_id IS NULL${travelling})`);
			params.push(options.projectId);
		}
	}
	if (options.sessionId) {
		// Session-scoped memories are private to their session; everything broader
		// stays visible, so asking inside a session sees both.
		where.push(`(${alias}.scope != 'session' OR ${alias}.session_id = ?)`);
		params.push(options.sessionId);
	}
	if (options.scopes?.length) {
		where.push(`${alias}.scope IN (${options.scopes.map(() => '?').join(',')})`);
		params.push(...options.scopes);
	}
	if (options.kinds?.length) {
		where.push(`${alias}.kind IN (${options.kinds.map(() => '?').join(',')})`);
		params.push(...options.kinds);
	}
	if (options.subkinds?.length) {
		where.push(`${alias}.subkind IN (${options.subkinds.map(() => '?').join(',')})`);
		params.push(...options.subkinds);
	}
	if (options.sources?.length) {
		where.push(`${alias}.source IN (${options.sources.map(() => '?').join(',')})`);
		params.push(...options.sources);
	}
	if (!options.includeArchived) where.push(`${alias}.archived_at IS NULL`);
	// Superseded memories are history. Handing an agent both the old and the new
	// version of a fact makes it adjudicate them on every turn, which is the exact
	// work belief revision exists to have already done.
	if (!options.includeSuperseded) where.push(`${alias}.superseded_by IS NULL`);

	return { clause: where.length ? `AND ${where.join(' AND ')}` : '', params };
}

/**
 * The same filter as a predicate over already-loaded nodes.
 *
 * Graph expansion reaches nodes through EDGES rather than through a query, and
 * edges deliberately cross project boundaries (that is what lets a pattern
 * proven in one repository be reused in another). Without re-checking the filter
 * here, one hop from a shared dependency node would pull another project's files
 * — and, through them, another project's memories — into a block that is about to
 * be injected into this project's prompt. Traversal has to obey the same scope
 * rules the channels do.
 */
function makeFilterPredicate(options: RetrievalOptions): (node: GraphNode) => boolean {
	const scopes = options.scopes?.length ? new Set(options.scopes) : null;
	const kinds = options.kinds?.length ? new Set(options.kinds) : null;
	const subkinds = options.subkinds?.length ? new Set(options.subkinds) : null;
	const sources = options.sources?.length ? new Set(options.sources) : null;

	const projectIds = options.projectIds ? new Set(options.projectIds) : null;

	return (node: GraphNode): boolean => {
		// Same admission rule as `buildFilter`, so traversal cannot reach anything
		// the channels were not allowed to return.
		const travels = options.crossProject === true && node.reach === 'anywhere' && node.kind === 'episodic';
		if (projectIds) {
			if (node.projectId !== null && !projectIds.has(node.projectId) && !travels) return false;
		} else if (options.projectId !== undefined) {
			if (options.projectId === null) {
				if (node.projectId !== null && !travels) return false;
			} else if (node.projectId !== null && node.projectId !== options.projectId && !travels) {
				return false;
			}
		}
		if (options.sessionId && node.scope === 'session' && node.sessionId !== options.sessionId) return false;
		if (scopes && !scopes.has(node.scope)) return false;
		if (kinds && !kinds.has(node.kind)) return false;
		if (subkinds && !subkinds.has(node.subkind)) return false;
		if (sources && !sources.has(node.source)) return false;
		if (!options.includeArchived && node.archivedAt) return false;
		if (!options.includeSuperseded && node.supersededBy) return false;
		return true;
	};
}

/** BM25 hits, best first, with a highlighted snippet. */
function lexicalSearch(options: RetrievalOptions): { id: string; snippet: string }[] {
	const ftsQuery = graphQueries.buildFtsQuery(options.query);
	if (!ftsQuery) return [];

	const filter = buildFilter(options, 'n');
	try {
		return getDatabase()
			.prepare(
				`SELECT fts.node_id AS id,
				        snippet(graph_nodes_fts, 4, char(1), char(2), '…', 16) AS snippet
				 FROM graph_nodes_fts fts
				 INNER JOIN graph_nodes n ON n.id = fts.node_id
				 WHERE graph_nodes_fts MATCH ? ${filter.clause}
				 ORDER BY rank
				 LIMIT ?`
			)
			.all(ftsQuery, ...filter.params, CHANNEL_DEPTH) as { id: string; snippet: string }[];
	} catch (error) {
		// A malformed MATCH expression must not take the whole retrieval down —
		// the vector channel can still answer.
		debug.warn('memory', 'Lexical retrieval failed', error);
		return [];
	}
}

/**
 * Cosine hits, best first. Empty when the embedding artifact is not loaded.
 *
 * Only episodic nodes carry vectors (see `nodesMissingVectors`), so this channel
 * searches prose while the lexical channel covers names and paths. The join does
 * that filtering implicitly — a node with no vector row is simply not a
 * candidate.
 */
function vectorSearch(options: RetrievalOptions): { id: string; score: number }[] {
	try {
		const query = embedder.embed(options.query);
		if (!query) return [];

		// SQLite is asked for IDS, not blobs. The scan is index-covered over columns
		// the filter already needs, and the vectors themselves come from the resident
		// cache — reading twenty thousand BLOBs per turn was the single most
		// expensive thing on the read path, and it grew with the corpus while the
		// arithmetic it fed did not.
		const filter = buildFilter(options, 'n');
		const candidates = (
			getDatabase()
				.prepare(
					`SELECT v.node_id AS id
					 FROM graph_vectors v
					 INNER JOIN graph_nodes n ON n.id = v.node_id
					 WHERE v.model = ? AND v.dim = ? ${filter.clause}
					 ORDER BY n.pinned DESC, n.weight DESC, n.updated_at DESC
					 LIMIT ?`
				)
				.all(EMBEDDING_VERSION, query.length, ...filter.params, MAX_VECTORS_SCANNED) as { id: string }[]
		).map(row => row.id);
		if (candidates.length === 0) return [];

		vectorCache.ensure();

		// Only the sign is filtered, not the magnitude.
		//
		// An absolute cutoff is tempting and wrong here. Measured on this artifact,
		// a correct cross-language match often scores 0.11–0.20 while an unrelated
		// pair can reach 0.24 — the distributions overlap, because mean-pooled
		// static embeddings put short texts closer together than their meanings
		// warrant. Any threshold that removed the noise would remove real answers
		// too. Ordering is still informative even where the absolute value is not,
		// so magnitude is left to decide rank and BM25 is what corrects the
		// mistakes vectors make. This is the concrete reason retrieval fuses two
		// channels rather than trusting either.
		const scored = vectorCache.score(query, candidates, 0);

		// In precise mode a vector hit has to EARN its place rather than merely beat
		// zero. The cutoff is relative to this query's own score distribution for the
		// same reason `relate.ts` uses one: with static embeddings the absolute
		// numbers are not comparable across queries, but "unusually close for this
		// query" is meaningful. An absolute floor sits under it, because standing out
		// from a field of near-zeros still means nothing.
		//
		// Injection deliberately does NOT use this: there a weak semantic lead is
		// still worth ranking, and BM25 corrects it. A search box is the opposite —
		// sixty loosely-related results read as a broken feature.
		if (options.precise && scored.length >= PRECISE_MIN_SAMPLE) {
			const mean = scored.reduce((sum, entry) => sum + entry.score, 0) / scored.length;
			const variance = scored.reduce((sum, entry) => sum + (entry.score - mean) ** 2, 0) / scored.length;
			const stddev = Math.sqrt(variance);
			const cutoff = Math.max(mean + PRECISE_Z * stddev, PRECISE_FLOOR);
			return scored.filter(entry => entry.score >= cutoff).slice(0, CHANNEL_DEPTH);
		}

		return scored.slice(0, CHANNEL_DEPTH);
	} catch (error) {
		debug.warn('memory', 'Vector retrieval failed', error);
		return [];
	}
}

/**
 * Prior applied on top of the fused rank: memories that have PROVED useful and
 * are still current outrank ones written once and never confirmed, and old
 * untouched memories fade without ever disappearing.
 *
 * `useful_count` carries the reinforcement here, not `access_count`. Being
 * retrieved is a fact about the ranker, and letting it feed its own input is a
 * loop that ends with the same handful of memories injected forever regardless
 * of the question. Being USED is evidence, and it is adjudicated by the
 * following turn (see `extract/episodic.ts`).
 *
 * Deliberately gentle (logarithmic, bounded, floored) — the query should decide
 * relevance, with track record only breaking ties.
 */
function prior(node: GraphNode): number {
	if (node.pinned) return 1.5;

	const proven = Math.log1p(node.usefulCount) * 0.18;
	const rejected = Math.log1p(node.unhelpfulCount) * 0.1;
	const reinforcement = Math.max(0.5, 1 + Math.log1p(Math.max(0, node.weight - 1)) * 0.15 + proven - rejected);

	const ageDays = ageInDays(node.accessedAt ?? node.updatedAt);
	const recency = 0.6 + 0.4 * Math.exp(-ageDays / 90);

	// A memory whose code changed underneath it is not wrong, but it has stopped
	// being evidence about the current state of the repository.
	const staleness = node.staleAt ? 0.7 : 1;

	return reinforcement * recency * staleness * (0.5 + 0.5 * node.confidence);
}

function channelOf(candidate: Candidate): RetrievalChannel {
	if (candidate.hops > 0) return 'graph';
	if (candidate.lexicalRank !== null && candidate.vectorRank !== null) return 'both';
	if (candidate.vectorRank !== null) return 'vector';
	return 'lexical';
}

/**
 * Retrieve memories for a query. Never throws: a failure in one channel degrades
 * the result rather than the caller, because this runs on the turn path.
 */
export function retrieve(options: RetrievalOptions): RetrievalResult {
	const started = performance.now();
	const profile = profileQuery(options.query);

	try {
		return { ...rank(options, profile), elapsedMs: performance.now() - started, profile };
	} catch (error) {
		// Retrieval is an enrichment. Everything that calls it — turn injection, the
		// MCP tool, the Memory modal — is better off with no memories than with an
		// exception, so the guarantee in the docstring is enforced rather than hoped
		// for.
		debug.error('memory', 'Retrieval failed; returning no hits', error);
		return { hits: [], vectorUsed: false, elapsedMs: performance.now() - started, profile };
	}
}

function rank(options: RetrievalOptions, profile: QueryProfile): { hits: RetrievalHit[]; vectorUsed: boolean } {
	const limit = options.limit ?? 12;

	const lexical = lexicalSearch(options);
	const vector = vectorSearch(options);

	const candidates = new Map<string, Candidate>();
	const ensure = (id: string, node: GraphNode): Candidate => {
		let existing = candidates.get(id);
		if (!existing) {
			existing = { node, lexicalRank: null, vectorRank: null, snippet: null, hops: 0, activation: 0 };
			candidates.set(id, existing);
		}
		return existing;
	};

	// One batched read for both channels' ids rather than a lookup per hit.
	const directIds = [...new Set([...lexical.map(l => l.id), ...vector.map(v => v.id)])];
	const nodesById = new Map(graphQueries.getByIds(directIds).map(n => [n.id, n]));

	lexical.forEach((hit, index) => {
		const node = nodesById.get(hit.id);
		if (!node) return;
		const candidate = ensure(hit.id, node);
		candidate.lexicalRank = index + 1;
		candidate.snippet = hit.snippet;
	});

	vector.forEach((hit, index) => {
		const node = nodesById.get(hit.id);
		if (!node) return;
		ensure(hit.id, node).vectorRank = index + 1;
	});

	const accept = makeFilterPredicate(options);

	// ── anchors ────────────────────────────────────────────────────────────
	// The files the session is working in are seeds too. Without this, a turn
	// whose text carries no retrievable signal — "continue", "fix it", "coba
	// lagi", which is a large share of real turns — retrieves nothing at all,
	// even when the graph holds a failure memory about the exact file on screen.
	// The query says nothing; the working set says plenty.
	const anchors = anchorSeeds(options, accept);
	for (const node of anchors) {
		if (candidates.has(node.id)) continue;
		candidates.set(node.id, {
			node,
			lexicalRank: null,
			vectorRank: null,
			snippet: null,
			hops: 0,
			// Anchors are context, not answers: they enter with a small activation so
			// they can pull their neighbours in without outranking a real match.
			activation: 1 / (RRF_K + CHANNEL_DEPTH)
		});
	}

	// ── graph expansion (spreading activation) ─────────────────────────────
	const expandHops = options.expandHops ?? 1;
	if (expandHops > 0 && candidates.size > 0) {
		spread(candidates, expandHops, accept, profile);
	}

	// ── fuse ───────────────────────────────────────────────────────────────
	const home = options.projectId ?? null;
	const scored: RetrievalHit[] = [...candidates.values()]
		.filter(candidate => accept(candidate.node))
		.map(candidate => {
			const base = candidate.hops > 0 ? candidate.activation : rrfScore(candidate, profile) + candidate.activation;
			// A memory that travelled here from another repository is worth having and
			// is not worth outranking one from this one when both match equally.
			const foreign =
				candidate.node.projectId !== null && home !== null && candidate.node.projectId !== home
					? FOREIGN_PROJECT_PENALTY
					: 1;
			return {
				node: candidate.node,
				score: base * prior(candidate.node) * foreign,
				channel: channelOf(candidate),
				lexicalRank: candidate.lexicalRank,
				vectorRank: candidate.vectorRank,
				hops: candidate.hops,
				snippet: candidate.snippet
			};
		})
		.sort((a, b) => b.score - a.score);

	const hits = resolveConflicts(scored).slice(0, limit);
	return { hits, vectorUsed: vector.length > 0 };
}

/**
 * Drop the losing side of every pair of memories that contradict each other.
 *
 * This is where belief revision actually happens now. The write path records a
 * disagreement and destroys nothing; the decision is made HERE, from scratch, on
 * every turn, by a rule with no model in it:
 *
 *   1. **Authority.** What the user said beats what the assistant asserted beats
 *      what a model inferred. This is the ordering the old design had no column
 *      for, which is how an inference came to retire a hand-written rule.
 *   2. **Durability.** A standing rule beats a one-off instruction. An exception
 *      taken for one task is not a policy, however recently it was taken.
 *   3. **Recency.** Between two claims of equal standing, the later one is the
 *      user's current position — which is the whole of what "the newest
 *      instruction wins" was supposed to mean.
 *
 * Deciding at read time rather than write time is what makes a wrong call
 * cheap. The loser is not removed from the graph, is still searchable, still
 * shows in the view, and comes back the moment the evidence changes.
 */
function resolveConflicts(hits: RetrievalHit[]): RetrievalHit[] {
	if (hits.length < 2) return hits;

	let edges: { srcId: string; dstId: string }[];
	try {
		edges = graphQueries.contradictionsFor(hits.map(hit => hit.node.id));
	} catch (error) {
		debug.warn('memory', 'Conflict resolution failed; returning every hit', error);
		return hits;
	}
	if (edges.length === 0) return hits;

	const byId = new Map(hits.map(hit => [hit.node.id, hit.node]));
	const losers = new Set<string>();
	for (const edge of edges) {
		const a = byId.get(edge.srcId);
		const b = byId.get(edge.dstId);
		// Only decide between two memories that BOTH reached this result set. A
		// contradiction with something the query never surfaced is not this turn's
		// argument to settle.
		if (!a || !b) continue;
		losers.add(currentOf(a, b) === a ? b.id : a.id);
	}
	if (losers.size === 0) return hits;

	return hits.filter(hit => !losers.has(hit.node.id));
}

const DURABILITY: Record<GraphNode['scope'], number> = { session: 0, project: 1, global: 2 };

/** Which of two contradicting memories is the current belief. */
function currentOf(a: GraphNode, b: GraphNode): GraphNode {
	const authority = AUTHORITY_RANK[a.assertedBy] - AUTHORITY_RANK[b.assertedBy];
	if (authority !== 0) return authority > 0 ? a : b;

	const durability = DURABILITY[a.scope] - DURABILITY[b.scope];
	if (durability !== 0) return durability > 0 ? a : b;

	// `updatedAt`, not `createdAt`: a memory re-observed this week is the user's
	// current position even if it was first written months ago.
	return Date.parse(`${a.updatedAt}Z`) >= Date.parse(`${b.updatedAt}Z`) ? a : b;
}

/**
 * Structural nodes for the paths the caller says it is working in.
 *
 * These are looked up rather than searched: a path is an exact key, and running
 * it through BM25 would be both slower and less precise.
 */
function anchorSeeds(options: RetrievalOptions, accept: (node: GraphNode) => boolean): GraphNode[] {
	const paths = options.anchorPaths;
	if (!paths?.length || options.projectId === undefined || options.projectId === null) return [];
	try {
		return graphQueries.getByPaths(options.projectId, paths.slice(0, 40)).filter(accept);
	} catch (error) {
		debug.warn('memory', 'Anchor seeding failed', error);
		return [];
	}
}

/**
 * Push activation out from the strongest candidates along their edges.
 *
 * Expanding from EVERY match would flood the result with weakly-related
 * neighbours, which is how graph retrieval usually goes wrong, so only the top
 * seeds emit. Each seed's mass is divided among its neighbours and damped per
 * hop, so being reached from two different seeds accumulates — which is the
 * property that makes a two-hop node worth surfacing at all — while a single
 * edge from a forty-edge hub contributes almost nothing.
 */
function spread(
	candidates: Map<string, Candidate>,
	hops: number,
	accept: (node: GraphNode) => boolean,
	profile: QueryProfile
): void {
	const seeds = [...candidates.values()]
		.filter(candidate => candidate.hops === 0)
		.sort((a, b) => rrfScore(b, profile) - rrfScore(a, profile))
		.slice(0, MAX_SEEDS);

	let frontier = seeds.map(seed => ({
		id: seed.node.id,
		mass: Math.max(rrfScore(seed, profile), 1 / (RRF_K + CHANNEL_DEPTH))
	}));
	const seedIds = new Set(frontier.map(entry => entry.id));

	for (let depth = 1; depth <= hops; depth++) {
		const next = new Map<string, number>();

		for (const { id, mass } of frontier) {
			let neighbours: { node: GraphNode; hops: number }[];
			try {
				neighbours = graphQueries.neighbours(id, 1, 24);
			} catch (error) {
				debug.warn('memory', `Expansion failed at ${id}`, error);
				continue;
			}

			// Filtered BEFORE the fan-out is counted, so a node whose neighbours are
			// mostly in another project does not have its activation diluted by
			// edges that were never eligible to receive any.
			const eligible = neighbours.filter(entry => accept(entry.node));
			if (eligible.length === 0) continue;

			const share = (mass * SPREAD_DAMPING) / eligible.length;
			for (const entry of eligible) {
				if (seedIds.has(entry.node.id)) continue;

				const existing = candidates.get(entry.node.id);
				if (existing) {
					// Already a direct match — it keeps its own rank; the extra mass only
					// confirms it.
					existing.activation += share;
					continue;
				}
				candidates.set(entry.node.id, {
					node: entry.node,
					lexicalRank: null,
					vectorRank: null,
					snippet: null,
					hops: depth,
					activation: share
				});
				next.set(entry.node.id, (next.get(entry.node.id) ?? 0) + share);
			}
		}

		frontier = [...next.entries()].map(([id, mass]) => ({ id, mass }));
		if (frontier.length === 0) break;
	}
}

/**
 * Reciprocal Rank Fusion contribution of a candidate's two ranks, tilted by how
 * the query was read (see `profileQuery`).
 */
function rrfScore(candidate: Candidate, profile: QueryProfile): number {
	let score = 0;
	if (candidate.lexicalRank !== null) score += profile.lexicalWeight / (RRF_K + candidate.lexicalRank);
	if (candidate.vectorRank !== null) score += profile.vectorWeight / (RRF_K + candidate.vectorRank);
	return score;
}

/**
 * Record that a human or an agent deliberately consulted these memories.
 *
 * Kept OUT of `retrieve` on purpose. Automatic turn-start injection retrieves on
 * every single turn, so counting that as usage would make `access_count` a
 * measure of how often the ranker picked a node — which then feeds the ranker.
 * Only deliberate reads (the MCP `recall` action, a search in the Memory modal)
 * count.
 */
export function markConsulted(hits: RetrievalHit[]): void {
	if (hits.length === 0) return;
	try {
		graphQueries.markAccessed(hits.map(hit => hit.node.id));
	} catch (error) {
		debug.warn('memory', 'Failed to record memory access', error);
	}
}
