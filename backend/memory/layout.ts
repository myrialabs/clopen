/**
 * The persisted arrangement of the Memory graph.
 *
 * Community detection and force layout both used to run on the read path — one
 * on the server inside `buildGraphView`, the other in the browser on every open —
 * and both produce the SAME answer for the same dataset. They were being
 * recomputed, not computed. So they happen HERE instead: in the background,
 * written to `graph_layout`, and read back as a position per node. Reading a
 * laid-out graph is then a table lookup whatever the graph costs to lay out.
 *
 * ── Two kinds of pass ─────────────────────────────────────────────────────────
 * A COLD pass arranges every live memory from nothing: communities, a force
 * simulation per component, lobes pushed apart, components packed. It is the
 * only thing that decides the map's shape, and it is the expensive half —
 * seconds for a few thousand memories.
 *
 * A WARM pass places what arrived since, and moves NOTHING that was already
 * placed. New memories are dropped next to what they connect to and relaxed
 * into the gaps around them by a small solver whose cost is the arrivals times
 * their neighbourhood, not the store. That is what keeps a map somebody has
 * learned in place while a conversation writes into it.
 *
 * ── Why a warm pass may not re-settle the map ────────────────────────────────
 * It used to, and the map grew without limit. A warm pass re-ran the simulation
 * from the stored positions and then pushed the lobes apart again — but the
 * stored positions were ALREADY pushed apart, and the simulation only pulls a
 * part of that back. Measured on one unchanged store, every pass inflated the
 * map by about 1.4×: 9.8k units, then 13.8k, 18.9k, 28.9k, 39.3k, 52.4k. Over
 * weeks of passes that compounded to 10³⁸, where squaring a coordinate
 * overflows to Infinity, Infinity / Infinity is NaN, and every pass after that
 * failed on the NOT NULL constraint — so nothing written since was ever placed,
 * and the overview binned five thousand memories into thirty-five marks because
 * the extent it divided into a grid was astronomically wide.
 *
 * Re-settling has no fixed point to converge to, so it is not done at all. The
 * map changes shape only on a cold pass, and a cold pass runs when the store has
 * grown enough since the last one that the shape is worth revisiting (see
 * `RECOLD_RATIO`) — or when the stored arrangement is unusable.
 *
 * ── A cold pass must not look like a new map ─────────────────────────────────
 * Two things would make it one, and both are undone after the fact. Louvain
 * numbers its communities arbitrarily, so colours would shuffle; the new
 * communities are matched to the old ones by overlap and take their numbers.
 * And a fresh simulation has no reason to face the same way as the last one; the
 * result is rotated (or mirrored) and translated onto the previous arrangement —
 * rigidly, never scaled, so the map cannot creep in size either way.
 *
 * ── The world ────────────────────────────────────────────────────────────────
 * The view is served as tiles of a fixed square, the WORLD, which covers every
 * placed row with a margin. It is part of the stored state together with an
 * EPOCH that changes whenever the world does — a cold pass, or an arrival that
 * lands outside it — because a client's cached tiles and camera are expressed in
 * it and have to know when they no longer mean the same thing.
 *
 * ── Bounded on purpose ────────────────────────────────────────────────────────
 * `MAX_LAYOUT_NODES` caps the simulation. What survives the cap is what the view
 * ranks highest; everything below it is placed by the same solver that places
 * arrivals, next to what it connects to.
 */

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { graphQueries, graphLayoutQueries, type GraphLayoutRow } from '$backend/database/queries/graph-queries';
import { settingsQueries } from '$backend/database/queries/settings-queries';
import { broadcastGraphChanged } from './notify';
import { debug } from '$shared/utils/logger';

/**
 * What produced the stored arrangement. BUMP IT whenever that changes — either
 * the edges this pass lays out, or how it places them.
 *
 * A mismatch drops the arrangement once and lays the store out cold. Version 7
 * is the one that stopped warm passes re-settling the map; every arrangement
 * written before it was inflated by them, and some of them to the point of being
 * unreadable, so none of them is worth preserving.
 */
const LAYOUT_VERSION = '8';
const LAYOUT_VERSION_KEY = 'memory_layout_version';
/** The key this used before it covered placement as well as derivation. */
const LEGACY_LAYOUT_KEY = 'memory_layout_derivation';
/** Where the world, the epoch and the cold-pass bookkeeping live. */
const LAYOUT_STATE_KEY = 'memory_layout_state';

/**
 * Two caps, because the two halves of a pass scale differently.
 *
 * COMMUNITY DETECTION is roughly linear in the edges and colours every node, so
 * it runs over everything live, up to a ceiling far beyond any real store.
 *
 * THE FORCE SIMULATION is superlinear and measurably so — around 15 ms per
 * iteration at 1,200 nodes and 90 ms at 5,000 — so it runs only over the
 * highest-ranked nodes. The rest are placed by the arrival solver next to what
 * they connect to.
 */
const MAX_COMMUNITY_NODES = 50_000;
const MAX_LAYOUT_NODES = 6_000;

/**
 * How much the store may grow by warm placement before the shape is revisited.
 *
 * Arrivals are placed well, but locally: a subject that grows from three
 * memories to three hundred still sits in the room its first three were given.
 * Past a fifth of the store arriving since the last cold pass, the arrangement
 * is describing a graph that no longer exists, and a cold pass is cheaper than
 * the confusion. Low enough that small stores — where a cold pass is a few
 * milliseconds — are re-arranged often.
 */
const RECOLD_RATIO = 0.2;

/**
 * Past this magnitude a coordinate is not an arrangement, it is a divergence.
 *
 * A healthy store spans thousands of units and a very large one tens of
 * thousands; a stored row beyond this means some earlier pass went wrong, and
 * the only sound response is to lay out from nothing.
 */
const MAX_SANE_COORDINATE = 1e7;

/** Margin around the placed rows, as a fraction of the world's side. */
const WORLD_MARGIN = 0.08;

/**
 * How long to wait after a write before laying out again.
 *
 * `notifyGraphChanged` already folds a turn's ingestion burst into one event at
 * 600 ms; this sits on top so a burst becomes one pass. Short, because a warm
 * pass is cheap now — and until it runs a new memory has no position, so it is
 * not on the map at all.
 */
const DEBOUNCE_MS = 1_500;

/** The arrangement's bookkeeping, persisted next to it. */
export interface LayoutState {
	/** Changes whenever the world does, so clients know their tiles are stale. */
	epoch: number;
	/**
	 * Changes whenever a pass writes anything — a new memory placed, an edge laid
	 * out. What a client compares to decide whether the tiles it holds still say
	 * the same thing; reinforcement rings the change doorbell constantly and moves
	 * none of this.
	 */
	stamp: number;
	/** The square every tile is cut from, or null before anything is placed. */
	world: { minX: number; minY: number; size: number } | null;
	/**
	 * The median distance from a live memory to its nearest neighbour — how much
	 * room a memory has on this map. The view sizes nodes from it, so a dot never
	 * outgrows the space around it at any zoom or store size.
	 */
	spacing: number;
	/** Live memories the last cold pass arranged. */
	coldNodes: number;
	/** Memories the arrival solver has placed since then. */
	arrivals: number;
}

const EMPTY_STATE: LayoutState = { epoch: 0, stamp: 0, world: null, spacing: 0, coldNodes: 0, arrivals: 0 };

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
/** A change arrived mid-pass, so the result is already out of date. */
let rerunRequested = false;

/**
 * What the last pass was computed from.
 *
 * Reinforcement bumps `weight` and `updated_at` on every recall, so the change
 * notification fires constantly without the set of nodes or edges moving at
 * all. Laying out an unchanged graph produces an unchanged answer, so this
 * skips it.
 */
let lastFingerprint = '';

/** The state as last read or written, so the read path does not parse JSON per fetch. */
let cachedState: LayoutState | null = null;

/** Cheap order-sensitive fingerprint of an id list. */
function membershipOf(ids: string[]): string {
	return `${ids.length}:${hashOf(ids.join('\u0000')).toString(36)}`;
}

/**
 * The stored world and epoch — what the view tiles against.
 *
 * Read through a cache because every tile request asks; written only by a pass.
 */
export function getLayoutState(): LayoutState {
	if (cachedState) return cachedState;
	const raw = settingsQueries.get(LAYOUT_STATE_KEY)?.value;
	let state = EMPTY_STATE;
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as Partial<LayoutState>;
			const world = parsed.world;
			state = {
				epoch: Number.isFinite(parsed.epoch) ? (parsed.epoch as number) : 0,
				stamp: Number.isFinite(parsed.stamp) ? (parsed.stamp as number) : 0,
				world:
					world && [world.minX, world.minY, world.size].every(Number.isFinite) && world.size > 0
						? { minX: world.minX, minY: world.minY, size: world.size }
						: null,
				spacing: Number.isFinite(parsed.spacing) ? (parsed.spacing as number) : 0,
				coldNodes: Number.isFinite(parsed.coldNodes) ? (parsed.coldNodes as number) : 0,
				arrivals: Number.isFinite(parsed.arrivals) ? (parsed.arrivals as number) : 0
			};
		} catch {
			state = EMPTY_STATE;
		}
	}
	cachedState = state;
	return state;
}

