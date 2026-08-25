/**
 * Writing a memory by hand.
 *
 * Automatic extraction has a hard limit that no amount of tuning removes: it can
 * only record what a conversation happened to state. A constraint the user
 * already knows — "never touch the vendored directory", "staging is on the old
 * schema until March", "this client insists on tabs" — has to be said to an
 * agent before it can be remembered, which means the mistake it would have
 * prevented has usually already happened once. This is the way in that does not
 * require staging a conversation to say something out loud.
 *
 * ── one field, then a review ──
 * The input is one free-text box, because the alternative is a six-field form
 * for a store whose whole promise is that you do not have to curate it. But what
 * gets stored IS six fields, and letting a model fill the other five without
 * showing its work would mean a graph whose contents nobody had read. So the
 * write is two steps: shape it, show it, then save what was shown. The preview
 * is editable, and the user can decline the shaping entirely.
 *
 * ── and it never depends on a model ──
 * `structure: false` — or a missing/failing memory model — falls back to
 * splitting the text into a heading and a body. That fallback is not a
 * degradation to apologise for; it is what makes this the one part of memory
 * that works on an instance with no model configured at all, which is exactly
 * the instance whose graph is otherwise empty.
 */

import { graphQueries } from '$backend/database/queries/graph-queries';
import { initializeEngine } from '$backend/engine';
import { resolveGenerationTarget } from '$backend/engine/resolve-model';
import { debug } from '$shared/utils/logger';
import type { EpisodicSubkind, GraphNode, MemoryDraft } from '$shared/types/memory';
import { getMemoryConfig, type MemoryModelConfig } from './config';
import { scheduleVectorIndexing } from './indexer';
import { notifyGraphChanged } from './notify';
import { redactSecrets } from './redact';
import { findRelatedCandidates, linkEntities } from './revise';
import { resetGraphEmptiness } from './context';

/** Longest free-text input accepted. A memory is a claim, not a document. */
const MAX_INPUT_CHARS = 4_000;

const SUBKINDS: EpisodicSubkind[] = ['decision', 'pattern', 'failure', 'preference', 'observation', 'entity'];

/**
 * Same lowest-common-denominator strict-mode shape as extraction: every property
 * required, no additional properties, optionality as a nullable union.
 */
const DRAFT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		subkind: {
			type: 'string',
			enum: SUBKINDS,
			description:
				'entity = who or what something is; preference = how the user wants things done; decision = a choice and its reason; pattern = a convention that holds; failure = something that broke and why; observation = any other durable fact',
			},
		scope: {
			type: 'string',
			enum: ['project', 'global'],
			description:
				'global = true of how the user works everywhere; project = true only of the project this was written in'
		},
		label: {
			type: 'string',
			description:
				'MUST BE IN ENGLISH. One sentence stating the memory with its subject named, useful out of context. Max 140 characters.'
		},
		body: {
			type: 'string',
			description:
				'MUST BE IN ENGLISH. Why this is true, what it rules out, what breaks without it. Two or three sentences. Never invent detail the input does not contain — if there is nothing to add, restate the claim precisely.'
		},
		entities: {
			type: 'array',
			description: 'People, tools or systems this memory is ABOUT, by name. Empty when none apply.',
			items: { type: 'string' }
		},
		relatedPaths: {
			type: 'array',
			description: 'Repo-relative paths named in the input. Never invent one. Usually empty.',
			items: { type: 'string' }
		}
	},
	required: ['subkind', 'scope', 'label', 'body', 'entities', 'relatedPaths']
};

export interface DraftInput {
	/** What the user typed. */
	text: string;
	projectId: string | null;
	/** False to skip the model and split the text as written. */
	structure?: boolean;
}

/**
 * Turn free text into a reviewable memory. Never throws — a model failure
 * degrades to the split-as-written form with the reason attached.
 */
