/**
 * Memory Graph handlers (the Memory modal + Settings → Infrastructure → Memory).
 *
 *   - memory:graph        — nodes/edges for the visualization, with communities
 *   - memory:node         — one node plus its neighbourhood, for the inspector
 *   - memory:search       — hybrid retrieval, the same path agents use
 *   - memory:stats        — size and composition
 *   - memory:save-node    — edit a memory's summary, reasoning or kind
 *   - memory:draft-node / memory:create-node     — write one by hand
 *   - memory:archive-node / memory:restore-nodes — "forget" and undo it
 *   - memory:forgotten / memory:delete-nodes / memory:purge
 *   - memory:status / memory:retry-failed
 *   - memory:config / memory:save-config
 *
 * Reads are open to any authenticated user, because the graph is what explains
 * the project to whoever is working on it. Mutations are admin-gated in
 * `backend/auth/permissions.ts`, matching skills / mcp_servers / subagents:
 * memory is instance-global, so one member editing it changes what every agent
 * is told on every future turn.
 */

import { t } from 'elysia';
import { createRouter, type WSConnection } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { projectContextService } from '$backend/mcp/internal/project-context';
import { debug } from '$shared/utils/logger';
import { graphQueries } from '$backend/database/queries/graph-queries';
import { buildGraphView, buildNodeDetail } from '$backend/memory/view';
import { markConsulted, retrieve } from '$backend/memory/retrieval';
import { scheduleVectorIndexing } from '$backend/memory/indexer';
import { getMemoryConfig, setMemoryConfig } from '$backend/memory/config';
import { notifyGraphChanged, notifyMemoryStatus } from '$backend/memory/notify';
import { memoryQueueQueries } from '$backend/database/queries/memory-queue-queries';
import { runningExtractions, startExtractionRunner } from '$backend/memory/extract';
import { createMemory, draftMemory } from '$backend/memory/compose';
import { resetGraphEmptiness } from '$backend/memory/context';
import { getMemoryReadiness } from '$backend/memory/readiness';
import { reconcileVectorIndex } from '$backend/memory/indexer';
import { ensureEmbeddingArtifact, embedder, vectorCache } from '$backend/memory/embedding';
import type { EngineType } from '$shared/types/unified';
import type { GraphNodeKind, GraphScope, GraphSource } from '$shared/types/memory';

const KIND = t.Union([t.Literal('episodic'), t.Literal('structural')]);
const SCOPE = t.Union([t.Literal('session'), t.Literal('project'), t.Literal('global')]);
const SOURCE = t.Union([t.Literal('agent'), t.Literal('user')]);
const EPISODIC_SUBKIND = t.Union([
	t.Literal('decision'),
	t.Literal('pattern'),
	t.Literal('failure'),
	t.Literal('preference'),
	t.Literal('observation'),
	t.Literal('entity')
]);

const NODE = t.Object({
	id: t.String(),
	kind: t.String(),
	subkind: t.String(),
	scope: t.String(),
	projectId: t.Union([t.String(), t.Null()]),
	sessionId: t.Union([t.String(), t.Null()]),
	label: t.String(),
	body: t.String(),
	path: t.Union([t.String(), t.Null()]),
	symbol: t.Union([t.String(), t.Null()]),
	language: t.Union([t.String(), t.Null()]),
	digest: t.String(),
	confidence: t.Number(),
	weight: t.Number(),
	accessCount: t.Number(),
	source: t.String(),
	assertedBy: t.String(),
	reach: t.String(),
	reachJudged: t.Boolean(),
	pinned: t.Boolean(),
	archivedAt: t.Union([t.String(), t.Null()]),
	createdAt: t.String(),
	updatedAt: t.String(),
	accessedAt: t.Union([t.String(), t.Null()]),
	supersededBy: t.Union([t.String(), t.Null()]),
	usefulCount: t.Number(),
	unhelpfulCount: t.Number(),
	staleAt: t.Union([t.String(), t.Null()]),
	entityKey: t.Union([t.String(), t.Null()])
});

