/**
 * The Memory graph, served the way a map is.
 *
 * ── Why tiles ────────────────────────────────────────────────────────────────
 * The view used to answer "show me the graph" with the graph: every memory up
 * to a render budget, and past it a single grid laid over the whole extent that
 * merged whatever shared a cell into one mark — which then had to be clicked to
 * see inside. The cost of a look grew with the store, and past the budget the
 * picture was mostly marks standing in for memories.
 *
 * Now the client asks for the squares of the map that are on screen, at the
 * resolution the camera is at, exactly as a map viewer does. The world (see
 * `layout.ts`) is cut into 2^z × 2^z tiles at zoom level z; the client picks the
 * level from its zoom, so a tile is always a few hundred pixels across whatever
 * the zoom. What is on screen therefore costs about the same at any zoom and
 * any store size, and zooming in is how you see more — never clicking.
 *
 * ── What a tile holds ────────────────────────────────────────────────────────
 * The budget is the SCREEN's, not a tile's: how many marks the client can draw
 * at once. When everything in the requested tiles fits it, every memory arrives
 * individually — so a store of a few thousand memories is drawn in full at every
 * zoom, and zooming in can never fold something the overview showed. Only when
 * the screen holds more than the budget is it shared out: sparse tiles keep
 * every memory, and what is left is split between the crowded ones, which are
 * folded into a grid of cells (a cell holding one memory still arrives as that
 * memory). Zooming in shows less of the map, which fits, so every cluster
 * resolves by zooming alone.
 *
 * Edges travel with the tile they leave from, carrying where their far end is,
 * so the client can attach them to whichever mark stands for that end at the
 * moment — the memory itself, or the cluster it is folded into.
 */

import { graphLayoutQueries, graphQueries, type GraphListFilter } from '$backend/database/queries/graph-queries';
import { getLayoutState, scheduleGraphLayout } from './layout';
import type {
	GraphScope,
	GraphSource,
	GraphTile,
	GraphTileCellEdge,
	GraphTileCluster,
	GraphTileNode,
	GraphTilesResponse,
	GraphViewMeta
} from '$shared/types/memory';

/** The deepest zoom level a client may ask for — far past one memory per tile. */
export const MAX_TILE_ZOOM = 20;

/** Tiles served per request. A screen needs a few dozen at most. */
const MAX_TILES_PER_REQUEST = 64;

/** The range a client may ask the screen's budget to be in. */
const MIN_SCREEN_BUDGET = 256;
const MAX_SCREEN_BUDGET = 40_000;

/**
 * Cells per side when a crowded tile is folded.
 *
 * A tile is drawn a few hundred pixels across, so 32 makes a cell 8–16 pixels —
 * about the size a cluster is drawn, which is what stops neighbouring clusters
 * overlapping. Smaller when the budget is smaller, so a folded tile never holds
 * more marks than its budget.
 */
const MAX_CELLS_PER_SIDE = 32;

/** Edges served per tile, as a multiple of the marks it holds, heaviest first. */
const EDGES_PER_MARK = 5;

export interface GraphViewFilter {
	/** The multi-select's answer: absent = every project, empty = global only. */
	projectIds?: string[];
	/** Narrow to particular subkinds — decisions only, failures only, and so on. */
	subkinds?: string[];
	scopes?: GraphScope[];
	/** Narrow by who wrote it: inferred, agent-requested, or hand-written. */
	sources?: GraphSource[];
	includeArchived?: boolean;
	/** Show memories that have been replaced by a newer belief. Off by default. */
	includeSuperseded?: boolean;
}

export interface GraphTileRequest extends GraphViewFilter {
	/** The epoch the client's tile addresses were computed against. */
	epoch: number;
	z: number;
	tiles: { x: number; y: number }[];
	/** Marks the client can draw at once, shared out across `tiles`. */
	budget: number;
}

function listFilter(filter: GraphViewFilter): GraphListFilter {
	return {
		projectIds: filter.projectIds,
		subkinds: filter.subkinds,
		scopes: filter.scopes,
		sources: filter.sources,
		includeArchived: filter.includeArchived,
		includeSuperseded: filter.includeSuperseded
	};
}

/**
 * What the client needs before it can ask for tiles: the world, its epoch, and
 * the filter's counts and extent.
 *
 * Also the nudge for anything still waiting to be placed. A memory with no
 * position is counted but not drawn, and the pass that places it is normally
 * already scheduled by the write — this covers a store that was written while
 * the server was not running a pass at all (an upgrade, a clear-data).
 */
