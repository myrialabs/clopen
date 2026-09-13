/**
 * The persisted arrangement of the Memory graph.
 *
 * Community detection and force layout both used to run on the read path — one
 * on the server inside `buildGraphView`, the other in the browser on every open —
 * and both produce the SAME answer for the same dataset. They were being
 * recomputed, not computed: opening the modal twice paid for the identical
 * arrangement twice, and every conversation that recorded a memory made every
 * connected client pay for it again.
 *
 * That is what made the modal's opening animation stutter once the graph got
 * large. The animation is two hundred milliseconds of one thread, and a few
 * hundred milliseconds of layout was landing inside it.
 *
 * So it happens HERE instead: once, in the background, written to `graph_layout`,
 * and read back as two numbers per node. Reading a laid-out graph is then a
 * table lookup whatever the graph costs to lay out, and the browser never runs a
 * force simulation for the whole store again.
 *
 * ── Warm, not cold ────────────────────────────────────────────────────────────
 * A pass starts from where the last one finished. That is not only cheaper, it is
 * the thing that makes the view stable to look at: a memory arriving must not
 * rearrange the map somebody has learned. New nodes are seeded at the centroid of
 * whatever they connect to and a short pass settles them into the gaps, exactly
 * as the client's incremental path used to do for a single session.
 *
 * ── Bounded on purpose ────────────────────────────────────────────────────────
 * `MAX_LAYOUT_NODES` caps the simulation. A force layout is superlinear and the
 * store grows without limit, so an uncapped pass would eventually take longer
 * than the interval between the writes that trigger it. What survives the cap is
 * what the view ranks highest anyway; anything below it is reachable by search
 * and by expanding a lobe, neither of which needs a position.
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
 * A pass is warm by default: every node is seeded at the position it already had
 * and only lightly re-settled, which is what stops one new memory rearranging a
 * map somebody has learned. That is exactly wrong after the pass itself changes,
 * because the arrangement it would preserve was computed by different rules —
 * when removing the code half took the store from 1,351 components to one, the
 * surviving memories stayed in the shell those nine thousand nodes had shaped.
 *
 * So the marker is stored alongside the arrangement, and a mismatch drops the
 * arrangement once. It costs one cold pass, which the store pays for anyway the
 * first time it is laid out.
 */
const LAYOUT_VERSION = '6';
const LAYOUT_VERSION_KEY = 'memory_layout_version';
/** The key this used before it covered placement as well as derivation. */
const LEGACY_LAYOUT_KEY = 'memory_layout_derivation';

/**
 * Two caps, because the two halves of a pass scale differently.
 *
 * COMMUNITY DETECTION is roughly linear in the edges, and it is what the overview
 * groups by — a node left out of it has no lobe to belong to and would vanish
 * from the picture entirely, which is exactly the failure a cap is supposed to
 * prevent. So it runs over everything live, up to a ceiling far beyond any real
 * store.
 *
 * THE FORCE SIMULATION is superlinear and measurably so — around 15 ms per
 * iteration at 1,200 nodes and 90 ms at 5,000 — so it runs only over the
 * highest-ranked nodes. The rest keep their real community and get a position
 * near it, marked `placed = 0` so nothing downstream mistakes the guess for a
 * computed arrangement.
 */
const MAX_COMMUNITY_NODES = 50_000;
const MAX_LAYOUT_NODES = 6_000;

/**
 * How long to wait after a write before laying out again.
 *
 * `notifyGraphChanged` already folds a turn's ingestion burst into one event at
 * 600 ms; this sits on top because a layout pass is far more expensive than a
 * broadcast and a user watching the graph does not need the new node to have
 * found its final place within the second — it appears immediately either way,
 * seeded next to what it connects to.
 */
const DEBOUNCE_MS = 4_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
/** A change arrived mid-pass, so the result is already out of date. */
let rerunRequested = false;

/**
 * What the last pass laid out.
 *
 * Reinforcement bumps `weight` and `updated_at` on every recall, so the change
 * notification fires constantly without the SET of nodes moving at all. Laying
 * out an unchanged set produces an unchanged answer, so this skips it.
 */
let lastMembership = '';