const MEMORY_MODEL = t.Object({
	engine: t.String(),
	providerSlug: t.Optional(t.String()),
	modelId: t.String(),
	accountId: t.Optional(t.Number())
});

const CONFIG = t.Object({
	enabled: t.Boolean(),
	recordCode: t.Boolean(),
	recordMemories: t.Boolean(),
	autoRecall: t.Boolean(),
	model: t.Union([MEMORY_MODEL, t.Null()])
});

/** Mirrors `MemoryReadiness`; see backend/memory/readiness.ts for why the two
 * halves have different prerequisites. */
const READINESS = t.Object({
	enabled: t.Boolean(),
	canRecall: t.Boolean(),
	canRecord: t.Boolean(),
	setupRequired: t.Boolean(),
	blockers: t.Array(t.Union([t.Literal('embedding'), t.Literal('model')])),
	embedding: t.Object({
		ready: t.Boolean(),
		phase: t.Union([
			t.Literal('idle'),
			t.Literal('downloading'),
			t.Literal('installed'),
			t.Literal('waiting'),
			t.Literal('failed')
		]),
		attempts: t.Number(),
		error: t.Union([t.String(), t.Null()]),
		failure: t.Union([
			t.Literal('network'),
			t.Literal('corrupt'),
			t.Literal('unpublished'),
			t.Null()
		]),
		permanent: t.Boolean(),
		nextAttemptAt: t.Union([t.String(), t.Null()]),
		receivedBytes: t.Number(),
		totalBytes: t.Number()
	}),
	model: t.Object({
		configured: t.Boolean(),
		engine: t.Union([t.String(), t.Null()]),
		modelId: t.Union([t.String(), t.Null()])
	})
});

/**
 * How the modal's project multi-select reaches a query.
 *
 * `projectIds` is tri-state on the wire and each state means something
 * different: ABSENT is "every project" (the cross-project view), an EMPTY array
 * is "global only" — nothing selected is a narrowing, not the absence of one —
 * and a non-empty array is those projects plus the globals that apply inside
 * every one of them.
 *
 * Cross-project is admin-only. Reads are otherwise open, because the graph is
 * what explains a project to whoever is working on it and withholding that would
 * defeat the feature. But "every project at once" is a different request: memory
 * is instance-global, so it would show a member everything every other team has
 * ever worked on, including repositories they have no access to. Narrowing to
 * the caller's current project is the honest degradation — they still see
 * everything that applies where they are, plus the globals.
 *
 * Mutations are gated separately, in `backend/auth/permissions.ts`.
 */
function scopeForRole(conn: WSConnection, requested: string[] | undefined): string[] | undefined {
	if (requested !== undefined) return requested;
	if (ws.getRole(conn) === 'admin') return undefined;

	const current = projectContextService.getCurrentProjectId();
	debug.log('path', 'memory: cross-project read narrowed to current project (not admin)');
	// No project selected and not an admin: global-scope memories only, which an
	// empty selection already means.
	return current ? [current] : [];
}

