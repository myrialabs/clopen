/**
 * Memory Graph types.
 *
 * One graph holds both kinds of memory (see migration 066): `episodic` for what
 * happened and what was decided, `structural` for the codebase as entities. They
 * are connected by real edges, so a query can travel from a decision to the code
 * it governs and back.
 *
 * Shared between backend and frontend — the visualization, the MCP tool surface
 * and the retrieval engine all speak these shapes.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Nodes
// ─────────────────────────────────────────────────────────────────────────────

export type GraphNodeKind = 'episodic' | 'structural';

/** What kind of memory an episodic node holds. */
export type EpisodicSubkind =
	| 'decision'
	| 'pattern'
	| 'failure'
	| 'preference'
	| 'observation'
	| 'entity';

/** What kind of code entity a structural node represents. */
export type StructuralSubkind = 'file' | 'symbol' | 'module' | 'dependency';

export type GraphNodeSubkind = EpisodicSubkind | StructuralSubkind;

/**
 * How LONG a claim holds — its durability, not its geography.
 *
 * `session` is a one-off: an instruction for the task at hand, which says
 * nothing about how future work should be done and can never repeal a standing
 * rule. `project` and `global` are standing claims, differing in whether they
 * are about one repository or about the user's way of working.
 *
 * The `session` value existed from migration 066, was filtered for in retrieval
 * and covered by a test, and was never written by any path — extraction's schema
 * only ever offered `project` and `global`. That gap is why "use the agent tool
 * for this analysis" was filed as a global policy and superseded the standing
 * prohibition it was an exception to.
 */
export type GraphScope = 'session' | 'project' | 'global';

/**
 * WHERE a claim applies, which is a different question from where it was
 * learned (`projectId`).
 *
 * `here` is about this codebase — its choices, its layout, its configuration.
 * Someone on another project cannot act on it, and handing it to them is worse
 * than saying nothing, because every project answers "where does this deploy"
 * differently.
 *
 * `anywhere` is about a language, runtime, library or practice. It was learned
 * in one repository and is true in all of them, and it is the reason a single
 * shared graph is worth having: a Svelte reactivity gotcha debugged in one
 * project should not have to be rediscovered in the next.
 *
 * Measured: a model fills this correctly 15 times in 16, with zero errors in the
 * damaging direction (a codebase fact wrongly released to travel). The same
 * model asked to judge durability scored 6 of 14 — reach is a property of the
 * sentence, durability a property of intent, and only the first is legible.
 */
export type GraphReach = 'here' | 'anywhere';

/**
 * Whose claim this is, which is a different question from which code path wrote
 * it (`source`).
 *
 * `user` — the person said it, in the conversation, or typed it by hand.
 * `assistant` — the assistant asserted it while working.
 * `inferred` — nobody said it; a model concluded it from what it read.
 *
 * Authority is read from here, not from `source`. Conflating the two is what
 * allowed a model's inference to retire a memory a person had written: both were
 * "a memory", and the only column that could have told them apart was answering
 * a different question.
 */
export type GraphAssertedBy = 'user' | 'assistant' | 'inferred';

/**
 * How much weight a claim carries when two of them disagree.
 *
 * Read-time conflict resolution walks this ordering first, then durability, then
 * recency. Higher wins.
 */
export const AUTHORITY_RANK: Record<GraphAssertedBy, number> = {
	user: 2,
	assistant: 1,
	inferred: 0
};

/**
 * Who created a node or edge — matters for trust and for what may be pruned.
 *
 * Exactly two values, and the absence of a third is deliberate. This used to
 * carry `auto` as well, for "written by the automatic extraction", alongside
 * `agent` for "written through the MCP tool" — but nothing could act on the
 * distinction, because both are a model reading text and deciding what to store.
 * Meanwhile `auto` was doing the work of the real question every consumer
 * actually asks: *did a person say this, or did a model infer it?* Retention,
 * structural decay, consolidation and the trust line in the injected block all
 * branch on precisely that. Two values answer it without ambiguity; three
 * invited every reader to guess which of the two model-written kinds a predicate
 * meant.
 */
