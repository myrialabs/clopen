/**
 * Memory Graph Queries
 *
 * CRUD and traversal for `graph_nodes` / `graph_edges` / `graph_vectors` plus the
 * `graph_nodes_fts` mirror (migration 066). Instance-global and admin-managed —
 * no `user_id` column — mirroring skills / mcp_servers / subagents.
 *
 * Two invariants live here rather than in callers:
 *
 *   1. **Writes upsert on `digest`.** Extraction runs every turn and would
 *      otherwise re-add the same memory endlessly. A repeat write reinforces the
 *      existing node (bumping `weight`) instead of duplicating it.
 *   2. **The FTS mirror is never updated by callers.** Every mutation that
 *      changes indexed text syncs `graph_nodes_fts` in the same transaction, the
 *      way message-queries owns `messages_fts`.
 *
 * Vectors are written separately (see backend/memory/indexer.ts) because they
 * depend on the on-demand embedding artifact, which may not be installed yet.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../index';
import { debug } from '$shared/utils/logger';
import { AUTHORITY_RANK } from '$shared/types/memory';
import type {
	GraphEdge,
	GraphEdgeInput,
	GraphNode,
	GraphNodeInput,
	GraphNodeKind,
	GraphRelation,
	GraphScope,
	GraphSource,
	GraphStats
} from '$shared/types/memory';

interface GraphNodeRow {
	id: string;
	kind: GraphNodeKind;
	subkind: string;
	scope: GraphScope;
	project_id: string | null;
	session_id: string | null;
	label: string;
	body: string;
	path: string | null;
	symbol: string | null;
	language: string | null;
	digest: string;
	confidence: number;
	weight: number;
	access_count: number;
	source: string;
	asserted_by: string;
	reach: string;
	reach_judged: number;
	pinned: number;
	archived_at: string | null;
	created_at: string;
	updated_at: string;
	accessed_at: string | null;
	superseded_by: string | null;
	useful_count: number;
	unhelpful_count: number;
	stale_at: string | null;
	entity_key: string | null;
	/** rowid of this node's row in `graph_nodes_fts` — see `syncFts`. */
	fts_rowid: number | null;
}

interface GraphEdgeRow {
	id: number;
	src_id: string;
	dst_id: string;
	rel: GraphRelation;
	weight: number;
	source: string;
	created_at: string;
}

function toNode(row: GraphNodeRow): GraphNode {
	return {
		id: row.id,
		kind: row.kind,
		subkind: row.subkind as GraphNode['subkind'],
		scope: row.scope,
		projectId: row.project_id,
		sessionId: row.session_id,
		label: row.label,
		body: row.body,
		path: row.path,
		symbol: row.symbol,
		language: row.language,
		digest: row.digest,
		confidence: row.confidence,
		weight: row.weight,
		accessCount: row.access_count,
		source: row.source as GraphNode['source'],
		assertedBy: (row.asserted_by ?? 'inferred') as GraphNode['assertedBy'],
		reach: (row.reach ?? 'here') as GraphNode['reach'],
		reachJudged: row.reach_judged === 1,
		pinned: row.pinned === 1,
		archivedAt: row.archived_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		accessedAt: row.accessed_at,
		supersededBy: row.superseded_by ?? null,
		usefulCount: row.useful_count ?? 0,
		unhelpfulCount: row.unhelpful_count ?? 0,
		staleAt: row.stale_at ?? null,
		entityKey: row.entity_key ?? null
	};
}

function toEdge(row: GraphEdgeRow): GraphEdge {
	return {
		id: row.id,
		srcId: row.src_id,
		dstId: row.dst_id,
		rel: row.rel,
		weight: row.weight,
		source: row.source as GraphEdge['source'],
		createdAt: row.created_at
	};
}

/**
 * Text a node contributes to the lexical index: its label, its body, and its
 * path/symbol. Paths are also split on separators so `sdk-loader` matches
 * `backend/engine/sdk-loader.ts` — BM25 tokenizes on word boundaries and would
 * otherwise treat the whole path as one opaque term.
 */
function indexedText(node: Pick<GraphNode, 'label' | 'body' | 'path' | 'symbol'> & { entityNames?: string[] }): string {
	const parts = [node.label, node.body];
	if (node.symbol) parts.push(node.symbol);
	// The entities a memory names used to be findable because each was a node of
	// its own. They are an attribute now, so the memories that name them have to
	// carry them into the lexical index — otherwise "what do we know about Bun"
	// only matches memories that happen to spell Bun in their prose.
	if (node.entityNames?.length) parts.push(node.entityNames.join(' '));
	if (node.path) {
		parts.push(node.path);
		parts.push(node.path.split(/[/\\._-]+/).filter(Boolean).join(' '));
	}
	return parts.filter(Boolean).join('\n').trim();
}

/**
 * Identity algorithm version, stored per row as `digest_version`.
 *
 * Bump when the basis or the hash changes. Rows at an older version can then be
 * re-derived deliberately instead of silently forking into duplicates the next
 * time extraction sees the same fact.
 */
export const DIGEST_VERSION = 2;

/**
 * Most terms one FTS5 MATCH may carry. See `buildFtsQuery` for why there is a
 * bound at all; 32 is comfortably more than any real question and far below the
 * point where the OR tree becomes a problem.
 */
const MAX_FTS_TERMS = 32;

/**
 * Canonical form of an entity name: the thing five differently-worded mentions
 * of one subject must agree on.
 *
 * Separators are REMOVED rather than normalised, and a trailing version is
 * dropped. The first version replaced punctuation with a hyphen and kept it,
 * which meant the key still encoded how someone happened to type the name — and
 * against a real graph that forked "Myria Labs" from "MyriaLabs", "Express" from
 * "Express.js", "Vue" from "Vue 3", "Tailwind" from "Tailwind CSS v4" and
 * "PostgreSQL" from "PostgreSQL 15". A dozen of 115 entities were pure spelling
 * duplicates.
 *
 * Version stripping is deliberately shallow — a trailing number only. "Docker"
 * and "Docker Compose" stay apart, because they are different things and the
 * second is not a version of the first.
 */
export function entityKeyFor(name: string): string | null {
	const key = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/\s+v?\d+(\.\d+)*$/, '')
		.replace(/[^a-z0-9]+/g, '')
		// "Express" and "Express.js" are one library; so are Node/Node.js and
		// Vue/Vue.js. Narrow on purpose — only a trailing `js`, and only when
		// something is left. The known cost is that an entity genuinely ending in
		// those two letters would fold into its stem, which no real technology name
		// in this corpus does.
		.replace(/js$/, '');
	return key.length >= 2 ? key.slice(0, 120) : null;
}

/**
 * Stable identity for a node when the caller does not supply one. Structural
 * nodes are identified by what they point at; episodic nodes by their normalized
 * claim, so the same decision phrased with different whitespace or casing
 * reinforces rather than duplicates.
 *
 * SHA-256 rather than `Bun.hash`. The hash is PERSISTED as a node's identity, so
 * it has to mean the same thing after a runtime upgrade — and Bun documents no
 * cross-version stability guarantee for `Bun.hash`. A seed change there would not
 * fail loudly; it would silently re-duplicate every memory in the graph on the
 * next extraction, which is close to the worst failure this store can have.
 */
export function deriveDigest(input: GraphNodeInput): string {
	// A canonical entity IS its key — that is the whole point. Two statements
	// about the same person must land on one node no matter how they are phrased,
	// so content plays no part in the identity of an entity node.
	if (input.entityKey) {
		return sha(`entity:${input.entityKey}`);
	}

	let basis: string;
	if (input.kind === 'structural') {
		// Identity is what the node points AT, so the label may be rewritten (a file
		// renamed in the graph's display) without splitting it into a second node.
		//
		// Dependency nodes have neither path nor symbol — a package is not a
		// location in the repository — so they must key on their name. Without that
		// fallback every dependency in the workspace collapses onto one shared
		// digest and each new package silently overwrites the previous one.
		const located = `${input.path ?? ''}:${input.symbol ?? ''}`;
		const identity = located === ':' ? input.label.trim().toLowerCase() : located;
		basis = `${input.subkind}:${identity}`;
	} else {
		basis = `${input.subkind}:${(input.label + ' ' + (input.body ?? '')).toLowerCase().replace(/\s+/g, ' ').trim()}`;
	}
	return sha(basis);
}

/** 20 hex characters of SHA-256 — 80 bits, far past collision risk at this scale. */
function sha(basis: string): string {
	return Bun.SHA256.hash(basis, 'hex').slice(0, 20);
}

/**
 * What a caller may narrow a listing by.
 *
 * `subkinds` and `sources` were added because a two-way kind toggle could not
 * answer real questions of the graph: "show only what the user stated, not what
 * was inferred", or "only the failures". Both are attributes the store has always
 * carried and nothing could filter on.
 */
export interface GraphListFilter {
	/** `undefined` = every project; `null` = global-scope nodes only. */
	projectId?: string | null;
	/**
	 * A SET of projects, from the modal's multi-select. Takes precedence over
	 * `projectId`. An empty array means global only — nothing selected is a
	 * narrowing, not an absence of one.
	 */
	projectIds?: string[];
	kinds?: GraphNodeKind[];
	subkinds?: string[];
	scopes?: GraphScope[];
	sources?: GraphSource[];
	includeArchived?: boolean;
	includeSuperseded?: boolean;
	/** Show ONLY archived nodes — what the "forgotten" list is. */
	archivedOnly?: boolean;
}

/**
 * The WHERE fragment shared by `list`, `count` and `listArchived`.
 *
 * Kept in one place because the three drifting apart is how a node ends up
 * counted but not shown, or shown in the graph after being forgotten.
 */
/**
 * An id set as ONE bound parameter instead of one placeholder per id.
 *
 * The graph view hands these queries up to three thousand ids at a time, and
 * `IN (?, ?, … ×3000)` builds a different SQL string for every distinct length —
 * so the statement cache never hits and SQLite recompiles the query on each
 * call. `edgesWithin` was the worst of them, repeating the set twice for six
 * thousand bound parameters. `json_each` takes the whole set as a single JSON
 * argument, which makes the SQL text constant and the statement cacheable.
 */
const ID_SET = '(SELECT value FROM json_each(?))';

const idSet = (ids: string[]): string => JSON.stringify(ids);