function saveLayoutState(state: LayoutState): void {
	cachedState = state;
	settingsQueries.set(LAYOUT_STATE_KEY, JSON.stringify(state));
}

/**
 * Note that the graph changed and a new arrangement will be needed.
 *
 * Cheap and idempotent — call it after any write rather than working out whether
 * this particular write moved anything.
 */
export function scheduleGraphLayout(): void {
	if (timer) return;
	timer = setTimeout(() => {
		timer = null;
		void runGraphLayout();
	}, DEBOUNCE_MS);
	// Housekeeping — never a reason to hold the process open at shutdown.
	timer.unref?.();
}

/** Forget what was laid out, so the next pass rebuilds from what the database holds. */
export function resetGraphLayoutState(): void {
	lastFingerprint = '';
	cachedState = null;
}

/**
 * Bring the arrangement up to date with the live graph.
 *
 * Never throws: a failed pass leaves the previous arrangement in place, and the
 * memories it would have placed simply wait for the next one.
 */
export async function runGraphLayout(): Promise<void> {
	if (running) {
		rerunRequested = true;
		return;
	}
	running = true;

	try {
		// Before anything reads the stored arrangement: if a different version of
		// this pass produced it, it is not an arrangement of this graph.
		if (settingsQueries.get(LAYOUT_VERSION_KEY)?.value !== LAYOUT_VERSION) {
			graphLayoutQueries.clear();
			settingsQueries.set(LAYOUT_VERSION_KEY, LAYOUT_VERSION);
			settingsQueries.delete(LEGACY_LAYOUT_KEY);
			const previous = getLayoutState();
			saveLayoutState({ ...EMPTY_STATE, epoch: previous.epoch + 1, stamp: previous.stamp + 1 });
			lastFingerprint = '';
			debug.log('memory', 'Memory layout: the pass changed, arranging from scratch');
		}

		// Rank-ordered, so "the first N" is also "the N the view would have shown".
		const ids = graphLayoutQueries.liveNodeIds(MAX_COMMUNITY_NODES);
		const state = getLayoutState();

		if (ids.length === 0) {
			graphLayoutQueries.clear();
			if (state.world) {
				saveLayoutState({ ...EMPTY_STATE, epoch: state.epoch + 1, stamp: state.stamp + 1 });
				broadcastGraphChanged('layout');
			}
			lastFingerprint = '';
			return;
		}

		// Same nodes, same edges, and nothing waiting to be placed: the answer is the
		// one already in the table.
		const fingerprint = `${membershipOf(ids)}|${graphLayoutQueries.sourceFingerprint()}`;
		if (fingerprint === lastFingerprint && !graphLayoutQueries.hasUnplaced()) return;

		const started = Date.now();
		const existing = graphLayoutQueries.read(ids);
		const { graph, derived } = buildLayoutGraph(ids);

		const placed = new Map<string, GraphLayoutRow>();
		for (const [id, row] of existing) {
			if (row.placed === 1 && Number.isFinite(row.x) && Number.isFinite(row.y)) placed.set(id, row);
		}

		const bounds = graphLayoutQueries.bounds();
		const corrupt = bounds !== null && !(bounds.magnitude <= MAX_SANE_COORDINATE);
		const arriving = ids.length - placed.size;
		const reason = corrupt
			? 'the stored arrangement diverged'
			: placed.size === 0 || state.world === null
				? 'nothing is placed yet'
				: state.arrivals + arriving > RECOLD_RATIO * Math.max(1, state.coldNodes)
					? 'the store outgrew its arrangement'
					: null;

		const rows = reason
			? await coldPass(ids, graph, corrupt ? new Map() : placed)
			: warmPass(ids, graph, placed);

		// Retired memories are drawn by the "show archived" view, so they need a
		// place too. A cold pass draws a new map and re-places every one of them; a
		// warm pass only places those that have none yet, and leaves the rest where
		// they were, which is still the same map.
		const retired = placeRetired(rows, reason !== null);

		const written = sanitise([...rows, ...retired]);
		const liveIds = new Set(ids);
		const world = worldFor(written, reason ? null : state.world);
		const worldChanged =
			!state.world ||
			world.minX !== state.world.minX ||
			world.minY !== state.world.minY ||
			world.size !== state.world.size;

		graphLayoutQueries.writeMany(written);
		graphLayoutQueries.replaceDerivedEdges(derived);
		graphLayoutQueries.pruneOrphans();

		saveLayoutState({
			epoch: reason || worldChanged ? state.epoch + 1 : state.epoch,
			stamp: state.stamp + 1,
			world,
			spacing: medianSpacing(written.filter(row => liveIds.has(row.nodeId))),
			coldNodes: reason ? ids.length : state.coldNodes,
			arrivals: reason ? 0 : state.arrivals + arriving
		});
		lastFingerprint = fingerprint;

		// Tell open views, or they never learn. The arrangement changes a moment
		// AFTER the write that triggered it — after the doorbell for that write has
		// been answered — so without this a new memory would stay off the map until
		// the modal was reopened.
		broadcastGraphChanged('layout');
		debug.log(
			'memory',
			reason
				? `Laid out ${ids.length} memory node(s) from scratch (${reason}) in ${Date.now() - started}ms`
				: `Placed ${arriving} arriving memory node(s) in ${Date.now() - started}ms`
		);
	} catch (error) {
		debug.warn('memory', 'Memory graph layout failed (non-fatal)', error);
	} finally {
		running = false;
		if (rerunRequested) {
			rerunRequested = false;
			scheduleGraphLayout();
		}
	}
}

/**
 * Arrange every live memory from nothing, then make it look like the map it
 * replaces.
 *
 * `previous` is the last arrangement's placed rows, empty when there was none or
 * it was unusable — in which case there is nothing to stay faithful to and the
 * fresh arrangement stands as computed.
 */
async function coldPass(
	ids: string[],
	graph: Graph,
	previous: Map<string, GraphLayoutRow>
): Promise<GraphLayoutRow[]> {
	// Louvain needs at least one edge; an edgeless graph leaves every node in its
	// own community, which is also the honest answer.
	let communities: Record<string, number> = {};
	if (graph.size > 0) {
		try {
			// `rng` is NOT optional here, whatever the signature suggests.
			// graphology-communities-louvain defaults to `Math.random` and walks the
			// graph in random order, so the same store produced different lobes on
			// every pass. A fixed seed keeps the randomised traversal (which is what
			// the algorithm wants) while making the answer reproducible.
			communities = louvain(graph, { getEdgeWeight: 'weight', rng: seededRandom() });
		} catch (error) {
			debug.warn('memory', 'Community detection failed; laying out without lobes', error);
		}
	}
	for (const id of ids) communities[id] ??= 0;
	communities = keepCommunityNumbers(ids, communities, previous);

	const simulatedIds = ids.slice(0, MAX_LAYOUT_NODES);
	const simulated = simulatedIds.length === ids.length ? graph : restrictTo(graph, simulatedIds);
	const arranged = await arrange(simulated, communities);

	alignTo(arranged, previous);

	// Everything below the simulation cap is placed the way an arrival is: next to
	// what it connects to, among what the simulation already placed.
	const positions = new Map<string, { x: number; y: number }>();
	for (const row of arranged) positions.set(row.nodeId, { x: row.x, y: row.y });
	const remaining = ids.slice(simulatedIds.length);
	const solved = placeArrivals(remaining, graph, positions, communities);

	return [
		...arranged.map(row => ({ ...row, degree: graph.degree(row.nodeId) })),
		...remaining.map(id => {
			const at = solved.positions.get(id) as { x: number; y: number };
			return { nodeId: id, community: communities[id], x: at.x, y: at.y, placed: 1, degree: graph.degree(id) };
		})
	];
}

/**
 * Place what arrived since the last pass, leaving everything else untouched.
 *
 * Every existing row is rewritten with its own position and community — only
 * its degree moves, because a new memory changes how connected its neighbours
 * are.
 */
function warmPass(ids: string[], graph: Graph, placed: Map<string, GraphLayoutRow>): GraphLayoutRow[] {
	const positions = new Map<string, { x: number; y: number }>();
	const communities: Record<string, number> = {};
	for (const [id, row] of placed) {
		positions.set(id, { x: row.x, y: row.y });
		communities[id] = row.community;
	}

	const arriving = ids.filter(id => !placed.has(id));
	const solved = placeArrivals(arriving, graph, positions, communities);

	return ids.map(id => {
		const row = placed.get(id);
		if (row) return { ...row, degree: graph.degree(id) };
		const at = solved.positions.get(id) as { x: number; y: number };
		return {
			nodeId: id,
			community: solved.communities[id] ?? 0,
			x: at.x,
			y: at.y,
			placed: 1,
			degree: graph.degree(id)
		};
	});
}

/**
 * Place archived and superseded memories among the live ones.
 *
 * They are not part of the layout graph — the pass arranges what is live — so
 * their neighbours are read from the stored edges, and one with no live
 * neighbour is placed in the field like any lone memory. They never move a live
 * memory: the live rows are the fixed half of the solve.
 */