/** Cheap order-sensitive fingerprint of an id list. */
function membershipOf(ids: string[]): string {
	let hash = 2166136261;
	for (const id of ids) {
		for (let i = 0; i < id.length; i++) {
			hash ^= id.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
	}
	return `${ids.length}:${(hash >>> 0).toString(36)}`;
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

/** Forget what was laid out, so the next pass rebuilds from nothing. */
export function resetGraphLayoutState(): void {
	lastMembership = '';
}

/**
 * Recompute communities and positions for the live graph.
 *
 * Never throws: a missing arrangement costs the client a seeded layout of its
 * own, which is what it used to do for everything, so a failure here degrades to
 * the previous behaviour instead of breaking the view.
 */
export async function runGraphLayout(): Promise<void> {
	if (running) {
		rerunRequested = true;
		return;
	}
	running = true;

	try {
		// Rank-ordered, so "the first N" is also "the N the view would have shown".
		const ids = graphLayoutQueries.liveNodeIds(MAX_COMMUNITY_NODES);
		if (ids.length === 0) {
			graphLayoutQueries.clear();
			lastMembership = membershipOf(ids);
			return;
		}

		// Before anything reads the stored arrangement: if a different version of
		// this pass produced it, it is not an arrangement of this graph.
		if (settingsQueries.get(LAYOUT_VERSION_KEY)?.value !== LAYOUT_VERSION) {
			graphLayoutQueries.clear();
			settingsQueries.set(LAYOUT_VERSION_KEY, LAYOUT_VERSION);
			settingsQueries.delete(LEGACY_LAYOUT_KEY);
			lastMembership = '';
			debug.log('memory', 'Memory layout: the pass changed, arranging from scratch');
		}

		const membership = membershipOf(ids);
		// Same nodes as last time and nothing waiting to be placed: the answer is
		// the one already in the table.
		if (membership === lastMembership && !graphLayoutQueries.hasUnplaced()) return;

		const started = Date.now();
		const existing = graphLayoutQueries.read(ids);
		const graph = buildLayoutGraph(ids);

		// Louvain needs at least one edge; an edgeless graph leaves every node in
		// its own community, which is also the honest answer.
		let communities: Record<string, number> = {};
		if (graph.size > 0) {
			try {
				// `rng` is NOT optional here, whatever the signature suggests.
				// graphology-communities-louvain defaults to `Math.random` and walks the
				// graph in random order, so the same store produced different lobes on
				// every pass — and since everything downstream is seeded from the
				// community structure, that alone made the whole map move. A fixed seed
				// keeps the randomised traversal (which is what the algorithm wants)
				// while making the answer reproducible.
				communities = louvain(graph, { getEdgeWeight: 'weight', rng: seededRandom() });
			} catch (error) {
				debug.warn('memory', 'Community detection failed; laying out without lobes', error);
			}
		}

		const simulatedIds = ids.slice(0, MAX_LAYOUT_NODES);
		const simulated = simulatedIds.length === ids.length ? graph : restrictTo(graph, simulatedIds);

		const cold = existing.size === 0;
		const rows = await arrange(simulated, communities, existing, cold);

		// Everything below the simulation cap. It keeps its real community — so the
		// view counts it and groups it correctly — and sits near the members of that
		// community that WERE placed, spread by its own id so a lobe of ten thousand
		// does not become one dot. `placed: 0` tells the view this is a
		// neighbourhood rather than an arrangement.
		if (simulatedIds.length < ids.length) {
			const centroids = new Map<number, { x: number; y: number; count: number }>();
			for (const row of rows) {
				const centroid = centroids.get(row.community) ?? { x: 0, y: 0, count: 0 };
				centroid.x += row.x;
				centroid.y += row.y;
				centroid.count++;
				centroids.set(row.community, centroid);
			}

			for (let i = simulatedIds.length; i < ids.length; i++) {
				const id = ids[i];
				const community = communities[id] ?? 0;
				const centroid = centroids.get(community);
				const anchor = centroid
					? { x: centroid.x / centroid.count, y: centroid.y / centroid.count }
					: { x: 0, y: 0 };
				const radius = centroid ? 40 + 8 * Math.sqrt(centroid.count) : 200;
				const jitter = jitterOf(id);

				rows.push({
					nodeId: id,
					community,
					x: anchor.x + jitter.x * radius,
					y: anchor.y + jitter.y * radius,
					placed: 0
				});
			}
		}

		graphLayoutQueries.writeMany(rows);
		graphLayoutQueries.pruneOrphans();
		lastMembership = membership;

		// Tell open views, or they never learn. The arrangement changes several
		// seconds AFTER the write that triggered it — long after the doorbell for
		// that write has been answered — so without this a modal that was open the
		// whole time keeps drawing positions it computed for itself, and only a
		// close-and-reopen picks up the real ones.
		broadcastGraphChanged('layout');
		debug.log(
			'memory',
			`Laid out ${simulated.order} of ${rows.length} memory node(s) in ${Date.now() - started}ms`
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
 * The graph the simulation runs on: stored edges plus the derived ones.
 *
 * Both are included because the derived edges are most of the structure the
 * episodic half has (see `graphQueries.derivedEdges`) — laying out without them
 * scatters memories that plainly belong together.
 */
function buildLayoutGraph(ids: string[]): Graph {
	const graph = new Graph({ type: 'undirected', multi: false });
	for (const id of ids) graph.addNode(id, { x: 0, y: 0, size: 1 });

	const link = (source: string, target: string, weight: number): void => {
		if (source === target) return;
		if (!graph.hasNode(source) || !graph.hasNode(target)) return;
		if (graph.hasEdge(source, target)) return;
		graph.addUndirectedEdge(source, target, { weight });
	};

	for (const edge of graphQueries.edgesWithin(ids)) link(edge.srcId, edge.dstId, edge.weight);
	for (const edge of graphQueries.derivedEdges(ids)) link(edge.srcId, edge.dstId, edge.weight);

	// ForceAtlas2 reads mass from `size`; a hub that weighs more holds its
	// neighbours' fan open instead of being dragged into the middle of it.
	graph.forEachNode(id => {
		graph.setNodeAttribute(id, 'size', 1 + Math.sqrt(graph.degree(id)));
	});
	return graph;
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
async function arrange(
	simulated: Graph,
	communities: Record<string, number>,
	existing: Map<string, GraphLayoutRow>,
	cold: boolean
): Promise<GraphLayoutRow[]> {
	const components = componentsOf(simulated);
	const singletons: string[] = [];
	const placed: PlacedComponent[] = [];

	for (const member of components) {
		if (member.length === 1) {
			singletons.push(member[0]);
			continue;
		}

		const part = restrictTo(simulated, member);
		// A component that was already on the map keeps its place. Only its interior
		// is re-settled, so a memory arriving in one lobe cannot rearrange the
		// others — the map somebody has learned survives the pass.
		const anchor = existingCentroid(member, existing);
		seedComponent(part, communities, existing, anchor);
		await settle(part, cold || !anchor ? iterationsFor(part.order) : warmIterationsFor(part.order));
		const lobes = spreadCommunities(part, communities);

		placed.push(measure(part, anchor, lobes));
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
				placed: 1
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

	for (const row of placeLoneNodes(singletons, field, communities, existing)) rows.push(row);
	return rows;
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
	const GAP = 0.9;
	const PASSES = 240;
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

	for (let pass = 0; pass < PASSES; pass++) {
		// Over-relaxed early and settling toward an exact correction, for the same
		// reason `packComponents` does it: separating one pair nudges both into
		// their other neighbours.
		const relax = 1.4 - 0.4 * (pass / PASSES);
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
	/** Where it already sat, when it was on the map before this pass. */
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

/** The centroid this component occupied before the pass, if it was on the map. */
function existingCentroid(
	member: string[],
	existing: Map<string, GraphLayoutRow>
): { x: number; y: number } | null {
	let sumX = 0;
	let sumY = 0;
	let count = 0;
	for (const id of member) {
		const previous = existing.get(id);
		if (!previous || previous.placed !== 1) continue;
		sumX += previous.x;
		sumY += previous.y;
		count++;
	}
	return count > 0 ? { x: sumX / count, y: sumY / count } : null;
}

/**
 * Where a component's nodes start, in LOCAL space.
 *
 * Local is what makes gravity harmless: a component sitting far from the origin
 * would otherwise be dragged toward it a little on every pass, and after enough
 * passes every component would have crept into one pile — the disc again, arrived
 * at slowly instead of immediately.
 *
 * Nodes that already had a position keep it, translated into local space, which
 * is what makes successive passes refinements of one arrangement rather than a
 * new arrangement each time.
 */
function seedComponent(
	part: Graph,
	communities: Record<string, number>,
	existing: Map<string, GraphLayoutRow>,
	anchor: { x: number; y: number } | null
): void {
	const meta = communityMetaSeed(part, communities);
	const placedIds = new Set<string>();

	part.forEachNode(id => {
		const previous = existing.get(id);
		if (!previous || previous.placed !== 1 || !anchor) return;
		part.setNodeAttribute(id, 'x', previous.x - anchor.x);
		part.setNodeAttribute(id, 'y', previous.y - anchor.y);
		placedIds.add(id);
	});

	part.forEachNode(id => {
		if (placedIds.has(id)) return;

		// Near whatever it connects to that is already placed — an arriving memory
		// belongs next to its subject, not wherever its community happens to sit.
		let sumX = 0;
		let sumY = 0;
		let count = 0;
		part.forEachNeighbor(id, neighbour => {
			if (!placedIds.has(neighbour)) return;
			sumX += part.getNodeAttribute(neighbour, 'x') as number;
			sumY += part.getNodeAttribute(neighbour, 'y') as number;
			count++;
		});

		const jitter = jitterOf(id);
		if (count > 0) {
			part.setNodeAttribute(id, 'x', sumX / count + jitter.x * 12);
			part.setNodeAttribute(id, 'y', sumY / count + jitter.y * 12);
			return;
		}

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
function measure(part: Graph, anchor: { x: number; y: number } | null, lobes: Disc[]): PlacedComponent {
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
		// An anchored component keeps its old centroid; the drift the settle
		// introduced is absorbed by re-centring rather than accumulating.
		offsetX: anchor ? anchor.x + centreX : 0,
		offsetY: anchor ? anchor.y + centreY : 0,
		anchored: anchor !== null
	};
}

/**
 * Give every unanchored component a place, and separate any that overlap.
 *
 * A store this feature has been running in for any length of time is ONE mass
 * and a handful of stragglers, so the placement is built around that rather than
 * around components being comparable: the largest holds the origin and does not
 * move, the others are put just outside it, and the relaxation pushes apart
 * whatever still collides. The silhouette is then decided by how big the mass is
 * and how many stragglers there are, both of which are properties of the data.
 *
 * Anchored components do not move: they are where the user last saw them.
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
	communities: Record<string, number>,
	existing: Map<string, GraphLayoutRow>
): GraphLayoutRow[] {
	if (singletons.length === 0) return [];

	const rows: GraphLayoutRow[] = [];

	/**
	 * One that was already on the map stays exactly where it was.
	 *
	 * Anchoring these matters more than anchoring components, and measurement is
	 * what showed it: the old free-cell grid was derived from where the components
	 * ended up, so a single memory arriving anywhere reassigned EVERY lone node. A
	 * warm pass moved a hundred of them clear across the map — the one thing a
	 * background pass must never do to a view somebody is reading.
	 */
	const ordered: string[] = [];
	for (const id of [...singletons].sort()) {
		const previous = existing.get(id);
		if (previous && previous.placed === 1) {
			rows.push({
				nodeId: id,
				community: communities[id] ?? 0,
				x: previous.x,
				y: previous.y,
				placed: 1
			});
			continue;
		}
		ordered.push(id);
	}
	if (ordered.length === 0) return rows;

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
				placed: 1
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

		rows.push({ nodeId: id, community: communities[id] ?? 0, x, y, placed: 1 });
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

/** A warm pass only has to absorb what arrived since the last one. */
function warmIterationsFor(order: number): number {
	if (order > 3_000) return 40;
	if (order > 1_500) return 60;
	return 90;
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