export async function draftMemory(input: DraftInput): Promise<MemoryDraft | null> {
	const text = redactSecrets(input.text.trim().slice(0, MAX_INPUT_CHARS)).text.trim();
	if (!text) return null;

	const config = getMemoryConfig();
	const wantsModel = input.structure !== false;

	let draft: MemoryDraft;
	if (!wantsModel) {
		draft = splitAsWritten(text, input.projectId, null);
	} else if (!config.model) {
		draft = splitAsWritten(
			text,
			input.projectId,
			'No memory model is configured, so this was saved as written. Choose one under Settings → Model → Memory.'
		);
	} else {
		draft = (await structure(config.model, text, input.projectId)) ?? splitAsWritten(
			text,
			input.projectId,
			'The memory model could not be reached, so this was kept as written.'
		);
	}

	// Shown, not enforced. Two people can legitimately want both statements, and
	// a duplicate check that silently refused the save would be the second-worst
	// version of this feature — the worst being one that stores the same fact
	// twice and lets ranking sort it out.
	//
	// This is the one caller that still shows a raw similarity neighbour, and it
	// is the one where doing so is safe: a PERSON reads the suggestion and decides.
	// The threshold that used to make this decision automatically is gone
	// everywhere it acted alone, because cosine scores a claim and its negation
	// higher than a claim and its own restatement.
	const nearest = findRelatedCandidates({
		text: `${draft.label}\n${draft.body}`,
		subkind: draft.subkind,
		projectId: draft.scope === 'global' ? null : input.projectId
	})[0];
	if (nearest) {
		draft.duplicateOf = {
			id: nearest.node.id,
			label: nearest.node.label,
			score: Number(nearest.score.toFixed(3))
		};
	}

	return draft;
}

export interface CreateInput {
	subkind: EpisodicSubkind;
	scope: 'project' | 'global';
	label: string;
	body: string;
	entities?: string[];
	relatedPaths?: string[];
	projectId: string | null;
	/**
	 * Whether this applies beyond the project it is written in. Omitted leaves it
	 * unjudged, and the maintenance pass decides — which is the right default for
	 * a one-box composer where asking would be a seventh field.
	 */
	reach?: 'here' | 'anywhere';
	/** Exempt from decay and from every automatic removal. */
	pinned?: boolean;
	/** Reinforce this existing memory instead of storing a second copy. */
	reinforceId?: string | null;
}

/**
 * Store a reviewed draft.
 *
 * `source: 'user'`, which is not bookkeeping — it is what exempts the node from
 * structural decay, from eviction and from being archived into a consolidation,
 * and what makes the injected block tell the agent a person said this rather
 * than that a model inferred it.
 */
