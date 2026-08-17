/**
 * Graph view assembly for the visualization.
 *
 * ── What this file is NOT allowed to do any more ─────────────────────────────
 * It used to run Louvain on every call. Community detection is stable per
 * dataset, so opening the modal, changing a filter, or any conversation
 * recording a memory made every connected client pay for the same clustering
 * again — and the cost grew with the store rather than with what was on screen.
 * It now lives in `graph_layout`, written by the background pass in `layout.ts`,
 * and this file only reads it.
 *
 * ── Showing everything, at bounded cost ──────────────────────────────────────
 * The old view answered scale with a cap: return the three thousand most
 * reinforced memories and set `truncated`. That is not a scale strategy, it is a
 * silent ceiling — past it the rest of the store simply was not in the picture,
 * with no way to reach it but narrowing a filter.
 *
 * The answer here is to aggregate by POSITION rather than to trim by rank, and
 * the difference is what the user sees. Grouping by community — the obvious
 * alternative, and the first thing tried — replaces the picture: you get lobes
 * instead of memories, and reaching any memory means opening one first. Grouping
 * by position keeps the picture. The layout plane is divided into a grid fine
 * enough that the number of OCCUPIED cells is bounded, and each occupied cell
 * becomes one mark. Marks merge only where their dots would have overlapped
 * anyway, so the silhouette, the lobes and the colours are the ones the full
 * graph would have drawn, and nothing is missing from it.
 *
 * Below `RENDER_BUDGET` no cell holds more than one memory, so every mark IS a
 * memory and the view is exactly the flat one it always was. Above it, a cell
 * holding one memory still returns that memory — fidelity is lost only where
 * the display had none to give.
 *
 * Zooming into a mark asks for its cell as a rectangle, which costs that
 * rectangle rather than the store.
 */

import { graphQueries, graphLayoutQueries, type GraphBinGrid } from '$backend/database/queries/graph-queries';
import type {
	GraphNode,
	GraphNodeKind,
	GraphRegion,
	GraphScope,
	GraphSource,
	GraphView,
	GraphViewBin,
	GraphViewBinEdge,
	GraphViewEdge,
	GraphViewNode
} from '$shared/types/memory';

/**
 * Marks the client is asked to draw at once.
 *
 * A ceiling on the WORK, not on the content: past it marks merge rather than
 * disappear. Set where a WebGL scene stays comfortable on a low-powered machine
 * — the graph build, sigma's indexation and the per-frame reducers are all
 * linear in this number, and it is the only number they are linear in.
 */
const RENDER_BUDGET = 3_000;

/** Bin edges drawn at once, heaviest first. Lines are cheaper than marks, not free. */
const MAX_BIN_EDGES = 6_000;

/** Longest caption a mark carries; the full text belongs to the inspector. */
const BIN_LABEL_MAX = 60;

export interface GraphViewFilter {
	/** `undefined` = every project (cross-project view); `null` = global only. */
	projectId?: string | null;
	/** The multi-select's answer: absent = every project, empty = global only. */
	projectIds?: string[];
	kinds?: GraphNodeKind[];
	/** Narrow to particular subkinds — decisions only, failures only, and so on. */
	subkinds?: string[];
	scopes?: GraphScope[];
	/** Narrow by who wrote it: inferred, agent-requested, or hand-written. */
	sources?: GraphSource[];
	includeArchived?: boolean;
	/** Show memories that have been replaced by a newer belief. Off by default. */
	includeSuperseded?: boolean;
	/**
	 * A rectangle of the layout to restrict to — how a mark is opened.
	 *
	 * Navigation, not filtering: it narrows what is DRAWN without changing what
	 * the graph is, which is why the totals it reports are the region's.
	 */
	region?: GraphRegion;
	limit?: number;
}

export function buildGraphView(filter: GraphViewFilter): GraphView {
	const limit = Math.min(filter.limit ?? RENDER_BUDGET, RENDER_BUDGET);
	const region = filter.region ?? null;

	// Zoomed in: the rectangle is already a bounded slice of the arrangement, so
	// it is drawn at full fidelity and counted within itself.
	if (region) {
		const nodes = graphQueries.listInRegion({ ...filter, limit }, region);
		return flat(nodes, region, nodes.length, false);
	}

	const extent = graphLayoutQueries.extent(filter);

	// Either it fits, or nothing has been laid out yet — a fresh install, or the
	// first fetch after the upgrade added the table. Both draw the flat view: the
	// second because binning needs positions, and falling back to what the feature
	// always did means the graph is never empty while the background pass catches
	// up.
	const laidOut = extent.total - extent.unplaced;
	if (extent.total <= RENDER_BUDGET || laidOut === 0) {
		const nodes = graphQueries.list({ ...filter, limit });
		return flat(nodes, null, extent.total, extent.total > nodes.length);
	}

	return binned(filter, extent, limit);
}