function appendProjectFilter(
	filter: GraphListFilter,
	where: string[],
	params: unknown[],
	as: string = ''
): void {
	if (filter.projectIds !== undefined) {
		// Nothing selected is "global only", not "everything": the user has narrowed
		// away every repository, and what remains is what was never a repository's.
		if (filter.projectIds.length === 0) where.push(`${as}project_id IS NULL`);
		else {
			where.push(
				`(${as}project_id IN (${filter.projectIds.map(() => '?').join(',')}) OR ${as}project_id IS NULL)`
			);
			params.push(...filter.projectIds);
		}
		return;
	}
	if (filter.projectId === undefined) return;
	if (filter.projectId === null) {
		where.push(`${as}project_id IS NULL`);
		return;
	}
	// A project view also shows the global memories that apply to it —
	// conventions and preferences are part of that project's context.
	where.push(`(${as}project_id = ? OR ${as}project_id IS NULL)`);
	params.push(filter.projectId);
}

/**
 * The graph view's WHERE clause, optionally qualified by a table alias.
 *
 * The alias exists for the queries that join `graph_nodes` to itself through an
 * edge — the cluster-adjacency rollup has to apply the SAME narrowing to both
 * ends of every edge, and unqualified column names are ambiguous there. Callers
 * pass `'n.'`; everything else keeps the bare form it always had.
 */
function buildNodeFilter(
	filter: GraphListFilter,
	as: string = ''
): { where: string[]; params: unknown[] } {
	const where: string[] = [];
	const params: unknown[] = [];

	appendProjectFilter(filter, where, params, as);
	if (filter.kinds?.length) {
		where.push(`${as}kind IN (${filter.kinds.map(() => '?').join(',')})`);
		params.push(...filter.kinds);
	}
	if (filter.subkinds?.length) {
		where.push(`${as}subkind IN (${filter.subkinds.map(() => '?').join(',')})`);
		params.push(...filter.subkinds);
	}
	if (filter.scopes?.length) {
		where.push(`${as}scope IN (${filter.scopes.map(() => '?').join(',')})`);
		params.push(...filter.scopes);
	}
	if (filter.sources?.length) {
		where.push(`${as}source IN (${filter.sources.map(() => '?').join(',')})`);
		params.push(...filter.sources);
	}

	if (filter.archivedOnly) where.push(`${as}archived_at IS NOT NULL`);
	else if (!filter.includeArchived) where.push(`${as}archived_at IS NULL`);

	// The graph view shows current beliefs. Superseded ones stay reachable by
	// walking a `supersedes` edge from the node that replaced them, which is where
	// that history belongs.
	if (!filter.includeSuperseded) where.push(`${as}superseded_by IS NULL`);

	return { where, params };
}