export function buildGraphMeta(filter: GraphViewFilter): GraphViewMeta {
	const narrowing = listFilter(filter);
	const state = getLayoutState();
	const extent = graphLayoutQueries.extent(narrowing);
	if (extent.unplaced > 0) scheduleGraphLayout();

	const placed = extent.total - extent.unplaced;
	return {
		epoch: state.epoch,
		stamp: state.stamp,
		world: state.world,
		spacing: state.spacing,
		total: extent.total,
		unplaced: extent.unplaced,
		extent:
			placed > 0 ? { minX: extent.minX, maxX: extent.maxX, minY: extent.minY, maxY: extent.maxY } : null,
		degreeScale: placed > 0 ? graphLayoutQueries.degreeScale(narrowing) : 1
	};
}

/**
 * The requested tiles of the map at one zoom level.
 *
 * Answers `stale` instead of tiles when the client's epoch is not the current
 * one: its addresses were computed against a world that no longer exists, and
 * serving them would draw the right memories in the wrong places.
 */
export function buildGraphTiles(request: GraphTileRequest): GraphTilesResponse {
	const state = getLayoutState();
	const world = state.world;
	if (!world || request.epoch !== state.epoch) return { epoch: state.epoch, stale: true, tiles: [] };

	const z = Math.max(0, Math.min(MAX_TILE_ZOOM, Math.floor(request.z)));
	const span = 2 ** z;
	const tileSize = world.size / span;
	const budget = Math.max(MIN_SCREEN_BUDGET, Math.min(MAX_SCREEN_BUDGET, Math.floor(request.budget)));
	const filter = listFilter(request);

	const wanted: { x: number; y: number }[] = [];
	const seen = new Set<string>();
	for (const tile of request.tiles) {
		const x = Math.floor(tile.x);
		const y = Math.floor(tile.y);
		if (x < 0 || y < 0 || x >= span || y >= span) continue;
		const key = `${x}:${y}`;
		if (seen.has(key)) continue;
		seen.add(key);
		wanted.push({ x, y });
		if (wanted.length >= MAX_TILES_PER_REQUEST) break;
	}
	if (wanted.length === 0) return { epoch: state.epoch, stale: false, tiles: [] };

	const rectOf = (x: number, y: number) => ({
		minX: world.minX + x * tileSize,
		maxX: world.minX + (x + 1) * tileSize,
		minY: world.minY + y * tileSize,
		maxY: world.minY + (y + 1) * tileSize
	});

	// One counting query over the union of what was asked, so each tile's
	// resolution is decided before a single label is read.
	let minTileX = Infinity;
	let maxTileX = -Infinity;
	let minTileY = Infinity;
	let maxTileY = -Infinity;
	for (const tile of wanted) {
		minTileX = Math.min(minTileX, tile.x);
		maxTileX = Math.max(maxTileX, tile.x);
		minTileY = Math.min(minTileY, tile.y);
		maxTileY = Math.max(maxTileY, tile.y);
	}
	const union = {
		minX: world.minX + minTileX * tileSize,
		maxX: world.minX + (maxTileX + 1) * tileSize,
		minY: world.minY + minTileY * tileSize,
		maxY: world.minY + (maxTileY + 1) * tileSize
	};
	const counts = new Map<string, number>();
	for (const row of graphLayoutQueries.tileCounts(filter, { originX: world.minX, originY: world.minY, size: tileSize }, union)) {
		counts.set(`${row.tileX}:${row.tileY}`, row.count);
	}

	const allowance = shareBudget(
		wanted.map(({ x, y }) => counts.get(`${x}:${y}`) ?? 0),
		budget
	);

	// An edge between two tiles of the same request would otherwise travel twice,
	// once from each end — measured, that was most of the payload at overview.
	const sentPairs = new Set<string>();
	const firstTime = (a: string, b: string): boolean => {
		const key = a < b ? `${a}|${b}` : `${b}|${a}`;
		if (sentPairs.has(key)) return false;
		sentPairs.add(key);
		return true;
	};

	const tiles: GraphTile[] = wanted.map(({ x, y }, index) => {
		const count = counts.get(`${x}:${y}`) ?? 0;
		const allowed = allowance[index];
		const rect = rectOf(x, y);
		const empty: GraphTile = { z, x, y, cells: 0, nodes: [], clusters: [], edges: [], cellEdges: [] };
		if (count === 0) return empty;
		const edgeLimit = Math.max(1, Math.min(count, allowed)) * EDGES_PER_MARK;

		if (count <= allowed) {
			const nodes = graphLayoutQueries.tileNodes(filter, rect, count).map(round);
			const edges = graphLayoutQueries
				.edgesTouching(
					filter,
					nodes.map(node => node.id),
					edgeLimit
				)
				.filter(edge => firstTime(edge.source, edge.target))
				.map(edge => ({ ...edge, targetX: tidy(edge.targetX), targetY: tidy(edge.targetY) }));
			return { ...empty, nodes, edges };
		}

		// Folded, into no more cells than its share of the budget. Cell coordinates
		// are global at this zoom, so an edge from any other tile can name the cell
		// it lands in without knowing this tile.
		const cellsPerSide = Math.max(4, Math.min(MAX_CELLS_PER_SIDE, Math.floor(Math.sqrt(allowed))));
		const cellGrid = { originX: world.minX, originY: world.minY, size: tileSize / cellsPerSide };
		const nodes: GraphTileNode[] = [];
		const clusters: GraphTileCluster[] = [];
		const markOfCell = new Map<string, string>();

		for (const cell of graphLayoutQueries.tileCells(filter, rect, cellGrid)) {
			const key = `${cell.cellX}:${cell.cellY}`;
			if (cell.members === 1) {
				nodes.push(round(cell));
				markOfCell.set(key, cell.id);
				continue;
			}
			const id = `cluster:${z}:${cell.cellX}:${cell.cellY}`;
			clusters.push({
				id,
				members: cell.members,
				label: cell.label,
				community: cell.community,
				x: tidy(cell.x),
				y: tidy(cell.y),
				cellX: cell.cellX,
				cellY: cell.cellY
			});
			markOfCell.set(key, id);
		}

		const cellEdges: GraphTileCellEdge[] = [];
		for (const edge of graphLayoutQueries.cellEdges(filter, rect, cellGrid, edgeLimit)) {
			const source = markOfCell.get(`${edge.sourceCellX}:${edge.sourceCellY}`);
			if (!source) continue;
			if (!firstTime(`${z}:${edge.sourceCellX}:${edge.sourceCellY}`, `${z}:${edge.targetCellX}:${edge.targetCellY}`)) {
				continue;
			}
			cellEdges.push({
				source,
				targetCellX: edge.targetCellX,
				targetCellY: edge.targetCellY,
				weight: edge.weight
			});
		}

		return { ...empty, cells: cellsPerSide, nodes, clusters, cellEdges };
	});

	return { epoch: state.epoch, stale: false, tiles };
}