function placeRetired(live: GraphLayoutRow[], all: boolean): GraphLayoutRow[] {
	const retired = graphLayoutQueries.retiredIds(all);
	if (retired.length === 0) return [];

	const positions = new Map<string, { x: number; y: number }>();
	const communities: Record<string, number> = {};
	for (const row of live) {
		positions.set(row.nodeId, { x: row.x, y: row.y });
		communities[row.nodeId] = row.community;
	}

	const graph = new Graph({ type: 'undirected', multi: false });
	for (const row of live) graph.addNode(row.nodeId);
	for (const id of retired) if (!graph.hasNode(id)) graph.addNode(id);
	for (const edge of graphQueries.edgesWithin([...retired, ...live.map(row => row.nodeId)])) {
		if (edge.srcId === edge.dstId || graph.hasEdge(edge.srcId, edge.dstId)) continue;
		graph.addUndirectedEdge(edge.srcId, edge.dstId, { weight: edge.weight });
	}

	const solved = placeArrivals(retired, graph, positions, communities);
	return retired.map(id => {
		const at = solved.positions.get(id) as { x: number; y: number };
		return {
			nodeId: id,
			community: solved.communities[id] ?? 0,
			x: at.x,
			y: at.y,
			placed: 1,
			degree: graph.degree(id)
		};
	});
}

/**
 * Only finite rows are written — the last line of defence for the table.
 *
 * Nothing upstream should produce anything else, and that is exactly why this
 * exists: the failure it replaces was a single NaN that made every subsequent
 * pass throw on the NOT NULL constraint, permanently, with the store growing
 * unplaced behind it. A row dropped here stays unplaced and is retried.
 */
function sanitise(rows: GraphLayoutRow[]): GraphLayoutRow[] {
	const kept = rows.filter(
		row =>
			Number.isFinite(row.x) &&
			Number.isFinite(row.y) &&
			Math.abs(row.x) <= MAX_SANE_COORDINATE &&
			Math.abs(row.y) <= MAX_SANE_COORDINATE &&
			Number.isFinite(row.community)
	);
	if (kept.length < rows.length) {
		debug.warn('memory', `Memory layout: dropped ${rows.length - kept.length} unusable position(s)`);
	}
	return kept;
}

/**
 * The median distance from a memory to its nearest neighbour.
 *
 * Found through a spatial hash whose cell is grown until most memories have a
 * neighbour within reach, so the cost stays linear whatever the scale.
 */
function medianSpacing(rows: { x: number; y: number }[]): number {
	if (rows.length < 2) return 0;
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const row of rows) {
		minX = Math.min(minX, row.x);
		maxX = Math.max(maxX, row.x);
		minY = Math.min(minY, row.y);
		maxY = Math.max(maxY, row.y);
	}
	// The spacing a uniform scatter would have: a starting cell, not the answer.
	const cell = Math.max(1e-6, Math.sqrt(((maxX - minX) * (maxY - minY)) / rows.length) || 1);
	const grid = new Map<string, { x: number; y: number }[]>();
	for (const row of rows) {
		const key = `${Math.floor(row.x / cell)}:${Math.floor(row.y / cell)}`;
		const bucket = grid.get(key);
		if (bucket) bucket.push(row);
		else grid.set(key, [row]);
	}

	const nearest: number[] = [];
	for (const row of rows) {
		const cx = Math.floor(row.x / cell);
		const cy = Math.floor(row.y / cell);
		let best = Infinity;
		// Ring by ring until something is found and no closer ring can beat it.
		for (let ring = 1; ring <= 64; ring++) {
			for (let gx = cx - ring; gx <= cx + ring; gx++) {
				for (let gy = cy - ring; gy <= cy + ring; gy++) {
					if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== ring && ring > 1) continue;
					for (const other of grid.get(`${gx}:${gy}`) ?? []) {
						if (other === row) continue;
						best = Math.min(best, Math.hypot(other.x - row.x, other.y - row.y));
					}
				}
			}
			if (best <= (ring - 1) * cell) break;
		}
		if (Number.isFinite(best)) nearest.push(best);
	}
	if (nearest.length === 0) return 0;
	nearest.sort((a, b) => a - b);
	return nearest[nearest.length >> 1];
}

/**
 * The square the view tiles, covering every row with a margin.
 *
 * `current` is kept whenever everything still fits inside it, so a warm pass
 * does not invalidate every client's tiles for a memory that landed in the
 * middle of the map. When something lands outside, the world is recomputed with
 * the margin restored — growing in steps rather than per arrival.
 */
function worldFor(
	rows: GraphLayoutRow[],
	current: { minX: number; minY: number; size: number } | null
): { minX: number; minY: number; size: number } {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const row of rows) {
		minX = Math.min(minX, row.x);
		maxX = Math.max(maxX, row.x);
		minY = Math.min(minY, row.y);
		maxY = Math.max(maxY, row.y);
	}
	if (!Number.isFinite(minX)) return current ?? { minX: -500, minY: -500, size: 1000 };

	if (
		current &&
		minX >= current.minX &&
		minY >= current.minY &&
		maxX < current.minX + current.size &&
		maxY < current.minY + current.size
	) {
		return current;
	}

	const side = Math.max(maxX - minX, maxY - minY, 200);
	const size = side * (1 + 2 * WORLD_MARGIN);
	return {
		minX: (minX + maxX) / 2 - size / 2,
		minY: (minY + maxY) / 2 - size / 2,
		size
	};
}

/**
 * Give the new communities the numbers the old ones had, wherever they overlap.
 *
 * Colour is derived from the community number, and Louvain's numbering is
 * arbitrary: without this every cold pass would recolour the whole map even
 * when the lobes were the same lobes. Largest communities choose first, each
 * taking the old number most of its members carried; anything with no
 * predecessor gets a number nothing has used.
 */
function keepCommunityNumbers(
	ids: string[],
	communities: Record<string, number>,
	previous: Map<string, GraphLayoutRow>
): Record<string, number> {
	if (previous.size === 0) return communities;

	const members = new Map<number, string[]>();
	for (const id of ids) {
		const community = communities[id];
		const list = members.get(community);
		if (list) list.push(id);
		else members.set(community, [id]);
	}

	let next = 0;
	for (const row of previous.values()) next = Math.max(next, row.community + 1);
	for (const community of members.keys()) next = Math.max(next, community + 1);

	const taken = new Set<number>();
	const renumber = new Map<number, number>();
	const ordered = [...members.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);

	for (const [community, list] of ordered) {
		const votes = new Map<number, number>();
		for (const id of list) {
			const old = previous.get(id);
			if (old) votes.set(old.community, (votes.get(old.community) ?? 0) + 1);
		}
		let best: number | null = null;
		let bestVotes = 0;
		for (const [old, count] of [...votes.entries()].sort((a, b) => a[0] - b[0])) {
			if (taken.has(old) || count <= bestVotes) continue;
			best = old;
			bestVotes = count;
		}
		const assigned = best ?? next++;
		taken.add(assigned);
		renumber.set(community, assigned);
	}

	const result: Record<string, number> = {};
	for (const id of ids) result[id] = renumber.get(communities[id]) ?? communities[id];
	return result;
}

/**
 * Turn a fresh arrangement to face the way the previous one did.
 *
 * Orthogonal Procrustes over the memories both arrangements placed: the
 * rotation — or rotation with a mirror, whichever fits better — and translation
 * that bring the new positions closest to the old. RIGID: no scaling, so the
 * map's size is always the simulation's own and can never ratchet the way the
 * old warm passes did.
 *
 * @internal Exported for tests.
 */
export function alignTo(rows: GraphLayoutRow[], previous: Map<string, GraphLayoutRow>): void {
	const pairs: { nx: number; ny: number; ox: number; oy: number }[] = [];
	for (const row of rows) {
		const old = previous.get(row.nodeId);
		if (old) pairs.push({ nx: row.x, ny: row.y, ox: old.x, oy: old.y });
	}
	if (pairs.length < 3) return;

	let ncx = 0;
	let ncy = 0;
	let ocx = 0;
	let ocy = 0;
	for (const pair of pairs) {
		ncx += pair.nx;
		ncy += pair.ny;
		ocx += pair.ox;
		ocy += pair.oy;
	}
	ncx /= pairs.length;
	ncy /= pairs.length;
	ocx /= pairs.length;
	ocy /= pairs.length;

	let sxx = 0;
	let sxy = 0;
	let syx = 0;
	let syy = 0;
	for (const pair of pairs) {
		const ax = pair.nx - ncx;
		const ay = pair.ny - ncy;
		const bx = pair.ox - ocx;
		const by = pair.oy - ocy;
		sxx += ax * bx;
		sxy += ax * by;
		syx += ay * bx;
		syy += ay * by;
	}

	// The best proper rotation maximises cos θ (Sxx + Syy) + sin θ (Sxy − Syx);
	// mirroring the new arrangement in y first flips the signs of Syx and Syy.
	const rotation = Math.hypot(sxx + syy, sxy - syx);
	const mirrored = Math.hypot(sxx - syy, sxy + syx);
	const mirror = mirrored > rotation;
	const angle = mirror ? Math.atan2(sxy + syx, sxx - syy) : Math.atan2(sxy - syx, sxx + syy);
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);

	for (const row of rows) {
		const ax = row.x - ncx;
		const ay = mirror ? -(row.y - ncy) : row.y - ncy;
		row.x = ocx + cos * ax - sin * ay;
		row.y = ocy + sin * ax + cos * ay;
	}
}

