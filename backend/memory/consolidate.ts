/**
 * Consolidation — compressing many small memories into fewer large ones.
 *
 * A graph of four hundred observations is less intelligent than a graph of forty
 * principles with four hundred observations hanging under them, even though it
 * contains strictly more text. Retrieval has a fixed budget: eighteen hits, a
 * few thousand characters. Spending that budget on eight variations of one idea
 * is the difference between an agent that knows how this project works and one
 * that gets eight anecdotes.
 *
 * So the graph periodically does what a person does overnight: takes a cluster of
 * related memories and writes down what they have in common. The children are not
 * deleted — they are archived and joined to the summary with `generalizes`, so
 * the evidence for a generalisation is always one hop away and a wrong summary
 * can be undone.
 *
 * This also IS the retention policy for episodic memory. Growth is bounded by
 * compression rather than by deletion, which is the only bound that does not
 * throw information away.
 *
 * It runs on a maintenance timer, never on a path anyone waits on, and it uses
 * the same configured model as extraction. Clusters come from the Louvain
 * communities already computed for the graph view, so the grouping the user sees
 * as coloured lobes is the grouping that gets consolidated.
 */

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { graphQueries } from '$backend/database/queries/graph-queries';
import { initializeEngine } from '$backend/engine';
import { resolveGenerationTarget } from '$backend/engine/resolve-model';
import { debug } from '$shared/utils/logger';
import { getMemoryConfig, type MemoryModelConfig } from './config';
import { notifyGraphChanged } from './notify';
import { redactSecrets } from './redact';
import { ageInDays } from './time';
import type { EpisodicSubkind, GraphNode } from '$shared/types/memory';

/**
 * Fewest memories a cluster needs before summarising it is worth a model call.
 * Below this the summary tends to be longer than the memories it replaces.
 */
const MIN_CLUSTER = 6;

/** Most memories fed into one summary, to keep the prompt bounded. */
const MAX_CLUSTER = 24;

/** Clusters consolidated per maintenance pass. */
const MAX_CLUSTERS_PER_RUN = 3;

/**
 * Age a memory must reach before it can be consolidated.
 *
 * Recent memories are still being used as memories. Summarising something
 * written this morning would remove the detail from exactly the sessions most
 * likely to need it, which is the opposite of the intent.
 */
const MIN_AGE_DAYS = 7;

const SUMMARY_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		worthSummarising: {
			type: 'boolean',
			description:
				'False when the memories below have no common thread and forcing one would invent a claim none of them make.'
		},
		subkind: {
			type: 'string',
			enum: ['decision', 'pattern', 'failure', 'preference', 'observation'],
			description: 'The kind of the consolidated memory. Usually pattern.'
		},
		label: {
			type: 'string',
			description:
				'MUST BE IN ENGLISH. One sentence stating what all of these memories share, specific enough to be useful on its own. Max 160 characters.'
		},
		body: {
			type: 'string',
			description:
				'MUST BE IN ENGLISH. The generalisation: what holds across these, what it rules out, where it does not apply. Three or four sentences.'
		},
		/**
		 * Not every member of a Louvain community belongs to the same idea —
		 * communities are a structural clustering, not a semantic one — so the model
		 * says which ones it actually summarised. The rest are left alone.
		 */
		coveredIds: {
			type: 'array',
			description: 'Ids of the memories this summary genuinely covers. Omit any that do not fit.',
			items: { type: 'string' }
		}
	},
	required: ['worthSummarising', 'subkind', 'label', 'body', 'coveredIds']
};

interface Summary {
	worthSummarising: boolean;
	subkind: EpisodicSubkind;
	label: string;
	body: string;
	coveredIds: string[];
}

export interface ConsolidationResult {
	clusters: number;
	summaries: number;
	archived: number;
}

/**
 * Find dense clusters of consolidatable memories and summarise them.
 *
 * Never throws. Returns what it did, for the log and for tests.
 */
export async function consolidateMemories(projectId: string | null, projectPath: string): Promise<ConsolidationResult> {
	const result: ConsolidationResult = { clusters: 0, summaries: 0, archived: 0 };

	const config = getMemoryConfig();
	if (!config.enabled || !config.recordMemories || !config.model) return result;

	try {
		const clusters = findClusters(projectId);
		result.clusters = clusters.length;

		for (const cluster of clusters.slice(0, MAX_CLUSTERS_PER_RUN)) {
			const summary = await summarise(config.model, cluster, projectPath);
			if (!summary?.worthSummarising || !summary.label?.trim()) continue;

			// Only members the model said it covered, and only ones that were really
			// in the cluster — an id from outside it was not summarised by anything.
			const clusterIds = new Set(cluster.map(node => node.id));
			const covered = cluster.filter(node => summary.coveredIds?.includes(node.id) && clusterIds.has(node.id));
			if (covered.length < MIN_CLUSTER) continue;

			const node = graphQueries.upsert({
				kind: 'episodic',
				subkind: summary.subkind,
				scope: projectId ? 'project' : 'global',
				projectId,
				label: summary.label.trim().slice(0, 300),
				body: summary.body.trim(),
				// A generalisation is only as good as its evidence, and it was inferred
				// rather than stated, so it starts below the memories it summarises.
				confidence: 0.65,
				source: 'agent'
			});
			result.summaries++;

			for (const child of covered) {
				// The edge is written BEFORE the archive, so a crash between the two
				// leaves the evidence attached rather than orphaned.
				graphQueries.link({ srcId: node.id, dstId: child.id, rel: 'generalizes', source: 'agent' });
				graphQueries.archive(child.id);
				result.archived++;
			}
		}

		if (result.summaries > 0) {
			notifyGraphChanged('consolidation', projectId);
			debug.log(
				'memory',
				`Consolidated ${result.archived} memory/memories into ${result.summaries} generalisation(s)`
			);
		}
	} catch (error) {
		debug.warn('memory', 'Consolidation failed (non-fatal)', error);
	}

	return result;
}

