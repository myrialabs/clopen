/**
 * The two judgements the graph makes about itself on a timer, both of which used
 * to be made by a cosine threshold and neither of which a similarity score can
 * answer.
 *
 *   1. **Are these two memories the same claim?** Measured against the shipped
 *      artifact on labelled pairs: same-claim pairs score 0.63–0.77, opposite
 *      pairs 0.70–0.99, unrelated-but-similar pairs up to 0.92. Every genuine
 *      duplicate scores below the median opposite, because a mean-pooled static
 *      embedding has no representation for negation — "prefers to use the agent
 *      tool" against "prefers NOT to use the agent tool" scores 0.9938. The same
 *      pairs put to a model: 11 of 12 correct on the harder three-way question,
 *      against 6 of 12 for cosine on the easier two-way one.
 *
 *   2. **Would this memory help someone on a different project?** Nothing tried
 *      to answer this before; `project_id` was doing double duty as provenance
 *      and as a fence, so a Svelte reactivity gotcha debugged in one repository
 *      was invisible in every other. Measured: a model answers it correctly 15
 *      times in 16, with zero errors in the damaging direction (a codebase fact
 *      wrongly released to travel).
 *
 * Both run on the maintenance timer, never on a path anyone waits on, using the
 * same configured model as extraction. Both are bounded per pass. Both fail
 * closed: a model that cannot be reached leaves the graph exactly as it was.
 */

import { initializeEngine } from '$backend/engine';
import { resolveGenerationTarget } from '$backend/engine/resolve-model';
import { getDatabase } from '$backend/database';
import { graphQueries } from '$backend/database/queries/graph-queries';
import { debug } from '$shared/utils/logger';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getClopenDir } from '$backend/utils/paths';
import { getMemoryConfig, type MemoryModelConfig } from './config';
import { findDuplicateCandidates, mergeDuplicate } from './revise';
import { notifyGraphChanged } from './notify';
import type { GraphNode, GraphReach } from '$shared/types/memory';

/** Pairs adjudicated per pass. One model call covers all of them. */
const MAX_PAIRS_PER_RUN = 12;

/** Memories reclassified per pass. */
const MAX_REACH_PER_RUN = 20;

/**
 * The same empty directory extraction uses.
 *
 * Engines implement `generateStructured` by opening a session in the directory
 * they are given, so pointing it at a repository puts that repository's
 * instruction files in the model's context. For extraction that produced
 * memories about a codebase nobody had mentioned; for a judgement it would bias
 * the answer toward whatever the open project happens to use.
 */
function workdir(): string {
	const dir = join(getClopenDir(), 'memory', 'extract');
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

async function generate<T>(model: MemoryModelConfig, prompt: string, schema: Record<string, unknown>): Promise<T | null> {
	try {
		const engine = await initializeEngine(model.engine);
		if (!engine.generateStructured) return null;
		const target = await resolveGenerationTarget(engine, model.modelId, model.providerSlug);
		const accountId = model.accountId ?? target.accountId;
		return await engine.generateStructured<T>({
			prompt,
			providerSlug: target.providerSlug,
			modelId: target.modelId,
			schema,
			projectPath: workdir(),
			...(accountId != null && { accountId })
		});
	} catch (error) {
		debug.warn('memory', 'Memory judgement call failed', error);
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Duplicates
// ─────────────────────────────────────────────────────────────────────────────

const RELATION_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		verdicts: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					index: { type: 'number' },
					relation: {
						type: 'string',
						enum: ['same', 'opposite', 'different'],
						description:
							'same = B asserts what A asserts, in other words; storing both is redundant. opposite = B cannot be true at the same time as A. different = about something else or a different aspect; both can be true and both are worth keeping.'
					}
				},
				required: ['index', 'relation']
			}
		}
	},
	required: ['verdicts']
};

/**
 * Collapse the pairs a model agrees are one claim, and record the ones it says
 * disagree.
 *
 * This is the pass that decides whether the graph is still usable after six
 * months. Without it, a model rephrases the same fact every time it sees it and
 * the store grows linearly with the number of turns — measured on the real
 * graph, five separate copies of "Arga is a full-stack developer" were taking
 * five of the nine slots the injected block had to spend.
 *
 * A pair the model calls `opposite` is NOT merged. It gets a `contradicts` edge
 * and both stay live; which one is current is decided on the read path, every
 * turn, from authority and recency rather than from a similarity score.
 */