export type GraphSource = 'agent' | 'user';

export interface GraphNode {
	id: string;
	kind: GraphNodeKind;
	subkind: GraphNodeSubkind;
	scope: GraphScope;
	projectId: string | null;
	sessionId: string | null;
	/** Short, human-readable title shown on the graph and in listings. */
	label: string;
	/** Full memory text, or a signature/summary for structural nodes. */
	body: string;
	/** Repo-relative path for structural nodes. */
	path: string | null;
	/** Symbol name for structural nodes of subkind `symbol`. */
	symbol: string | null;
	/** Detected language of the file a structural node came from. */
	language: string | null;
	/** Stable identity hash used to upsert instead of duplicating. */
	digest: string;
	/** How much the writer trusts this memory, 0–1. */
	confidence: number;
	/** Reinforcement: grows when a memory is re-observed or proves useful. */
	weight: number;
	accessCount: number;
	source: GraphSource;
	/** Whose claim this is — the basis for authority. See `GraphAssertedBy`. */
	assertedBy: GraphAssertedBy;
	/** Whether this travels to other projects. See `GraphReach`. */
	reach: GraphReach;
	/** False until a model has judged `reach`; the backfill defaults to `here`. */
	reachJudged: boolean;
	/** Pinned nodes are exempt from decay and automatic pruning. */
	pinned: boolean;
	/** Soft-delete timestamp; archived nodes keep their edges but leave retrieval. */
	archivedAt: string | null;
	createdAt: string;
	updatedAt: string;
	accessedAt: string | null;

