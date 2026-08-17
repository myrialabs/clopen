/**
 * Memory Graph Store
 *
 * Backs the Memory modal: the graph view, the selected node's neighbourhood, and
 * hybrid search. It is a view over server state — the graph is
 * instance-global and every engine writes to it — so nothing is cached
 * optimistically: a mutation refetches, because another member's session may
 * have changed the same node between renders.
 *
 * Community assignment and node degree arrive precomputed from the server
 * (`backend/memory/view.ts`); clustering on the client would fight the force
 * simulation for the main thread on exactly the low-powered devices this has to
 * stay usable on.
 */

import ws, { onWsReconnect } from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type {
	MemoryQueueStatus,
	MemoryDraft,
	GraphNode,
	GraphNodeKind,
	GraphRegion,
	GraphScope,
	GraphSource,
	GraphView,
	RetrievalHit
} from '$shared/types/memory';

export interface MemoryStats {
	nodes: number;
	edges: number;
	episodic: number;
	structural: number;
	vectors: number;
	byScope: Record<GraphScope, number>;
	byProject: { projectId: string | null; count: number }[];
	superseded: number;
	stale: number;
	entities: number;
	confirmedUseful: number;
	forgotten: number;
	embedding: {
		ready: boolean;
		installed: boolean;
		version: string | null;
		dim: number | null;
		rows: number | null;
		error: string | null;
	};
}

export interface NodeDetail {
	node: GraphNode;
	neighbours: { node: GraphNode; hops: number }[];
}

export interface MemoryModel {
	engine: string;
	providerSlug?: string;
	modelId: string;
	accountId?: number;
}

export interface MemoryConfig {
	enabled: boolean;
	recordCode: boolean;
	recordMemories: boolean;
	autoRecall: boolean;
	model: MemoryModel | null;
}

export interface MemoryFilter {
	/**
	 * Which projects the view covers.
	 *
	 * `null` is the untouched default and means every project. An ARRAY is an
	 * explicit choice, and an EMPTY array is a real one: nothing selected means the
	 * user has narrowed away every repository, and what is left is the global
	 * memories that were never a repository's to begin with. That is why there is
	 * no separate "Global" entry to tick — clearing the selection already says it.
	 */
	projectIds: string[] | null;
	kinds: GraphNodeKind[];
	/** Empty means every subkind — the filter is a narrowing, not a whitelist. */
	subkinds: string[];
	/** Empty means any writer: inferred, agent-requested or hand-written. */
	sources: GraphSource[];
	includeArchived: boolean;
}

/** Subkinds offered in the filter, grouped the way the graph itself is split. */
export const EPISODIC_SUBKINDS = [
	'decision',
	'pattern',
	'failure',
	'preference',
	'observation',
	'entity'
] as const;

export const STRUCTURAL_SUBKINDS = ['file', 'symbol', 'module', 'dependency'] as const;

const EMPTY_VIEW: GraphView = {
	level: 'flat',
	nodes: [],
	edges: [],
	bins: [],
	binEdges: [],
	region: null,
	totalNodes: 0,
	truncated: false
};

/**
 * A fingerprint of everything the canvas actually DRAWS.
 *
 * It lives here rather than in the canvas because it belongs to a FETCH, not to
 * a render: computed once when a response lands, it used to be recomputed inside
 * a reactive effect — hashing every label of every node again on any store write
 * that happened to invalidate the effect.
 *
 * Every field that feeds a colour, a size or a caption is folded in, and nothing
 * else: `weight` and `rel` are absent because no drawn property is derived from
 * them, and including them would buy repaints that change no pixels. Positions
 * are absent too, but for a different reason — they move a node without changing
 * what it IS, so they are watched separately by `layoutSignatureOf` and applied
 * without a rebuild.
 *
 * Hashed rather than concatenated: the ids alone are a string joined from up to
 * three thousand entries, and adding labels would build a few hundred kilobytes
 * on every refetch to then throw it away.
 */
