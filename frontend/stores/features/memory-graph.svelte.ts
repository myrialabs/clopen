/**
 * Memory Graph Store
 *
 * Backs the Memory modal: what the map covers, the selected node's
 * neighbourhood, and hybrid search. It is a view over server state — the graph
 * is instance-global and every engine writes to it — so nothing is cached
 * optimistically: a mutation refetches, because another session may have
 * changed the same node between renders.
 *
 * The map itself is served as tiles (see `backend/memory/view.ts`), and the
 * canvas asks for the ones it is looking at. This store holds what the tiles
 * are relative to — the meta: world, epoch, counts — plus a `revision` that
 * moves whenever what the tiles would say has changed, so the canvas knows to
 * fetch the ones on screen again.
 */

import ws, { onWsReconnect } from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type {
	MemoryQueueStatus,
	MemoryDraft,
	GraphNode,
	GraphScope,
	GraphSource,
	GraphTileNode,
	GraphTilesResponse,
	GraphViewMeta,
	RetrievalHit
} from '$shared/types/memory';

export interface MemoryStats {
	nodes: number;
	edges: number;
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
	/** Empty means every subkind — the filter is a narrowing, not a whitelist. */
	subkinds: string[];
	/** Empty means any writer: inferred, agent-requested or hand-written. */
	sources: GraphSource[];
	includeArchived: boolean;
}

/** Subkinds offered in the filter. */
export const EPISODIC_SUBKINDS = [
	'decision',
	'pattern',
	'failure',
	'preference',
	'observation',
	'entity'
] as const;

/** Forgotten memories fetched per page. The list is a review queue, not a feed. */
const FORGOTTEN_PAGE = 200;

/** What the map covers under the current filter; null until first fetched. */
let meta = $state<GraphViewMeta | null>(null);
let loading = $state(false);

/**
 * Moves whenever the tiles on screen may say something different — a write, a
 * layout pass, a filter change, a mutation from this client.
 *
 * A counter rather than a signature of the data, because the data is not here:
 * it is in whichever tiles the canvas happens to be showing, and only the
 * canvas can refetch those.
 */
let revision = $state(0);

/**
 * Memories that must be on the map whatever the tiles around them say: the
 * selected one, its connections, and the search results.
 *
 * They are the things the user is looking FOR, and the tile they sit in may be
 * folded into a cluster or not loaded at all. Drawing them on top keeps
 * selection, hover and highlight working on exactly what was asked about.
 */
let pinned = $state<GraphTileNode[]>([]);
/** The edges from the selected memory to its listed connections. */
let pinnedEdges = $state<{ source: string; target: string }[]>([]);
let searchPinned: GraphTileNode[] = [];
let selectionPinned: GraphTileNode[] = [];

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
	subkinds: [],
	sources: [],
	includeArchived: false
});

/** What the extraction queue is doing — see MemoryQueueStatus. */
let status = $state<MemoryQueueStatus | null>(null);

/**
 * Which meta fetch is the current one.
 *
 * Refreshes overlap routinely — a filter change while a `memory:changed` refetch
 * is still in flight — and nothing about a WebSocket request guarantees the
 * replies come back in the order they were sent. Without this, a slower earlier
 * response lands last and wins, so the view settles on a result nobody asked for
 * and stays there until something triggers yet another refresh.
 */
let refreshSeq = 0;
let selectSeq = 0;
let searchSeq = 0;

/** The filter as the graph requests send it. */
function filterParams(): {
	projectIds?: string[];
	subkinds?: string[];
	sources?: GraphSource[];
	includeArchived: boolean;
} {
	return {
		...(filter.projectIds !== null && { projectIds: filter.projectIds }),
		...(filter.subkinds.length > 0 && { subkinds: filter.subkinds }),
		...(filter.sources.length > 0 && { sources: filter.sources }),
		includeArchived: filter.includeArchived
	};
}