/**
 * Every matching memory, drawn individually.
 *
 * The ordinary case and the one the view is tuned for — below the render budget
 * this is the whole story, and it is unchanged from before any of this existed.
 */
function flat(
	nodes: GraphNode[],
	region: GraphRegion | null,
	totalNodes: number,
	truncated: boolean
): GraphView {
	if (nodes.length === 0) {
		return {
			level: 'flat',
			nodes: [],
			edges: [],
			bins: [],
			binEdges: [],
			region,
			totalNodes,
			truncated: false
		};
	}

	const ids = nodes.map(node => node.id);
	const stored = graphQueries.edgesWithin(ids);

	// Two memories about the same subject ARE connected, and that connection is
	// stated by extraction rather than inferred from how they are worded. It is
	// derived here rather than stored, so it can never outlive the claim it came
	// from — see `derivedEdges`.
	//
	// Without it the episodic half has almost no structure at all. Similarity
	// linking used to supply it, badly: on a real graph 144 of 371 edges were
	// fabricated by cosine over a corpus with no variance. Removing that was right
	// and removing it ALONE was not — the view became ninety-three disconnected
	// dots, which is a less honest picture than the wrong one, because these
	// memories genuinely do belong together.
	const derived: GraphViewEdge[] = graphQueries.derivedEdges(ids).map((edge, index) => ({
		// Negative ids, so nothing can mistake a derived edge for a stored row and
		// try to delete or re-weight it.
		id: -(index + 1),
		source: edge.srcId,
		target: edge.dstId,
		rel: 'relates_to' as const,
		weight: edge.weight
	}));

	// Degree is counted over what is being DRAWN, so a node's size answers "how
	// connected is this within what I am looking at" — which is the question the
	// eye is actually asking.
	const degree = new Map<string, number>();
	const bump = (srcId: string, dstId: string): void => {
		degree.set(srcId, (degree.get(srcId) ?? 0) + 1);
		degree.set(dstId, (degree.get(dstId) ?? 0) + 1);
	};
	for (const edge of stored) bump(edge.srcId, edge.dstId);
	for (const edge of derived) bump(edge.source, edge.target);

	const layout = graphLayoutQueries.read(ids);
	const viewNodes = nodes.map(node => toViewNode(node, degree.get(node.id) ?? 0, layout.get(node.id)));
	placeArrivals(viewNodes, [...stored.map(edge => ({ source: edge.srcId, target: edge.dstId })), ...derived]);

	return {
		level: 'flat',
		nodes: viewNodes,
		edges: [
			...stored.map(edge => ({
				id: edge.id,
				source: edge.srcId,
				target: edge.dstId,
				rel: edge.rel,
				weight: edge.weight
			})),
			...derived
		],
		bins: [],
		binEdges: [],
		region,
		totalNodes,
		truncated
	};
}

/**
 * The whole graph, with crowded neighbourhoods folded into single marks.
 *
 * Cells holding exactly one memory come back as that memory, so this is a flat
 * view everywhere the display could have drawn one — which, in a force layout,
 * is most of the periphery. Only the dense middle merges, and only as far as it
 * was going to overlap.
 */