function signatureOf(view: GraphView): string {
	let hash = 2166136261;
	const feed = (value: string | number): void => {
		const text = typeof value === 'number' ? value.toString(36) : value;
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		// A field separator, so ("ab","c") and ("a","bc") cannot collide.
		hash ^= 0x1f;
		hash = Math.imul(hash, 16777619);
	};

	for (const node of view.nodes) {
		feed(node.id);
		feed(node.label);
		feed(node.kind);
		feed(node.community);
		feed(node.degree);
	}
	for (const edge of view.edges) {
		feed(edge.source);
		feed(edge.target);
	}
	for (const bin of view.bins) {
		feed(bin.id);
		feed(bin.label);
		feed(bin.members);
		feed(bin.community);
	}
	for (const edge of view.binEdges) {
		feed(edge.source);
		feed(edge.target);
	}
	return `${view.level}:${view.nodes.length}:${view.edges.length}:${view.bins.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * A fingerprint of WHERE things are, kept apart from what they are.
 *
 * The two change on different schedules and want different responses. A changed
 * node set has to rebuild the graph; a changed arrangement must not, because a
 * rebuild resets the camera and replays the entrance — and the arrangement
 * changes on its own, seconds after any memory is recorded, when the background
 * layout pass lands.
 *
 * Without this the canvas never saw those positions at all: the structural
 * signature was identical, so a graph the client had laid out for itself stayed
 * on screen until the modal was closed and reopened.
 */
function layoutSignatureOf(view: GraphView): string {
	let hash = 2166136261;
	const feed = (value: number): void => {
		// Rounded, so a position that moved a fraction of a pixel does not read as
		// news. The layout pass re-settles slightly on every run.
		const text = Math.round(value).toString(36);
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		hash ^= 0x1f;
		hash = Math.imul(hash, 16777619);
	};

	let placed = 0;
	for (const node of view.nodes) {
		if (node.x === undefined || node.y === undefined) continue;
		placed++;
		feed(node.x);
		feed(node.y);
	}
	for (const bin of view.bins) {
		feed(bin.x);
		feed(bin.y);
	}
	return `${placed}:${(hash >>> 0).toString(36)}`;
}

/** Forgotten memories fetched per page. The list is a review queue, not a feed. */
const FORGOTTEN_PAGE = 200;

let view = $state<GraphView>(EMPTY_VIEW);
let viewSignature = $state(signatureOf(EMPTY_VIEW));
let layoutSignature = $state(layoutSignatureOf(EMPTY_VIEW));
let loading = $state(false);

/**
 * The part of the layout being looked at closely, when a crowded mark was opened.
 *
 * NAVIGATION, not filtering, which is why it does not live in `filter`: a filter
 * narrows what exists, this chooses what to look at closely. Changing a filter
 * clears it, because the rectangle was read off an arrangement the new filter
 * may not produce.
 */
let region = $state<GraphRegion | null>(null);
let stats = $state<MemoryStats | null>(null);
let selected = $state<NodeDetail | null>(null);
let selectedLoading = $state(false);
let searchHits = $state<RetrievalHit[]>([]);
let searching = $state(false);
let searchQuery = $state('');
let vectorUsed = $state(true);
let config = $state<MemoryConfig | null>(null);
let filter = $state<MemoryFilter>({
	projectIds: null,
	kinds: ['episodic', 'structural'],
	subkinds: [],
	sources: [],
	includeArchived: false
});

/** What the extraction queue is doing — see MemoryQueueStatus. */
let status = $state<MemoryQueueStatus | null>(null);

/**
 * Which graph fetch is the current one.
 *
 * Refreshes overlap routinely — a filter change while a `memory:changed` refetch
 * is still in flight — and nothing about a WebSocket request guarantees the
 * replies come back in the order they were sent. Without this, a slower earlier
 * response lands last and wins, so the view settles on a result nobody asked for
 * and stays there until something triggers yet another refresh.
 */
let refreshSeq = 0;

/** The forgotten list: archived and superseded memories, and what is selected. */
let forgotten = $state<GraphNode[]>([]);
let forgottenTotal = $state(0);
let forgottenLoading = $state(false);
let forgottenSelection = $state<Set<string>>(new Set());

/**
 * Hovering a search result should feel like hovering the node it names, so the
 * canvas subscribes to this rather than the list reaching into it. A store field
 * keeps the two views in step without either owning the other.
 */
let hoveredId = $state<string | null>(null);

export const memoryGraphStore = {
	get view() { return view; },
	/** Changes exactly when the drawn graph changes; see `signatureOf`. */
	get viewSignature() { return viewSignature; },
	/** Changes when the persisted arrangement moves; see `layoutSignatureOf`. */
	get layoutSignature() { return layoutSignature; },
	get region() { return region; },
	get loading() { return loading; },
	get stats() { return stats; },
	get selected() { return selected; },
	get selectedLoading() { return selectedLoading; },
	get searchHits() { return searchHits; },
	get searching() { return searching; },
	get searchQuery() { return searchQuery; },
	get vectorUsed() { return vectorUsed; },
	get filter() { return filter; },
	get config() { return config; },
	get forgotten() { return forgotten; },
	get forgottenTotal() { return forgottenTotal; },
	get forgottenLoading() { return forgottenLoading; },
	get forgottenSelection() { return forgottenSelection; },
	get hoveredId() { return hoveredId; },
	get status() { return status; },

	/**
	 * Config is shared by two settings screens (the model picker under Models and
	 * the behaviour page under Memory), so it lives here rather than in either
	 * component — otherwise changing the model on one would leave the other
	 * showing a stale copy.
	 */
	async fetchConfig(): Promise<MemoryConfig | null> {
		try {
			config = (await ws.http('memory:config', {})) as MemoryConfig;
		} catch (error) {
			debug.error('settings', 'Failed to load memory config:', error);
			config = null;
		}
		return config;
	},

	async saveConfig(patch: Partial<MemoryConfig>): Promise<MemoryConfig | null> {
		config = (await ws.http('memory:save-config', patch)) as MemoryConfig;
		return config;
	},

	setFilter(patch: Partial<MemoryFilter>): void {
		filter = { ...filter, ...patch };
		// The rectangle was read off an arrangement this filter may not produce, so
		// keeping it would zoom the new graph to a patch of the old one's plane.
		region = null;
		void this.refresh();
	},

	/**
	 * Zoom into one crowded mark, drawing the memories it stands for.
	 *
	 * REPLACES rather than accumulates. Holding several unrelated rectangles at
	 * once has no coherent picture to draw and would make "back" undo them one at
	 * a time — a history nobody asked to build. One region, and the whole graph is
	 * always one step away.
	 */
	focusRegion(next: GraphRegion): void {
		region = next;
		void this.refresh();
	},

	/** Back to the whole graph. */
	clearRegion(): void {
		if (!region) return;
		region = null;
		selected = null;
		void this.refresh();
	},

	async refresh(): Promise<void> {
		const seq = ++refreshSeq;
		loading = true;
		try {
			const next = (await ws.http('memory:graph', {
				...(filter.projectIds !== null && { projectIds: filter.projectIds }),
				kinds: filter.kinds,
				...(filter.subkinds.length > 0 && { subkinds: filter.subkinds }),
				...(filter.sources.length > 0 && { sources: filter.sources }),
				...(region !== null && { region }),
				includeArchived: filter.includeArchived
			})) as GraphView;
			// A newer fetch has already been issued, so this answer describes a filter
			// or a moment the user has moved on from. Dropping it is the whole point.
			if (seq !== refreshSeq) return;
			view = next;
			viewSignature = signatureOf(next);
			layoutSignature = layoutSignatureOf(next);
			// The server decides the resolution — a graph can fall back to the flat
			// view while its arrangement is still being computed — so what it
			// answered with is the truth about what is drawn, not what was asked.
			region = next.region;
		} catch (error) {
			if (seq !== refreshSeq) return;
			debug.error('settings', 'Failed to load memory graph:', error);
			view = EMPTY_VIEW;
			viewSignature = signatureOf(EMPTY_VIEW);
			layoutSignature = layoutSignatureOf(EMPTY_VIEW);
		} finally {
			// Still loading, as far as the user is concerned — the request that
			// overtook this one has not answered yet.
			if (seq === refreshSeq) loading = false;
		}
	},

	/**
	 * Poll-free: this is refetched when the server says the queue moved, and once
	 * when a view opens. Recording is background work, so without it the UI has no
	 * way to distinguish "nothing worth remembering happened" from "the model has
	 * been failing for an hour".
	 */
	async refreshStatus(): Promise<void> {
		try {
			status = (await ws.http('memory:status', {})) as MemoryQueueStatus;
		} catch (error) {
			debug.error('settings', 'Failed to load memory status:', error);
			status = null;
		}
	},

	async retryFailed(): Promise<number> {
		const result = (await ws.http('memory:retry-failed', {})) as { requeued: number };
		await this.refreshStatus();
		return result.requeued;
	},

	async refreshStats(): Promise<void> {
		try {
			stats = (await ws.http('memory:stats', {})) as MemoryStats;
		} catch (error) {
			debug.error('settings', 'Failed to load memory stats:', error);
			stats = null;
		}
	},

	async select(nodeId: string | null, hops = 1): Promise<void> {
		if (!nodeId) {
			selected = null;
			return;
		}
		selectedLoading = true;
		try {
			const detail = (await ws.http('memory:node', { nodeId, hops })) as {
				node: GraphNode | null;
				neighbours: { node: GraphNode; hops: number }[];
			};
			// A node can vanish between the click and the fetch (another member
			// forgot it), which is a cleared selection rather than an error.
			selected = detail.node ? { node: detail.node, neighbours: detail.neighbours } : null;
		} catch (error) {
			debug.error('settings', 'Failed to load memory node:', error);
			selected = null;
		} finally {
			selectedLoading = false;
		}
	},

	async search(query: string): Promise<void> {
		searchQuery = query;
		const trimmed = query.trim();
		if (!trimmed) {
			searchHits = [];
			return;
		}

		searching = true;
		try {
			const result = (await ws.http('memory:search', {
				query: trimmed,
				...(filter.projectIds !== null && { projectIds: filter.projectIds }),
				kinds: filter.kinds,
				...(filter.subkinds.length > 0 && { subkinds: filter.subkinds }),
				...(filter.sources.length > 0 && { sources: filter.sources }),
				includeArchived: filter.includeArchived,
				limit: 30
			})) as { hits: RetrievalHit[]; vectorUsed: boolean };
			searchHits = result.hits;
			vectorUsed = result.vectorUsed;
		} catch (error) {
			debug.error('settings', 'Memory search failed:', error);
			searchHits = [];
		} finally {
			searching = false;
		}
	},

	clearSearch(): void {
		searchQuery = '';
		searchHits = [];
	},

	async saveNode(
		nodeId: string,
		patch: { label?: string; body?: string; subkind?: string }
	): Promise<void> {
		await ws.http('memory:save-node', { nodeId, ...patch });
		// The label may have changed, so the graph view's node caption is stale too.
		await Promise.all([this.select(nodeId), this.refresh()]);
	},

	async archiveNode(nodeId: string): Promise<void> {
		await ws.http('memory:archive-node', { nodeId });
		selected = null;
		await Promise.all([this.refresh(), this.refreshStats()]);
	},

	/**
	 * Bring memories back into recall.
	 *
	 * One call for one item and for a selection, because the server treats them
	 * identically — and because "restore" covers both kinds of forgetting: an
	 * archived memory and one a model decided had been replaced.
	 */
	async restoreNodes(nodeIds: string[]): Promise<number> {
		if (nodeIds.length === 0) return 0;
		const result = (await ws.http('memory:restore-nodes', { nodeIds })) as { restored: number };
		forgottenSelection = new Set();
		await Promise.all([this.refresh(), this.refreshStats(), this.refreshForgotten()]);
		if (nodeIds.length === 1) await this.select(nodeIds[0]);
		return result.restored;
	},

	// ── writing one by hand ─────────────────────────────────────────────────

	/**
	 * Shape free text into a reviewable draft. Never saves anything.
	 *
	 * `structure: false` skips the model and splits the text as written, which is
	 * what makes this path work on an instance with no memory model configured —
	 * exactly the instance whose graph is otherwise empty.
	 */
	async draftNode(text: string, options?: { structure?: boolean }): Promise<MemoryDraft | null> {
		const result = (await ws.http('memory:draft-node', {
			text,
			...(options?.structure !== undefined && { structure: options.structure })
		})) as { draft: MemoryDraft | null };
		return result.draft;
	},

	/** Store a reviewed draft. */
	async createNode(input: {
		subkind: string;
		scope: 'project' | 'global';
		label: string;
		body: string;
		entities?: string[];
		relatedPaths?: string[];
		pinned?: boolean;
		reinforceId?: string | null;
	}): Promise<GraphNode | null> {
		const result = (await ws.http('memory:create-node', {
			subkind: input.subkind as MemoryDraft['subkind'],
			scope: input.scope,
			label: input.label,
			body: input.body,
			entities: input.entities ?? [],
			relatedPaths: input.relatedPaths ?? [],
			pinned: input.pinned ?? false,
			...(input.reinforceId && { reinforceId: input.reinforceId })
		})) as { node: GraphNode | null };
		await Promise.all([this.refresh(), this.refreshStats()]);
		return result.node;
	},

	// ── the forgotten list ──────────────────────────────────────────────────

	async refreshForgotten(): Promise<void> {
		forgottenLoading = true;
		try {
			const result = (await ws.http('memory:forgotten', {
				...(filter.projectIds !== null && { projectIds: filter.projectIds }),
				limit: FORGOTTEN_PAGE
			})) as { nodes: GraphNode[]; total: number };
			forgotten = result.nodes;
			forgottenTotal = result.total;
			// A selection that survives a refresh can hold ids that no longer exist,
			// which would then be sent to a delete that silently does nothing.
			const live = new Set(result.nodes.map(node => node.id));
			forgottenSelection = new Set([...forgottenSelection].filter(id => live.has(id)));
		} catch (error) {
			debug.error('settings', 'Failed to load forgotten memories:', error);
			forgotten = [];
			forgottenTotal = 0;
		} finally {
			forgottenLoading = false;
		}
	},

	toggleForgottenSelection(nodeId: string): void {
		// Reassigned rather than mutated: a Set mutated in place is the same object,
		// so $state has nothing to compare and the UI never updates.
		const next = new Set(forgottenSelection);
		if (next.has(nodeId)) next.delete(nodeId);
		else next.add(nodeId);
		forgottenSelection = next;
	},

	selectAllForgotten(select: boolean): void {
		forgottenSelection = select ? new Set(forgotten.map(node => node.id)) : new Set();
	},

	/** Permanently delete the selected memories. Returns how many were removed. */
	async deleteSelectedForgotten(): Promise<number> {
		const nodeIds = [...forgottenSelection];
		if (nodeIds.length === 0) return 0;

		const result = (await ws.http('memory:delete-nodes', { nodeIds })) as { deleted: number };
		forgottenSelection = new Set();
		await Promise.all([this.refreshForgotten(), this.refresh(), this.refreshStats()]);
		return result.deleted;
	},

	/**
	 * Delete every memory in a project, or — with no project — in the whole
	 * instance. There is no undo; the caller is responsible for confirming.
	 */
	async purge(projectIds?: string[]): Promise<{ nodes: number; edges: number }> {
		const result = (await ws.http('memory:purge', {
			...(projectIds !== undefined && { projectIds })
		})) as { nodes: number; edges: number };

		selected = null;
		searchHits = [];
		await Promise.all([this.refresh(), this.refreshStats(), this.refreshForgotten()]);
		return result;
	},

	// ── cross-view hover ────────────────────────────────────────────────────

	setHovered(nodeId: string | null): void {
		hoveredId = nodeId;
	},

	// ── live updates ────────────────────────────────────────────────────────

	/**
	 * Follow the graph while it is being written.
	 *
	 * The view used to be a snapshot taken at mount: a conversation could add eight
	 * memories with the modal open and none appeared until the page was reloaded.
	 * The server coalesces its own writes (see backend/memory/notify.ts), and this
	 * debounces on top of that, because several clients acting on one event should
	 * not turn into several refetches per client.
	 *
	 * Returns an unsubscribe function for the component's teardown.
	 */
	subscribeToChanges(): () => void {
		let timer: ReturnType<typeof setTimeout> | null = null;

		const off = ws.on('memory:changed', () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				void this.refresh();
				void this.refreshStats();
			}, 400);
		});

		// The queue moves far more often than the graph — every enqueue, retry and
		// failure — and refetching a handful of counts is cheap, so it is not
		// debounced alongside the graph refetch.
		const offStatus = ws.on('memory:status-changed', () => {
			void this.refreshStatus();
		});

		// `memory:changed` is a doorbell, and a doorbell rung while nobody is home
		// is simply not heard: the events emitted during a dropped connection are
		// gone, not queued. A socket can drop for a server restart, a sleeping
		// laptop or a tunnel hiccup while this view sits open the whole time, so
		// without a refetch on the way back the graph is silently stale with no
		// event left to correct it.
		const offReconnect = onWsReconnect(() => {
			void this.refresh();
			void this.refreshStats();
			void this.refreshStatus();
		});

		return () => {
			if (timer) clearTimeout(timer);
			off();
			offStatus();
			offReconnect();
		};
	}
};
