/**
 * Graph view assembly for the visualization.
 *
 * Community detection runs HERE, not in the browser. Louvain is O(n log n)-ish
 * but iterative, and running it on the client would compete with the force
 * simulation for the same main thread on exactly the low-powered devices this
 * has to stay usable on. It is also stable per dataset, so computing it server
 * side lets the result be sent once instead of recomputed on every mount.
 *
 * Communities are what make the view legible: each becomes a coloured "lobe", so
 * the clustering the user sees comes out of their own memory's structure rather
 * than being imposed by a layout algorithm.
 */

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { graphQueries } from '$backend/database/queries/graph-queries';
import { debug } from '$shared/utils/logger';
import type {
	GraphNodeKind,
	GraphScope,
	GraphSource,
	GraphView,
	GraphViewEdge,
	GraphViewNode
} from '$shared/types/memory';

/**
 * Nodes sent to the client at once.
 *
 * Beyond a few thousand, a force layout stops communicating structure — it
 * becomes a hairball — and the payload starts costing more than it explains. The
 * cap is reported through `truncated` so the UI can say so rather than implying
 * the graph is smaller than it is.
 */
const MAX_VIEW_NODES = 3_000;

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
	limit?: number;
}

export function buildGraphView(filter: GraphViewFilter): GraphView {
	const limit = Math.min(filter.limit ?? MAX_VIEW_NODES, MAX_VIEW_NODES);

	// `list` orders by pinned, then weight, then recency — so when the cap bites,
	// what survives is what the user reinforced and touched most recently.
	const nodes = graphQueries.list({ ...filter, limit });
	const totalNodes = graphQueries.count(filter);

	if (nodes.length === 0) {
		return { nodes: [], edges: [], totalNodes, truncated: false };
	}

	const ids = nodes.map(n => n.id);
	const stored = graphQueries.edgesWithin(ids);

	// Two memories about the same subject ARE connected, and that connection is
	// stated by extraction rather than inferred from how they are worded. It is
	// derived here rather than stored, so it can never outlive the claim it came
	// from — see `derivedEntityEdges`.
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

	// Undirected for community detection: `about` and `imports` point one way, but
	// whether two nodes belong to the same cluster does not depend on direction,
	// and treating them as directed splits obvious groups in half.
	const graph = new Graph({ type: 'undirected', multi: false });
	for (const node of nodes) graph.addNode(node.id);

	const degree = new Map<string, number>();
	const link = (srcId: string, dstId: string, weight: number): void => {
		degree.set(srcId, (degree.get(srcId) ?? 0) + 1);
		degree.set(dstId, (degree.get(dstId) ?? 0) + 1);
		if (srcId === dstId) return;
		if (!graph.hasNode(srcId) || !graph.hasNode(dstId)) return;
		if (!graph.hasEdge(srcId, dstId)) graph.addUndirectedEdge(srcId, dstId, { weight });
	};
	for (const edge of stored) link(edge.srcId, edge.dstId, edge.weight);
	for (const edge of derived) link(edge.source, edge.target, edge.weight);

	let communities: Record<string, number> = {};
	try {
		// Louvain needs at least one edge; an edgeless graph leaves every node in
		// its own community, which is also the honest answer.
		if (graph.size > 0) {
			communities = louvain(graph, { getEdgeWeight: 'weight' });
		}
	} catch (error) {
		// A failed clustering must not cost the user their graph — the view just
		// renders in one colour.
		debug.warn('memory', 'Community detection failed; rendering without lobes', error);
		communities = {};
	}

	const viewNodes: GraphViewNode[] = nodes.map(node => ({
		id: node.id,
		kind: node.kind,
		subkind: node.subkind,
		scope: node.scope,
		label: node.label,
		projectId: node.projectId,
		degree: degree.get(node.id) ?? 0,
		weight: node.weight,
		pinned: node.pinned,
		community: communities[node.id] ?? 0,
		createdAt: node.createdAt
	}));

	const viewEdges: GraphViewEdge[] = [
		...stored.map(edge => ({
			id: edge.id,
			source: edge.srcId,
			target: edge.dstId,
			rel: edge.rel,
			weight: edge.weight
		})),
		...derived
	];

	return {
		nodes: viewNodes,
		edges: viewEdges,
		totalNodes,
		truncated: totalNodes > nodes.length
	};
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