function binned(
	filter: GraphViewFilter,
	extent: { total: number; minX: number; maxX: number; minY: number; maxY: number },
	limit: number
): GraphView {
	const grid = gridFor(extent);
	const cells = graphLayoutQueries.binnedNodes(filter, grid);

	// A cell of one is not a bin, it is a memory. Splitting them here is what
	// keeps the picture inspectable: everything the grid did not have to merge
	// stays clickable, hoverable and highlightable exactly as before.
	const singles = cells.filter(cell => cell.members === 1);
	const groups = cells.filter(cell => cell.members > 1);

	const nodes = graphQueries.getByIds(singles.map(cell => cell.id));
	const byId = new Map(nodes.map(node => [node.id, node]));
	const layout = graphLayoutQueries.read(nodes.map(node => node.id));

	// Which mark each cell is, so the rolled-up edges can name their ends. A
	// single's mark is the memory's own id; a group's is the cell.
	const markOf = new Map<string, string>();
	for (const cell of cells) {
		markOf.set(cellKey(cell.cellX, cell.cellY), cell.members === 1 ? cell.id : binId(cell.cellX, cell.cellY));
	}

	const binEdges: GraphViewBinEdge[] = [];
	const nodeEdges: GraphViewEdge[] = [];
	let syntheticId = -1;

	for (const edge of graphLayoutQueries.binnedEdges(filter, grid, MAX_BIN_EDGES)) {
		const source = markOf.get(cellKey(edge.srcX, edge.srcY));
		const target = markOf.get(cellKey(edge.dstX, edge.dstY));
		if (!source || !target || source === target) continue;

		// An edge between two singles is a real edge between two real memories, and
		// the canvas dims and highlights those against the node it is anchored on.
		// Demoting it to a bin edge would break hover on exactly the marks that did
		// not need binning in the first place.
		if (byId.has(source) && byId.has(target)) {
			nodeEdges.push({
				id: syntheticId--,
				source,
				target,
				rel: 'relates_to',
				weight: edge.weight
			});
		} else {
			binEdges.push({ source, target, weight: edge.weight });
		}
	}

	// Degree over what is drawn, same as the flat path — counting both kinds of
	// edge, because a memory next to a dense clump is well connected whether or
	// not the thing it connects to had to be merged.
	const degree = new Map<string, number>();
	const bump = (id: string): void => {
		degree.set(id, (degree.get(id) ?? 0) + 1);
	};
	for (const edge of nodeEdges) {
		bump(edge.source);
		bump(edge.target);
	}
	for (const edge of binEdges) {
		bump(edge.source);
		bump(edge.target);
	}

	const bins: GraphViewBin[] = groups.map(cell => ({
		id: binId(cell.cellX, cell.cellY),
		members: cell.members,
		label: truncate(cell.label ?? ''),
		community: cell.community,
		x: cell.x,
		y: cell.y,
		region: {
			minX: grid.originX + cell.cellX * grid.cellWidth,
			maxX: grid.originX + (cell.cellX + 1) * grid.cellWidth,
			minY: grid.originY + cell.cellY * grid.cellHeight,
			maxY: grid.originY + (cell.cellY + 1) * grid.cellHeight
		}
	}));

	return {
		level: 'binned',
		nodes: singles
			.map(cell => byId.get(cell.id))
			.filter((node): node is GraphNode => node !== undefined)
			.map(node => toViewNode(node, degree.get(node.id) ?? 0, layout.get(node.id))),
		edges: nodeEdges,
		bins,
		binEdges,
		region: null,
		totalNodes: extent.total,
		// Nothing was left out — every memory is inside one of these marks. The
		// only thing a binned view withholds is which memory is which inside a
		// crowd, and opening the mark answers that.
		truncated: nodes.length + bins.length > limit
	};
}

/**
 * The grid, sized so the number of cells cannot exceed the render budget.
 *
 * Cells are square in layout space rather than fitted to the extent's aspect
 * ratio: a non-square cell merges more readily along one axis than the other,
 * which shows up as marks that smear horizontally or vertically — the eye reads
 * that as structure, and there is none.
 */
function gridFor(extent: { minX: number; maxX: number; minY: number; maxY: number }): GraphBinGrid {
	const width = Math.max(1e-6, extent.maxX - extent.minX);
	const height = Math.max(1e-6, extent.maxY - extent.minY);

	// One axis of the grid. Squared, this is the cell count, so it is the budget's
	// square root — and the longer side sets the cell size for both.
	const perAxis = Math.max(1, Math.floor(Math.sqrt(RENDER_BUDGET)));
	const cell = Math.max(width, height) / perAxis;

	return {
		originX: extent.minX,
		originY: extent.minY,
		cellWidth: cell,
		cellHeight: cell
	};
}