/**
 * Place memories among an arrangement that does not move.
 *
 * Each is dropped at the centroid of whatever it connects to that already has a
 * place — so a chain of arrivals resolves outward from whichever end touches the
 * map — and one connected to nothing placed is dropped into the field the map
 * already covers. Then a short relaxation moves ONLY the arrivals: pulled to an
 * edge's natural length from their neighbours, pushed off anything closer than
 * that. The natural length is measured from the arrangement itself, so the
 * solver works at whatever scale the map is drawn at.
 *
 * Cost is the arrivals times their neighbourhood. Repulsion reads a spatial
 * hash, never the whole store, which is what makes a warm pass milliseconds
 * where re-running the simulation was seconds.
 *
 * Deterministic: ids are visited in sorted order and every scatter comes from
 * `jitterOf`.
 */
function placeArrivals(
	arrivals: string[],
	graph: Graph,
	fixed: Map<string, { x: number; y: number }>,
	knownCommunities: Record<string, number>
): { positions: Map<string, { x: number; y: number }>; communities: Record<string, number> } {
	const positions = new Map(fixed);
	const communities: Record<string, number> = { ...knownCommunities };
	if (arrivals.length === 0) return { positions, communities };

	const neighboursOf = (id: string): string[] => (graph.hasNode(id) ? graph.neighbors(id) : []);
	// Two scales, because a declumped map has two. Edges are long — they span a
	// lobe — but neighbours sit only `spacing` apart, and a solver that kept an
	// edge's length of clear space around each arrival found no room left inside
	// a lobe and pushed newcomers out of it, sometimes nearer a different subject
	// than their own. So arrivals are pulled to within a few spacings of what
	// they connect to and keep only a neighbour's distance clear.
	const spacing = medianSpacing([...fixed.values()]);
	const length = spacing > 0 ? Math.min(naturalLength(graph, fixed), spacing * 1.5) : naturalLength(graph, fixed);
	const personal = spacing > 0 ? spacing * 0.6 : length * 0.75;

	let nextCommunity = 0;
	for (const value of Object.values(communities)) nextCommunity = Math.max(nextCommunity, value + 1);

	// The field: where the map already is, so a lone memory lands inside it rather
	// than deciding how far it reaches.
	let centreX = 0;
	let centreY = 0;
	for (const point of fixed.values()) {
		centreX += point.x;
		centreY += point.y;
	}
	if (fixed.size > 0) {
		centreX /= fixed.size;
		centreY /= fixed.size;
	}
	let reach = 0;
	for (const point of fixed.values()) reach = Math.max(reach, Math.hypot(point.x - centreX, point.y - centreY));
	if (reach === 0) reach = length * Math.sqrt(arrivals.length + 1) * 2;

	const pending = [...arrivals].sort();
	const waiting = new Set(pending);

	while (waiting.size > 0) {
		// Everything that touches the map, repeatedly, until nothing new does.
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (const id of pending) {
				if (!waiting.has(id)) continue;
				let sumX = 0;
				let sumY = 0;
				let count = 0;
				const votes = new Map<number, number>();
				for (const neighbour of neighboursOf(id)) {
					const at = positions.get(neighbour);
					if (!at) continue;
					sumX += at.x;
					sumY += at.y;
					count++;
					const community = communities[neighbour];
					if (community !== undefined) votes.set(community, (votes.get(community) ?? 0) + 1);
				}
				if (count === 0) continue;

				const jitter = jitterOf(id);
				positions.set(id, { x: sumX / count + jitter.x * length * 0.6, y: sumY / count + jitter.y * length * 0.6 });
				if (communities[id] === undefined) {
					let best = -1;
					let bestVotes = 0;
					for (const [community, votesFor] of [...votes.entries()].sort((a, b) => a[0] - b[0])) {
						if (votesFor > bestVotes) {
							best = community;
							bestVotes = votesFor;
						}
					}
					communities[id] = best >= 0 ? best : nextCommunity++;
				}
				waiting.delete(id);
				progressed = true;
			}
		}

		// One that connects to nothing placed seeds its own little group in the
		// field; the loop above then grows the rest of that group around it.
		const seed = pending.find(id => waiting.has(id));
		if (seed === undefined) break;
		const draw = jitterOf(seed);
		const radius = reach * Math.sqrt((draw.x + 1) / 2);
		positions.set(seed, {
			x: centreX + Math.cos(draw.angle) * radius,
			y: centreY + Math.sin(draw.angle) * radius
		});
		communities[seed] ??= nextCommunity++;
		waiting.delete(seed);
	}

	relaxArrivals(pending, graph, fixed, positions, length, personal);
	return { positions, communities };
}

/**
 * The typical edge length of an arrangement — the scale the solver works at.
 *
 * The median over edges both of whose ends are placed, so a handful of long
 * bridges between lobes does not inflate it. Falls back to the spacing a
 * uniform scatter of the placed nodes would have, and to a constant when there
 * is nothing placed at all.
 */
function naturalLength(graph: Graph, fixed: Map<string, { x: number; y: number }>): number {
	const lengths: number[] = [];
	graph.forEachEdge((_edge, _attributes, source, target) => {
		if (lengths.length >= 20_000) return;
		const a = fixed.get(source);
		const b = fixed.get(target);
		if (!a || !b) return;
		const distance = Math.hypot(a.x - b.x, a.y - b.y);
		if (distance > 0 && Number.isFinite(distance)) lengths.push(distance);
	});
	if (lengths.length >= 8) {
		lengths.sort((a, b) => a - b);
		return lengths[lengths.length >> 1];
	}

	if (fixed.size >= 2) {
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const point of fixed.values()) {
			minX = Math.min(minX, point.x);
			maxX = Math.max(maxX, point.x);
			minY = Math.min(minY, point.y);
			maxY = Math.max(maxY, point.y);
		}
		const area = Math.max(1, (maxX - minX) * (maxY - minY));
		return Math.max(10, Math.sqrt(area / fixed.size));
	}
	return 40;
}

/**
 * Settle the arrivals into the gaps, moving nothing else.
 *
 * Spring toward each neighbour to `length`, push off anything nearer than
 * `personal`, and never move further than half of `length` in one step — the
 * bound is what makes it impossible for this to diverge the way an unbounded
 * force step can.
 */
function relaxArrivals(
	arrivals: string[],
	graph: Graph,
	fixed: Map<string, { x: number; y: number }>,
	positions: Map<string, { x: number; y: number }>,
	length: number,
	personal: number
): void {
	const ITERATIONS = 40;
	const cell = Math.max(1e-6, personal);
	const key = (x: number, y: number): string => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;

	const fixedGrid = new Map<string, { x: number; y: number }[]>();
	for (const point of fixed.values()) {
		const k = key(point.x, point.y);
		const list = fixedGrid.get(k);
		if (list) list.push(point);
		else fixedGrid.set(k, [point]);
	}

	const moving = arrivals.filter(id => positions.has(id) && !fixed.has(id));
	if (moving.length === 0) return;

	for (let iteration = 0; iteration < ITERATIONS; iteration++) {
		const cooling = 1 - iteration / ITERATIONS;

		const arrivalGrid = new Map<string, string[]>();
		for (const id of moving) {
			const at = positions.get(id) as { x: number; y: number };
			const k = key(at.x, at.y);
			const list = arrivalGrid.get(k);
			if (list) list.push(id);
			else arrivalGrid.set(k, [id]);
		}

		for (const id of moving) {
			const at = positions.get(id) as { x: number; y: number };
			let dx = 0;
			let dy = 0;

			for (const neighbour of graph.hasNode(id) ? graph.neighbors(id) : []) {
				const other = positions.get(neighbour);
				if (!other) continue;
				const ox = other.x - at.x;
				const oy = other.y - at.y;
				const distance = Math.hypot(ox, oy);
				if (distance < 1e-9) continue;
				const pull = ((distance - length) / distance) * 0.3;
				dx += ox * pull;
				dy += oy * pull;
			}

			const cx = Math.floor(at.x / cell);
			const cy = Math.floor(at.y / cell);
			for (let gx = cx - 1; gx <= cx + 1; gx++) {
				for (let gy = cy - 1; gy <= cy + 1; gy++) {
					const k = `${gx}:${gy}`;
					const push = (other: { x: number; y: number }, salt: string): void => {
						let ox = at.x - other.x;
						let oy = at.y - other.y;
						let distance = Math.hypot(ox, oy);
						if (distance >= personal) return;
						if (distance < 1e-9) {
							const angle = jitterOf(id + salt).angle;
							ox = Math.cos(angle);
							oy = Math.sin(angle);
							distance = 1;
						}
						const strength = ((personal - distance) / distance) * 0.5;
						dx += ox * strength;
						dy += oy * strength;
					};
					for (const point of fixedGrid.get(k) ?? []) push(point, `${point.x},${point.y}`);
					for (const other of arrivalGrid.get(k) ?? []) {
						if (other !== id) push(positions.get(other) as { x: number; y: number }, other);
					}
				}
			}

			const step = Math.hypot(dx, dy);
			const limit = length * 0.5 * cooling;
			if (!Number.isFinite(step) || step === 0) continue;
			const scale = step > limit ? limit / step : 1;
			positions.set(id, { x: at.x + dx * scale, y: at.y + dy * scale });
		}
	}
}