export async function collapseDuplicates(): Promise<number> {
	const config = getMemoryConfig();
	if (!config.enabled || !config.model) return 0;

	const pairs = findDuplicateCandidates(200).slice(0, MAX_PAIRS_PER_RUN);
	if (pairs.length === 0) return 0;

	const listing = pairs
		.map((pair, index) => `${index}.\n   A: ${describe(pair.a)}\n   B: ${describe(pair.b)}`)
		.join('\n');

	const result = await generate<{ verdicts?: { index: number; relation: string }[] }>(
		config.model,
		`For each numbered pair of memories, say how B relates to A.

Judge the CLAIM, not the wording. Two sentences that share most of their words can still be opposite — "prefers to use X" and "prefers not to use X" differ by one word and cannot both hold. Two that share no words can still be the same claim.

When unsure, answer "different". Merging two memories that were actually different destroys one of them; keeping two that say the same thing costs a line.

${listing}

Return one verdict per index.`,
		RELATION_SCHEMA
	);

	let merged = 0;
	let conflicts = 0;
	for (const verdict of result?.verdicts ?? []) {
		const pair = pairs[verdict.index];
		if (!pair) continue;

		if (verdict.relation === 'same') {
			// The winner is the one with the better claim to being current: authority
			// first, then recency. `mergeDuplicate` goes through `supersede`, whose
			// guards refuse a merge that would retire a person's memory behind a
			// model's — in which case the pair simply stays as two.
			const [winner, loser] = order(pair.a, pair.b);
			if (mergeDuplicate(winner.id, loser.id)) merged++;
		} else if (verdict.relation === 'opposite') {
			const [newer, older] = order(pair.a, pair.b);
			if (graphQueries.contradict(newer.id, older.id)) conflicts++;
		}
	}

	if (merged > 0 || conflicts > 0) {
		debug.log('memory', `Duplicate pass: ${merged} merged, ${conflicts} contradiction(s) recorded`);
		notifyGraphChanged('edited', null);
	}
	return merged;
}

function describe(node: GraphNode): string {
	const body = node.body.trim().split('\n')[0];
	return body ? `${node.label} — ${body.slice(0, 160)}` : node.label;
}

/** Which of two memories should survive a merge, strongest first. */
function order(a: GraphNode, b: GraphNode): [GraphNode, GraphNode] {
	if (a.source !== b.source) return a.source === 'user' ? [a, b] : [b, a];
	if (a.assertedBy !== b.assertedBy && (a.assertedBy === 'user' || b.assertedBy === 'user')) {
		return a.assertedBy === 'user' ? [a, b] : [b, a];
	}
	return Date.parse(`${a.updatedAt}Z`) >= Date.parse(`${b.updatedAt}Z`) ? [a, b] : [b, a];
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reach
// ─────────────────────────────────────────────────────────────────────────────

const REACH_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		verdicts: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					index: { type: 'number' },
					reach: { type: 'string', enum: ['here', 'anywhere'] }
				},
				required: ['index', 'reach']
			}
		}
	},
	required: ['verdicts']
};

/**
 * Decide which existing memories describe a technology rather than a codebase,
 * so they can travel.
 *
 * `reach` defaults to `here` on purpose: a memory wrongly kept local is invisible
 * until this pass reaches it, while one wrongly released appears in every project
 * immediately, and only the first is recoverable by waiting. This is what walks
 * that back, a batch at a time, for memories an extraction failed to classify.
 */
export async function reclassifyReach(): Promise<number> {
	const config = getMemoryConfig();
	if (!config.enabled || !config.model) return 0;

	const rows = getDatabase()
		.prepare(
			`SELECT id FROM graph_nodes
			 WHERE kind = 'episodic' AND reach_judged = 0
			   AND archived_at IS NULL AND superseded_by IS NULL
			   AND subkind <> 'entity'
			 ORDER BY weight DESC, updated_at DESC
			 LIMIT ?`
		)
		.all(MAX_REACH_PER_RUN) as { id: string }[];
	if (rows.length === 0) return 0;

	const nodes = graphQueries.getByIds(rows.map(row => row.id));
	if (nodes.length === 0) return 0;

	const listing = nodes.map((node, index) => `${index}. ${describe(node)}`).join('\n');

	const result = await generate<{ verdicts?: { index: number; reach: string }[] }>(
		config.model,
		`Each line is a note taken while working on one software project. Decide whether the note would still be useful to someone working on a DIFFERENT project.

here     = the note is about this particular codebase — its choices, its structure, its configuration. Someone on another project cannot act on it.
anywhere = the note is about a language, framework, runtime, library or general practice. Someone on another project using the same technology would want to know it, even though it was learned here.

The test is not whether a project name appears. "Project X deploys to Fly.io" is here, because another project deploys somewhere else. "Bun swallows unhandled rejections" is anywhere, because Bun behaves that way in every project.

${listing}

Return one verdict per index.`,
		REACH_SCHEMA
	);
	if (!result?.verdicts?.length) return 0;

	const db = getDatabase();
	const mark = db.prepare(`UPDATE graph_nodes SET reach = ?, reach_judged = 1 WHERE id = ?`);
	let travelling = 0;
	let judged = 0;
	// One transaction: this is a bulk rewrite of rows the read path filters on, and
	// a half-applied batch would leave the graph disagreeing with itself about
	// which memories are allowed to cross a project boundary.
	const write = (): void => {
		for (const verdict of result.verdicts ?? []) {
			const node = nodes[verdict.index];
			if (!node) continue;
			const reach: GraphReach = verdict.reach === 'anywhere' ? 'anywhere' : 'here';
			mark.run(reach, node.id);
			judged++;
			if (reach === 'anywhere') travelling++;
		}
	};
	// `transaction` is optional on the connection interface, so the batch falls back
	// to plain statements rather than not running at all.
	if (db.transaction) db.transaction(write)();
	else write();

	if (judged > 0) {
		debug.log('memory', `Reach pass: judged ${judged} memory/memories, ${travelling} of them travel`);
	}
	return judged;
}
