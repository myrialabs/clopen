/**
 * Memory Graph Layout Worker
 *
 * ForceAtlas2 runs here instead of on the page's main thread.
 *
 * The reason is the same one behind the preview decode worker: a force
 * simulation is a per-iteration O(n log n) grind over every node, and on a
 * low-powered machine it competes directly with Svelte reactivity, the chat view
 * and the terminal for one thread. Off-thread, the main thread's only remaining
 * job is handing sigma a fresh set of coordinates.
 *
 * Positions are streamed back in batches as a flat Float32Array (transferred,
 * zero copy) rather than as an object per node, because at a few thousand nodes
 * the structured-clone cost of the object form is itself enough to stutter.
 *
 * ── One phase, deliberately ───────────────────────────────────────────────────
 * This used to run three: spread with plain ForceAtlas2, condense with LinLog,
 * then a pass that pushed community lobes apart as rigid circles. All three
 * survived a long time on the theory that the last two made the grouping legible.
 * They did the opposite, and the reason is that sigma renders with `autoRescale`:
 * positions are normalised to their bounding box before being drawn, so the
 * layout's absolute size is invisible and only the RELATIVE distribution counts.
 *
 * Under that transform, LinLog contracts each group into a ball and the
 * separation pass then inflates the bounding box by shoving the balls apart —
 * which, after normalisation, shrinks every lobe on screen and packs it tighter
 * still. Two passes intended to reveal structure were jointly manufacturing the
 * blobs, and the node sizes on the other side had to fight them.
 *
 * What is left is ForceAtlas2 with hub dissuasion and high repulsion, which is
 * the setup that produces the open, fanned-out look this view wants: leaves
 * radiate off their hub instead of collapsing onto it, and communities end up
 * adjacent because their edges say so rather than because a post-process placed
 * them. Colour carries which lobe is which; the arrangement carries the shape.
 */

import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';

interface StartMessage {
	type: 'start';
	nodes: { id: string; x: number; y: number; degree: number }[];
	edges: { source: string; target: string; weight: number }[];
	/** Total iterations to run. Higher settles more but costs more. */
	iterations: number;
}

interface StopMessage {
	type: 'stop';
}

type Incoming = StartMessage | StopMessage;

/** Iterations per chunk between position emissions — the layout visibly settles. */
const CHUNK = 12;

let cancelled = false;

self.onmessage = (event: MessageEvent<Incoming>) => {
	const message = event.data;

	if (message.type === 'stop') {
		cancelled = true;
		return;
	}

	if (message.type === 'start') {
		cancelled = false;
		run(message);
	}
};

function run(message: StartMessage): void {
	const graph = new Graph({ type: 'undirected', multi: false });

	for (const node of message.nodes) {
		graph.addNode(node.id, { x: node.x, y: node.y, size: 1 + Math.sqrt(node.degree) });
	}
	for (const edge of message.edges) {
		if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
		if (edge.source === edge.target) continue;
		if (graph.hasEdge(edge.source, edge.target)) continue;
		graph.addUndirectedEdge(edge.source, edge.target, { weight: edge.weight });
	}

	const order = graph.order;
	if (order === 0) {
		self.postMessage({ type: 'done' });
		return;
	}

	const inferred = forceAtlas2.inferSettings(graph);

	/**
	 * ONE set of settings, tuned for openness.
	 *
	 * `outboundAttractionDistribution` is the setting that shapes this view more
	 * than any other: it divides attraction by a node's mass, so a hub does not
	 * drag its neighbours onto itself. That is what turns a hub and its forty leaves
	 * into a fan rather than a dot, and fans are most of what makes a large graph
	 * readable at a glance.
	 *
	 * `scalingRatio` is repulsion. It matters less than it looks under sigma's
	 * `autoRescale` — doubling it mostly scales the whole layout up, which the
	 * rescale then undoes — but it does change the BALANCE against attraction, so
	 * higher means longer edges relative to how tightly a group holds together.
	 * 24 was chosen back when a LinLog phase followed and re-contracted everything;
	 * with that gone it left the graph tighter than intended.
	 *
	 * Anti-collision (`adjustSizes`) stays off throughout. It is a local correction
	 * that enforces a minimum spacing from the node sizes, which flattens exactly
	 * the density differences between a busy lobe and a sparse one that the layout
	 * exists to show.
	 */
	const settings = {
		...inferred,
		outboundAttractionDistribution: true,
		// Gravity holds disconnected components in frame; without it they drift off
		// and the user is left panning across empty space.
		//
		// Kept LOW on purpose. Gravity is an isotropic pull toward a single point, so
		// the stronger it is the more every graph converges on the same disc
		// regardless of what its edges say. Together with the ring-shaped seed this
		// used to have (see `seedPosition` in MemoryGraphCanvas) that is why the view
		// always rendered as a circle whatever the data looked like.
		gravity: 0.12,
		scalingRatio: 50,
		adjustSizes: false,
		// Similarity edges carry their cosine as a weight, so letting weight
		// influence attraction means a 0.9 pair sits visibly closer than a 0.4 one —
		// the strength of a relationship becomes a distance the user can read.
		edgeWeightInfluence: 1,
		barnesHutOptimize: order > 500
	};

	// Node order is stable for the lifetime of a run, so positions can be sent as
	// a flat array and re-associated by index on the other side.
	const ids = graph.nodes();
	self.postMessage({ type: 'order', ids });

	let done = 0;
	const step = (): void => {
		if (cancelled) return;

		const iterations = Math.min(CHUNK, message.iterations - done);
		forceAtlas2.assign(graph, { iterations, settings });
		done += iterations;

		const coords = new Float32Array(ids.length * 2);
		for (let i = 0; i < ids.length; i++) {
			const attributes = graph.getNodeAttributes(ids[i]) as { x: number; y: number };
			coords[i * 2] = attributes.x;
			coords[i * 2 + 1] = attributes.y;
		}
		self.postMessage({ type: 'positions', coords }, [coords.buffer]);

		if (done >= message.iterations) {
			self.postMessage({ type: 'done' });
			return;
		}

		// Yield between chunks so a 'stop' message can be delivered — a tight loop
		// would ignore cancellation until the whole layout finished.
		setTimeout(step, 0);
	};

	step();
}