/**
 * The graph the simulation runs on: stored edges plus the derived ones.
 *
 * Both are included because the derived edges are most of the structure the
 * episodic half has (see `graphQueries.derivedEdges`) — laying out without them
 * scatters memories that plainly belong together. The derived set is returned as
 * well, because the view draws exactly the edges the map was laid out on.
 */
function buildLayoutGraph(ids: string[]): {
	graph: Graph;
	derived: { srcId: string; dstId: string; weight: number }[];
} {
	const graph = new Graph({ type: 'undirected', multi: false });
	for (const id of ids) graph.addNode(id, { x: 0, y: 0, size: 1 });

	const link = (source: string, target: string, weight: number): void => {
		if (source === target) return;
		if (!graph.hasNode(source) || !graph.hasNode(target)) return;
		if (graph.hasEdge(source, target)) return;
		graph.addUndirectedEdge(source, target, { weight });
	};

	for (const edge of graphQueries.edgesWithin(ids)) link(edge.srcId, edge.dstId, edge.weight);
	const derived = graphQueries.derivedEdges(ids);
	for (const edge of derived) link(edge.srcId, edge.dstId, edge.weight);

	// ForceAtlas2 reads mass from `size`; a hub that weighs more holds its
	// neighbours' fan open instead of being dragged into the middle of it.
	graph.forEachNode(id => {
		graph.setNodeAttribute(id, 'size', 1 + Math.sqrt(graph.degree(id)));
	});
	return { graph, derived };
}

/** The induced subgraph over `ids` — the part the simulation will actually move. */
function restrictTo(graph: Graph, ids: string[]): Graph {
	const keep = new Set(ids);
	const subgraph = new Graph({ type: 'undirected', multi: false });
	for (const id of ids) {
		if (graph.hasNode(id)) subgraph.addNode(id, { ...graph.getNodeAttributes(id) });
	}
	graph.forEachUndirectedEdge((_edge, attributes, source, target) => {
		if (!keep.has(source) || !keep.has(target)) return;
		if (subgraph.hasEdge(source, target)) return;
		subgraph.addUndirectedEdge(source, target, { ...attributes });
	});
	return subgraph;
}

/**
 * Arrange the graph — the step that decides its SHAPE.
 *
 * ── Why the old view was always a circle ─────────────────────────────────────
 * Two causes, and the second is by far the larger.
 *
 * The seed was a golden-angle spiral of community regions, which is a disc by
 * construction. That much was known and only half-fixed: an earlier pass sized
 * the regions by membership and left them on the spiral, so the silhouette stayed
 * round however lopsided the data was.
 *
 * But the real cause is that a memory graph is not connected. Measured on a real
 * store: 1,801 live nodes in 146 components — one giant of 961, a handful in the
 * hundreds, and 108 lone nodes with no relationship to anything. ForceAtlas2
 * exerts NO force between components, so the only thing arranging them was
 * gravity, and gravity is an isotropic pull toward one point. Repulsion pushes
 * out, gravity pulls in, and every unrelated component settles at roughly the
 * same radius. That is the ring of small stars around the edge, and it is why the
 * outline was a circle regardless of what the graph contained.
 *
 * ── What replaces it ─────────────────────────────────────────────────────────
 * Each component is laid out in ITS OWN local space, where gravity is a local
 * force that keeps it cohesive instead of a global one that rounds everything
 * off. The components are then packed, and the packing is what the outline comes
 * from: sizes and counts, which differ per dataset, rather than a formula that
 * does not. Lone nodes go into the gaps between the packed components, which is
 * what dissolves the ring — they were a third of the marks and all of them were
 * on it.
 *
 * Deterministic throughout. Every scatter is derived from a node id or a
 * community index, both stable for a given dataset, so reopening the modal
 * settles into the same map. Different data gives a different shape; the same
 * data does not.
 *
 * ── And it is cheaper ────────────────────────────────────────────────────────
 * Repulsion is O(n²), so laying out components separately costs Σn²ᵢ instead of
 * (Σnᵢ)². On the store measured above that is 1.0M against 3.2M — the shape is
 * better AND the pass is a third of the work.
 */
async function arrange(simulated: Graph, communities: Record<string, number>): Promise<GraphLayoutRow[]> {
	const components = componentsOf(simulated);
	const singletons: string[] = [];
	const placed: PlacedComponent[] = [];

	for (const member of components) {
		if (member.length === 1) {
			singletons.push(member[0]);
			continue;
		}

		const part = restrictTo(simulated, member);
		seedComponent(part, communities);
		await settle(part, iterationsFor(part.order));
		declump(part, communities);
		const lobes = spreadCommunities(part, communities);

		placed.push(measure(part, lobes));
	}

	packComponents(placed);
	const rows: GraphLayoutRow[] = [];

	for (const component of placed) {
		for (let i = 0; i < component.ids.length; i++) {
			rows.push({
				nodeId: component.ids[i],
				community: communities[component.ids[i]] ?? 0,
				x: component.xs[i] + component.offsetX,
				y: component.ys[i] + component.offsetY,
				placed: 1,
				// Filled in by the caller, which holds the whole graph.
				degree: 0
			});
		}
	}

	// The field is where the LOBES are. Lone nodes are dropped into it rather than
	// onto a disc of their own, which is what stopped them deciding how far the
	// map reaches — see `placeLoneNodes`.
	const field: Disc[] = [];
	for (const component of placed) {
		for (const lobe of component.lobes) {
			field.push({ x: lobe.x + component.offsetX, y: lobe.y + component.offsetY, radius: lobe.radius });
		}
	}

	for (const row of placeLoneNodes(singletons, field, communities)) rows.push(row);
	return rows;
}

/**
 * Give every memory room of its own, at the scale the lobe was drawn at.
 *
 * ForceAtlas2 with mass-distributed attraction pulls a lobe's members onto its
 * hubs, so a settled lobe is a dense core with a thin rim. Measured on a real
 * store, the median distance to the nearest neighbour was 46 units against a
 * median edge of 416 — at the zoom that shows the whole map that is under two
 * pixels, so the cores drew as solid blobs and nothing inside them could be
 * told apart, hovered or clicked.
 *
 * So members closer than `MIN_SPACING` of the lobe's own typical edge are pushed
 * apart, pairwise, until none are — which grows the dense cores and leaves the
 * already-spacious rims where they were. Measured against the component's
 * INTRA-lobe edges, so the spacing follows the scale this layout happened to
 * settle at rather than a constant that is right for one store.
 *
 * Neighbours are found through a spatial hash, so a pass is linear in the
 * members; deterministic, because every tie is broken by id.
 */
function declump(part: Graph, communities: Record<string, number>): void {
	/** Clear space between two members, as a fraction of the lobe's median edge. */
	const MIN_SPACING = 0.8;
	/**
	 * A ceiling, not a count: the loop stops the moment nothing overlaps. Dense
	 * cores need many — each pass only resolves the overlaps it sees, and pushing
	 * one pair apart presses both into their other neighbours.
	 */
	const PASSES = 400;

	const lengths: number[] = [];
	part.forEachUndirectedEdge((_edge, _attributes, source, target) => {
		if ((communities[source] ?? 0) !== (communities[target] ?? 0)) return;
		const a = part.getNodeAttributes(source) as { x: number; y: number };
		const b = part.getNodeAttributes(target) as { x: number; y: number };
		const length = Math.hypot(a.x - b.x, a.y - b.y);
		if (length > 0 && Number.isFinite(length)) lengths.push(length);
	});
	if (lengths.length === 0) return;
	lengths.sort((a, b) => a - b);
	const spacing = lengths[lengths.length >> 1] * MIN_SPACING;
	if (!(spacing > 0)) return;

	const ids = part.nodes().sort();
	const xs = new Float64Array(ids.length);
	const ys = new Float64Array(ids.length);
	for (let i = 0; i < ids.length; i++) {
		xs[i] = part.getNodeAttribute(ids[i], 'x') as number;
		ys[i] = part.getNodeAttribute(ids[i], 'y') as number;
	}

	for (let pass = 0; pass < PASSES; pass++) {
		const grid = new Map<string, number[]>();
		for (let i = 0; i < ids.length; i++) {
			const key = `${Math.floor(xs[i] / spacing)}:${Math.floor(ys[i] / spacing)}`;
			const bucket = grid.get(key);
			if (bucket) bucket.push(i);
			else grid.set(key, [i]);
		}

		let moved = false;
		for (let i = 0; i < ids.length; i++) {
			const cx = Math.floor(xs[i] / spacing);
			const cy = Math.floor(ys[i] / spacing);
			for (let gx = cx - 1; gx <= cx + 1; gx++) {
				for (let gy = cy - 1; gy <= cy + 1; gy++) {
					for (const j of grid.get(`${gx}:${gy}`) ?? []) {
						if (j <= i) continue;
						let dx = xs[j] - xs[i];
						let dy = ys[j] - ys[i];
						let distance = Math.hypot(dx, dy);
						if (distance >= spacing) continue;
						if (distance < 1e-9) {
							const angle = jitterOf(ids[i] + ids[j]).angle;
							dx = Math.cos(angle);
							dy = Math.sin(angle);
							distance = 1;
						}
						const push = (spacing - distance) / distance / 2;
						xs[i] -= dx * push;
						ys[i] -= dy * push;
						xs[j] += dx * push;
						ys[j] += dy * push;
						moved = true;
					}
				}
			}
		}
		if (!moved) break;
	}

	for (let i = 0; i < ids.length; i++) {
		part.setNodeAttribute(ids[i], 'x', xs[i]);
		part.setNodeAttribute(ids[i], 'y', ys[i]);
	}
}