/**
 * Everything in the meta whose change means the tiles on screen may be out of
 * date. The PLACED count rather than the total: a memory that has just been
 * written has no position yet, so it is in no tile until the pass that places
 * it moves the stamp — refetching for it any earlier fetches the same tiles.
 */
function metaSignature(value: GraphViewMeta): string {
	return JSON.stringify([
		value.epoch,
		value.stamp,
		value.total - value.unplaced,
		value.degreeScale,
		value.world,
		value.extent
	]);
}

function republishPinned(): void {
	const byId = new Map<string, GraphTileNode>();
	for (const node of [...selectionPinned, ...searchPinned]) byId.set(node.id, node);
	pinned = [...byId.values()];
}

async function locate(nodeIds: string[]): Promise<GraphTileNode[]> {
	if (nodeIds.length === 0) return [];
	try {
		const result = (await ws.http('memory:locate', { nodeIds })) as { nodes: GraphTileNode[] };
		return result.nodes;
	} catch (error) {
		debug.error('settings', 'Failed to locate memory nodes:', error);
		return [];
	}
}

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
	get meta() { return meta; },
	/** Moves whenever the tiles on screen should be fetched again. */
	get revision() { return revision; },
	/** A key for the current filter — tiles fetched under another are not these. */
	get filterKey() { return JSON.stringify(filterParams()); },
	get pinned() { return pinned; },
	get pinnedEdges() { return pinnedEdges; },
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
		void this.refresh({ force: true });
		// The results were retrieved under the old filter, so they may name
		// memories this one hides.
		if (searchQuery.trim()) void this.search(searchQuery);
	},

	/**
	 * Re-read what the map covers, and tell the canvas to refetch its tiles if
	 * what they would say has changed.
	 *
	 * "Changed" is decided by the meta — epoch, layout stamp, counts — because the
	 * change doorbell rings for every write, including reinforcement on every
	 * recall, which moves nothing on the map. Refetching every tile on screen for
	 * those was a multi-megabyte stall every few seconds while a conversation ran.
	 * `force` is for this client's own mutations: an edited label changes a tile
	 * without changing any count.
	 *
	 * The revision moves when the answer lands rather than when it is asked for,
	 * so the canvas refetches against the epoch and world it is about to be told
	 * about rather than the ones it already had.
	 */
	async refresh(options: { force?: boolean } = {}): Promise<void> {
		const seq = ++refreshSeq;
		loading = true;
		try {
			const next = (await ws.http('memory:graph', filterParams())) as GraphViewMeta;
			// A newer fetch has already been issued, so this answer describes a filter
			// or a moment the user has moved on from. Dropping it is the whole point.
			if (seq !== refreshSeq) return;
			const changed = options.force || meta === null || metaSignature(meta) !== metaSignature(next);
			meta = next;
			if (changed) revision++;
		} catch (error) {
			if (seq !== refreshSeq) return;
			debug.error('settings', 'Failed to load memory graph:', error);
		} finally {
			// Still loading, as far as the user is concerned — the request that
			// overtook this one has not answered yet.
			if (seq === refreshSeq) loading = false;
		}
	},

	/**
	 * Some tiles of the map, at one zoom level, under the current filter.
	 *
	 * Called by the canvas, which is the only thing that knows what is on screen.
	 * A `stale` answer means the map changed since the meta was read; the meta is
	 * refetched, and the revision it bumps makes the canvas ask again.
	 */
	async fetchTiles(request: {
		epoch: number;
		z: number;
		tiles: { x: number; y: number }[];
		budget: number;
	}): Promise<GraphTilesResponse | null> {
		try {
			const response = (await ws.http('memory:graph-tiles', {
				...filterParams(),
				...request
			})) as GraphTilesResponse;
			if (response.stale) void this.refresh({ force: true });
			return response;
		} catch (error) {
			debug.error('settings', 'Failed to load memory graph tiles:', error);
			return null;
		}
	},

	/** Where memories are on the map, for going to one the canvas has not drawn. */
	locate,

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
		const seq = ++selectSeq;
		if (!nodeId) {
			selected = null;
			selectionPinned = [];
			pinnedEdges = [];
			republishPinned();
			return;
		}
		selectedLoading = true;
		try {
			const detail = (await ws.http('memory:node', { nodeId, hops })) as {
				node: GraphNode | null;
				neighbours: { node: GraphNode; hops: number }[];
			};
			if (seq !== selectSeq) return;
			// A node can vanish between the click and the fetch (another session
			// forgot it), which is a cleared selection rather than an error.
			selected = detail.node ? { node: detail.node, neighbours: detail.neighbours } : null;

			// The selection and what it connects to are drawn whatever the tiles say,
			// so its neighbourhood lights up even where the map is folded or not
			// loaded yet.
			const direct = detail.neighbours.filter(entry => entry.hops === 1).map(entry => entry.node.id);
			const located = detail.node ? await locate([detail.node.id, ...direct]) : [];
			if (seq !== selectSeq) return;
			selectionPinned = located;
			const present = new Set(located.map(node => node.id));
			pinnedEdges = present.has(nodeId)
				? direct.filter(id => present.has(id)).map(target => ({ source: nodeId, target }))
				: [];
			republishPinned();
		} catch (error) {
			if (seq !== selectSeq) return;
			debug.error('settings', 'Failed to load memory node:', error);
			selected = null;
			selectionPinned = [];
			pinnedEdges = [];
			republishPinned();
		} finally {
			if (seq === selectSeq) selectedLoading = false;
		}
	},

	async search(query: string): Promise<void> {
		const seq = ++searchSeq;
		searchQuery = query;
		const trimmed = query.trim();
		if (!trimmed) {
			searchHits = [];
			searchPinned = [];
			republishPinned();
			return;
		}

		searching = true;
		try {
			const result = (await ws.http('memory:search', {
				query: trimmed,
				...filterParams(),
				limit: 30
			})) as { hits: RetrievalHit[]; vectorUsed: boolean };
			if (seq !== searchSeq) return;
			searchHits = result.hits;
			vectorUsed = result.vectorUsed;
			// Results are drawn on the map whatever the tiles say, so every one of
			// them can be hovered, highlighted and gone to.
			const located = await locate(result.hits.map(hit => hit.node.id));
			if (seq !== searchSeq) return;
			searchPinned = located;
			republishPinned();
		} catch (error) {
			if (seq !== searchSeq) return;
			debug.error('settings', 'Memory search failed:', error);
			searchHits = [];
			searchPinned = [];
			republishPinned();
		} finally {
			if (seq === searchSeq) searching = false;
		}
	},

	clearSearch(): void {
		searchSeq++;
		searchQuery = '';
		searchHits = [];
		searchPinned = [];
		searching = false;
		republishPinned();
	},

	async saveNode(
		nodeId: string,
		patch: { label?: string; body?: string; subkind?: string }
	): Promise<void> {
		await ws.http('memory:save-node', { nodeId, ...patch });
		// The label may have changed, so the graph view's node caption is stale too.
		await Promise.all([this.select(nodeId), this.refresh({ force: true })]);
	},

	async archiveNode(nodeId: string): Promise<void> {
		await ws.http('memory:archive-node', { nodeId });
		await this.select(null);
		await Promise.all([this.refresh({ force: true }), this.refreshStats()]);
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
		await Promise.all([this.refresh({ force: true }), this.refreshStats(), this.refreshForgotten()]);
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
		await Promise.all([this.refresh({ force: true }), this.refreshStats()]);
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
		await Promise.all([this.refreshForgotten(), this.refresh({ force: true }), this.refreshStats()]);
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

		await this.select(null);
		this.clearSearch();
		await Promise.all([this.refresh({ force: true }), this.refreshStats(), this.refreshForgotten()]);
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
			void this.refresh({ force: true });
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