export function createMemory(input: CreateInput): GraphNode | null {
	const label = redactSecrets(input.label.trim()).text.slice(0, 300);
	if (!label) return null;
	const body = redactSecrets((input.body ?? '').trim()).text;

	const scope = input.scope === 'global' ? 'global' : 'project';
	const projectId = scope === 'global' ? null : input.projectId;

	// Reinforcing goes through the EXISTING node's identity, so a person agreeing
	// with a memory raises its weight instead of adding a near-copy that competes
	// with it for the same recall budget.
	if (input.reinforceId) {
		const existing = graphQueries.getById(input.reinforceId);
		if (existing) {
			const node = graphQueries.update(
				existing.id,
				{ confidence: Math.max(existing.confidence, 0.95), pinned: input.pinned ?? existing.pinned },
				'user'
			);
			if (node) {
				linkEntities(node.id, input.entities ?? []);
				scheduleVectorIndexing();
				notifyGraphChanged('created', projectId);
			}
			return node;
		}
	}

	const node = graphQueries.upsert({
		kind: 'episodic',
		subkind: input.subkind,
		scope,
		projectId,
		label,
		body,
		// Stated outright by a person, which is the highest confidence anything in
		// the graph can have — extraction only reaches 0.95 for exactly this case.
		confidence: 0.95,
		source: 'user',
		// A person typed this, so it carries the highest authority the graph
		// recognises: nothing a model writes may retire it, and it goes into the
		// standing-instructions section of every turn rather than competing for a
		// recall slot.
		assertedBy: 'user',
		reach: input.reach ?? 'here',
		reachJudged: input.reach !== undefined,
		pinned: input.pinned ?? false
	});

	linkEntities(node.id, input.entities ?? []);

	for (const raw of input.relatedPaths ?? []) {
		const path = raw.replace(/\\/g, '/').replace(/^\.\//, '');
		const target = input.projectId ? graphQueries.getByPath(input.projectId, path) : null;
		if (!target) continue;
		graphQueries.link({ srcId: node.id, dstId: target.id, rel: 'about', source: 'user' });
	}

	scheduleVectorIndexing();
	resetGraphEmptiness();
	notifyGraphChanged('created', projectId);
	debug.log('memory', `Stored a hand-written memory: ${label.slice(0, 60)}`);
	return node;
}

/**
 * The text, split rather than interpreted.
 *
 * First line (or first sentence) is the claim, the rest is the reasoning. The
 * subkind is `observation` because guessing without a model would be worse than
 * a neutral default the user can change in the preview — the point of the
 * preview is that nothing here has to be right, only visible.
 */
function splitAsWritten(text: string, projectId: string | null, note: string | null): MemoryDraft {
	const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
	let label = lines[0] ?? text;
	let body = lines.slice(1).join('\n');

	// One paragraph carrying several sentences: the first is the claim and the rest
	// is the reasoning, which is exactly the split the graph stores. Done on the
	// SENTENCE rather than on a character count, because a label truncated at 140
	// characters is not a claim, it is the first 140 characters of one.
	if (!body) {
		const stop = label.search(/[.!?](\s|$)/);
		const rest = stop === -1 ? '' : label.slice(stop + 1).trim();
		// A first sentence too short to stand alone, or nothing after it, is better
		// left whole than cut in half.
		if (stop > 20 && stop < 200 && rest.length > 0) {
			body = rest;
			label = label.slice(0, stop + 1).trim();
		}
	}

	return {
		subkind: 'observation',
		scope: projectId ? 'project' : 'global',
		label: label.slice(0, 300),
		body,
		entities: [],
		relatedPaths: [],
		structured: false,
		duplicateOf: null,
		note
	};
}

async function structure(
	model: MemoryModelConfig,
	text: string,
	projectId: string | null
): Promise<MemoryDraft | null> {
	const prompt = `A person is writing one memory into a long-term store by hand. Below is exactly what they typed. Turn it into a single structured memory.

Change as little as possible. This is not a summary and not an improvement — the person already decided what they wanted to record, and your job is to file it. Do not add a claim they did not make, do not soften one they did, and do not invent a reason they did not give.

Write both fields in English, whatever language the input is in.

Choose "global" scope when the statement is about how this person works everywhere; "project" when it is only true of the codebase they are working in${projectId ? '' : '. There is no project selected, so this is almost certainly global'}.

What they typed:
${text}`;

	try {
		const engine = await initializeEngine(model.engine);
		if (!engine.generateStructured) return null;

		const target = await resolveGenerationTarget(engine, model.modelId, model.providerSlug);
		const accountId = model.accountId ?? target.accountId;

		const result = await engine.generateStructured<{
			subkind: EpisodicSubkind;
			scope: 'project' | 'global';
			label: string;
			body: string;
			entities: string[];
			relatedPaths: string[];
		}>({
			prompt,
			providerSlug: target.providerSlug,
			modelId: target.modelId,
			schema: DRAFT_SCHEMA,
			projectPath: process.cwd(),
			...(accountId != null && { accountId })
		});

		if (!result?.label?.trim()) return null;

		return {
			subkind: SUBKINDS.includes(result.subkind) ? result.subkind : 'observation',
			// A model cannot promote a memory to project scope when there is no
			// project to scope it to.
			scope: result.scope === 'project' && projectId ? 'project' : 'global',
			label: redactSecrets(result.label.trim()).text.slice(0, 300),
			body: redactSecrets((result.body ?? '').trim()).text,
			entities: Array.isArray(result.entities) ? result.entities.slice(0, 6) : [],
			relatedPaths: Array.isArray(result.relatedPaths) ? result.relatedPaths.slice(0, 10) : [],
			structured: true,
			duplicateOf: null,
			note: null
		};
	} catch (error) {
		debug.warn('memory', 'Could not structure a hand-written memory', error);
		return null;
	}
}