/**
 * Push the lobes apart from each other, leaving each one's interior alone.
 *
 * The forces cannot do this on their own. Repulsion is between NODES, so it is
 * strongest exactly where nodes are dense — inside a lobe — while the edges
 * between two lobes pull them together with nothing pushing back at the same
 * scale. A well-clustered graph therefore settles as one field of colour with
 * its groups readable only by hue.
 *
 * Raising `scalingRatio` would not fix it: global repulsion inflates the lobes
 * and the gaps together, so the picture gets bigger and reads the same.
 *
 * SEPARATION IS SOLVED, NOT SCALED, and the difference matters. Multiplying each
 * lobe's distance from the centre — by one constant, or by a draw per lobe —
 * cannot promise any particular lobe clear space: the constant preserves the
 * silhouette and only inflates it, and the draw flings a few lobes far out while
 * the rest stay exactly as crowded as they were. Measured, that second version
 * put the whole store's extent in the hands of two outliers and left the other
 * fifty-six in a clump.
 *
 * So each lobe is treated as a disc, and the discs are relaxed apart until none
 * of them overlap — the same collision pass `packComponents` runs over
 * components, one level down. Every lobe ends up with room, the field grows only
 * as far as it has to, and `GAP` is the dial: clear space between two lobes as a
 * fraction of the smaller one's radius.
 *
 * Each lobe moves RIGIDLY. Every node keeps its offset from its own lobe's
 * centroid, so the interior the forces worked out is preserved exactly and only
 * the distance between lobes changes. Deterministic, and it cannot destabilise a
 * simulation that has already finished.
 *
 * Returns the discs, because they are the FIELD: what the map covers is where
 * the lobes are, and the nodes that connect to nothing are placed inside it
 * rather than on a disc of their own. See `placeLoneNodes`.
 */
function spreadCommunities(part: Graph, communities: Record<string, number>): Disc[] {
	/**
	 * Clear space between two lobes, as a fraction of the smaller one's radius.
	 * This is the "multiverse rather than one universe" dial. `packComponents`
	 * uses 0.15 between whole components; lobes want far more, because unlike
	 * components they are joined by edges that read as bridges.
	 */
	const GAP = 0.35;
	const PASSES = 240;
	/** Share of the distance to the centre a lobe moves per compaction pass. */
	const COMPACT_PULL = 0.06;
	/**
	 * The percentile of member distances taken as a lobe's radius.
	 *
	 * Not the maximum: Louvain leaves the occasional member stretched toward a
	 * neighbouring lobe by one edge, and sizing the disc to that straggler would
	 * separate on a distance almost none of the lobe occupies.
	 */
	const RADIUS_PERCENTILE = 0.9;

	const members = new Map<number, string[]>();
	part.forEachNode(id => {
		const community = communities[id] ?? 0;
		const list = members.get(community);
		if (list) list.push(id);
		else members.set(community, [id]);
	});

	interface Lobe extends Disc {
		ids: string[];
		originX: number;
		originY: number;
	}

	const lobes: Lobe[] = [];
	for (const [, ids] of [...members.entries()].sort((a, b) => a[0] - b[0])) {
		let sumX = 0;
		let sumY = 0;
		for (const id of ids) {
			sumX += part.getNodeAttribute(id, 'x') as number;
			sumY += part.getNodeAttribute(id, 'y') as number;
		}
		const x = sumX / ids.length;
		const y = sumY / ids.length;

		const distances = ids
			.map(id =>
				Math.hypot((part.getNodeAttribute(id, 'x') as number) - x, (part.getNodeAttribute(id, 'y') as number) - y)
			)
			.sort((a, b) => a - b);
		const radius = Math.max(distances[Math.floor(distances.length * RADIUS_PERCENTILE)] ?? 0, 20);

		lobes.push({ ids, x, y, radius, originX: x, originY: y });
	}

	// One lobe has nothing to be spread away from, but it is still the field.
	if (lobes.length < 2) return lobes.map(lobe => ({ x: lobe.x, y: lobe.y, radius: lobe.radius }));

	const separate = (limit: number): void => {
	for (let pass = 0; pass < limit; pass++) {
		// Over-relaxed early and settling toward an exact correction, for the same
		// reason `packComponents` does it: separating one pair nudges both into
		// their other neighbours.
		const relax = 1.4 - 0.4 * (pass / limit);
		let collided = false;

		for (let i = 0; i < lobes.length; i++) {
			for (let j = i + 1; j < lobes.length; j++) {
				const a = lobes[i];
				const b = lobes[j];
				const minimum = a.radius + b.radius + GAP * Math.min(a.radius, b.radius);
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				const squared = dx * dx + dy * dy;
				if (squared >= minimum * minimum) continue;

				let distance = Math.sqrt(squared);
				if (distance < 1e-9) {
					// Two centroids on the same point have no direction to separate
					// along; take one from the ids, so it is still the same every pass.
					const angle = jitterOf(a.ids[0] + b.ids[0]).angle;
					dx = Math.cos(angle);
					dy = Math.sin(angle);
					distance = 1;
				}

				const push = (relax * (minimum - distance)) / distance / 2;
				a.x -= dx * push;
				a.y -= dy * push;
				b.x += dx * push;
				b.y += dy * push;
				collided = true;
			}
		}

		if (!collided) break;
	}
	};

	separate(PASSES);

	// Then close the gaps. Separation only ever pushes apart, so lobes stayed as
	// far apart as the simulation left them — and once `declump` had grown their
	// interiors, that was most of the map: measured, the lobes covered a sixth of
	// the world, the rest was empty, and every edge between two lobes crossed it
	// as a long line. Drawing the lobes toward their common centre while the
	// separation keeps them from overlapping packs them like circles: the same
	// neighbours, a fraction of the empty space, and shorter bridges.
	const COMPACT_PASSES = 160;
	for (let pass = 0; pass < COMPACT_PASSES; pass++) {
		let weight = 0;
		let centreX = 0;
		let centreY = 0;
		for (const lobe of lobes) {
			const area = lobe.radius * lobe.radius;
			centreX += lobe.x * area;
			centreY += lobe.y * area;
			weight += area;
		}
		centreX /= weight;
		centreY /= weight;
		for (const lobe of lobes) {
			lobe.x += (centreX - lobe.x) * COMPACT_PULL;
			lobe.y += (centreY - lobe.y) * COMPACT_PULL;
		}
		separate(8);
	}
	// Whatever the last pull left touching is pulled apart for good.
	separate(PASSES);

	for (const lobe of lobes) {
		const shiftX = lobe.x - lobe.originX;
		const shiftY = lobe.y - lobe.originY;
		if (shiftX === 0 && shiftY === 0) continue;
		for (const id of lobe.ids) {
			part.setNodeAttribute(id, 'x', (part.getNodeAttribute(id, 'x') as number) + shiftX);
			part.setNodeAttribute(id, 'y', (part.getNodeAttribute(id, 'y') as number) + shiftY);
		}
	}

	return lobes.map(lobe => ({ x: lobe.x, y: lobe.y, radius: lobe.radius }));
}

/** A circle something occupies — a lobe, or a whole component. */
interface Disc {
	x: number;
	y: number;
	radius: number;
}

/** One component, laid out in local space and waiting to be given a place. */
interface PlacedComponent {
	ids: string[];
	xs: Float64Array;
	ys: Float64Array;
	/** Enclosing radius in local space, for the packing to keep clear. */
	radius: number;
	offsetX: number;
	offsetY: number;
	/** Held still by the packing — the largest component, which holds the origin. */
	anchored: boolean;
	/** Its lobes, in the same local space as `xs`/`ys`. See `placeLoneNodes`. */
	lobes: Disc[];
}

/**
 * Connected components, largest first.
 *
 * Ordered by size and then by the lowest id it contains, so the ordering — and
 * therefore everything the packing derives from it — is stable for a given
 * dataset rather than dependent on insertion order.
 */
function componentsOf(graph: Graph): string[][] {
	const seen = new Set<string>();
	const components: string[][] = [];

	for (const start of graph.nodes()) {
		if (seen.has(start)) continue;

		const member: string[] = [start];
		seen.add(start);
		const stack = [start];
		while (stack.length > 0) {
			const current = stack.pop() as string;
			graph.forEachNeighbor(current, neighbour => {
				if (seen.has(neighbour)) return;
				seen.add(neighbour);
				member.push(neighbour);
				stack.push(neighbour);
			});
		}
		member.sort();
		components.push(member);
	}

	components.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
	return components;
}