	/**
	 * Id of the memory that replaced this one. Non-null means "no longer the
	 * current belief": the node keeps its edges so the reasoning path stays
	 * visible, but retrieval skips it so an agent is never handed two versions of
	 * the same fact and asked to adjudicate.
	 */
	supersededBy: string | null;
	/** Times a later turn actually used this memory. Evidence, unlike accessCount. */
	usefulCount: number;
	/** Times a later turn found this memory wrong or misleading. */
	unhelpfulCount: number;
	/** When the code this memory is `about` last changed underneath it. */
	staleAt: string | null;
	/** Canonical identity for `entity` nodes — the slug every statement hangs off. */
	entityKey: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Edges
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Relation types, grouped by what they connect.
 *
 * `about` is the load-bearing one: it links an episodic memory to the code it
 * concerns, which is what fuses the two halves into a single graph instead of
 * two indexes in one database.
 */
export type GraphRelation =
	// structural ↔ structural
	| 'imports'
	| 'calls'
	| 'defines'
	| 'contains'
	// episodic ↔ episodic
	| 'caused_by'
	| 'supersedes'
	| 'contradicts'
	| 'generalizes'
	// episodic → structural
	| 'about'
	// anything, drawn by hand
	| 'relates_to';

export interface GraphEdge {
	id: number;
	srcId: string;
	dstId: string;
	rel: GraphRelation;
	weight: number;
	source: GraphSource;
	createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphNodeInput {
	kind: GraphNodeKind;
	subkind: GraphNodeSubkind;
	scope?: GraphScope;
	projectId?: string | null;
	sessionId?: string | null;
	label: string;
	body?: string;
	path?: string | null;
	symbol?: string | null;
	language?: string | null;
	/** Supply to control identity; otherwise derived from the node's content. */
	digest?: string;
	confidence?: number;
	source?: GraphSource;
	assertedBy?: GraphAssertedBy;
	reach?: GraphReach;
	reachJudged?: boolean;
	pinned?: boolean;
	/**
	 * Canonical entity slug. When present it REPLACES content as the node's
	 * identity, which is what makes every statement about one person converge on
	 * a single node instead of one node per phrasing.
	 */
	entityKey?: string | null;
}

/** What a later turn did with a memory that was injected into it. */
export type MemoryVerdict = 'used' | 'wrong' | 'ignored';

export interface GraphEdgeInput {
	srcId: string;
	dstId: string;
	rel: GraphRelation;
	weight?: number;
	source?: GraphSource;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retrieval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a result came from. Both retrievers run on every query and their ranks
 * are fused, so a result is frequently `both` — which is exactly the signal that
 * it is a strong match.
 */
export type RetrievalChannel = 'lexical' | 'vector' | 'both' | 'graph';

export interface RetrievalHit {
	node: GraphNode;
	/** Fused score after RRF, decay and reinforcement weighting. */
	score: number;
	channel: RetrievalChannel;
	/** Rank in the BM25 result list, when it appeared there. */
	lexicalRank: number | null;
	/** Rank in the vector result list, when it appeared there. */
	vectorRank: number | null;
	/** Hops from a directly-matched node; 0 when matched directly. */
	hops: number;
	/** Highlighted BM25 snippet, when the lexical channel produced one. */
	snippet: string | null;
}

export interface RetrievalOptions {
	/** Free text. Both retrievers consume it as-is; no LLM is involved. */
	query: string;
	/** Narrow to a single project. Omit to search across every project. */
	projectId?: string | null;
	/**
	 * Narrow to a SET of projects — what the modal's multi-select produces.
	 *
	 * Takes precedence over `projectId` when present. An empty array is not "no
	 * filter", it is "global only": nothing selected means the user has narrowed
	 * away every repository, and the memories that remain are the ones that were
	 * never a repository's to begin with. Global-scope nodes are always included
	 * alongside a non-empty selection, because a user-level convention applies
	 * inside every project it is viewed next to.
	 */
	projectIds?: string[];
	/** Narrow to a single session's memories. */
	sessionId?: string | null;
	/** Restrict which scopes may match. Defaults to all three. */
	scopes?: GraphScope[];
	/** Restrict to one kind of memory. Defaults to both. */
	kinds?: GraphNodeKind[];
	/** Restrict to particular subkinds (decision, failure, entity, file, …). */
	subkinds?: string[];
	/** Restrict by who wrote it: inferred, asked for by an agent, or hand-written. */
	sources?: GraphSource[];
	/**
	 * Let `reach: 'anywhere'` memories from OTHER projects into the results,
	 * ranked below equally-matching local ones.
	 *
	 * Off by default so the modal, the graph view and any listing keep answering
	 * "what does this project know". Turn-start injection and the MCP `recall`
	 * action turn it on, because that is where "we already solved this in the
	 * other repo" has to arrive without being asked for.
	 *
	 * Structural nodes never travel whatever this says — another repository's
	 * file paths are noise here, and admitting them is the leak the hard project
	 * filter was originally added to stop.
	 */
	crossProject?: boolean;
	/** Maximum hits returned after fusion. */
	limit?: number;
	/** How many hops to expand from directly-matched nodes. 0 disables expansion. */
	expandHops?: number;
	/** Include archived nodes. Defaults to false. */
	includeArchived?: boolean;
	/**
	 * Repo-relative paths the session is currently working in. Their structural
	 * nodes join the query's seeds, so a turn whose text carries no signal
	 * ("continue", "fix it") still reaches the memories attached to the code in
	 * front of it.
	 */
	anchorPaths?: string[];
	/**
	 * Include memories that have been superseded. Off by default: a superseded
	 * memory is history, and history competing with the current belief is the
	 * failure mode revision exists to remove.
	 */
	includeSuperseded?: boolean;
	/**
	 * Favour precision over recall — what an explicit search box wants.
	 *
	 * The vector channel normally admits any positive cosine, because for
	 * turn-start injection a weak semantic lead is still worth ranking and BM25
	 * corrects it. Typed into a search box that same behaviour looks broken: with
	 * static embeddings almost every pair scores positive, so a one-word query
	 * returns sixty loosely-related memories and the user concludes the search is
	 * wrong. When set, a vector-only hit must stand out from the scanned
	 * distribution instead of merely beating zero.
	 */
	precise?: boolean;
}

/** How a query was read, and therefore how the two channels were weighted. */
export interface QueryProfile {
	/** `code` when the query looks like identifiers or paths, `prose` otherwise. */
	shape: 'code' | 'prose' | 'mixed';
	lexicalWeight: number;
	vectorWeight: number;
}

export interface RetrievalResult {
	hits: RetrievalHit[];
	/** True when the vector channel contributed — false while the artifact installs. */
	vectorUsed: boolean;
	/** Wall-clock cost, so the cost of injection stays observable. */
	elapsedMs: number;
	/** How the query was read and how the channels were weighted for it. */
	profile: QueryProfile;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visualization
// ─────────────────────────────────────────────────────────────────────────────

/** A node as sent to the graph view: display fields plus its community. */
export interface GraphViewNode {
	id: string;
	kind: GraphNodeKind;
	subkind: GraphNodeSubkind;
	scope: GraphScope;
	label: string;
	projectId: string | null;
	/** Degree, used to size the node. */
	degree: number;
	weight: number;
	pinned: boolean;
	/** Louvain community index — the "lobe" a node belongs to. */
	community: number;
	createdAt: string;
	/**
	 * Where the persisted layout put this node, when it has been laid out.
	 *
	 * Absent means "no position yet" — a memory written since the last layout
	 * pass — and the client seeds those from their neighbours rather than
	 * re-solving the whole graph. See `backend/memory/layout.ts`.
	 */
	x?: number;
	y?: number;
}

export interface GraphViewEdge {
	id: number;
	source: string;
	target: string;
	rel: GraphRelation;
	weight: number;
}

/** A rectangle in layout space — what a zoomed-in view is scoped to. */
export interface GraphRegion {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

/**
 * Several memories that fell in one cell of the layout grid, drawn as one mark.
 *
 * This is what keeps the view's cost bounded without taking anything out of the
 * picture, and the distinction from the alternative matters. Grouping by
 * COMMUNITY replaces the picture — you see lobes instead of memories, and
 * reaching a memory means opening one. Grouping by POSITION keeps the picture:
 * marks merge only where their dots would have overlapped anyway, so the
 * silhouette, the lobes and the colours are the ones the full graph would have
 * drawn. Below the render budget nothing merges at all and every memory is its
 * own mark, exactly as before.
 *
 * A bin is not a memory — it has no body, no scope and nothing to inspect —
 * which is why it travels in its own array rather than as a node wearing a fake
 * subkind.
 */
export interface GraphViewBin {
	/** `bin:<cellX>:<cellY>` — namespaced so it cannot collide with a node id. */
	id: string;
	/** How many memories it stands for; drives its size. */
	members: number;
	/** The most reinforced member's summary, for the hover pill. */
	label: string;
	/** Community of that same member, so the mark keeps its lobe's colour. */
	community: number;
	/** Centroid of its members — not the cell's centre, which would grid the map. */
	x: number;
	y: number;
	/** The cell itself, so opening the mark asks for exactly this rectangle. */
	region: GraphRegion;
}

/** A connection between two bins, weighted by the edges that cross between them. */
export interface GraphViewBinEdge {
	source: string;
	target: string;
	weight: number;
}

export interface GraphView {
	/**
	 * `flat` when every matching memory is drawn individually — the ordinary case,
	 * and the only one below the render budget. `binned` when some marks stand for
	 * more than one memory.
	 *
	 * Both populate `nodes`: a cell holding a single memory returns that memory,
	 * not a bin of one. So the two are not alternatives to each other — a binned
	 * view is a full-fidelity view everywhere it can afford to be.
	 */
	level: 'flat' | 'binned';
	nodes: GraphViewNode[];
	edges: GraphViewEdge[];
	bins: GraphViewBin[];
	binEdges: GraphViewBinEdge[];
	/** The rectangle this view was scoped to, when the caller zoomed into one. */
	region: GraphRegion | null;
	/** Total nodes matching the filter before any display cap was applied. */
	totalNodes: number;
	/** True when `totalNodes` exceeded the cap and the view was trimmed. */
	truncated: boolean;
}

/**
 * What the extraction queue is doing right now.
 *
 * Surfaced in the UI because the alternative is a feature that silently stops
 * working: recording happens in the background, so a model outage or an
 * unconfigured model looks exactly like "nothing worth remembering happened".
 */
export interface MemoryQueueStatus {
	/** Conversations waiting to be summarised. */
	pending: number;
	/** Of those, how many have already failed at least once. */
	retrying: number;
	/** Gave up after repeated failures. Kept, and retryable. */
	failed: number;
	/** Being summarised at this moment. */
	running: number;
	/** When the next queued conversation becomes eligible. */
	nextAttemptAt: string | null;
	/** The most recent failure, whatever it was. */
	lastError: string | null;
	/** False when no model is chosen, which is why nothing is being recorded. */
	modelConfigured: boolean;
}

/** How an artifact download ended. `corrupt` and `unpublished` are not retried. */
export type EmbeddingFailureKind = 'network' | 'corrupt' | 'unpublished';

export interface EmbeddingInstallStatus {
	ready: boolean;
	phase: 'idle' | 'downloading' | 'installed' | 'waiting' | 'failed';
	attempts: number;
	error: string | null;
	failure: EmbeddingFailureKind | null;
	/** True when no further automatic attempt is scheduled. */
	permanent: boolean;
	nextAttemptAt: string | null;
	receivedBytes: number;
	totalBytes: number;
}

/** What is still missing before memory works. */
export type MemoryBlocker = 'embedding' | 'model';

/**
 * Whether memory is usable, and what is missing when it is not.
 *
 * The two halves have DIFFERENT prerequisites and are reported separately on
 * purpose: recall needs the embedding artifact, recording only needs a model.
 * Recording therefore runs during setup, so the turns a user has while a 44 MB
 * download completes are still captured — they are usually the ones that
 * establish a project. See backend/memory/readiness.ts.
 */
export interface MemoryReadiness {
	enabled: boolean;
	canRecall: boolean;
	canRecord: boolean;
	/** True while anything still needs doing; what the setup banner keys on. */
	setupRequired: boolean;
	blockers: MemoryBlocker[];
	embedding: EmbeddingInstallStatus;
	model: { configured: boolean; engine: string | null; modelId: string | null };
}

export interface GraphStats {
	nodes: number;
	edges: number;
	episodic: number;
	structural: number;
	vectors: number;
	byScope: Record<GraphScope, number>;
	byProject: { projectId: string | null; count: number }[];
	/** Memories replaced by a newer belief — history, no longer retrieved. */
	superseded: number;
	/** Memories whose code changed underneath them since they were written. */
	stale: number;
	/** Canonical entity nodes (people, tools, systems) everything else hangs off. */
	entities: number;
	/** Memories a later turn confirmed it actually used. */
	confirmedUseful: number;
	/** Archived or superseded — what the Forgotten list holds. */
	forgotten: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hand-written memory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A memory a person typed, after it has been shaped but before it is stored.
 *
 * The manual path exists because the automatic one has a hard limit: it can only
 * record what a conversation happened to state. A constraint someone already
 * knows — "never touch the vendored directory", "the staging box is on the old
 * schema until March" — has to be said to an agent before it can be remembered,
 * which means the mistake it would have prevented has usually already happened.
 *
 * The draft is returned for review rather than saved directly. What the user
 * typed is one field; what the graph stores is six, and letting a model fill the
 * other five without showing its work would mean a store whose contents nobody
 * had actually read.
 */
export interface MemoryDraft {
	subkind: EpisodicSubkind;
	scope: 'project' | 'global';
	label: string;
	body: string;
	/** Named subjects, which become canonical entity nodes on save. */
	entities: string[];
	/** Repo-relative paths the memory concerns, which become `about` edges. */
	relatedPaths: string[];
	/** True when a model shaped this, false when it is the raw text split in two. */
	structured: boolean;
	/** An existing memory that already says this, if one was found. */
	duplicateOf: { id: string; label: string; score: number } | null;
	/** Why the model was not used, when it was not. Shown as a quiet note. */
	note: string | null;
}