export const graphQueries = {
	// ── nodes ───────────────────────────────────────────────────────────────

	/**
	 * Insert a node, or reinforce the existing one with the same digest.
	 *
	 * Reinforcement is what keeps a re-observed memory ranked above a one-off:
	 * `weight` grows sub-linearly (capped) and confidence takes the higher of the
	 * two. The label/body are refreshed because a later extraction usually phrases
	 * the same claim better, but a user-authored node is never overwritten by an
	 * automatic one — hand-written memory outranks inference.
	 */
	upsert(input: GraphNodeInput): GraphNode {
		const db = getDatabase();
		const digest = input.digest ?? deriveDigest(input);
		const projectId = input.projectId ?? null;

		const existing = db
			.prepare(
				`SELECT * FROM graph_nodes
				 WHERE COALESCE(project_id, '') = COALESCE(?, '') AND kind = ? AND digest = ?`
			)
			.get(projectId, input.kind, digest) as GraphNodeRow | null;

		if (existing) {
			const source = input.source ?? 'agent';
			const keepText = existing.source === 'user' && source !== 'user';
			const label = keepText ? existing.label : input.label;
			const body = keepText ? existing.body : (input.body ?? existing.body);

			// Authority only ever climbs. A memory the user stated, re-observed later
			// by a model that could not tell who said it, must not quietly demote to
			// `inferred` and lose its place in the standing-instructions block.
			const assertedBy =
				AUTHORITY_RANK[(input.assertedBy ?? 'inferred') as GraphNode['assertedBy']] >
				AUTHORITY_RANK[(existing.asserted_by ?? 'inferred') as GraphNode['assertedBy']]
					? (input.assertedBy as string)
					: (existing.asserted_by ?? 'inferred');

			// Reach climbs too: once something has been judged to travel, a later
			// write that failed to notice does not lock it back into one repository.
			const reach = input.reach === 'anywhere' || existing.reach === 'anywhere' ? 'anywhere' : 'here';
			const reachJudged = input.reachJudged || existing.reach_judged === 1 ? 1 : 0;

			// `stale_at` is cleared: the memory has just been re-observed, which is
			// exactly the evidence that it survived whatever code change marked it
			// stale. `superseded_by` is deliberately NOT cleared — that was a
			// judgement about which of two beliefs is current, and re-stating the old
			// one is not grounds to overturn it. Revision has to overturn revision.
			db.prepare(
				`UPDATE graph_nodes
				 SET label = ?, body = ?, weight = MIN(weight + 0.25, 10.0),
				     confidence = MAX(confidence, ?), stale_at = NULL,
				     asserted_by = ?, reach = ?, reach_judged = ?,
				     updated_at = CURRENT_TIMESTAMP
				 WHERE id = ?`
			).run(
				label,
				body,
				input.confidence ?? existing.confidence,
				assertedBy,
				reach,
				reachJudged,
				existing.id
			);

			this.syncFts(existing.id);
			return this.getById(existing.id)!;
		}

		const id = nanoid();
		db.prepare(
			`INSERT INTO graph_nodes (
				id, kind, subkind, scope, project_id, session_id, label, body,
				path, symbol, language, digest, confidence, source, pinned,
				entity_key, digest_version, asserted_by, reach, reach_judged
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			input.kind,
			input.subkind,
			input.scope ?? (projectId ? 'project' : 'global'),
			projectId,
			input.sessionId ?? null,
			input.label,
			input.body ?? '',
			input.path ?? null,
			input.symbol ?? null,
			input.language ?? null,
			digest,
			input.confidence ?? 0.5,
			input.source ?? 'agent',
			input.pinned ? 1 : 0,
			input.entityKey ?? null,
			DIGEST_VERSION,
			input.assertedBy ?? 'inferred',
			// Structural nodes are a repository's files and never travel, whatever a
			// caller passes.
			input.kind === 'structural' ? 'here' : (input.reach ?? 'here'),
			input.kind === 'structural' || input.reachJudged ? 1 : 0
		);

		this.syncFts(id);
		return this.getById(id)!;
	},

	getById(id: string): GraphNode | null {
		const row = getDatabase().prepare(`SELECT * FROM graph_nodes WHERE id = ?`).get(id) as GraphNodeRow | null;
		return row ? toNode(row) : null;
	},

	getByIds(ids: string[]): GraphNode[] {
		if (ids.length === 0) return [];
		const rows = getDatabase()
			.prepare(`SELECT * FROM graph_nodes WHERE id IN ${ID_SET}`)
			.all(idSet(ids)) as GraphNodeRow[];
		return rows.map(toNode);
	},

	/** Structural node for a repo-relative path, when one exists. */
	getByPath(projectId: string | null, path: string): GraphNode | null {
		const row = getDatabase()
			.prepare(
				`SELECT * FROM graph_nodes
				 WHERE COALESCE(project_id, '') = COALESCE(?, '') AND kind = 'structural' AND path = ?
				 ORDER BY CASE subkind WHEN 'file' THEN 0 ELSE 1 END
				 LIMIT 1`
			)
			.get(projectId, path) as GraphNodeRow | null;
		return row ? toNode(row) : null;
	},

	/**
	 * Edit the human-facing fields of a node (the graph editor's save path).
	 *
	 * `source` is a PARAMETER, not a constant, and getting that wrong was quietly
	 * expensive. This used to hard-code `'user'`, and the MCP `update` action goes
	 * through here — so one edit by an agent made the node permanently exempt from
	 * structural decay (`markStale` skips `source = 'user'`), from eviction, and
	 * from consolidation, while the injected block advertised it to every future
	 * turn as "stated by user". A model's correction was being given a human's
	 * authority.
	 */
	update(
		id: string,
		patch: Partial<Pick<GraphNode, 'label' | 'body' | 'subkind' | 'scope' | 'confidence' | 'pinned' | 'reach'>>,
		source: GraphSource = 'user'
	): GraphNode | null {
		const db = getDatabase();
		const current = this.getById(id);
		if (!current) return null;

		db.prepare(
			`UPDATE graph_nodes
			 SET label = ?, body = ?, subkind = ?, scope = ?, confidence = ?, pinned = ?,
			     source = ?, asserted_by = ?, reach = ?, reach_judged = 1,
			     updated_at = CURRENT_TIMESTAMP
			 WHERE id = ?`
		).run(
			patch.label ?? current.label,
			patch.body ?? current.body,
			patch.subkind ?? current.subkind,
			patch.scope ?? current.scope,
			patch.confidence ?? current.confidence,
			(patch.pinned ?? current.pinned) ? 1 : 0,
			source,
			// A person editing a memory adopts it; an agent editing one does not get
			// to promote it to the user's word. Same reasoning as `source` being a
			// parameter here rather than a constant.
			source === 'user' ? 'user' : current.assertedBy,
			current.kind === 'structural' ? 'here' : (patch.reach ?? current.reach),
			id
		);

		// A hand-edited node's text no longer matches its derived digest; leaving
		// the old one would let the next automatic extraction of the ORIGINAL text
		// overwrite the edit. Re-deriving re-parents identity onto what the user
		// actually wrote.
		const updated = this.getById(id)!;
		if (updated.kind === 'episodic') {
			const digest = deriveDigest({
				kind: updated.kind,
				subkind: updated.subkind,
				label: updated.label,
				body: updated.body
			});
			const clash = db
				.prepare(
					`SELECT id FROM graph_nodes
					 WHERE COALESCE(project_id, '') = COALESCE(?, '') AND kind = ? AND digest = ? AND id != ?`
				)
				.get(updated.projectId, updated.kind, digest, id) as { id: string } | null;
			if (!clash) db.prepare(`UPDATE graph_nodes SET digest = ? WHERE id = ?`).run(digest, id);
		}

		this.syncFts(id);
		// The vector describes text that just changed, so it must be recomputed.
		db.prepare(`DELETE FROM graph_vectors WHERE node_id = ?`).run(id);
		return this.getById(id);
	},

	/** Soft-delete: leaves edges intact so the reasoning path is still visible. */
	archive(id: string): void {
		getDatabase().prepare(`UPDATE graph_nodes SET archived_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
		this.dropFts([id]);
	},

	/** Batch soft-delete — the same statement per node, one FTS sweep. */
	archiveNodes(ids: string[]): number {
		if (ids.length === 0) return 0;
		const placeholders = ids.map(() => '?').join(',');
		getDatabase()
			.prepare(
				`UPDATE graph_nodes SET archived_at = CURRENT_TIMESTAMP
				 WHERE id IN (${placeholders}) AND archived_at IS NULL`
			)
			.run(...ids);
		this.dropFts(ids);
		return ids.length;
	},

	/**
	 * Bring memories back into recall.
	 *
	 * Clears BOTH kinds of "no longer recalled", because from the Forgotten list
	 * they are one list and a Restore that silently skipped half of it would be
	 * worse than no Restore at all. Archiving says "this was never true";
	 * superseding says "something newer replaced it". Both are judgements the
	 * graph made on its own — supersession by a model reading a transcript — so
	 * both have to be reversible by the person who disagrees, or "reversible" is a
	 * property of the schema rather than of the product.
	 *
	 * The `supersedes` edge is removed with it: leaving it would draw a claim in
	 * the graph view that is no longer being made.
	 */
	restoreNodes(ids: string[]): number {
		if (ids.length === 0) return 0;
		const db = getDatabase();
		const placeholders = ids.map(() => '?').join(',');

		return this.transaction(() => {
			const rows = db
				.prepare(
					`SELECT id, superseded_by FROM graph_nodes
					 WHERE id IN (${placeholders}) AND (archived_at IS NOT NULL OR superseded_by IS NOT NULL)`
				)
				.all(...ids) as { id: string; superseded_by: string | null }[];
			if (rows.length === 0) return 0;

			const live = rows.map(row => row.id);
			const livePlaceholders = live.map(() => '?').join(',');
			db.prepare(
				`UPDATE graph_nodes SET archived_at = NULL, superseded_by = NULL, updated_at = CURRENT_TIMESTAMP
				 WHERE id IN (${livePlaceholders})`
			).run(...live);

			for (const row of rows) {
				if (!row.superseded_by) continue;
				db.prepare(`DELETE FROM graph_edges WHERE src_id = ? AND dst_id = ? AND rel = 'supersedes'`).run(
					row.superseded_by,
					row.id
				);
			}

			for (const id of live) this.syncFts(id);
			return live.length;
		});
	},

	restore(id: string): void {
		this.restoreNodes([id]);
	},

	/** Hard-delete. Edges and the vector cascade; the FTS mirror is manual. */
	remove(id: string): void {
		this.dropFts([id]);
		getDatabase().prepare(`DELETE FROM graph_nodes WHERE id = ?`).run(id);
	},

	/** The canonical node for an entity, if one has been created. */
	getByEntityKey(projectId: string | null, entityKey: string): GraphNode | null {
		const row = getDatabase()
			.prepare(
				`SELECT * FROM graph_nodes
				 WHERE COALESCE(project_id, '') = COALESCE(?, '') AND entity_key = ?`
			)
			.get(projectId, entityKey) as GraphNodeRow | null;
		return row ? toNode(row) : null;
	},

	/**
	 * Structural nodes for a set of repo-relative paths, in one query.
	 *
	 * Used to turn the files a session is working in into retrieval seeds, so the
	 * lookup happens once per turn rather than once per path.
	 */
	getByPaths(projectId: string | null, paths: string[]): GraphNode[] {
		if (paths.length === 0) return [];
		const placeholders = paths.map(() => '?').join(',');
		const rows = getDatabase()
			.prepare(
				`SELECT * FROM graph_nodes
				 WHERE COALESCE(project_id, '') = COALESCE(?, '')
				   AND kind = 'structural' AND subkind = 'file'
				   AND archived_at IS NULL AND path IN (${placeholders})`
			)
			.all(projectId, ...paths) as GraphNodeRow[];
		return rows.map(toNode);
	},

	/**
	 * Mark `oldId` as replaced by `newId`: belief revision.
	 *
	 * DESTRUCTIVE, and therefore RESERVED FOR PEOPLE. This is the one operation in
	 * the feature that removes a memory from every future recall in a single step,
	 * and it used to be driven by a model's opinion of one turn. Measured, that
	 * opinion retired a hand-written standing rule in one run out of two, on the
	 * strength of a task-local exception the model itself flagged as possibly "a
	 * specific exception for this task".
	 *
	 * Automatic contradiction handling now writes a `contradicts` edge instead and
	 * lets the read path pick a winner on every turn (see `resolveConflicts`). A
	 * wrong verdict there costs one mis-ranked line; a wrong verdict here costs a
	 * memory. Callers that are not acting on a person's explicit instruction should
	 * use `contradict()`.
	 *
	 * The old node is NOT archived. Archiving would say "this was never true";
	 * superseding says "this was true and is not any more", which is a different
	 * claim and the one worth keeping — the edge is what lets someone ask why the
	 * current belief is what it is. It simply stops being retrieved.
	 *
	 * A chain is collapsed rather than followed: if A already superseded B, and C
	 * now supersedes A, B is repointed at C too. Otherwise "is this current?"
	 * would need a recursive walk on the read path, which runs every turn.
	 */
	supersede(oldId: string, newId: string): boolean {
		if (oldId === newId) return false;
		const db = getDatabase();
		const older = this.getById(oldId);
		const newer = this.getById(newId);
		if (!older || !newer) return false;
		// Refuse to point the new belief at itself through a cycle.
		if (newer.supersededBy === oldId) return false;

		// Authority never runs downhill. A memory the user stated cannot be retired
		// by one the assistant asserted or a model inferred, however recent or
		// confident. The disagreement is still real, so the caller's contradiction
		// edge (written by `contradict`) is what carries it instead.
		if (AUTHORITY_RANK[older.assertedBy] > AUTHORITY_RANK[newer.assertedBy]) {
			debug.log(
				'memory',
				`Refused supersession: ${newer.assertedBy}-asserted memory cannot retire a ${older.assertedBy}-asserted one`
			);
			return false;
		}

		// Durability never runs uphill either. A one-off instruction is an exception
		// being taken, not a rule being repealed, and a claim about one repository
		// does not settle a claim about how the user works everywhere.
		const DURABILITY: Record<GraphScope, number> = { session: 0, project: 1, global: 2 };
		if (DURABILITY[newer.scope] < DURABILITY[older.scope]) {
			debug.log('memory', `Refused supersession: ${newer.scope}-scoped memory cannot retire a ${older.scope}-scoped one`);
			return false;
		}

		db.prepare(`UPDATE graph_nodes SET superseded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
			newId,
			oldId
		);
		db.prepare(`UPDATE graph_nodes SET superseded_by = ? WHERE superseded_by = ?`).run(newId, oldId);

		this.link({ srcId: newId, dstId: oldId, rel: 'supersedes', source: 'agent' });
		// Out of the lexical index for the same reason it is out of retrieval.
		this.dropFts([oldId]);
		return true;
	},

	/**
	 * Record that two memories make claims that cannot both be current.
	 *
	 * This is what automatic revision writes instead of superseding, and the whole
	 * difference is that NOTHING IS REMOVED. Both memories stay live, stay
	 * searchable, stay in the graph view; the read path decides on each turn which
	 * of them to hand to the agent, and the user can see the disagreement and
	 * settle it.
	 *
	 * The reasoning is asymmetric in a way the old design ignored. A model reading
	 * one turn is guessing at whether a rule was repealed or an exception taken —
	 * it cannot see the next turn, or the user's face. Freezing that guess into a
	 * destructive write meant a bad guess was unrecoverable in practice, because
	 * nobody reviews a store that is working. Freezing it into an EDGE means a bad
	 * guess is one line ranked wrongly, re-decided from scratch every turn against
	 * evidence that keeps arriving.
	 *
	 * Both directions are stored as one edge from the newer claim to the older, so
	 * "what does this disagree with" is a single indexed lookup either way.
	 */
	contradict(newId: string, oldId: string): boolean {
		if (newId === oldId) return false;
		if (!this.getById(newId) || !this.getById(oldId)) return false;
		return this.link({ srcId: newId, dstId: oldId, rel: 'contradicts', source: 'agent' }) !== null;
	},

	// ── entities ────────────────────────────────────────────────────────────

	/**
	 * Record what a memory is about, replacing whatever was recorded before.
	 *
	 * Replace rather than append, because extraction re-reads the same memory
	 * whenever it is reinforced and a later reading is a better one — appending
	 * would accumulate every phrasing the model ever used for the same subject,
	 * which is the failure the canonical key exists to prevent.
	 *
	 * Re-syncs the lexical index, since the names are part of the memory's
	 * searchable text now rather than nodes of their own.
	 */
	setEntities(nodeId: string, entities: { key: string; name: string }[]): number {
		const db = getDatabase();
		db.prepare(`DELETE FROM graph_node_entities WHERE node_id = ?`).run(nodeId);
		const insert = db.prepare(
			`INSERT OR IGNORE INTO graph_node_entities (node_id, entity_key, name) VALUES (?, ?, ?)`
		);
		for (const entity of entities) insert.run(nodeId, entity.key, entity.name);
		this.syncFts(nodeId);
		return entities.length;
	},

	/** The names a memory was recorded as being about. */
	entityNamesOf(nodeId: string): string[] {
		return (
			getDatabase().prepare(`SELECT name FROM graph_node_entities WHERE node_id = ?`).all(nodeId) as {
				name: string;
			}[]
		).map(row => row.name);
	},

	/** Names for many memories at once, for listings and the graph view. */
	entityNamesFor(nodeIds: string[]): Map<string, string[]> {
		const byNode = new Map<string, string[]>();
		if (nodeIds.length === 0) return byNode;
		const rows = getDatabase()
			.prepare(
				`SELECT node_id, name FROM graph_node_entities WHERE node_id IN ${ID_SET}`
			)
			.all(idSet(nodeIds)) as { node_id: string; name: string }[];
		for (const row of rows) {
			const names = byNode.get(row.node_id);
			if (names) names.push(row.name);
			else byNode.set(row.node_id, [row.name]);
		}
		return byNode;
	},

	/**
	 * Edges DERIVED from two memories being about the same subject.
	 *
	 * Removing similarity linking removed almost all of the graph's structure —
	 * 371 edges became 6 — and that was an over-correction with a visible cost: the
	 * view turned into a field of disconnected dots. What was wrong with those 144
	 * edges was never that they connected memories; it was that COSINE decided
	 * which ones. Two memories are related when they are about the same THING, not
	 * when they are phrased alike, and extraction already records what each memory
	 * is about.
	 *
	 * So the relation is stated rather than inferred, and it is derived at READ
	 * time rather than stored: nothing to keep in sync, nothing to repair when a
	 * memory's entities are rewritten, and no way for an edge to outlive the claim
	 * it came from.
	 *
	 * Two bounds, both about hubs.
	 *
	 * A subject shared by a large slice of the graph is not a relationship, it is a
	 * word everyone happens to use. "TypeScript" across forty memories says nothing
	 * about any two of them, and connecting them all would recreate the
	 * fabricated-structure problem from a different cause. `MAX_SUBJECT_MEMBERS`
	 * drops those.
	 *
	 * And within a subject each memory links only to the few strongest members
	 * rather than to all of them. A clique of thirteen is seventy-eight lines
	 * saying one thing; bounded degree says the same thing, keeps the cluster
	 * visible, and stays linear as the graph grows.
	 */
	derivedEdges(nodeIds: string[]): { srcId: string; dstId: string; weight: number; via: 'subject' | 'project' }[] {
		if (nodeIds.length < 2) return [];

		/** Above this a group is a common word rather than a shared topic. */
		const MAX_GROUP_MEMBERS = 24;
		/** Links each memory draws per group, toward the heaviest members. */
		const LINKS_PER_MEMBER = 4;

		const set = idSet(nodeIds);
		const edges: { srcId: string; dstId: string; weight: number; via: 'subject' | 'project' }[] = [];
		const seen = new Set<string>();

		/** Chain a group's members, heaviest first, into bounded-degree edges. */
		const connect = (members: string[], weight: number, via: 'subject' | 'project'): void => {
			if (members.length < 2 || members.length > MAX_GROUP_MEMBERS) return;
			for (let i = 0; i < members.length; i++) {
				for (let j = i + 1; j < Math.min(members.length, i + 1 + LINKS_PER_MEMBER); j++) {
					const [a, b] = members[i] < members[j] ? [members[i], members[j]] : [members[j], members[i]];
					const key = `${a}|${b}`;
					if (seen.has(key)) continue;
					seen.add(key);
					edges.push({ srcId: a, dstId: b, weight, via });
				}
			}
		};

		// ── shared subject ───────────────────────────────────────────────────
		const rows = getDatabase()
			.prepare(
				`SELECT e.entity_key AS groupKey, e.node_id AS nodeId
				 FROM graph_node_entities e
				 INNER JOIN graph_nodes n ON n.id = e.node_id
				 WHERE e.node_id IN ${ID_SET}
				 ORDER BY e.entity_key, n.weight DESC, n.updated_at DESC`
			)
			.all(set) as { groupKey: string; nodeId: string }[];
		// Appended, not rebuilt. Spreading the existing array on every row made this
		// quadratic in the size of a group — invisible for the subject groups, which
		// are capped at two dozen, and the dominant cost of the whole call for the
		// project groups, which routinely run to hundreds before the size check
		// below discards them.
		const bySubject = new Map<string, string[]>();
		for (const row of rows) {
			const members = bySubject.get(row.groupKey);
			if (members) members.push(row.nodeId);
			else bySubject.set(row.groupKey, [row.nodeId]);
		}
		// `members` is heaviest-first, so linking forward attaches the tail of a
		// subject to its most reinforced memories rather than to whichever happened
		// to be written first.
		for (const members of bySubject.values()) connect(members, 1, 'subject');

		// ── same codebase ────────────────────────────────────────────────────
		// Weaker on purpose. Two memories about tunnelkit are related BECAUSE they
		// are about tunnelkit; two memories that merely live in the same repository
		// are related the way two books on one shelf are. Louvain reads the weight,
		// so a project holds together only where subjects do not already say more.
		//
		// It also catches what nothing else can. Eleven memories in the real graph
		// named no subject at all — extraction simply left the field empty — and
		// they are exactly the "the calculator app has three modes" kind of note
		// that clearly belongs with its neighbours and had no way to say so.
		const projectRows = getDatabase()
			.prepare(
				`SELECT project_id AS groupKey, id AS nodeId FROM graph_nodes
				 WHERE id IN ${ID_SET} AND project_id IS NOT NULL AND kind = 'episodic'
				 ORDER BY project_id, weight DESC, updated_at DESC`
			)
			.all(set) as { groupKey: string; nodeId: string }[];
		const byProject = new Map<string, string[]>();
		for (const row of projectRows) {
			const members = byProject.get(row.groupKey);
			if (members) members.push(row.nodeId);
			else byProject.set(row.groupKey, [row.nodeId]);
		}
		for (const members of byProject.values()) connect(members, 0.4, 'project');

		return edges;
	},

	/** Ids sharing a subject with `nodeId`, for one hop of traversal. */
	entityNeighbourIds(nodeId: string, limit = 12): string[] {
		try {
			return (
				getDatabase()
					.prepare(
						`SELECT DISTINCT other.node_id AS id
						 FROM graph_node_entities mine
						 INNER JOIN graph_node_entities other ON other.entity_key = mine.entity_key
						 INNER JOIN graph_nodes n ON n.id = other.node_id
						 WHERE mine.node_id = ? AND other.node_id <> ?
						   AND n.archived_at IS NULL AND n.superseded_by IS NULL
						 ORDER BY n.weight DESC, n.updated_at DESC
						 LIMIT ?`
					)
					.all(nodeId, nodeId, limit) as { id: string }[]
			).map(row => row.id);
		} catch {
			return [];
		}
	},

	/**
	 * Every memory recorded as being about one subject.
	 *
	 * This is what the entity NODE existed to answer, and it answers it better:
	 * an index seek returning the memories themselves, rather than a hop into a
	 * hub and back out through whichever of its edges survived the activation
	 * split.
	 */
	memoriesAboutEntity(key: string, limit = 20): GraphNode[] {
		try {
			const rows = getDatabase()
				.prepare(
					`SELECT n.* FROM graph_node_entities e
					 INNER JOIN graph_nodes n ON n.id = e.node_id
					 WHERE e.entity_key = ? AND n.archived_at IS NULL AND n.superseded_by IS NULL
					 ORDER BY n.weight DESC, n.updated_at DESC
					 LIMIT ?`
				)
				.all(key, limit) as GraphNodeRow[];
			return rows.map(toNode);
		} catch {
			return [];
		}
	},

	/** Live memories that contradict any of `ids`, in both directions. */
	contradictionsFor(ids: string[]): { srcId: string; dstId: string }[] {
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => '?').join(',');
		return getDatabase()
			.prepare(
				`SELECT src_id AS srcId, dst_id AS dstId FROM graph_edges
				 WHERE rel = 'contradicts' AND (src_id IN (${placeholders}) OR dst_id IN (${placeholders}))`
			)
			.all(...ids, ...ids) as { srcId: string; dstId: string }[];
	},

	/**
	 * The claims that hold on every turn regardless of what was asked.
	 *
	 * Retrieval cannot deliver these, and no amount of ranking will fix that. A
	 * standing instruction has no topical overlap with "analyse this project", so
	 * similarity search will always rank it below whatever the question was
	 * actually about — measured, human-stated rules reached the prompt on 3 of 20
	 * opportunities. Worse, static embeddings cannot represent negation, so a query
	 * that states a prohibition retrieves the permission: asking "jangan gunakan
	 * agent tool" returned "requested use of agent tool" as the top hit.
	 *
	 * So they are not retrieved at all. They are SELECTED — structurally, by who
	 * asserted them and how durable they are — and prepended to every turn.
	 *
	 * `session`-scoped rows are excluded: a one-off instruction belongs to the turn
	 * that gave it, and the engine still has that turn in its own history.
	 */
	standingInstructions(projectId: string | null, limit: number): GraphNode[] {
		const rows = getDatabase()
			.prepare(
				`SELECT * FROM graph_nodes
				 WHERE kind = 'episodic'
				   AND archived_at IS NULL AND superseded_by IS NULL
				   AND scope IN ('project', 'global')
				   AND subkind IN ('preference', 'decision', 'pattern')
				   AND (asserted_by = 'user' OR pinned = 1)
				   AND (project_id IS NULL OR project_id = ?)
				   AND confidence >= 0.3
				 ORDER BY pinned DESC,
				          CASE subkind WHEN 'preference' THEN 0 WHEN 'decision' THEN 1 ELSE 2 END,
				          updated_at DESC
				 LIMIT ?`
			)
			.all(projectId, limit) as GraphNodeRow[];
		return rows.map(toNode);
	},

	/**
	 * Record what a later turn did with a memory that was handed to it.
	 *
	 * This is the only evidence in the system that a memory is any good.
	 * `access_count` records that a memory was RETRIEVED, which is a fact about
	 * the ranker rather than about the memory, and letting it feed back into
	 * ranking is how popular memories crowd out correct ones.
	 *
	 * `wrong` costs confidence rather than deleting: one turn misreading a memory
	 * should not destroy it, but three should push it below the injection floor.
	 */
	recordFeedback(id: string, verdict: 'used' | 'wrong' | 'ignored'): void {
		const db = getDatabase();
		if (verdict === 'used') {
			db.prepare(
				`UPDATE graph_nodes
				 SET useful_count = useful_count + 1,
				     weight = MIN(weight + 0.5, 10.0),
				     confidence = MIN(confidence + 0.05, 1.0)
				 WHERE id = ?`
			).run(id);
			return;
		}
		if (verdict === 'wrong') {
			db.prepare(
				`UPDATE graph_nodes
				 SET unhelpful_count = unhelpful_count + 1,
				     confidence = MAX(confidence - 0.2, 0.05)
				 WHERE id = ?`
			).run(id);
			return;
		}
		// 'ignored' is weak evidence — most memories in a block are irrelevant to
		// the turn through no fault of their own — so it is counted and nothing else.
		db.prepare(`UPDATE graph_nodes SET unhelpful_count = unhelpful_count + 1 WHERE id = ?`).run(id);
	},

	/**
	 * Mark memories as standing on code that has since changed.
	 *
	 * Decay is per subkind because the subkinds age differently: an `observation`
	 * about how a file works is invalidated by that file being rewritten, while a
	 * `decision` about why it was written that way survives the rewrite — the
	 * decision is the reason the change happened. Applying one rate to both would
	 * either keep stale observations or destroy durable decisions.
	 */
	markStale(nodeIds: string[], factorBySubkind: Record<string, number>, coolOffHours = 6): number {
		if (nodeIds.length === 0) return 0;
		const db = getDatabase();
		let touched = 0;
		// The cool-off is what stops decay COMPOUNDING per turn. Without it, editing
		// one file across ten turns multiplies every observation about it by
		// 0.82 ten times over — 0.14, below the injection floor — so an ordinary
		// afternoon of iteration silently destroys everything the graph knew about
		// the file being worked on. One code change is one piece of evidence,
		// however many times it is saved.
		const update = db.prepare(
			`UPDATE graph_nodes
			 SET confidence = MAX(confidence * ?, 0.05), stale_at = CURRENT_TIMESTAMP
			 WHERE id = ? AND pinned = 0 AND source != 'user'
			   AND (stale_at IS NULL OR stale_at < datetime('now', ?))`
		);
		const window = `-${Math.max(0, Math.round(coolOffHours))} hours`;
		for (const node of this.getByIds(nodeIds)) {
			const factor = factorBySubkind[node.subkind];
			if (factor === undefined || factor >= 1) continue;
			const result = update.run(factor, node.id, window) as { changes?: number };
			if (Number(result.changes ?? 0) > 0) touched++;
		}
		return touched;
	},

	/**
	 * Memories that claim something about any of these code nodes, in one query.
	 *
	 * `about` points memory → code, so the memory is always the source. Replaces a
	 * per-file `edgesOf` loop that pulled every edge of every changed file — on a
	 * turn touching sixty files, most of them `defines` and `imports` edges that
	 * invalidation has no interest in.
	 */
	memoriesAbout(codeNodeIds: string[]): string[] {
		if (codeNodeIds.length === 0) return [];
		const placeholders = codeNodeIds.map(() => '?').join(',');
		const rows = getDatabase()
			.prepare(
				`SELECT DISTINCT e.src_id AS id FROM graph_edges e
				 INNER JOIN graph_nodes n ON n.id = e.src_id
				 WHERE e.rel = 'about' AND e.dst_id IN (${placeholders})
				   AND n.archived_at IS NULL AND n.superseded_by IS NULL`
			)
			.all(...codeNodeIds) as { id: string }[];
		return rows.map(row => row.id);
	},

	/**
	 * Run `fn` inside one SQLite transaction.
	 *
	 * Structural ingestion performs several thousand statements per busy turn
	 * (a file upsert is a SELECT, an INSERT/UPDATE and an FTS rewrite, and a file
	 * can define 25 symbols). Outside a transaction each one is its own durability
	 * barrier, which is the single largest cost on the write path.
	 */
	transaction<T>(fn: () => T): T {
		const db = getDatabase();
		// Not every driver exposes transactions (see `DatabaseConnection`). Running
		// the block unbatched is the correct degradation: slower, identical result.
		return db.transaction ? db.transaction(fn)() : fn();
	},

	/** Record that retrieval surfaced these nodes, feeding the usage signal. */
	markAccessed(ids: string[]): void {
		if (ids.length === 0) return;
		const placeholders = ids.map(() => '?').join(',');
		getDatabase()
			.prepare(
				`UPDATE graph_nodes
				 SET access_count = access_count + 1, accessed_at = CURRENT_TIMESTAMP
				 WHERE id IN (${placeholders})`
			)
			.run(...ids);
	},

	// ── FTS mirror ──────────────────────────────────────────────────────────

	/**
	 * Rewrite one node's row in the lexical index. Archived nodes are removed.
	 *
	 * The delete goes through `fts_rowid`, NOT through `node_id`, and that is the
	 * difference between this being free and this being the most expensive
	 * statement on the write path. `graph_nodes_fts` is a standalone FTS5 table
	 * whose `node_id` is UNINDEXED, so `WHERE node_id = ?` is a full scan of the
	 * content table — and this function runs on every upsert, which on a busy turn
	 * means fifteen hundred full scans of a table that only grows (migration 066).
	 * A rowid is a primary key, so the same delete is a lookup.
	 */
	syncFts(id: string): void {
		const db = getDatabase();
		const current = db.prepare(`SELECT fts_rowid FROM graph_nodes WHERE id = ?`).get(id) as {
			fts_rowid: number | null;
		} | null;
		if (current?.fts_rowid != null) {
			db.prepare(`DELETE FROM graph_nodes_fts WHERE rowid = ?`).run(current.fts_rowid);
		}

		const node = this.getById(id);
		if (!node || node.archivedAt || node.supersededBy) {
			if (current?.fts_rowid != null) {
				db.prepare(`UPDATE graph_nodes SET fts_rowid = NULL WHERE id = ?`).run(id);
			}
			return;
		}

		const text = indexedText({ ...node, entityNames: this.entityNamesOf(id) });
		if (!text) {
			db.prepare(`UPDATE graph_nodes SET fts_rowid = NULL WHERE id = ?`).run(id);
			return;
		}

		const result = db
			.prepare(`INSERT INTO graph_nodes_fts (node_id, project_id, scope, kind, text) VALUES (?, ?, ?, ?, ?)`)
			.run(id, node.projectId ?? '', node.scope, node.kind, text) as { lastInsertRowid?: number | bigint };
		db.prepare(`UPDATE graph_nodes SET fts_rowid = ? WHERE id = ?`).run(
			Number(result.lastInsertRowid ?? 0),
			id
		);
	},

	/**
	 * Drop a set of nodes from the lexical index in one statement.
	 *
	 * Same rowid argument as `syncFts`, applied to the batch paths — archiving a
	 * deleted file's symbols, purging a project, collapsing duplicates. The
	 * sub-select is index-covered on `graph_nodes.id`, so the FTS side only ever
	 * sees primary keys.
	 */
	dropFts(ids: string[]): void {
		if (ids.length === 0) return;
		const db = getDatabase();
		const placeholders = ids.map(() => '?').join(',');
		db.prepare(
			`DELETE FROM graph_nodes_fts
			 WHERE rowid IN (SELECT fts_rowid FROM graph_nodes WHERE id IN (${placeholders}) AND fts_rowid IS NOT NULL)`
		).run(...ids);
		db.prepare(`UPDATE graph_nodes SET fts_rowid = NULL WHERE id IN (${placeholders})`).run(...ids);
	},

	/**
	 * Turn free-typed text into a safe FTS5 MATCH query: quoted prefix terms
	 * OR-ed together. Quoting is the injection guard — no user character can
	 * reach FTS5 as syntax.
	 *
	 * Unlike `sessionQueries.buildFtsQuery`, punctuation SPLITS a word instead of
	 * being stripped from it. That difference matters here because this index
	 * holds code: stripping would turn `stream-manager` into `streammanager`,
	 * which matches nothing, whereas splitting yields `stream` and `manager` —
	 * the same tokens FTS5 stored for the path.
	 *
	 * Terms are OR-ed rather than AND-ed because retrieval is a ranking problem,
	 * not a filter: a node matching three of four terms should still be offered,
	 * with BM25 deciding how highly. Single-character terms are dropped, since as
	 * prefixes they match a large share of the index and swamp the ranking.
	 */
	buildFtsQuery(raw: string): string | null {
		const terms = [
			...new Set(
				raw
					.split(/[^\p{L}\p{N}]+/u)
					.filter(t => t.length > 1)
					.map(t => t.toLowerCase())
			)
		];
		if (terms.length === 0) return null;

		// The term count is CAPPED, and not for tidiness. Two callers pass long text
		// here: a user who pasted a stack trace into chat, and belief revision, which
		// deliberately queries with four thousand characters of transcript. Both
		// produce hundreds of OR-ed prefix terms — every one of them a separate index
		// range scan, over a parse tree deep enough to hit SQLite's expression-depth
		// limit. That throws, retrieval catches it, and the lexical channel silently
		// disappears for exactly the queries that had the most to say.
		//
		// Longest first is a rough proxy for most selective: `EngineNotReadyError`
		// discriminates, `the` does not, and a prefix search on a short common word
		// matches a large share of the index while contributing nothing to the
		// ranking.
		if (terms.length > MAX_FTS_TERMS) {
			terms.sort((a, b) => b.length - a.length);
			terms.length = MAX_FTS_TERMS;
		}
		return terms.map(t => `"${t}"*`).join(' OR ');
	},

	// ── edges ───────────────────────────────────────────────────────────────

	/**
	 * Create an edge, or strengthen it when it already exists. Self-loops are
	 * rejected: they carry no information and would make traversal double-count
	 * a node's own weight.
	 */
	link(input: GraphEdgeInput): GraphEdge | null {
		if (input.srcId === input.dstId) return null;

		const db = getDatabase();
		const existing = db
			.prepare(`SELECT * FROM graph_edges WHERE src_id = ? AND dst_id = ? AND rel = ?`)
			.get(input.srcId, input.dstId, input.rel) as GraphEdgeRow | null;

		if (existing) {
			db.prepare(`UPDATE graph_edges SET weight = MIN(weight + 0.25, 10.0) WHERE id = ?`).run(existing.id);
			return toEdge(
				db.prepare(`SELECT * FROM graph_edges WHERE id = ?`).get(existing.id) as GraphEdgeRow
			);
		}

		try {
			const result = db
				.prepare(`INSERT INTO graph_edges (src_id, dst_id, rel, weight, source) VALUES (?, ?, ?, ?, ?)`)
				.run(input.srcId, input.dstId, input.rel, input.weight ?? 1.0, input.source ?? 'agent') as {
				lastInsertRowid?: number | bigint;
			};
			return toEdge(
				db.prepare(`SELECT * FROM graph_edges WHERE id = ?`).get(Number(result.lastInsertRowid)) as GraphEdgeRow
			);
		} catch (error) {
			// Foreign keys are ON, so linking a node that has since been deleted
			// fails here rather than leaving a dangling edge.
			debug.warn('memory', `Failed to link ${input.srcId} -[${input.rel}]-> ${input.dstId}`, error);
			return null;
		}
	},

	/** Every edge touching a node, in either direction. */
	edgesOf(nodeId: string): GraphEdge[] {
		const rows = getDatabase()
			.prepare(`SELECT * FROM graph_edges WHERE src_id = ? OR dst_id = ?`)
			.all(nodeId, nodeId) as GraphEdgeRow[];
		return rows.map(toEdge);
	},

	/** Every edge with both ends inside the given set — the induced subgraph. */
	edgesWithin(nodeIds: string[]): GraphEdge[] {
		if (nodeIds.length === 0) return [];

		/**
		 * Driven from the index, with the second end checked in JS.
		 *
		 * `WHERE src_id IN (…) AND dst_id IN (…)` reads naturally and is 200× slower,
		 * measured: SQLite scans `graph_edges` and tests each row against a set of up
		 * to three thousand values twice over, using neither of the indexes on the
		 * columns being tested. 220 ms for 1,789 edges. Joining the id set to
		 * `idx_graph_edges_src` turns it into one seek per id — 1 ms for the same
		 * data — and the surviving rows are few enough that filtering the far end
		 * against a `Set` here costs nothing.
		 *
		 * The placeholder form this replaced was no better; the cost was never the
		 * binding, it was the plan.
		 */
		const wanted = new Set(nodeIds);
		const rows = getDatabase()
			.prepare(
				`SELECT e.* FROM json_each(?) ids
				 INNER JOIN graph_edges e ON e.src_id = ids.value`
			)
			.all(idSet(nodeIds)) as GraphEdgeRow[];

		return rows.filter(row => wanted.has(row.dst_id)).map(toEdge);
	},

	/**
	 * Neighbours of a node up to `hops` away, breadth-first, with the distance at
	 * which each was reached.
	 *
	 * Written as an iterative walk rather than a recursive CTE on purpose: the
	 * per-level `LIMIT` is what stops one hub node (a heavily-imported file, say)
	 * from dragging half the graph into a result set. A recursive CTE cannot cap
	 * fan-out per level without materialising it first.
	 */
	neighbours(
		nodeId: string,
		hops: number = 1,
		perLevelLimit: number = 60,
		options: { includeArchived?: boolean; includeSuperseded?: boolean } = {}
	): { node: GraphNode; hops: number }[] {
		const db = getDatabase();
		const distance = new Map<string, number>([[nodeId, 0]]);
		let frontier = [nodeId];

		for (let depth = 1; depth <= Math.max(0, hops); depth++) {
			if (frontier.length === 0) break;
			const placeholders = frontier.map(() => '?').join(',');
			const rows = db
				.prepare(
					`SELECT src_id, dst_id, weight FROM graph_edges
					 WHERE src_id IN (${placeholders}) OR dst_id IN (${placeholders})
					 ORDER BY weight DESC
					 LIMIT ?`
				)
				.all(...frontier, ...frontier, perLevelLimit) as { src_id: string; dst_id: string }[];

			const next: string[] = [];
			for (const row of rows) {
				for (const candidate of [row.src_id, row.dst_id]) {
					if (distance.has(candidate)) continue;
					distance.set(candidate, depth);
					next.push(candidate);
				}
			}

			// Memories about the same subject are neighbours too, without an edge in
			// the table. This is what the entity NODE used to provide as two hops
			// through a stub; it is one hop now, and it is the only structure the
			// episodic half has left since similarity linking was removed.
			for (const id of frontier) {
				for (const candidate of this.entityNeighbourIds(id)) {
					if (distance.has(candidate)) continue;
					distance.set(candidate, depth);
					next.push(candidate);
				}
			}
			frontier = next;
		}

		distance.delete(nodeId);
		if (distance.size === 0) return [];

		// Archived and superseded nodes are excluded HERE rather than by callers.
		// Edges deliberately survive both — that is what keeps the reasoning trail
		// intact — so a traversal that does not filter will happily walk into a
		// memory the user has already forgotten and present it as a live
		// connection. That was visible in the inspector and in the MCP
		// `neighbours` action while retrieval, which does filter, looked correct.
		const nodes = this.getByIds([...distance.keys()]).filter(node => {
			if (!options.includeArchived && node.archivedAt) return false;
			if (!options.includeSuperseded && node.supersededBy) return false;
			return true;
		});
		return nodes
			.map(node => ({ node, hops: distance.get(node.id) ?? 1 }))
			.sort((a, b) => a.hops - b.hops);
	},

	// ── listing & stats ─────────────────────────────────────────────────────

	/**
	 * Nodes for the graph view. `projectId === undefined` means every project —
	 * the cross-project view; `null` means global-scope nodes only.
	 */
	list(filter: GraphListFilter & { limit?: number }): GraphNode[] {
		const { where, params } = buildNodeFilter(filter);

		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		params.push(filter.limit ?? 2000);

		const rows = getDatabase()
			.prepare(
				`SELECT * FROM graph_nodes ${clause}
				 ORDER BY pinned DESC, weight DESC, updated_at DESC
				 LIMIT ?`
			)
			.all(...params) as GraphNodeRow[];
		return rows.map(toNode);
	},

	/**
	 * The same listing, narrowed to a rectangle of the persisted layout.
	 *
	 * This is what opening a bin reads, and it is why the view can be complete
	 * without being unbounded: zooming into part of the map costs that part. The
	 * bounds come from the layout's own coordinate space, which the client already
	 * holds — every mark it drew carries the cell it stands for.
	 */
	listInRegion(
		filter: GraphListFilter & { limit?: number },
		region: { minX: number; maxX: number; minY: number; maxY: number }
	): GraphNode[] {
		const { where, params } = buildNodeFilter(filter);
		where.push(
			`id IN (SELECT node_id FROM graph_layout
			        WHERE x >= ? AND x <= ? AND y >= ? AND y <= ?)`
		);
		params.push(region.minX, region.maxX, region.minY, region.maxY);
		params.push(filter.limit ?? 2000);

		const rows = getDatabase()
			.prepare(
				`SELECT * FROM graph_nodes WHERE ${where.join(' AND ')}
				 ORDER BY pinned DESC, weight DESC, updated_at DESC
				 LIMIT ?`
			)
			.all(...params) as GraphNodeRow[];
		return rows.map(toNode);
	},

	/**
	 * Whether the graph holds any live memory at all.
	 *
	 * `EXISTS`, not `COUNT`, because the only caller runs on every turn and only
	 * needs to know whether to bother saying anything.
	 */
	hasEpisodic(): boolean {
		const row = getDatabase()
			.prepare(
				`SELECT 1 AS present FROM graph_nodes
				 WHERE kind = 'episodic' AND archived_at IS NULL AND superseded_by IS NULL
				 LIMIT 1`
			)
			.get() as { present: number } | null;
		return row !== null && row !== undefined;
	},

	/** Count matching the same filter as `list`, before the display cap. */
	count(filter: GraphListFilter): number {
		const { where, params } = buildNodeFilter(filter);
		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const row = getDatabase().prepare(`SELECT COUNT(*) AS c FROM graph_nodes ${clause}`).get(...params) as {
			c: number;
		};
		return row.c;
	},

	/** Chronological memories for a session or project — backs the timeline view. */
	timeline(filter: { projectId?: string | null; sessionId?: string | null; limit?: number }): GraphNode[] {
		const where: string[] = [`archived_at IS NULL`, `superseded_by IS NULL`, `kind = 'episodic'`];
		const params: unknown[] = [];

		if (filter.sessionId) {
			where.push(`session_id = ?`);
			params.push(filter.sessionId);
		} else if (filter.projectId !== undefined && filter.projectId !== null) {
			where.push(`project_id = ?`);
			params.push(filter.projectId);
		}
		params.push(filter.limit ?? 100);

		const rows = getDatabase()
			.prepare(`SELECT * FROM graph_nodes WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
			.all(...params) as GraphNodeRow[];
		return rows.map(toNode);
	},

	stats(): GraphStats {
		const db = getDatabase();
		const one = (sql: string, ...params: unknown[]): number =>
			(db.prepare(sql).get(...params) as { c: number }).c;

		const byScope = { session: 0, project: 0, global: 0 } as Record<GraphScope, number>;
		for (const row of db
			.prepare(`SELECT scope, COUNT(*) AS c FROM graph_nodes WHERE archived_at IS NULL GROUP BY scope`)
			.all() as { scope: GraphScope; c: number }[]) {
			byScope[row.scope] = row.c;
		}

		const byProject = (
			db
				.prepare(
					`SELECT project_id, COUNT(*) AS c FROM graph_nodes
					 WHERE archived_at IS NULL GROUP BY project_id ORDER BY c DESC`
				)
				.all() as { project_id: string | null; c: number }[]
		).map(r => ({ projectId: r.project_id, count: r.c }));

		const live = `archived_at IS NULL AND superseded_by IS NULL`;
		return {
			nodes: one(`SELECT COUNT(*) AS c FROM graph_nodes WHERE ${live}`),
			edges: one(`SELECT COUNT(*) AS c FROM graph_edges`),
			episodic: one(`SELECT COUNT(*) AS c FROM graph_nodes WHERE ${live} AND kind = 'episodic'`),
			structural: one(`SELECT COUNT(*) AS c FROM graph_nodes WHERE ${live} AND kind = 'structural'`),
			vectors: one(`SELECT COUNT(*) AS c FROM graph_vectors`),
			byScope,
			byProject,
			superseded: one(`SELECT COUNT(*) AS c FROM graph_nodes WHERE superseded_by IS NOT NULL`),
			forgotten: one(
				`SELECT COUNT(*) AS c FROM graph_nodes WHERE archived_at IS NOT NULL OR superseded_by IS NOT NULL`
			),
			stale: one(`SELECT COUNT(*) AS c FROM graph_nodes WHERE ${live} AND stale_at IS NOT NULL`),
			entities: one(`SELECT COUNT(*) AS c FROM graph_nodes WHERE ${live} AND entity_key IS NOT NULL`),
			confirmedUseful: one(`SELECT COUNT(*) AS c FROM graph_nodes WHERE ${live} AND useful_count > 0`)
		};
	},

	/**
	 * Forgotten memories, newest first — what the "Forgotten" list shows.
	 *
	 * Archiving is a soft delete precisely so it can be reviewed, but until this
	 * existed there was no way to see what had been archived, which made the
	 * reviewability theoretical. Superseded nodes are deliberately included: from
	 * the user's point of view "no longer recalled" is one category, even though
	 * the graph distinguishes "was never true" from "is no longer true".
	 */
	listArchived(filter: GraphListFilter & { limit?: number; offset?: number }): GraphNode[] {
		const where: string[] = [`(archived_at IS NOT NULL OR superseded_by IS NOT NULL)`];
		const params: unknown[] = [];
		appendProjectFilter(filter, where, params);

		params.push(filter.limit ?? 200, filter.offset ?? 0);
		const rows = getDatabase()
			.prepare(
				`SELECT * FROM graph_nodes WHERE ${where.join(' AND ')}
				 ORDER BY COALESCE(archived_at, updated_at) DESC
				 LIMIT ? OFFSET ?`
			)
			.all(...params) as GraphNodeRow[];
		return rows.map(toNode);
	},

	/** How many forgotten memories match, for the list's header and paging. */
	countArchived(filter: GraphListFilter): number {
		const where: string[] = [`(archived_at IS NOT NULL OR superseded_by IS NOT NULL)`];
		const params: unknown[] = [];
		appendProjectFilter(filter, where, params);

		return (
			getDatabase()
				.prepare(`SELECT COUNT(*) AS c FROM graph_nodes WHERE ${where.join(' AND ')}`)
				.get(...params) as { c: number }
		).c;
	},

	/**
	 * Permanently delete specific nodes. Edges and vectors cascade; the FTS mirror
	 * is manual, as everywhere else in this file.
	 *
	 * This is the only hard delete a user can reach directly, and it is reached
	 * only from the Forgotten list — so a memory has always been archived first.
	 */
	deleteNodes(ids: string[]): number {
		if (ids.length === 0) return 0;
		const db = getDatabase();
		const placeholders = ids.map(() => '?').join(',');

		return this.transaction(() => {
			// Counted before the delete rather than read from `changes`, which on a
			// cascading delete reports rows removed from every table rather than the
			// nodes the caller asked about.
			const existing = (
				db.prepare(`SELECT COUNT(*) AS c FROM graph_nodes WHERE id IN (${placeholders})`).get(...ids) as {
					c: number;
				}
			).c;

			this.dropFts(ids);
			// Nodes that pointed AT a deleted node as their current belief would be
			// left claiming to be superseded by something that no longer exists, which
			// hides them from retrieval forever with nothing to explain why. They come
			// BACK into the lexical index at the same time, for the same reason.
			const orphaned = (
				db
					.prepare(`SELECT id FROM graph_nodes WHERE superseded_by IN (${placeholders})`)
					.all(...ids) as { id: string }[]
			).map(row => row.id);
			if (orphaned.length > 0) {
				db.prepare(
					`UPDATE graph_nodes SET superseded_by = NULL WHERE superseded_by IN (${placeholders})`
				).run(...ids);
			}
			db.prepare(`DELETE FROM graph_nodes WHERE id IN (${placeholders})`).run(...ids);
			for (const id of orphaned) this.syncFts(id);
			return existing;
		});
	},

	/**
	 * Delete every memory in a set of projects, or in the whole instance.
	 *
	 * `projectIds === undefined` means EVERYTHING, including the global-scope
	 * memories that belong to the user rather than to any repository. A project
	 * purge deliberately does NOT touch those: preferences and conventions were
	 * never that project's to hold, and losing them because one repository was
	 * cleaned would be a surprise. That is why the two are separate actions in the
	 * UI rather than one control with a checkbox.
	 */
	purge(projectIds?: string[]): { nodes: number; edges: number } {
		const db = getDatabase();

		return this.transaction(() => {
			const before = (db.prepare(`SELECT COUNT(*) AS c FROM graph_edges`).get() as { c: number }).c;

			if (projectIds === undefined) {
				const nodes = (db.prepare(`SELECT COUNT(*) AS c FROM graph_nodes`).get() as { c: number }).c;
				db.prepare(`DELETE FROM graph_nodes_fts`).run();
				db.prepare(`DELETE FROM graph_nodes`).run();
				const after = (db.prepare(`SELECT COUNT(*) AS c FROM graph_edges`).get() as { c: number }).c;
				return { nodes, edges: before - after };
			}
			if (projectIds.length === 0) return { nodes: 0, edges: 0 };

			const placeholders = projectIds.map(() => '?').join(',');
			const match = `project_id IN (${placeholders})`;

			const doomed = (
				db.prepare(`SELECT id FROM graph_nodes WHERE ${match}`).all(...projectIds) as { id: string }[]
			).map(row => row.id);
			if (doomed.length === 0) return { nodes: 0, edges: 0 };

			// In chunks: a purge can cover tens of thousands of nodes, and SQLite has a
			// hard ceiling on bound parameters per statement.
			for (let i = 0; i < doomed.length; i += 400) this.dropFts(doomed.slice(i, i + 400));

			const orphaned = (
				db
					.prepare(`SELECT id FROM graph_nodes WHERE superseded_by IN (SELECT id FROM graph_nodes WHERE ${match})`)
					.all(...projectIds) as { id: string }[]
			).map(row => row.id);
			db.prepare(
				`UPDATE graph_nodes SET superseded_by = NULL
				 WHERE superseded_by IN (SELECT id FROM graph_nodes WHERE ${match})`
			).run(...projectIds);
			db.prepare(`DELETE FROM graph_nodes WHERE ${match}`).run(...projectIds);
			for (const id of orphaned) this.syncFts(id);

			const after = (db.prepare(`SELECT COUNT(*) AS c FROM graph_edges`).get() as { c: number }).c;
			return { nodes: doomed.length, edges: before - after };
		});
	},

	// ── retention ───────────────────────────────────────────────────────────

	/**
	 * Auto-written memories that have earned no place: never confirmed useful,
	 * never read, low confidence, and old enough that they were not going to be.
	 *
	 * The predicate is deliberately conjunctive. Age alone is not decay — a
	 * decision from a year ago may be the most load-bearing thing in the graph —
	 * so a node has to fail every test at once before it is a candidate. Anything
	 * a person touched (`source = 'user'`), pinned, or ever marked useful is
	 * exempt outright.
	 */
	evictionCandidates(options: { maxAgeDays: number; maxConfidence: number; limit: number }): GraphNode[] {
		const rows = getDatabase()
			.prepare(
				`SELECT * FROM graph_nodes
				 WHERE kind = 'episodic'
				   AND source = 'agent'
				   AND pinned = 0
				   AND archived_at IS NULL
				   AND superseded_by IS NULL
				   AND useful_count = 0
				   AND access_count = 0
				   AND confidence <= ?
				   AND entity_key IS NULL
				   AND julianday('now') - julianday(updated_at) > ?
				 ORDER BY confidence ASC, updated_at ASC
				 LIMIT ?`
			)
			.all(options.maxConfidence, options.maxAgeDays, options.limit) as GraphNodeRow[];
		return rows.map(toNode);
	},

	/**
	 * Permanently remove archived auto-written nodes older than `maxAgeDays`.
	 *
	 * Archiving is reversible on purpose, but "reversible forever" means the table
	 * only grows. A node a person archived by hand is never purged here — undoing
	 * that is exactly the case soft-delete exists for.
	 */
	purgeArchived(maxAgeDays: number, limit: number): number {
		const db = getDatabase();
		const ids = (
			db
				.prepare(
					`SELECT id FROM graph_nodes
					 WHERE archived_at IS NOT NULL
					   AND source = 'agent'
					   AND pinned = 0
					   AND julianday('now') - julianday(archived_at) > ?
					 LIMIT ?`
				)
				.all(maxAgeDays, limit) as { id: string }[]
		).map(r => r.id);

		if (ids.length === 0) return 0;
		const placeholders = ids.map(() => '?').join(',');
		this.dropFts(ids);
		db.prepare(`DELETE FROM graph_nodes WHERE id IN (${placeholders})`).run(...ids);
		return ids.length;
	},

	/**
	 * Structural nodes nothing in the graph depends on any more.
	 *
	 * This is the bound on the term that actually dominates growth. Every turn
	 * writes a node per changed file, per directory and up to twenty-five per
	 * file's symbols, so on a repository under active development the structural
	 * half outgrows the episodic half by an order of magnitude — and episodic
	 * retention does not touch it, because none of those queries look at
	 * `kind = 'structural'`.
	 *
	 * What is safe to remove is narrow and stays narrow: a `symbol` or `module`
	 * node, untouched for `maxAgeDays`, that NO memory is `about`. A file node is
	 * spared even when nothing points at it — it is the anchor a path lookup
	 * resolves to, and `invalidate.ts` already retires files the moment the disk
	 * says they are gone, which is better evidence than age. Anything a memory
	 * hangs off is spared outright: deleting it would sever the `about` edge that
	 * is the entire reason both halves live in one graph.
	 */
	pruneStructural(options: { maxAgeDays: number; limit: number }): number {
		const db = getDatabase();
		const ids = (
			db
				.prepare(
					`SELECT n.id AS id FROM graph_nodes n
					 WHERE n.kind = 'structural'
					   AND n.subkind IN ('symbol', 'module')
					   AND n.pinned = 0
					   AND n.source != 'user'
					   AND julianday('now') - julianday(n.updated_at) > ?
					   AND NOT EXISTS (
					     SELECT 1 FROM graph_edges e WHERE e.rel = 'about' AND e.dst_id = n.id
					   )
					 ORDER BY n.updated_at ASC
					 LIMIT ?`
				)
				.all(options.maxAgeDays, options.limit) as { id: string }[]
		).map(r => r.id);

		if (ids.length === 0) return 0;
		const placeholders = ids.map(() => '?').join(',');
		this.dropFts(ids);
		db.prepare(`DELETE FROM graph_nodes WHERE id IN (${placeholders})`).run(...ids);
		return ids.length;
	},

	/**
	 * Structural nodes whose file no longer exists on disk, so the graph stops
	 * pointing agents at paths that are gone. Symbols of a removed file go with
	 * it — a symbol has no meaning without the file that defined it.
	 */
	archiveMissingFiles(projectId: string, paths: string[]): number {
		if (paths.length === 0) return 0;
		const placeholders = paths.map(() => '?').join(',');
		const ids = (
			getDatabase()
				.prepare(
					`SELECT id FROM graph_nodes
					 WHERE project_id = ? AND kind = 'structural' AND path IN (${placeholders})
					   AND archived_at IS NULL`
				)
				.all(projectId, ...paths) as { id: string }[]
		).map(r => r.id);

		return this.archiveNodes(ids);
	},

	// ── vectors ─────────────────────────────────────────────────────────────

	setVector(nodeId: string, dim: number, model: string, vec: Uint8Array): void {
		getDatabase()
			.prepare(
				`INSERT INTO graph_vectors (node_id, dim, model, vec, updated_at)
				 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
				 ON CONFLICT(node_id) DO UPDATE SET
				   dim = excluded.dim, model = excluded.model, vec = excluded.vec,
				   updated_at = CURRENT_TIMESTAMP`
			)
			.run(nodeId, dim, model, vec);
	},

	/**
	 * Nodes that still need a vector for the current model.
	 *
	 * EPISODIC ONLY, deliberately. A structural node is identified by a name and a
	 * path, and embedding that produces a bag of path fragments rather than a
	 * meaning — measured, `backend/database/queries/index.ts` scored above a
	 * correct answer for two unrelated natural-language questions, because
	 * mean-pooled fragments land near the middle of the space where everything
	 * looks vaguely similar. Names and paths are precisely what BM25 is best at,
	 * so structural nodes lose nothing by staying lexical.
	 *
	 * Code is still reachable semantically, just not directly: a question finds
	 * the memory *about* a file, and graph expansion crosses the `about` edge to
	 * the file itself. That is the intended route — and the reason both kinds of
	 * memory live in one graph.
	 */
	nodesMissingVectors(model: string, limit: number = 200): GraphNode[] {
		const rows = getDatabase()
			.prepare(
				`SELECT n.* FROM graph_nodes n
				 LEFT JOIN graph_vectors v ON v.node_id = n.id AND v.model = ?
				 WHERE n.archived_at IS NULL AND n.superseded_by IS NULL
				   AND n.kind = 'episodic' AND n.entity_key IS NULL AND v.node_id IS NULL
				 ORDER BY n.updated_at DESC
				 LIMIT ?`
			)
			.all(model, limit) as GraphNodeRow[];
		return rows.map(toNode);
	},

	/** Text to embed for a node — the same basis the lexical index uses. */
	embeddableText(node: GraphNode): string {
		return indexedText(node);
	},

	/** Drop vectors written by a different artifact version. */
	pruneVectorsForOtherModels(model: string): number {
		const result = getDatabase().prepare(`DELETE FROM graph_vectors WHERE model != ?`).run(model) as {
			changes?: number;
		};
		return Number(result.changes ?? 0);
	}
};

/** One node's place in the persisted arrangement. */
export interface GraphLayoutRow {
	nodeId: string;
	community: number;
	x: number;
	y: number;
	/**
	 * 1 when the force simulation computed this position, 0 when it is a guess
	 * from the community's neighbourhood. See migration 067 for why the two must
	 * stay distinguishable.
	 */
	placed: number;
}

/** How many nodes match a filter, and the rectangle their layout occupies. */
export interface GraphLayoutExtent {
	total: number;
	/** Matching nodes with no position yet — counted, but outside the bounds. */
	unplaced: number;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

/** The grid a binned view is rolled up to, in layout coordinates. */
export interface GraphBinGrid {
	originX: number;
	originY: number;
	cellWidth: number;
	cellHeight: number;
}

/** One occupied cell: how many it holds, where they average, and which speaks for it. */
export interface GraphBinRow {
	cellX: number;
	cellY: number;
	members: number;
	x: number;
	y: number;
	/** The most reinforced member — the mark itself when `members` is 1. */
	id: string;
	label: string;
	community: number;
}

export interface GraphBinEdgeRow {
	srcX: number;
	srcY: number;
	dstX: number;
	dstY: number;
	weight: number;
}

/**
 * Reading and writing the persisted arrangement (see migration 067).
 *
 * Kept apart from `graphQueries` because it answers a different question:
 * `graphQueries` is about what is remembered, this is about how it is drawn.
 * Every row here is derived and disposable — deleting the table costs one
 * background pass and no memory.
 */
export const graphLayoutQueries = {
	/** Positions and communities for a set of nodes. */
	read(nodeIds: string[]): Map<string, GraphLayoutRow> {
		const result = new Map<string, GraphLayoutRow>();
		if (nodeIds.length === 0) return result;
		const rows = getDatabase()
			.prepare(
				`SELECT node_id AS nodeId, community, x, y, placed FROM graph_layout
				 WHERE node_id IN ${ID_SET}`
			)
			.all(idSet(nodeIds)) as GraphLayoutRow[];
		for (const row of rows) result.set(row.nodeId, row);
		return result;
	},

	/** Replace the arrangement for the nodes given, in one transaction. */
	writeMany(rows: GraphLayoutRow[]): number {
		if (rows.length === 0) return 0;
		return graphQueries.transaction(() => {
			const statement = getDatabase().prepare(
				`INSERT INTO graph_layout (node_id, community, x, y, placed, updated_at)
				 VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
				 ON CONFLICT(node_id) DO UPDATE SET
				   community = excluded.community, x = excluded.x, y = excluded.y,
				   placed = excluded.placed, updated_at = CURRENT_TIMESTAMP`
			);
			for (const row of rows) {
				statement.run(row.nodeId, row.community, row.x, row.y, row.placed);
			}
			return rows.length;
		});
	},

	/**
	 * Live nodes in the order the view itself ranks them, for the layout pass.
	 *
	 * Capped, because a force layout over an unbounded set is unbounded work. What
	 * survives the cap is what the view would have shown anyway — pinned, then
	 * most reinforced, then most recent — so anything left unplaced is also the
	 * least likely to be looked at.
	 */
	liveNodeIds(limit: number): string[] {
		const rows = getDatabase()
			.prepare(
				// `id` is the tiebreak, and it is load-bearing rather than tidy. Most
				// live nodes share a weight and a timestamp, so without it SQLite is
				// free to return ties in any order — and this order decides the order
				// the layout graph is built in, which ForceAtlas2 is sensitive to. The
				// same store laid out to a different map on every pass.
				`SELECT id FROM graph_nodes
				 WHERE archived_at IS NULL AND superseded_by IS NULL
				 ORDER BY pinned DESC, weight DESC, updated_at DESC, id ASC
				 LIMIT ?`
			)
			.all(limit) as { id: string }[];
		return rows.map(row => row.id);
	},

	/** Whether any live node is still waiting to be placed. */
	hasUnplaced(): boolean {
		const row = getDatabase()
			.prepare(
				`SELECT 1 AS present FROM graph_nodes n
				 LEFT JOIN graph_layout l ON l.node_id = n.id
				 WHERE n.archived_at IS NULL AND n.superseded_by IS NULL AND l.node_id IS NULL
				 LIMIT 1`
			)
			.get() as { present: number } | null;
		return row !== null && row !== undefined;
	},

	/** Rows whose node no longer exists. Foreign keys are not always enforced. */
	pruneOrphans(): number {
		const result = getDatabase()
			.prepare(`DELETE FROM graph_layout WHERE node_id NOT IN (SELECT id FROM graph_nodes)`)
			.run() as { changes?: number };
		return Number(result.changes ?? 0);
	},

	/** Drop the whole arrangement — used when the graph is purged. */
	clear(): void {
		getDatabase().prepare(`DELETE FROM graph_layout`).run();
	},

	/**
	 * How many nodes match, and the rectangle their arrangement occupies.
	 *
	 * One pass answering both, because the two are always wanted together: the
	 * count decides whether the view has to bin at all, and the extent is what the
	 * grid is laid over. `MIN`/`MAX` skip NULLs, so a node still waiting to be
	 * placed is counted without dragging the bounds toward the origin.
	 */
	extent(filter: GraphListFilter): GraphLayoutExtent {
		const { where, params } = buildNodeFilter(filter, 'n.');
		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

		const row = getDatabase()
			.prepare(
				`SELECT COUNT(*) AS total,
				        SUM(CASE WHEN l.node_id IS NULL THEN 1 ELSE 0 END) AS unplaced,
				        MIN(l.x) AS minX, MAX(l.x) AS maxX,
				        MIN(l.y) AS minY, MAX(l.y) AS maxY
				 FROM graph_nodes n
				 LEFT JOIN graph_layout l ON l.node_id = n.id
				 ${clause}`
			)
			.get(...params) as {
			total: number;
			unplaced: number | null;
			minX: number | null;
			maxX: number | null;
			minY: number | null;
			maxY: number | null;
		};

		return {
			total: row.total ?? 0,
			unplaced: row.unplaced ?? 0,
			minX: row.minX ?? 0,
			maxX: row.maxX ?? 0,
			minY: row.minY ?? 0,
			maxY: row.maxY ?? 0
		};
	},

	/**
	 * One row per occupied cell of the grid: its size, its centroid, and its most
	 * reinforced member.
	 *
	 * The count of rows is bounded by the grid, not by the store — that is the
	 * whole point. A cell holding one memory comes back with `members = 1` and
	 * that memory's id, so the caller can return the memory ITSELF rather than a
	 * bin standing for it; below the render budget that is every cell, and the
	 * view is bit-for-bit the flat one.
	 *
	 * `CAST(... AS INTEGER)` truncates toward zero, which would fold the cells on
	 * either side of the origin into one — the grid is therefore anchored at the
	 * arrangement's minimum, so every offset it sees is positive.
	 */
	binnedNodes(filter: GraphListFilter, grid: GraphBinGrid): GraphBinRow[] {
		const { where, params } = buildNodeFilter(filter, 'n.');
		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

		return getDatabase()
			.prepare(
				`SELECT cellX, cellY, members, cx AS x, cy AS y, id, label, community
				 FROM (
				   SELECT cellX, cellY, id, label, community,
				          COUNT(*) OVER (PARTITION BY cellX, cellY) AS members,
				          AVG(x) OVER (PARTITION BY cellX, cellY) AS cx,
				          AVG(y) OVER (PARTITION BY cellX, cellY) AS cy,
				          ROW_NUMBER() OVER (
				            PARTITION BY cellX, cellY
				            ORDER BY pinned DESC, weight DESC, updated_at DESC
				          ) AS rn
				   FROM (
				     SELECT CAST((l.x - ?) / ? AS INTEGER) AS cellX,
				            CAST((l.y - ?) / ? AS INTEGER) AS cellY,
				            l.x AS x, l.y AS y, l.community AS community,
				            n.id AS id, n.label AS label,
				            n.pinned AS pinned, n.weight AS weight, n.updated_at AS updated_at
				     FROM graph_nodes n
				     INNER JOIN graph_layout l ON l.node_id = n.id
				     ${clause}
				   )
				 )
				 WHERE rn = 1`
			)
			.all(
				grid.originX,
				grid.cellWidth,
				grid.originY,
				grid.cellHeight,
				...params
			) as GraphBinRow[];
	},

	/**
	 * Edges rolled up to the same grid, so the binned picture keeps its structure.
	 *
	 * Stored edges only. The derived ones (see `derivedEdges`) exist to hold a
	 * subject's memories together, and the layout pass already consumed them —
	 * their effect is in the POSITIONS, which is where it belongs at this
	 * resolution. Recomputing them here would mean handing this query the id of
	 * every matching node, which is the unbounded thing the grid exists to avoid.
	 *
	 * Edges inside a single cell are dropped: both ends are the same mark.
	 */
	binnedEdges(filter: GraphListFilter, grid: GraphBinGrid, limit: number): GraphBinEdgeRow[] {
		const src = buildNodeFilter(filter, 'na.');
		const dst = buildNodeFilter(filter, 'nb.');
		const conditions = [...src.where, ...dst.where];
		const clause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

		return getDatabase()
			.prepare(
				`SELECT srcX, srcY, dstX, dstY, SUM(weight) AS weight
				 FROM (
				   SELECT CAST((la.x - ?) / ? AS INTEGER) AS srcX,
				          CAST((la.y - ?) / ? AS INTEGER) AS srcY,
				          CAST((lb.x - ?) / ? AS INTEGER) AS dstX,
				          CAST((lb.y - ?) / ? AS INTEGER) AS dstY,
				          e.weight AS weight
				   FROM graph_edges e
				   INNER JOIN graph_layout la ON la.node_id = e.src_id
				   INNER JOIN graph_layout lb ON lb.node_id = e.dst_id
				   INNER JOIN graph_nodes na ON na.id = e.src_id
				   INNER JOIN graph_nodes nb ON nb.id = e.dst_id
				   ${clause}
				 )
				 WHERE NOT (srcX = dstX AND srcY = dstY)
				 GROUP BY 1, 2, 3, 4
				 ORDER BY weight DESC
				 LIMIT ?`
			)
			.all(
				grid.originX,
				grid.cellWidth,
				grid.originY,
				grid.cellHeight,
				grid.originX,
				grid.cellWidth,
				grid.originY,
				grid.cellHeight,
				...src.params,
				...dst.params,
				limit
			) as GraphBinEdgeRow[];
	}
};