/**
 * Where a component's nodes start, in LOCAL space.
 *
 * Local is what makes gravity harmless: a component sitting far from the origin
 * would otherwise be dragged toward it a little on every pass, and after enough
 * passes every component would have crept into one pile — the disc again, arrived
 * at slowly instead of immediately.
 *
 * Every node starts inside its community's region, scattered by its own id, so
 * the same store always starts — and therefore settles — the same way.
 */
function seedComponent(part: Graph, communities: Record<string, number>): void {
	const meta = communityMetaSeed(part, communities);

	part.forEachNode(id => {
		const jitter = jitterOf(id);
		const region = meta.get(communities[id] ?? 0);
		part.setNodeAttribute(id, 'x', (region?.x ?? 0) + jitter.x * (region?.radius ?? 120));
		part.setNodeAttribute(id, 'y', (region?.y ?? 0) + jitter.y * (region?.radius ?? 120));
	});
}

/**
 * Where each community inside a component starts, from the communities' own graph.
 *
 * This is what replaced the spiral, and the difference is not only that it is
 * irregular. A spiral orders lobes by size and says nothing about them; laying
 * out a META-GRAPH — one node per community, edges weighted by how many real
 * edges cross between them — puts lobes near the lobes they are actually
 * connected to. The macro arrangement starts meaning something, and the forces
 * that follow refine a structure instead of fighting a formula.
 *
 * Tens of nodes at most, so it costs nothing next to the component it seeds.
 */
function communityMetaSeed(
	part: Graph,
	communities: Record<string, number>
): Map<number, { x: number; y: number; radius: number }> {
	const sizes = new Map<number, number>();
	part.forEachNode(id => {
		const community = communities[id] ?? 0;
		sizes.set(community, (sizes.get(community) ?? 0) + 1);
	});

	const regions = new Map<number, { x: number; y: number; radius: number }>();
	if (sizes.size === 0) return regions;

	/** Local radius per √member — area proportional to membership. */
	const SCALE = 26;

	if (sizes.size === 1) {
		const [[community, size]] = [...sizes.entries()];
		regions.set(community, { x: 0, y: 0, radius: Math.max(40, SCALE * Math.sqrt(size)) });
		return regions;
	}

	const meta = new Graph({ type: 'undirected', multi: false });
	for (const [community, size] of sizes) {
		const jitter = jitterOf(`community-${community}`);
		const radius = Math.max(40, SCALE * Math.sqrt(size));
		// Deterministic scatter rather than a ring: a ring is the shape the forces
		// would then have to escape, and they do not escape it.
		meta.addNode(String(community), {
			x: jitter.x * 400,
			y: jitter.y * 400,
			size: 1 + Math.sqrt(size),
			radius
		});
	}

	part.forEachUndirectedEdge((_edge, _attributes, source, target) => {
		const a = String(communities[source] ?? 0);
		const b = String(communities[target] ?? 0);
		if (a === b || !meta.hasNode(a) || !meta.hasNode(b)) return;
		if (meta.hasEdge(a, b)) {
			meta.updateEdgeAttribute(a, b, 'weight', (weight: unknown) => (weight as number) + 1);
			return;
		}
		meta.addUndirectedEdge(a, b, { weight: 1 });
	});

	if (meta.size > 0) {
		forceAtlas2.assign(meta, {
			iterations: 300,
			settings: {
				...forceAtlas2.inferSettings(meta),
				outboundAttractionDistribution: true,
				gravity: 0.05,
				scalingRatio: 200,
				adjustSizes: false,
				edgeWeightInfluence: 1,
				barnesHutOptimize: false
			}
		});
	}

	meta.forEachNode((key, attributes) => {
		regions.set(Number(key), {
			x: attributes.x as number,
			y: attributes.y as number,
			radius: attributes.radius as number
		});
	});
	return regions;
}

/** Centre a settled component on its own centroid and measure what it needs. */
function measure(part: Graph, lobes: Disc[]): PlacedComponent {
	const ids = part.nodes();
	const xs = new Float64Array(ids.length);
	const ys = new Float64Array(ids.length);

	let sumX = 0;
	let sumY = 0;
	for (let i = 0; i < ids.length; i++) {
		xs[i] = part.getNodeAttribute(ids[i], 'x') as number;
		ys[i] = part.getNodeAttribute(ids[i], 'y') as number;
		sumX += xs[i];
		sumY += ys[i];
	}
	const centreX = sumX / ids.length;
	const centreY = sumY / ids.length;

	let radius = 0;
	for (let i = 0; i < ids.length; i++) {
		xs[i] -= centreX;
		ys[i] -= centreY;
		radius = Math.max(radius, Math.sqrt(xs[i] * xs[i] + ys[i] * ys[i]));
	}

	return {
		ids,
		xs,
		ys,
		// Re-centred with the nodes, so a lobe keeps describing where its members
		// actually are once the component is given a place.
		lobes: lobes.map(lobe => ({ x: lobe.x - centreX, y: lobe.y - centreY, radius: lobe.radius })),
		radius: Math.max(radius, 20),
		// Given a place by `packComponents`.
		offsetX: 0,
		offsetY: 0,
		anchored: false
	};
}

/**
 * Give every component a place, and separate any that overlap.
 *
 * A store this feature has been running in for any length of time is ONE mass
 * and a handful of stragglers, so the placement is built around that rather than
 * around components being comparable: the largest holds the origin and does not
 * move, the others are put just outside it, and the relaxation pushes apart
 * whatever still collides. The silhouette is then decided by how big the mass is
 * and how many stragglers there are, both of which are properties of the data.
 *
 * The largest component is held still once it is given the origin; everything
 * else moves around it.
 */
function packComponents(placed: PlacedComponent[]): void {
	if (placed.length === 0) return;

	// THE LARGEST COMPONENT HOLDS THE ORIGIN, and the rest are placed around it.
	//
	// Both halves of that are corrections, and both came from the same measurement.
	// Once a store has grown its components are not comparable: the measured graph
	// is one of 2,036 memories, one of three, one of two, and twenty-six lone
	// nodes. Scattering all of them into a box sized by TOTAL area — which is what
	// this did — flung the giant half a box width, so it settled at (6960, 5095)
	// and took the whole map off the origin with it, while every other placement
	// in this file measures from the middle. It also threw the two tiny components
	// tens of thousands of units out, which then set how far the map reached.
	//
	// So the biggest mass is pinned at the origin and marked as fixed, and the
	// others are placed in a ring just outside it — near the thing they are small
	// against, rather than lost in a box scaled to it. The relaxation below then
	// resolves whatever still overlaps. `componentsOf` returns them largest first.
	const movable = placed.filter(component => !component.anchored);
	const anchorRadius = movable.length > 0 ? movable[0].radius : 0;
	for (let i = 0; i < movable.length; i++) {
		const component = movable[i];
		if (i === 0) {
			component.offsetX = 0;
			component.offsetY = 0;
			// Fixed for the relaxation too. Without this a three-node component
			// landing on it pushes the mass — and the map — aside to make room.
			component.anchored = true;
			continue;
		}
		const jitter = jitterOf(component.ids[0]);
		// Deterministic angle, and a radius just clear of the mass with enough
		// variation that the satellites do not draw a circle around it.
		const distance = anchorRadius + component.radius * (1.4 + 0.9 * ((jitter.y + 1) / 2));
		component.offsetX = Math.cos(jitter.angle) * distance;
		component.offsetY = Math.sin(jitter.angle) * distance;
	}

	/** Clear space between two components, as a fraction of the smaller radius. */
	const GAP = 0.15;
	const PASSES = 220;

	for (let pass = 0; pass < PASSES; pass++) {
		// Over-relaxed early and settling toward an exact correction: separating one
		// pair nudges both into their other neighbours, so overshooting clears a
		// crowd far faster, and easing off stops it oscillating near the answer.
		const relax = 1.4 - 0.4 * (pass / PASSES);
		let collided = false;

		for (let i = 0; i < placed.length; i++) {
			for (let j = i + 1; j < placed.length; j++) {
				const a = placed[i];
				const b = placed[j];
				if (a.anchored && b.anchored) continue;

				const minimum = a.radius + b.radius + GAP * Math.min(a.radius, b.radius);
				let dx = b.offsetX - a.offsetX;
				let dy = b.offsetY - a.offsetY;
				const squared = dx * dx + dy * dy;
				if (squared >= minimum * minimum) continue;

				let distance = Math.sqrt(squared);
				if (distance < 1e-9) {
					const angle = jitterOf(a.ids[0] + b.ids[0]).angle;
					dx = Math.cos(angle);
					dy = Math.sin(angle);
					distance = 1;
				}

				const push = (relax * (minimum - distance)) / distance;
				// An anchored neighbour absorbs none of the correction — the mover
				// takes all of it, which is what keeps a known map still.
				const shareA = a.anchored ? 0 : b.anchored ? 1 : 0.5;
				const shareB = b.anchored ? 0 : a.anchored ? 1 : 0.5;
				a.offsetX -= dx * push * shareA;
				a.offsetY -= dy * push * shareA;
				b.offsetX += dx * push * shareB;
				b.offsetY += dy * push * shareB;
				collided = true;
			}
		}

		if (!collided) break;
	}
}