/**
 * Share the screen's budget between tiles, sparse ones first.
 *
 * Water-filling: walking the tiles from least to most crowded, each takes what
 * it holds if that is within an even split of what is left, and the crowded
 * remainder share the rest equally. So a tile is only ever folded when the
 * screen as a whole could not afford it, and then only the crowded ones are.
 */
function shareBudget(counts: number[], budget: number): number[] {
	const allowance = new Array<number>(counts.length).fill(0);
	const order = counts.map((count, index) => ({ count, index })).sort((a, b) => a.count - b.count);
	let remaining = budget;
	for (let i = 0; i < order.length; i++) {
		const share = Math.floor(remaining / (order.length - i));
		const take = Math.min(order[i].count, share);
		allowance[order[i].index] = order[i].count <= share ? order[i].count : Math.max(16, share);
		remaining -= take;
	}
	return allowance;
}

/**
 * Where particular memories are on the map, whatever the client has loaded.
 *
 * What lets the view go TO a memory it has not drawn: a search result, a
 * connection listed in the inspector, a step back through history. A memory the
 * layout has not placed yet is simply absent from the answer.
 */
export function locateNodes(nodeIds: string[]): GraphTileNode[] {
	return graphLayoutQueries.locate(nodeIds.slice(0, 500)).map(round);
}

/** Positions are drawn on a screen; a tenth of a unit is far below a pixel. */
function tidy(value: number): number {
	return Math.round(value * 10) / 10;
}

function round(node: GraphTileNode): GraphTileNode {
	return {
		id: node.id,
		label: node.label,
		community: node.community,
		degree: node.degree,
		x: tidy(node.x),
		y: tidy(node.y)
	};
}

/**
 * A node plus the nodes it reaches — what the inspector renders.
 *
 * The paths are attached HERE and nowhere else on the read path. They are a
 * per-node query, and a listing draws thousands of nodes at a time; the
 * inspector draws one.
 */
export function buildNodeDetail(nodeId: string, hops = 1) {
	const node = graphQueries.getById(nodeId);
	if (!node) return null;

	return {
		node: { ...node, relatedPaths: graphQueries.pathsOf(nodeId) },
		neighbours: graphQueries.neighbours(nodeId, hops).map(n => ({ node: n.node, hops: n.hops }))
	};
}