/**
 * Groups of related memories, from the same Louvain communities the graph view
 * renders as lobes.
 *
 * Pinned, user-authored and entity nodes are excluded before clustering rather
 * than after: they must never be archived into a summary, and leaving them in
 * would let them shape a cluster they cannot be part of.
 */
function findClusters(projectId: string | null): GraphNode[][] {
	const nodes = graphQueries
		.list({ projectId, kinds: ['episodic'], limit: 2_000 })
		.filter(
			node =>
				node.source === 'agent' &&
				!node.pinned &&
				!node.entityKey &&
				// Already a generalisation, or old enough to become part of one.
				ageInDays(node.updatedAt) >= MIN_AGE_DAYS
		);

	if (nodes.length < MIN_CLUSTER) return [];

	const ids = new Set(nodes.map(node => node.id));
	const graph = new Graph({ type: 'undirected', multi: false });
	for (const node of nodes) graph.addNode(node.id);

	for (const edge of graphQueries.edgesWithin([...ids])) {
		if (edge.srcId === edge.dstId) continue;
		if (!ids.has(edge.srcId) || !ids.has(edge.dstId)) continue;
		if (!graph.hasEdge(edge.srcId, edge.dstId)) {
			graph.addUndirectedEdge(edge.srcId, edge.dstId, { weight: edge.weight });
		}
	}

	// No edges means no clusters. That is a graph where similarity linking has not
	// run yet, and consolidating it would be guessing.
	if (graph.size === 0) return [];

	let communities: Record<string, number>;
	try {
		communities = louvain(graph, { getEdgeWeight: 'weight' });
	} catch (error) {
		debug.warn('memory', 'Clustering for consolidation failed', error);
		return [];
	}

	const byCommunity = new Map<number, GraphNode[]>();
	const nodeById = new Map(nodes.map(node => [node.id, node]));
	for (const [id, community] of Object.entries(communities)) {
		const node = nodeById.get(id);
		if (!node) continue;
		const bucket = byCommunity.get(community) ?? [];
		bucket.push(node);
		byCommunity.set(community, bucket);
	}

	return [...byCommunity.values()]
		.filter(bucket => bucket.length >= MIN_CLUSTER)
		// Densest first: a large cluster is where the redundancy is.
		.sort((a, b) => b.length - a.length)
		.map(bucket => bucket.slice(0, MAX_CLUSTER));
}

async function summarise(
	model: MemoryModelConfig,
	cluster: GraphNode[],
	projectPath: string
): Promise<Summary | null> {
	const listing = cluster
		.map(node => `- [${node.id}] (${node.subkind}) ${node.label}${node.body ? ` — ${node.body.split('\n')[0].slice(0, 200)}` : ''}`)
		.join('\n');

	// The memories were redacted on the way in, but a summary is a new durable
	// artifact and this is the last point before it is written.
	const prompt = redactSecrets(`You maintain a long-term memory. Below is a cluster of memories that the graph has found to be related.

Write ONE memory that states what they have in common — the principle, convention or conclusion they are all instances of. It replaces them in day-to-day recall, so it has to carry the useful content of the group, not merely name the topic.

WRITE IN ENGLISH, both label and body.

Set worthSummarising to false if these memories do not actually share a thread. Inventing a generalisation that none of them supports is far worse than leaving them as they are — they would be archived behind a claim that is not true.

List in coveredIds only the memories your summary genuinely covers. Anything that does not fit stays as it is.

Memories:
${listing}`).text;

	try {
		const engine = await initializeEngine(model.engine);
		if (!engine.generateStructured) return null;

		const target = await resolveGenerationTarget(engine, model.modelId, model.providerSlug);
		const accountId = model.accountId ?? target.accountId;

		return await engine.generateStructured<Summary>({
			prompt,
			providerSlug: target.providerSlug,
			modelId: target.modelId,
			schema: SUMMARY_SCHEMA,
			projectPath,
			...(accountId != null && { accountId })
		});
	} catch (error) {
		debug.warn('memory', 'Cluster summary failed', error);
		return null;
	}
}