export const memoryCrudHandler = createRouter()
	.http('memory:graph', {
		data: t.Object({
			projectIds: t.Optional(t.Array(t.String())),
			kinds: t.Optional(t.Array(KIND)),
			subkinds: t.Optional(t.Array(t.String())),
			scopes: t.Optional(t.Array(SCOPE)),
			sources: t.Optional(t.Array(SOURCE)),
			includeArchived: t.Optional(t.Boolean()),
			includeSuperseded: t.Optional(t.Boolean()),
			limit: t.Optional(t.Number())
		}),
		response: t.Object({
			nodes: t.Array(t.Object({
				id: t.String(),
				kind: t.String(),
				subkind: t.String(),
				scope: t.String(),
				label: t.String(),
				projectId: t.Union([t.String(), t.Null()]),
				degree: t.Number(),
				weight: t.Number(),
				pinned: t.Boolean(),
				community: t.Number(),
				createdAt: t.String()
			})),
			edges: t.Array(t.Object({
				id: t.Number(),
				source: t.String(),
				target: t.String(),
				rel: t.String(),
				weight: t.Number()
			})),
			totalNodes: t.Number(),
			truncated: t.Boolean()
		})
	}, async ({ conn, data }) => {
		debug.log('path', 'memory:graph');
		return buildGraphView({
			projectIds: scopeForRole(conn, data.projectIds),
			kinds: data.kinds as GraphNodeKind[] | undefined,
			subkinds: data.subkinds,
			scopes: data.scopes as GraphScope[] | undefined,
			sources: data.sources as GraphSource[] | undefined,
			includeArchived: data.includeArchived,
			includeSuperseded: data.includeSuperseded,
			limit: data.limit
		});
	})
	.http('memory:node', {
		data: t.Object({ nodeId: t.String(), hops: t.Optional(t.Number()) }),
		response: t.Object({
			node: t.Union([NODE, t.Null()]),
			neighbours: t.Array(t.Object({ node: NODE, hops: t.Number() }))
		})
	}, async ({ data }) => {
		debug.log('path', `memory:node ${data.nodeId}`);
		const detail = buildNodeDetail(data.nodeId, data.hops ?? 1);
		return detail ?? { node: null, neighbours: [] };
	})
	.http('memory:search', {
		data: t.Object({
			query: t.String(),
			projectIds: t.Optional(t.Array(t.String())),
			kinds: t.Optional(t.Array(KIND)),
			subkinds: t.Optional(t.Array(t.String())),
			sources: t.Optional(t.Array(SOURCE)),
			limit: t.Optional(t.Number()),
			includeArchived: t.Optional(t.Boolean()),
			includeSuperseded: t.Optional(t.Boolean())
		}),
		response: t.Object({
			hits: t.Array(t.Object({
				node: NODE,
				score: t.Number(),
				channel: t.String(),
				lexicalRank: t.Union([t.Number(), t.Null()]),
				vectorRank: t.Union([t.Number(), t.Null()]),
				hops: t.Number(),
				snippet: t.Union([t.String(), t.Null()])
			})),
			vectorUsed: t.Boolean(),
			elapsedMs: t.Number(),
			profile: t.Object({
				shape: t.String(),
				lexicalWeight: t.Number(),
				vectorWeight: t.Number()
			})
		})
	}, async ({ conn, data }) => {
		debug.log('path', 'memory:search');
		const result = retrieve({
			query: data.query,
			projectIds: scopeForRole(conn, data.projectIds),
			kinds: data.kinds as GraphNodeKind[] | undefined,
			subkinds: data.subkinds,
			sources: data.sources as GraphSource[] | undefined,
			limit: data.limit ?? 20,
			includeArchived: data.includeArchived,
			includeSuperseded: data.includeSuperseded,
			// A typed query is answered with what MATCHES it, not with what matches
			// it plus everything one edge away. Expansion is right for turn-start
			// injection — the useful memory is often adjacent to the match — and
			// wrong here: a user searching "phoenix" was being shown memories about
			// calculators, because a neighbour of a neighbour had been dragged in.
			expandHops: 0,
			// And the vector channel has to earn its rows rather than admit any
			// positive cosine. See `RetrievalOptions.precise`.
			precise: true
		});
		// A person typing a query is deliberately consulting memory, so it counts —
		// unlike the automatic turn-start injection, which retrieves on every turn
		// and would otherwise be measuring itself.
		markConsulted(result.hits);
		return result;
	})
	.http('memory:stats', {
		data: t.Object({}),
		response: t.Object({
			nodes: t.Number(),
			edges: t.Number(),
			episodic: t.Number(),
			structural: t.Number(),
			vectors: t.Number(),
			byScope: t.Object({ session: t.Number(), project: t.Number(), global: t.Number() }),
			byProject: t.Array(t.Object({ projectId: t.Union([t.String(), t.Null()]), count: t.Number() })),
			superseded: t.Number(),
			stale: t.Number(),
			entities: t.Number(),
			confirmedUseful: t.Number(),
			forgotten: t.Number(),
			embedding: t.Object({
				ready: t.Boolean(),
				installed: t.Boolean(),
				version: t.Union([t.String(), t.Null()]),
				dim: t.Union([t.Number(), t.Null()]),
				rows: t.Union([t.Number(), t.Null()]),
				error: t.Union([t.String(), t.Null()])
			})
		})
	}, async () => {
		debug.log('path', 'memory:stats');
		return { ...graphQueries.stats(), embedding: embedder.status() };
	})
	.http('memory:save-node', {
		data: t.Object({
			nodeId: t.String(),
			label: t.Optional(t.String()),
			body: t.Optional(t.String()),
			subkind: t.Optional(t.String())
		}),
		response: t.Object({ node: t.Union([NODE, t.Null()]) })
	}, async ({ data }) => {
		debug.log('path', `memory:save-node ${data.nodeId}`);
		const node = graphQueries.update(
			data.nodeId,
			{
				...(data.label !== undefined && { label: data.label }),
				...(data.body !== undefined && { body: data.body }),
				...(data.subkind !== undefined && { subkind: data.subkind as never })
			},
			// A person typed this, which is what exempts the node from decay and from
			// every automatic removal.
			'user'
		);
		// The edit changed the text a vector describes, so `update` dropped it —
		// ask for a fresh one rather than leaving the node semantically stale.
		if (node) {
			vectorCache.drop([node.id]);
			scheduleVectorIndexing();
			notifyGraphChanged('edited', node.projectId);
		}
		return { node };
	})
	.http('memory:archive-node', {
		data: t.Object({ nodeId: t.String() }),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data }) => {
		debug.log('path', `memory:archive-node ${data.nodeId}`);
		graphQueries.archive(data.nodeId);
		resetGraphEmptiness();
		notifyGraphChanged('forgotten');
		return { success: true };
	})
	/**
	 * Bring memories back into recall — one, or a selection.
	 *
	 * Restores BOTH kinds of "no longer recalled". Archiving says "this was never
	 * true"; superseding says "something newer replaced it", and that second
	 * judgement was made automatically, by a model reading a transcript. Leaving
	 * it as the one thing the user could not undo would have meant their only
	 * recourse against a wrong revision was permanent deletion — which is how
	 * "reversible" ends up being a property of the schema rather than of the
	 * product.
	 */
	.http('memory:restore-nodes', {
		data: t.Object({ nodeIds: t.Array(t.String()) }),
		response: t.Object({ restored: t.Number() })
	}, async ({ data }) => {
		debug.log('path', `memory:restore-nodes (${data.nodeIds.length})`);
		const restored = graphQueries.restoreNodes(data.nodeIds);
		if (restored > 0) {
			scheduleVectorIndexing();
			resetGraphEmptiness();
			notifyGraphChanged('restored');
		}
		return { restored };
	})
	/**
	 * Shape free text into a memory, for review before anything is stored.
	 *
	 * Returns a draft rather than saving, because what the user types is one field
	 * and what the graph stores is six. Filling the other five without showing the
	 * result would mean a store whose contents nobody had read — and this is the
	 * one write path where a person is present to read them.
	 */
	.http('memory:draft-node', {
		data: t.Object({
			text: t.String(),
			projectId: t.Optional(t.String()),
			/** False to skip the model entirely and keep the text as written. */
			structure: t.Optional(t.Boolean())
		}),
		response: t.Object({
			draft: t.Union([
				t.Object({
					subkind: t.String(),
					scope: t.String(),
					label: t.String(),
					body: t.String(),
					entities: t.Array(t.String()),
					relatedPaths: t.Array(t.String()),
					structured: t.Boolean(),
					duplicateOf: t.Union([
						t.Object({ id: t.String(), label: t.String(), score: t.Number() }),
						t.Null()
					]),
					note: t.Union([t.String(), t.Null()])
				}),
				t.Null()
			])
		})
	}, async ({ data }) => {
		debug.log('path', 'memory:draft-node');
		const draft = await draftMemory({
			text: data.text,
			projectId: data.projectId || projectContextService.getCurrentProjectId(),
			...(data.structure !== undefined && { structure: data.structure })
		});
		return { draft };
	})
	/** Store a reviewed draft. Always `source: 'user'`. */
	.http('memory:create-node', {
		data: t.Object({
			subkind: EPISODIC_SUBKIND,
			scope: t.Union([t.Literal('project'), t.Literal('global')]),
			label: t.String(),
			body: t.String(),
			entities: t.Optional(t.Array(t.String())),
			relatedPaths: t.Optional(t.Array(t.String())),
			projectId: t.Optional(t.String()),
			pinned: t.Optional(t.Boolean()),
			reinforceId: t.Optional(t.String())
		}),
		response: t.Object({ node: t.Union([NODE, t.Null()]) })
	}, async ({ data }) => {
		debug.log('path', 'memory:create-node');
		const node = createMemory({
			subkind: data.subkind,
			scope: data.scope,
			label: data.label,
			body: data.body,
			entities: data.entities ?? [],
			relatedPaths: data.relatedPaths ?? [],
			projectId: data.projectId || projectContextService.getCurrentProjectId(),
			pinned: data.pinned ?? false,
			reinforceId: data.reinforceId ?? null
		});
		return { node };
	})



	/**
	 * The forgotten list: memories that have been archived or superseded.
	 *
	 * Soft delete was always meant to be reviewable, but with nothing to review it
	 * with, "reversible" was a property of the schema rather than of the product.
	 * Archived and superseded are shown together because from here they are one
	 * category — "no longer recalled" — even though the graph keeps the distinction
	 * between "was never true" and "is no longer true", which the row still states.
	 */
	/**
	 * What the extraction queue is doing.
	 *
	 * Open to any member, because it answers "is memory working right now", and a
	 * user watching the graph fail to grow deserves an answer whether or not they
	 * can change the setting that fixes it.
	 */
	.http('memory:status', {
		data: t.Object({}),
		response: t.Object({
			pending: t.Number(),
			retrying: t.Number(),
			failed: t.Number(),
			running: t.Number(),
			nextAttemptAt: t.Union([t.String(), t.Null()]),
			lastError: t.Union([t.String(), t.Null()]),
			modelConfigured: t.Boolean()
		})
	}, async () => {
		return {
			...memoryQueueQueries.status(),
			running: runningExtractions(),
			modelConfigured: getMemoryConfig().model !== null
		};
	})
	/**
	 * Whether memory can actually recall and record, and what is missing.
	 *
	 * Separate from `memory:status`, which reports the extraction QUEUE. This one
	 * answers "is the feature usable at all", which is what the setup banner needs
	 * and what nothing could answer before: a user whose artifact never downloaded
	 * saw an empty graph and no explanation for it.
	 */
	.http('memory:readiness', {
		data: t.Object({}),
		response: READINESS
	}, async () => {
		return getMemoryReadiness();
	})
	/**
	 * Install the embedding artifact now.
	 *
	 * Forces a restart of a schedule that has given up — a checksum mismatch and an
	 * unpublished release both stop deliberately, and a user who has fixed either
	 * (upgraded, or come back online after a proxy mangled the download) has no
	 * other way to say so.
	 */
	.http('memory:install-embedding', {
		data: t.Object({}),
		response: READINESS
	}, async () => {
		debug.log('memory', 'Embedding artifact install requested');
		await ensureEmbeddingArtifact(true);
		// Vectors for everything recorded while recall was unavailable.
		if (embedder.status().ready) void reconcileVectorIndex();
		return getMemoryReadiness();
	})
	/**
	 * Put every failed extraction back in the queue.
	 *
	 * Exists because the usual cause of exhaustion is something the user has just
	 * fixed — chosen a model, re-authenticated an account, restarted an engine —
	 * and waiting for a server restart to find that out is a poor answer.
	 */
	.http('memory:retry-failed', {
		data: t.Object({}),
		response: t.Object({ requeued: t.Number() })
	}, async () => {
		const requeued = memoryQueueQueries.retryFailed();
		debug.log('memory', `Re-queued ${requeued} failed extraction(s) on request`);
		if (requeued > 0) {
			startExtractionRunner();
			notifyMemoryStatus();
		}
		return { requeued };
	})
	.http('memory:forgotten', {
		data: t.Object({
			projectIds: t.Optional(t.Array(t.String())),
			limit: t.Optional(t.Number()),
			offset: t.Optional(t.Number())
		}),
		response: t.Object({
			nodes: t.Array(NODE),
			total: t.Number()
		})
	}, async ({ conn, data }) => {
		debug.log('path', 'memory:forgotten');
		const projectIds = scopeForRole(conn, data.projectIds);
		return {
			nodes: graphQueries.listArchived({
				projectIds,
				limit: Math.min(data.limit ?? 200, 500),
				offset: data.offset ?? 0
			}),
			total: graphQueries.countArchived({ projectIds })
		};
	})
	/**
	 * Permanently delete specific memories. Reached only from the forgotten list,
	 * so everything it touches has already been archived once — two deliberate
	 * decisions rather than one.
	 */
	.http('memory:delete-nodes', {
		data: t.Object({ nodeIds: t.Array(t.String()) }),
		response: t.Object({ deleted: t.Number() })
	}, async ({ data }) => {
		debug.log('path', `memory:delete-nodes (${data.nodeIds.length})`);
		const deleted = graphQueries.deleteNodes(data.nodeIds);
		if (deleted > 0) {
			vectorCache.drop(data.nodeIds);
			resetGraphEmptiness();
			notifyGraphChanged('deleted');
		}
		return { deleted };
	})
	/**
	 * Delete every memory in one project, or in the whole instance.
	 *
	 * `projectIds` absent means EVERYTHING, including the global memories that
	 * belong to the user rather than to any repository — which is why the two are
	 * separate actions in the UI rather than one control with a checkbox. A project
	 * purge deliberately leaves globals alone: preferences and conventions were
	 * never that project's to hold.
	 */
	.http('memory:purge', {
		data: t.Object({ projectIds: t.Optional(t.Array(t.String())) }),
		response: t.Object({ nodes: t.Number(), edges: t.Number() })
	}, async ({ data }) => {
		debug.log(
			'path',
			`memory:purge ${data.projectIds === undefined ? 'EVERYTHING' : `${data.projectIds.length} project(s)`}`
		);

		const result = graphQueries.purge(data.projectIds);
		// The cache is holding vectors for rows that no longer exist, and injection
		// may now be looking at an empty graph.
		vectorCache.reset();
		resetGraphEmptiness();
		notifyGraphChanged('purged', data.projectIds?.[0] ?? null);
		debug.log('memory', `Purged ${result.nodes} node(s) and ${result.edges} edge(s)`);
		return result;
	})
	.http('memory:config', {
		data: t.Object({}),
		response: CONFIG
	}, async () => {
		debug.log('path', 'memory:config');
		return getMemoryConfig();
	})
	.http('memory:save-config', {
		data: t.Object({
			enabled: t.Optional(t.Boolean()),
			recordCode: t.Optional(t.Boolean()),
			recordMemories: t.Optional(t.Boolean()),
			autoRecall: t.Optional(t.Boolean()),
			model: t.Optional(t.Union([MEMORY_MODEL, t.Null()]))
		}),
		response: CONFIG
	}, async ({ data }) => {
		debug.log('path', 'memory:save-config');
		return setMemoryConfig({
			...(data.enabled !== undefined && { enabled: data.enabled }),
			...(data.recordCode !== undefined && { recordCode: data.recordCode }),
			...(data.recordMemories !== undefined && { recordMemories: data.recordMemories }),
			...(data.autoRecall !== undefined && { autoRecall: data.autoRecall }),
			...(data.model !== undefined && {
				model: data.model ? { ...data.model, engine: data.model.engine as EngineType } : null
			})
		});
	});