function toViewNode(
	node: GraphNode,
	degree: number,
	placed?: { community: number; x: number; y: number; placed: number }
): GraphViewNode {
	return {
		id: node.id,
		kind: node.kind,
		subkind: node.subkind,
		scope: node.scope,
		label: node.label,
		projectId: node.projectId,
		degree,
		weight: node.weight,
		pinned: node.pinned,
		community: placed?.community ?? 0,
		createdAt: node.createdAt,
		// Sent ONLY when the simulation computed it. A memory written since the
		// last pass has no row at all, and one below the simulation cap has a row
		// holding a guess — in both cases the client seeds it from its neighbours,
		// which is a far better answer than drawing a whole lobe on one point.
		...(placed?.placed === 1 && { x: placed.x, y: placed.y })
	};
}

/**
 * Give a position to anything the arrangement has not reached yet.
 *
 * A memory recorded while the modal is open has no layout row: the background
 * pass is debounced behind the notification that announces the memory, so the
 * first fetch after it lands is always a few seconds early. Sending it without
 * coordinates left the client to invent some, and what it invented was the
 * middle of the map — a new memory appearing nowhere near the subject it is
 * about.
 *
 * Derived HERE instead, from the same rule the layout pass itself uses: the
 * centroid of whatever it connects to. The answer is therefore the one the pass
 * will confirm a few seconds later rather than one it will have to correct, and
 * the client stops having an opinion about placement at all.
 *
 * Read-time only — nothing is written. A position that has not been through the
 * simulation is a guess, and guesses do not belong in the table the simulation
 * owns.
 *
 * A node with no placed neighbour is deliberately LEFT without a position. That
 * is the honest signal for "the arrangement does not cover this yet", and it is
 * what the client's cold fallback keys on — inventing a centroid for a store that
 * has never been laid out would replace a considered scatter with a meaningless
 * one.
 */
function placeArrivals(nodes: GraphViewNode[], edges: { source: string; target: string }[]): void {
	const arrivals = nodes.filter(node => node.x === undefined);
	if (arrivals.length === 0) return;

	const byId = new Map(nodes.map(node => [node.id, node]));
	const adjacency = new Map<string, string[]>();
	const link = (from: string, to: string): void => {
		const neighbours = adjacency.get(from);
		if (neighbours) neighbours.push(to);
		else adjacency.set(from, [to]);
	};
	for (const edge of edges) {
		link(edge.source, edge.target);
		link(edge.target, edge.source);
	}

	// Three passes, so a small cluster of arrivals resolves outward from whichever
	// end touches the existing map rather than all of them giving up at once.
	for (let pass = 0; pass < 3; pass++) {
		let settled = 0;

		for (const node of arrivals) {
			if (node.x !== undefined) continue;

			let sumX = 0;
			let sumY = 0;
			let count = 0;
			for (const neighbour of adjacency.get(node.id) ?? []) {
				const other = byId.get(neighbour);
				if (!other || other.x === undefined || other.y === undefined) continue;
				sumX += other.x;
				sumY += other.y;
				count++;
			}
			if (count === 0) continue;

			// Nudged off the exact centroid, or several arrivals about one subject
			// land on the same point and read as a single node.
			const jitter = jitterOf(node.id);
			node.x = sumX / count + jitter.x * 24;
			node.y = sumY / count + jitter.y * 24;
			settled++;
		}

		if (settled === 0) break;
	}
}

/** A deterministic offset in [-1, 1]², derived from an id. FNV-1a. */
function jitterOf(id: string): { x: number; y: number } {
	let hash = 2166136261;
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	hash = hash >>> 0;
	return {
		x: ((hash % 65536) / 65536) * 2 - 1,
		y: (((hash >>> 16) % 65536) / 65536) * 2 - 1
	};
}

/** Namespaced so a bin's id can never collide with a node's. */
function binId(cellX: number, cellY: number): string {
	return `bin:${cellX}:${cellY}`;
}

function cellKey(cellX: number, cellY: number): string {
	return `${cellX}:${cellY}`;
}

function truncate(label: string): string {
	return label.length > BIN_LABEL_MAX ? `${label.slice(0, BIN_LABEL_MAX - 1)}…` : label;
}

/** A node plus the nodes it reaches — what the inspector renders. */
export function buildNodeDetail(nodeId: string, hops = 1) {
	const node = graphQueries.getById(nodeId);
	if (!node) return null;

	return {
		node,
		neighbours: graphQueries.neighbours(nodeId, hops).map(n => ({ node: n.node, hops: n.hops }))
	};
}
