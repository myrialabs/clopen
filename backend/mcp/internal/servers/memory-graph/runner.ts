/**
 * Memory Graph tool runner.
 *
 * Executes a batch of operations in order and renders one report. Unlike the
 * browser server, an operation here never mutates something the next operation
 * depends on physically, so there is no coalescing or re-resolution — but the
 * batch still runs sequentially, because `remember` followed by `link` is a
 * common pair and the second needs the first's id.
 *
 * Project context is OPTIONAL by design. Every other internal MCP server can
 * assume a project (a browser belongs to one), but the graph deliberately cannot:
 * a global-scope question — "what does the user prefer", "which project handles
 * auth" — has to be answerable before any project is selected. That is the shape
 * cross-project chat needs, so `projectId` being null is a normal case here, not
 * an error.
 */

import { z } from 'zod';
import { graphQueries } from '$backend/database/queries/graph-queries';
import { projectContextService } from '$backend/mcp/internal/project-context';
import { markConsulted, retrieve } from '$backend/memory/retrieval';
import { scheduleVectorIndexing } from '$backend/memory/indexer';
import { getMemoryConfig } from '$backend/memory/config';
import { notifyGraphChanged } from '$backend/memory/notify';
import { getMemoryReadiness } from '$backend/memory/readiness';
import { embedder, vectorCache } from '$backend/memory/embedding';
import { debug } from '$shared/utils/logger';
import type { GraphNode, GraphRelation, RetrievalHit } from '$shared/types/memory';
import type { memorySchema } from './schema';

type Operation = z.infer<typeof memorySchema>;

export interface OperationReport {
	action: string;
	ok: boolean;
	text: string;
}

export interface RunReport {
	operations: OperationReport[];
	projectScoped: boolean;
	vectorSearchAvailable: boolean;
}

/** Where the batch is running: a project and session when one is in play. */
interface Context {
	projectId: string | null;
	sessionId: string | null;
}

function resolveContext(): Context {
	return {
		projectId: projectContextService.getCurrentProjectId(),
		sessionId: projectContextService.getCurrentChatSessionId()
	};
}

/** One line per hit: enough to act on, compact enough to batch. */
function renderHit(hit: RetrievalHit, currentProjectId: string | null): string {
	const node = hit.node;
	const found = hit.hops > 0 ? `via graph, ${hit.hops} hop${hit.hops > 1 ? 's' : ''}` : hit.channel;
	// Where it came from, not what its scope value is. A memory learned in another
	// repository is worth acting on when it is about a technology and misleading
	// when read as a description of THIS codebase, and the agent can only tell the
	// difference if it is told.
	const where =
		node.projectId === null
			? 'any project'
			: node.projectId !== currentProjectId
				? 'learned in another project'
				: node.scope;
	const detail =
		node.kind === 'structural'
			? (node.symbol ? `${node.symbol} — ${node.path}` : (node.path ?? ''))
			: node.body.split('\n')[0].slice(0, 260);

	return [
		`[${node.id}] (${node.subkind}, ${where}, confidence ${node.confidence.toFixed(2)}, found by ${found})`,
		`  ${node.label}`,
		detail ? `  ${detail}` : ''
	]
		.filter(Boolean)
		.join('\n');
}

function renderNode(node: GraphNode, prefix = ''): string {
	const detail = node.kind === 'structural' ? (node.path ?? '') : node.body.split('\n')[0].slice(0, 200);
	return `${prefix}[${node.id}] (${node.subkind}) ${node.label}${detail ? `\n${prefix}  ${detail}` : ''}`;
}

