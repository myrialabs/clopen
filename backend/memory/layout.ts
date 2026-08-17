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
import { broadcastGraphChanged } from './notify';
import { debug } from '$shared/utils/logger';

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

		placed.push(measure(part, anchor));
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

	for (const row of scatterSingletons(singletons, placed, communities, existing)) rows.push(row);
	return rows;
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
function measure(part: Graph, anchor: { x: number; y: number } | null): PlacedComponent {
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
 * The outline this produces is the point. Components are scattered into a box
 * whose AREA follows the total they need and whose aspect is deliberately not
 * square, then pushed apart until they no longer collide — so the silhouette is
 * decided by how many components there are and how big each one is, both of which
 * are properties of the data. Every spiral, ring or fill-outward-from-a-point
 * strategy converges on a disc no matter how its regions are sized; that lesson
 * cost two attempts.
 *
 * Anchored components do not move: they are where the user last saw them.
 */
function packComponents(placed: PlacedComponent[]): void {
	if (placed.length === 0) return;

	const total = placed.reduce((sum, component) => sum + Math.PI * component.radius ** 2, 0);
	/** Air, as a multiple of the area the components themselves occupy. */
	const BREATHING = 2.6;
	/** Wider than tall, so the default outline is not a square either. */
	const ASPECT = 1.45;
	const width = Math.sqrt(total * BREATHING * ASPECT);
	const height = width / ASPECT;

	for (const component of placed) {
		if (component.anchored) continue;
		const jitter = jitterOf(component.ids[0]);
		component.offsetX = (jitter.x * width) / 2;
		component.offsetY = (jitter.y * height) / 2;
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
 * Place the nodes that connect to nothing, in the gaps between what does.
 *
 * These were the ring. A third of the marks on the measured store are lone
 * nodes, and with no edges there is no force to arrange them — so under the old
 * global gravity they all settled at one radius and drew a circle around
 * everything else. Filling the gaps instead removes the ring and puts them where
 * there is room, which is also where the eye is not already busy.
 *
 * The grid is coarse on purpose: it only has to answer "is anything here", and a
 * fine one would cost more than the question is worth.
 */
function scatterSingletons(
	singletons: string[],
	placed: PlacedComponent[],
	communities: Record<string, number>,
	existing: Map<string, GraphLayoutRow>
): GraphLayoutRow[] {
	if (singletons.length === 0) return [];

	const rows: GraphLayoutRow[] = [];

	/**
	 * One that was already on the map stays exactly where it was.
	 *
	 * Anchoring these matters more than anchoring components, and measurement is
	 * what showed it: the free-cell grid is derived from where the components
	 * ended up, so a single memory arriving anywhere changed one component's
	 * radius, which changed the grid, which reassigned EVERY lone node. A warm
	 * pass moved a hundred of them clear across the map — the one thing a
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

	// Nothing else on the map — spread them over a box of their own rather than
	// piling them on the origin.
	if (placed.length === 0) {
		const span = 120 * Math.sqrt(ordered.length);
		for (const id of ordered) {
			const jitter = jitterOf(id);
			rows.push({
				nodeId: id,
				community: communities[id] ?? 0,
				x: jitter.x * span,
				y: (jitter.y * span) / 1.45,
				placed: 1
			});
		}
		return rows;
	}

	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const component of placed) {
		minX = Math.min(minX, component.offsetX - component.radius);
		maxX = Math.max(maxX, component.offsetX + component.radius);
		minY = Math.min(minY, component.offsetY - component.radius);
		maxY = Math.max(maxY, component.offsetY + component.radius);
	}

	// A thin margin, not a ring. At 12% this added a whole outer band of candidate
	// cells, and combined with spreading across every free cell it put the lone
	// nodes OUTSIDE the components — measured, they reached 9,790 wide where the
	// components reached 7,996, which is the ring reappearing one layer out. Just
	// enough air that a tightly packed store still has somewhere to put them.
	const margin = 0.04 * Math.max(maxX - minX, maxY - minY);
	minX -= margin;
	maxX += margin;
	minY -= margin;
	maxY += margin;

	// Roughly four candidate cells per node, which leaves enough free ones to
	// spread across after the occupied ones are struck out.
	const columns = Math.max(4, Math.round(Math.sqrt(ordered.length * 4 * 1.45)));
	const rowsCount = Math.max(4, Math.round(columns / 1.45));
	const cellWidth = (maxX - minX) / columns;
	const cellHeight = (maxY - minY) / rowsCount;

	const free: { x: number; y: number; distance: number }[] = [];
	for (let column = 0; column < columns; column++) {
		for (let row = 0; row < rowsCount; row++) {
			const x = minX + (column + 0.5) * cellWidth;
			const y = minY + (row + 0.5) * cellHeight;

			let occupied = false;
			for (const component of placed) {
				const dx = x - component.offsetX;
				const dy = y - component.offsetY;
				if (dx * dx + dy * dy < component.radius * component.radius) {
					occupied = true;
					break;
				}
			}
			// And the lone nodes already anchored here, so an arrival does not land
			// on top of one that has been sitting there since a previous pass.
			if (!occupied) {
				const reach = Math.min(cellWidth, cellHeight) * 0.5;
				for (const row of rows) {
					if (Math.abs(row.x - x) < reach && Math.abs(row.y - y) < reach) {
						occupied = true;
						break;
					}
				}
			}
			if (occupied) continue;
			free.push({ x, y, distance: Math.hypot(x, y) });
		}
	}

	// Nearest the middle first, so the gaps between the big components fill before
	// the empty edges do — which is what stops them re-forming a ring.
	free.sort((a, b) => a.distance - b.distance || a.x - b.x || a.y - b.y);

	for (let i = 0; i < ordered.length; i++) {
		const id = ordered[i];
		const jitter = jitterOf(id);

		if (free.length === 0) {
			rows.push({
				nodeId: id,
				community: communities[id] ?? 0,
				x: jitter.x * (maxX - minX) * 0.5,
				y: jitter.y * (maxY - minY) * 0.5,
				placed: 1
			});
			continue;
		}

		// NEAREST free cells first while there are enough of them, so the lone nodes
		// fill the gaps between the components rather than reaching for the edge.
		// Spreading across the whole list unconditionally was what sent them to the
		// outermost cells even when the interior had room to spare.
		const cell =
			ordered.length <= free.length
				? free[i]
				: free[Math.floor((i * free.length) / ordered.length)];
		rows.push({
			nodeId: id,
			community: communities[id] ?? 0,
			x: cell.x + jitter.x * cellWidth * 0.4,
			y: cell.y + jitter.y * cellHeight * 0.4,
			placed: 1
		});
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