/**
 * Place the nodes that connect to nothing, inside the field the lobes occupy.
 *
 * These were the ring. With no edges there is no force to arrange them, so under
 * the old global gravity they all settled at one radius and drew a circle around
 * everything else. Two attempts to fix that each failed in their own way, and
 * both failures are why this is shaped as it is.
 *
 * A GRID OF FREE CELLS over the bounding RECTANGLE of the components, filled
 * from the middle out, worked while the graph was many small components with
 * gaps between them. It stopped working the moment the store became one
 * connected mass: there is no interior gap left, so every free cell was a corner
 * or an edge of the rectangle, and the lone nodes lined up along two sides of a
 * box.
 *
 * A DISC OF THEIR OWN, sized from the component's reach, put them off the box —
 * and made them the largest thing on the map. Measured on a real store their
 * span was 40,998 against the clusters' 26,065, so the view fitted to THEM and
 * zoomed the clusters, which are the thing worth looking at, down into a clump
 * in one corner. Nodes that connect to nothing were setting the scale of
 * everything that does.
 *
 * So there is no second field. The lobes ARE the field: a lone node is drawn
 * somewhere inside it — angle and radius from its own id, the radius
 * square-rooted so the draws are uniform over the AREA rather than bunched at
 * the centre — and pushed clear if it lands on a lobe. It fills the gaps between
 * the islands, and it cannot make the map larger than the islands already do.
 *
 * Deterministic: an id does not change, so neither does where its memory sits.
 */
function placeLoneNodes(
	singletons: string[],
	field: Disc[],
	communities: Record<string, number>
): GraphLayoutRow[] {
	if (singletons.length === 0) return [];

	const rows: GraphLayoutRow[] = [];
	const ordered = [...singletons].sort();

	// Nothing else on the map — a field of their own, which is the only case where
	// they set the scale, because there is nothing else to set it.
	if (field.length === 0) {
		const span = 120 * Math.sqrt(ordered.length);
		for (const id of ordered) {
			const draw = jitterOf(id);
			const radius = span * Math.sqrt((draw.x + 1) / 2);
			rows.push({
				nodeId: id,
				community: communities[id] ?? 0,
				x: Math.cos(draw.angle) * radius,
				y: Math.sin(draw.angle) * radius,
				placed: 1,
				degree: 0
			});
		}
		return rows;
	}

	// The field's own centre and reach, taken from the lobes rather than from the
	// origin: a component is re-centred on its own centroid and then given a
	// place, so the origin is not where the map is.
	let centreX = 0;
	let centreY = 0;
	for (const lobe of field) {
		centreX += lobe.x;
		centreY += lobe.y;
	}
	centreX /= field.length;
	centreY /= field.length;

	let reach = 0;
	for (const lobe of field) {
		reach = Math.max(reach, Math.hypot(lobe.x - centreX, lobe.y - centreY) + lobe.radius);
	}

	/** Clear space kept around a lobe a lone node was drawn on top of. */
	const CLEARANCE = 0.12;

	for (const id of ordered) {
		const draw = jitterOf(id);
		const radius = reach * Math.sqrt((draw.x + 1) / 2);
		let x = centreX + Math.cos(draw.angle) * radius;
		let y = centreY + Math.sin(draw.angle) * radius;

		// Nudged off any lobe it landed on, along the line out of that lobe's
		// centre. A lone memory drawn on top of a cluster reads as a member of it,
		// which is the one thing it is not. Bounded, because pushing off one lobe
		// can land it on the next.
		for (let attempt = 0; attempt < 8; attempt++) {
			const hit = field.find(lobe => Math.hypot(x - lobe.x, y - lobe.y) < lobe.radius);
			if (!hit) break;
			let dx = x - hit.x;
			let dy = y - hit.y;
			let distance = Math.hypot(dx, dy);
			if (distance < 1e-9) {
				// Dead centre of a lobe has no direction to leave by; take one from the
				// id, so it is still the same on every pass.
				dx = Math.cos(draw.angle);
				dy = Math.sin(draw.angle);
				distance = 1;
			}
			const target = hit.radius * (1 + CLEARANCE);
			x = hit.x + (dx / distance) * target;
			y = hit.y + (dy / distance) * target;
		}

		rows.push({ nodeId: id, community: communities[id] ?? 0, x, y, placed: 1, degree: 0 });
	}

	return rows;
}

/**
 * A deterministic offset in [-1, 1]², plus an angle, derived from a string.
 *
 * Every scatter in this file comes through here, which is what makes the whole
 * arrangement reproducible: node ids and community indices are both stable for a
 * given dataset, so the same store settles into the same map however many times
 * it is laid out. Nothing here reads a clock or a random number.
 */
function jitterOf(key: string): { x: number; y: number; angle: number } {
	const hash = hashOf(key);
	return {
		x: (hash % 65536) / 65536 * 2 - 1,
		y: ((hash >>> 16) % 65536) / 65536 * 2 - 1,
		angle: ((hash % 3600) / 3600) * Math.PI * 2
	};
}


/** FNV-1a — cheap, well-distributed, and deterministic across restarts. */
function hashOf(id: string): number {
	let hash = 2166136261;
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

/**
 * A cold pass has to discover the shape; smaller graphs can afford to converge.
 *
 * Lower than the numbers the browser used to run, and deliberately: the seed is
 * already grouped by community, so these iterations refine an arrangement rather
 * than construct one. Measured, an iteration costs ~15 ms at 1,200 nodes and
 * ~90 ms at 5,000, so the counts have to come down as the graph goes up or a
 * cold pass turns into minutes.
 */
function iterationsFor(order: number): number {
	if (order > 3_000) return 120;
	if (order > 1_500) return 200;
	if (order > 400) return 300;
	return 600;
}

/**
 * Run the simulation, yielding between chunks.
 *
 * The yield is the whole point of doing this on a timer rather than inline: Bun
 * serves the WebSocket from the same loop, so a pass that ran to completion
 * without returning to the event loop would stall every open session for as long
 * as it took. Chunked, the cost is spread across frames nobody is waiting on.
 */
async function settle(graph: Graph, iterations: number): Promise<void> {
	const settings = {
		...forceAtlas2.inferSettings(graph),
		// Divides attraction by mass, so a hub does not drag its neighbours onto
		// itself — which is what turns a hub and its forty leaves into a fan rather
		// than a dot, and fans are most of what makes a large graph readable.
		outboundAttractionDistribution: true,
		/**
		 * Very low, and now it can be: this runs per COMPONENT, in that component's
		 * own local space, so gravity is only holding one connected thing together
		 * rather than gathering unrelated things into a disc. Attraction along the
		 * edges does most of that work anyway; this just stops a long chain from
		 * stretching without limit.
		 *
		 * Run globally, at any strength, it is what made every graph round — an
		 * isotropic pull toward one point is a circle, and 146 components with no
		 * forces between them had nothing else deciding where they went.
		 */
		gravity: 0.05,
		scalingRatio: 50,
		// A local correction that enforces minimum spacing from node sizes, which
		// flattens exactly the density differences the layout exists to show.
		adjustSizes: false,
		edgeWeightInfluence: 1,
		/**
		 * OFF, which is not what the browser did and not what the setting's name
		 * suggests. Measured against this workload, graphology's Barnes-Hut costs
		 * more than the naive repulsion it replaces at every size that reaches this
		 * code: at 5,000 nodes it took 142 ms per iteration against 93 ms without.
		 * It rebuilds its quadtree every iteration, and below the tens of thousands
		 * that tree costs more than the pairs it saves.
		 */
		barnesHutOptimize: false
	};

	/**
	 * Iterations per `assign` call, derived from the graph's SIZE and nothing else.
	 *
	 * This used to adapt to measured time, which was faster and quietly
	 * non-reproducible. FA2 keeps a per-node convergence factor — its adaptive
	 * local speed — and `graphToByteArrays` re-initialises it to 1 on every
	 * `assign` call, so where the iterations are split changes the trajectory. With
	 * the split decided by a clock, the same store settled into a different map
	 * every pass.
	 *
	 * Size is the right basis instead: it bounds how long one call blocks the event
	 * loop (an iteration costs roughly linearly in the node count here) and it is a
	 * property of the data, so two passes over the same graph split identically.
	 */
	const chunk = Math.max(1, Math.min(50, Math.round(6_000 / Math.max(1, graph.order))));

	let done = 0;
	while (done < iterations) {
		const batch = Math.min(chunk, iterations - done);
		forceAtlas2.assign(graph, { iterations: batch, settings });
		done += batch;
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
}

/**
 * A seeded PRNG — mulberry32.
 *
 * Fixed seed, no clock, no entropy: the arrangement has to be the same map every
 * time it is computed, and anything that reaches for `Math.random` breaks that
 * however good its distribution is.
 */
function seededRandom(): () => number {
	let state = 0x9e3779b9;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