async function runOne(op: Operation, ctx: Context): Promise<OperationReport> {
	switch (op.action) {
		case 'recall': {
			// Refused rather than answered lexically while the artifact is still
			// arriving. A thin BM25 result set is indistinguishable to the agent from
			// a complete one, so answering would let it conclude "nothing was decided"
			// from "no shared keywords" — and act on that. Saying so plainly costs one
			// turn; a wrong answer costs a wrong decision.
			const readiness = getMemoryReadiness();
			if (!readiness.canRecall) {
				return {
					action: op.action,
					ok: false,
					text: readiness.enabled
						? 'Memory recall is not ready yet — the local embedding model is still being set up. ' +
							'Do not treat this as "nothing has been decided"; proceed without memory for now.'
						: 'Memory is switched off for this workspace.'
				};
			}

			const result = retrieve({
				query: op.query,
				// "all" drops the project filter entirely, which is what makes
				// "how did we solve this in another repo" answerable.
				projectId: op.scope === 'all' ? undefined : ctx.projectId,
				// Even a project-scoped lookup sees what other projects learned about
				// TECHNOLOGY, ranked below what this one knows. Requiring `scope: "all"`
				// for that meant an agent had to already suspect the answer lived
				// elsewhere before it could find it — which is the "didn't know to ask"
				// case memory exists to cover.
				crossProject: true,
				sessionId: ctx.sessionId ?? undefined,
				kinds: op.kind && op.kind !== 'both' ? [op.kind] : undefined,
				limit: op.limit ?? 10,
				// An explicit lookup is answered with what MATCHES it, not with what
				// matches it plus everything one edge away. Expansion belongs to
				// turn-start injection, where a weak lead is still worth ranking and the
				// agent never sees the ranking; asked a direct question, it turns
				// "phoenix" into three correct rows plus sixty neighbours-of-neighbours,
				// and an agent has no way to tell which is which. Same reasoning, and the
				// same settings, as the Memory modal's search box.
				expandHops: 0,
				precise: true
			});

			// A deliberate lookup by an agent IS evidence of use, unlike the automatic
			// turn-start injection — which is why `retrieve` no longer counts itself.
			markConsulted(result.hits);

			if (result.hits.length === 0) {
				return {
					action: op.action,
					ok: true,
					text: `No memory found for "${op.query}".${
						op.scope === 'all' ? '' : ' Retry with scope "all" to search every project.'
					}`
				};
			}

			return {
				action: op.action,
				ok: true,
				text:
					`${result.hits.length} result(s) for "${op.query}"` +
					`${result.vectorUsed ? '' : ' (keyword only — semantic search is still initializing)'}:\n\n` +
					result.hits.map(hit => renderHit(hit, ctx.projectId)).join('\n\n')
			};
		}

		case 'neighbours': {
			const node = graphQueries.getById(op.nodeId);
			if (!node) return { action: op.action, ok: false, text: `No node with id ${op.nodeId}.` };

			const neighbours = graphQueries.neighbours(op.nodeId, op.hops ?? 1);
			if (neighbours.length === 0) {
				return { action: op.action, ok: true, text: `[${node.id}] ${node.label}\nNo connections yet.` };
			}

			const edges = graphQueries.edgesOf(op.nodeId);
			const relationOf = (otherId: string): string => {
				const edge = edges.find(e => e.srcId === otherId || e.dstId === otherId);
				if (!edge) return 'connected';
				return edge.srcId === op.nodeId ? `${edge.rel} →` : `← ${edge.rel}`;
			};

			return {
				action: op.action,
				ok: true,
				text:
					`[${node.id}] ${node.label}\n\n${neighbours.length} connection(s):\n` +
					neighbours
						.map(n => `  ${n.hops === 1 ? relationOf(n.node.id) : `${n.hops} hops`}  ${renderNode(n.node)}`)
						.join('\n')
			};
		}

		case 'timeline': {
			const nodes = graphQueries.timeline({
				projectId: ctx.projectId,
				sessionId: op.thisSessionOnly ? ctx.sessionId : null,
				limit: op.limit ?? 20
			});
			if (nodes.length === 0) return { action: op.action, ok: true, text: 'No memories recorded yet.' };

			return {
				action: op.action,
				ok: true,
				text: `${nodes.length} recent memory/memories (newest first):\n` +
					nodes.map(n => `  ${n.createdAt}  ${renderNode(n)}`).join('\n')
			};
		}

		case 'link': {
			const from = graphQueries.getById(op.fromId);
			const to = graphQueries.getById(op.toId);
			if (!from) return { action: op.action, ok: false, text: `No node with id ${op.fromId}.` };
			if (!to) return { action: op.action, ok: false, text: `No node with id ${op.toId}.` };

			const edge = graphQueries.link({
				srcId: op.fromId,
				dstId: op.toId,
				rel: op.relation as GraphRelation,
				source: 'agent'
			});
			if (!edge) {
				return { action: op.action, ok: false, text: 'Could not link those nodes (a node cannot link to itself).' };
			}

			// `supersedes` means the older memory should stop competing with the newer
			// one in retrieval. It is marked superseded rather than ARCHIVED, which is a
			// different claim: archiving says "this was never true", superseding says
			// "this was true and no longer is". The node keeps its edges, stays readable,
			// and sits one hop from the belief that replaced it.
			notifyGraphChanged('linked', from.projectId);
			if (op.relation === 'supersedes') {
				graphQueries.supersede(op.toId, op.fromId);
				return {
					action: op.action,
					ok: true,
					text: `[${from.id}] now supersedes [${to.id}], which is no longer recalled but stays as history.`
				};
			}

			return { action: op.action, ok: true, text: `[${from.id}] -[${op.relation}]-> [${to.id}]` };
		}

		case 'forget': {
			const node = graphQueries.getById(op.nodeId);
			if (!node) return { action: op.action, ok: false, text: `No node with id ${op.nodeId}.` };

			graphQueries.archive(op.nodeId);
			notifyGraphChanged('forgotten', node.projectId);
			debug.log('memory', `Archived node ${op.nodeId} via MCP${op.reason ? `: ${op.reason}` : ''}`);
			return {
				action: op.action,
				ok: true,
				text: `Forgot [${node.id}] "${node.label}". It is out of search but the user can restore it from Memory.`
			};
		}

		case 'update': {
			const before = graphQueries.getById(op.nodeId);
			if (!before) return { action: op.action, ok: false, text: `No node with id ${op.nodeId}.` };

			const node = graphQueries.update(
				op.nodeId,
				{
					...(op.label !== undefined && { label: op.label }),
					...(op.body !== undefined && { body: op.body }),
					...(op.subkind !== undefined && { subkind: op.subkind })
				},
				// An agent's correction is an agent's correction. Recording it as the
				// user's would exempt the node from structural decay, from eviction and
				// from consolidation, and would tell every future turn a person had
				// stated it — authority the model did not earn by editing.
				'agent'
			);
			if (!node) return { action: op.action, ok: false, text: `Could not update ${op.nodeId}.` };

			// `update` drops the vector, because it described text that just changed.
			scheduleVectorIndexing();
			vectorCache.drop([node.id]);
			notifyGraphChanged('edited', node.projectId);
			return { action: op.action, ok: true, text: `Updated [${node.id}]: ${node.label}` };
		}

		case 'restore': {
			const node = graphQueries.getById(op.nodeId);
			if (!node) return { action: op.action, ok: false, text: `No node with id ${op.nodeId}.` };
			if (!node.archivedAt) return { action: op.action, ok: true, text: `[${node.id}] was not archived.` };

			graphQueries.restore(op.nodeId);
			scheduleVectorIndexing();
			notifyGraphChanged('restored', node.projectId);
			return { action: op.action, ok: true, text: `Restored [${node.id}] "${node.label}".` };
		}

		case 'stats': {
			const stats = graphQueries.stats();
			return {
				action: op.action,
				ok: true,
				text: [
					`${stats.nodes} nodes, ${stats.edges} edges`,
					`  episodic: ${stats.episodic}   structural: ${stats.structural}`,
					`  scope — session ${stats.byScope.session}, project ${stats.byScope.project}, global ${stats.byScope.global}`,
					`  ${stats.vectors} node(s) have semantic vectors`,
					`  ${stats.entities} canonical entity/entities, ${stats.confirmedUseful} confirmed useful`,
					`  ${stats.superseded} superseded (history), ${stats.stale} standing on code that has changed`,
					`  spread across ${stats.byProject.length} project(s)`
				].join('\n')
			};
		}
	}
}

export async function runMemoryOperations(args: { operations: Operation[] }): Promise<RunReport> {
	const config = getMemoryConfig();
	if (!config.enabled) {
		return {
			operations: [{ action: 'disabled', ok: false, text: 'The Memory Graph is turned off in Settings → Infrastructure → Memory.' }],
			projectScoped: false,
			vectorSearchAvailable: false
		};
	}

	const ctx = resolveContext();
	const reports: OperationReport[] = [];

	for (const op of args.operations) {
		try {
			reports.push(await runOne(op, ctx));
		} catch (error) {
			// One bad operation must not discard the results of the ones that
			// already succeeded — the agent gets a partial, honest report.
			reports.push({
				action: op.action,
				ok: false,
				text: `Failed: ${error instanceof Error ? error.message : String(error)}`
			});
		}
	}

	return {
		operations: reports,
		projectScoped: ctx.projectId !== null,
		// `embedder.ready` rather than `stats().vectors > 0`: stats runs eight
		// COUNT(*) scans over the whole table, and this ran on every single tool
		// call purely to fill in one boolean.
		vectorSearchAvailable: embedder.ready
	};
}
