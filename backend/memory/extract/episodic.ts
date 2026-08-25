/**
 * Episodic extraction — turning a finished turn into durable memory.
 *
 * This is the one part of the Memory Graph that calls a model, and it is placed
 * where that cost is invisible: after the turn has finished streaming, off the
 * render path, with nothing waiting on the result. A slow extraction delays only
 * when a memory becomes searchable, never when the user sees their answer.
 *
 * Because it is the only model call in the system, it does THREE jobs rather than
 * one, all from the same transcript and the same request:
 *
 *   1. **Extract** what the turn established that is worth keeping.
 *   2. **Revise** — decide whether each new memory replaces something the graph
 *      already holds, or merely restates it. This needs a reader of the turn;
 *      cosine can tell that two memories are about the same thing but not which
 *      of them is currently true.
 *   3. **Adjudicate** the memories that were injected INTO this turn: which
 *      actually helped, which were wrong. That is the only evidence in the whole
 *      system about whether a memory is any good, and it exists for free here
 *      because the turn that consumed them is exactly what is being read.
 *
 * What it looks at is the transcript of the turn plus which files changed on
 * disk. Reading the transcript rather than only the diff is the point — a diff
 * shows what changed, but the reason it changed, the approach that failed first,
 * and the preference the user stated along the way exist only in the
 * conversation.
 *
 * Everything is written in English regardless of the chat's language. That keeps
 * the corpus in one language so embeddings compare cleanly and the same claim
 * made in two languages de-duplicates instead of becoming two nodes. The
 * repository already requires English for durable text, so this follows suit.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { messageQueries } from '$backend/database/queries/message-queries';
import { graphQueries } from '$backend/database/queries/graph-queries';
import { initializeEngine } from '$backend/engine';
import { resolveGenerationTarget } from '$backend/engine/resolve-model';
import { getClopenDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';
import type {
	EpisodicSubkind,
	GraphAssertedBy,
	GraphNode,
	GraphReach,
	GraphScope,
	MemoryVerdict
} from '$shared/types/memory';
import type { UnifiedMessage } from '$shared/types/unified';
import { embedder } from '../embedding';
import { getMemoryConfig, type MemoryModelConfig } from '../config';
import { ensureMemoryModel } from '../model';
import { redactSecrets } from '../redact';
import {
	applyFeedback,
	findRelatedCandidates,
	gatherRelatedMemories,
	linkEntities,
	recordContradictions,
	renderRelatedMemories
} from '../revise';

/** Transcript characters handed to the model. Enough for a turn, bounded for cost. */
const MAX_TRANSCRIPT_CHARS = 24_000;

/**
 * Memories accepted from one turn.
 *
 * Lowered from eight, because eight was being reached by splitting one fact
 * rather than by finding eight. A single "what is this project?" turn produced
 * five separate observations — payments, referrals, OTP auth, localisation —
 * that were one answer about one repository, and every one of them competes for
 * the same recall slot on every future turn. The prompt asks for fewer and
 * larger; this is the backstop.
 */
const MAX_MEMORIES_PER_TURN = 5;

/**
 * Cosine at which two memories from the SAME response are treated as one.
 *
 * Deliberately high, and deliberately scoped to a single response. See the call
 * site for why the objection that removed this threshold everywhere else — that
 * cosine scores a claim and its negation higher than a claim and its own
 * restatement — does not apply within one model answer describing one turn.
 */
const SELF_DUPLICATE = 0.85;

/**
 * How long one extraction may take before it is abandoned.
 *
 * Generous, because a slow local model summarising a long turn is normal and
 * nobody is waiting on the answer. Finite, because this is the only write path in
 * the feature and it sits inside a drain loop that processes one entry at a time
 * — so a call that never returns does not merely lose its own turn, it stops
 * recording entirely and holds maintenance down with it.
 */
const EXTRACTION_TIMEOUT_MS = 4 * 60_000;

/**
 * Strict JSON Schema, shaped for the lowest common denominator across engines:
 * OpenAI's strict structured-output mode requires `additionalProperties: false`,
 * every property listed in `required`, and optionality expressed as a nullable
 * union rather than an absent key. Claude/OpenCode/Copilot/Qwen all accept it —
 * same reasoning as `COMMIT_MESSAGE_SCHEMA` in backend/ws/git/commit-message.ts.
 */
const MEMORY_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		memories: {
			type: 'array',
			description:
				'Every durable fact the turn stated, whatever its subject, each written in English. Empty only when the turn stated no fact at all.',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					subkind: {
						type: 'string',
						enum: ['decision', 'pattern', 'failure', 'preference', 'observation', 'entity'],
						description:
							'entity = who someone is (name, role, expertise); preference = how the user wants things done; decision = a choice made and its reason; pattern = a convention that holds; failure = something that broke and why; observation = a durable fact about the system'
					},
					scope: {
						type: 'string',
						enum: ['session', 'project', 'global'],
						description:
							'How LONG this holds. session = an instruction for the task at hand only, which does not change any standing rule — "for this analysis, use X" is session even when it goes against a standing rule, because it is an exception being taken, not the rule being repealed. project = a standing claim about this codebase. global = a standing claim about how the user works everywhere.'
					},
					reach: {
						type: 'string',
						enum: ['here', 'anywhere'],
						description:
							'WHERE this is useful, which is a different question from where it was learned. here = about this particular codebase, its choices, its layout, its configuration; someone on another project cannot act on it. anywhere = about a language, framework, runtime, library or general practice, and someone on a different project would want to know it. The test is not whether a project name appears: "Project X deploys to Fly.io" is here because another project deploys elsewhere, while "Bun swallows unhandled rejections" is anywhere because Bun behaves that way in every project.'
					},
					assertedBy: {
						type: 'string',
						enum: ['user', 'assistant', 'inferred'],
						description:
							'Whose claim this is. user = the user said it in the transcript. assistant = the assistant asserted it. inferred = nobody said it outright and you concluded it from what you read. Judge only from the transcript; do not mark something as the user\'s unless they actually said it.'
					},
					label: {
						type: 'string',
						description:
							'MUST BE WRITTEN IN ENGLISH, whatever language the conversation used. One sentence stating the memory, with its subject named, specific enough to be useful out of context. Max 140 characters.'
					},
					body: {
						type: 'string',
						description:
							'MUST BE WRITTEN IN ENGLISH, whatever language the conversation used. The reasoning: why this is true, what it rules out, what breaks without it. Two or three sentences.'
					},
					confidence: {
						type: 'number',
						description: '0.4 when inferred, 0.7 when clearly implied, 0.95 when stated outright by the user.'
					},
					relatedPaths: {
						type: 'array',
						description:
							'Repo-relative paths this memory is about. Only paths that appear in the turn. Empty when none apply.',
						items: { type: 'string' }
					},
					entities: {
						type: 'array',
						description:
							'People, tools, companies or systems this memory is ABOUT, by name — "Arga", "Bun", "Cloudflare". Names only, no description. Empty when the memory is about no particular named thing.',
						items: { type: 'string' }
					},
					relations: {
						type: 'array',
						description:
							'How this memory relates to each of the NEIGHBOURS listed under it. Judge the CLAIM, not the wording: two sentences sharing most of their words can still be opposite, and two sharing none can still be the same claim. Include an entry only for neighbours that are "same" or "opposite"; leave the rest out.',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								id: { type: 'string', description: 'Id of the neighbour, exactly as listed.' },
								relation: {
									type: 'string',
									enum: ['same', 'opposite', 'different'],
									description:
										'same = asserts the same thing in different words, so storing both would be redundant. opposite = cannot be true at the same time as this memory. different = about something else, or a different aspect; both can be true and both are worth keeping.'
								}
							},
							required: ['id', 'relation']
						}
					}
				},
				required: [
					'subkind',
					'scope',
					'reach',
					'assertedBy',
					'label',
					'body',
					'confidence',
					'relatedPaths',
					'entities',
					'relations'
				]
			}
		},
		feedback: {
			type: 'array',
			description:
				'A verdict for each memory listed under MEMORIES GIVEN TO THIS TURN. Judge only from the transcript: did the assistant actually act on it, or did the turn show it to be wrong?',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					id: { type: 'string', description: 'Id from MEMORIES GIVEN TO THIS TURN.' },
					verdict: {
						type: 'string',
						enum: ['used', 'wrong', 'ignored'],
						description:
							'used = the turn relied on it or it was clearly correct; wrong = the turn contradicted it or it caused a mistake; ignored = it simply had no bearing on this turn (the common case, and not a criticism)'
					}
				},
				required: ['id', 'verdict']
			}
		}
	},
	required: ['memories', 'feedback']
};

interface ExtractedMemory {
	subkind: EpisodicSubkind;
	scope: GraphScope;
	reach: GraphReach;
	assertedBy: GraphAssertedBy;
	label: string;
	body: string;
	confidence: number;
	relatedPaths: string[];
	entities: string[];
	relations: { id: string; relation: 'same' | 'opposite' | 'different' }[];
}

interface ExtractionResponse {
	memories?: ExtractedMemory[];
	feedback?: { id: string; verdict: MemoryVerdict }[];
}

export interface EpisodicIngestInput {
	projectId: string;
	projectPath: string;
	sessionId: string;
	/** The user message that opened the OLDEST turn not yet extracted. */
	userMessageId: string;
	/** Repo-relative paths that changed on disk this turn. */
	changedPaths: string[];
	/** Repo-relative paths that no longer exist on disk. */
	deletedPaths?: string[];
	/** Path → structural node id, from structural extraction, for `about` edges. */
	fileNodes: Map<string, string>;
	/** Memories that were injected into this turn, for adjudication. */
	injectedMemoryIds?: string[];
}

/** Plain text of a message's content blocks. */
function messageText(message: UnifiedMessage): string {
	if (message.type === 'compact_boundary') return '';

	// Reasoning is INCLUDED, and it is some of the highest-value text in the
	// transcript. The final answer states a conclusion; the reasoning states why
	// one approach was chosen over another, which is precisely what a `decision`
	// memory is and what cannot be recovered by reading the diff afterwards. It is
	// truncated because reasoning blocks can be very long and most of the length is
	// exploration that led nowhere.
	if (message.type === 'reasoning') {
		const text = (message as { content?: unknown }).content;
		if (typeof text === 'string') return text.slice(0, 2_000);
		if (!Array.isArray(text)) return '';
		return (text as Record<string, unknown>[])
			.filter(block => typeof block.text === 'string')
			.map(block => block.text as string)
			.join('\n')
			.slice(0, 2_000);
	}

	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return '';

	const parts: string[] = [];
	for (const block of content as Record<string, unknown>[]) {
		if (block.type === 'text' && typeof block.text === 'string') {
			parts.push(block.text);
		} else if (block.type === 'tool_use' && typeof block.name === 'string') {
			// Tool NAMES are useful context ("it ran the tests"), but arguments are
			// mostly file contents and would swamp the transcript budget.
			parts.push(`[tool: ${block.name}]`);
		} else if (block.type === 'tool_result') {
			// Failures are the highest-signal thing in a transcript — they are what
			// becomes a `failure` memory that stops the mistake being repeated.
			const isError = block.isError === true || block.is_error === true;
			if (isError) {
				const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
				parts.push(`[tool failed: ${text.slice(0, 600)}]`);
			}
		}
	}
	return parts.join('\n').trim();
}

/**
 * Transcript of everything since `userMessageId`, oldest first.
 *
 * Reads the session's visible chain and slices from that user message, so a turn
 * on a forked branch sees its own history rather than an abandoned one — and so a
 * session that stayed busy, and therefore banked several turns behind one parked
 * boundary, has all of them summarised together.
 */
function buildTranscript(sessionId: string, userMessageId: string): string {
	const chain = messageQueries.getBySessionId(sessionId);
	const startIndex = chain.findIndex(m => m.messageId === userMessageId);
	const turn = startIndex === -1 ? chain.slice(-8) : chain.slice(startIndex);

	const lines: string[] = [];
	for (const message of turn) {
		const text = messageText(message);
		if (!text) continue;
		const role = message.type === 'user' ? 'USER' : message.type === 'reasoning' ? 'REASONING' : 'ASSISTANT';
		lines.push(`${role}: ${text}`);
	}

	const transcript = lines.join('\n\n');
	if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;

	// Keep the tail: the end of a turn holds the conclusion and any final
	// correction, which is where the durable memory usually is.
	return `…\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
}

function buildPrompt(options: {
	transcript: string;
	changedPaths: string[];
	related: string;
	injected: string;
}): string {
	const files = options.changedPaths.length
		? options.changedPaths.slice(0, 40).map(p => `- ${p}`).join('\n')
		: '- (no files changed on disk)';

	return `You keep a long-term memory. Read one span of a work session and write down everything stated in it that would still be worth knowing weeks from now, in a different session, to someone with no other context.

WRITE EVERY MEMORY IN ENGLISH, both label and body. The conversation below is usually in another language; translate as you record it. A corpus in mixed languages neither compares nor de-duplicates, so the same fact stated once in each language becomes two unrelated entries that never connect.

THE TEST IS WHETHER IT COULD BE READ BACK OUT OF THE REPOSITORY.

An agent in a later session can open the code, the config and the lockfile in seconds. Anything it would find there is not worth a memory, however true. What it can NEVER recover that way is what happened in the conversation: why a choice was made and what was rejected, what the user asked for and objected to, what was tried and failed, and the conventions people follow that the code merely reflects.

WRITE DOWN:
- decisions and the reasoning behind them, including the option that was not taken
- preferences and corrections the user stated
- failures: what broke, why, and what fixed it
- conventions and constraints that hold beyond the file they were noticed in
- who someone is, and how they work
- behaviour of a language, runtime, framework or library that surprised someone

DO NOT WRITE DOWN:
- what the project is built with, unless the turn explains WHY it was chosen. "The project uses Prisma with PostgreSQL" is in package.json
- a feature inventory of the codebase — payments, auth, localization, uploads. Listing the directory answers that faster than recalling it
- a blow-by-blow account of what the agent did (that is history, not knowledge)
- a restatement of the code diff
- something true only for this one turn, with no bearing on later ones
- content-free pleasantries ("thanks", "ok", "continue")
- credentials, tokens, keys or anything else secret, even in passing

A turn that only ANSWERED A QUESTION about existing code has usually established nothing durable, and returning an empty list is the right answer far more often than it feels like. A memory that merely describes the code costs recall budget on every future turn and tells the reader what it could have looked up.

PAY PARTICULAR ATTENTION TO CORRECTIONS. When the user says a version of "no, not like that", "don't do X", "I'd rather you Y", that is the single highest-value thing in the transcript: it is a preference stated explicitly, it usually generalises beyond this turn, and it is the kind of thing that gets re-litigated every session until someone writes it down. Record it as a preference with high confidence, phrased as the rule rather than as the incident.

PREFER FEWER, LARGER MEMORIES. If a turn establishes one thing, write ONE. Five notes saying a marketplace takes payments, has referrals, uses OTP and compiles SCSS are one fact about one project split five ways, competing with each other for the same slot forever.

How to write each one:
- English. Not the language of the conversation. Check this before returning.
- The label must stand alone, with the subject named. "Arga is a full-stack developer working in JavaScript and TypeScript", not "the user introduced themselves". "Sessions are rejected once the auth token expires", not "fixed the bug".
- Pick the closest subkind. entity = who or what something is. preference = how someone wants things done. decision = a choice and its reason. pattern = a convention that holds. failure = something that broke and why. observation = anything else durable.
- scope "global" = true beyond this codebase (people, preferences, cross-project conventions). scope "project" = true of this codebase only.
- relatedPaths must be paths that appear below; never invent one. Most memories have none.
- entities names the people, tools or systems the memory is about, so statements about the same subject are stored together.

WRITE IT SO IT TRAVELS. When the turn establishes something about a language, a runtime, a library or a way of working, state the RULE rather than the incident: "In Svelte 5 a multi-statement derived block must use $derived.by", not "fixed the total showing a function". The rule is useful in another project six months from now; the incident is not. When the turn establishes something about this codebase in particular, say which codebase it is about.

RELATING TO WHAT IS ALREADY KNOWN
Each of your memories may be compared against the neighbours listed under EXISTING MEMORIES. For every neighbour that is either the SAME claim or the OPPOSITE claim, add an entry to relations. Judge the claim, not the wording.
- same — it says what you are saying, in other words. The existing memory is reinforced instead of a near-copy being stored.
- opposite — it cannot be true at the same time as yours. Both are kept; the system decides which is current each time it is asked, using who said it and how recently.
- Everything else you may leave out.

Do not try to decide which of two conflicting memories should win, and do not withhold a memory because it disagrees with something stored. Recording the disagreement IS the answer.

EXISTING MEMORIES:
${options.related}

MEMORIES GIVEN TO THIS TURN:
${options.injected}
For each of those, return a verdict in feedback. "ignored" is the ordinary answer and carries no criticism — most memories offered to a turn simply do not bear on it. Reserve "wrong" for one the transcript actually shows to be incorrect.

Files changed on disk during this span:
${files}

Transcript:
${options.transcript}`;
}

/**
 * What happened to one queued extraction.
 *
 * The distinction that matters is between "there was nothing to record" and
 * "this could not be recorded right now". Both used to return 0, so the queue
 * deleted the entry either way and a model outage cost the user a conversation.
 *
 * `countsAsAttempt` separates a genuine failure from a condition the user has to
 * resolve. No model configured will not start working by being retried harder;
 * burning attempts on it would park the entry as failed within minutes, for
 * something that is fixed by visiting a settings page.
 */
export type EpisodicIngestResult =
	| { ok: true; written: number }
	| { ok: false; error: string; countsAsAttempt: boolean };

/**
 * Extract and store episodic memories for a finished turn.
 *
 * Never throws: extraction is a best-effort enrichment of work the user already
 * considers done, so a model error, a missing account or a malformed response is
 * REPORTED to the queue rather than raised at a caller who cannot act on it.
 */
export async function ingestEpisodicMemories(input: EpisodicIngestInput): Promise<EpisodicIngestResult> {
	const config = getMemoryConfig();
	// Switched off. The user decided this; drop the entry rather than hoarding
	// work for a feature they have turned off.
	if (!config.enabled || !config.recordMemories) return { ok: true, written: 0 };

	// Switched ON with nothing to run it. Pick a default first: at startup the
	// engine catalog is often not loaded yet, but by the time a turn has finished
	// it certainly is, which makes this the reliable moment to choose one.
	//
	// Still keep the turn if that fails — the moment a model becomes available,
	// everything banked while it was missing gets summarised.
	const model = config.model ?? (await ensureMemoryModel());
	if (!model) {
		return { ok: false, error: 'No model is configured for writing memories', countsAsAttempt: false };
	}

	const rawTranscript = buildTranscript(input.sessionId, input.userMessageId);
	// Only skip a span with no dialogue at all (a bare tool run, an interrupted
	// stream). The floor is deliberately low: "my name is Arga, a full-stack
	// developer" is a short turn and one of the most valuable things the graph can
	// hold, so a length threshold tuned for code discussions would throw it away.
	if (rawTranscript.trim().length < 24) return { ok: true, written: 0 };

	// Redaction happens BEFORE the model sees the text, not after. A summariser
	// asked to record what a turn established will happily quote the API key it
	// was shown, and by then the secret is in a durable, re-injected, instance-wide
	// store. See backend/memory/redact.ts.
	const redacted = redactSecrets(rawTranscript);
	if (redacted.hits.length > 0) {
		debug.log('memory', `Redacted ${redacted.hits.join(', ')} from transcript before extraction`);
	}

	const related = gatherRelatedMemories({
		transcript: redacted.text,
		projectId: input.projectId,
		sessionId: input.sessionId
	});
	const candidateIds = new Set(related.map(memory => memory.id));

	const injectedIds = new Set(input.injectedMemoryIds ?? []);
	const injectedListing = renderInjected(input.injectedMemoryIds ?? []);

	let response: ExtractionResponse;
	try {
		response = await requestExtraction(
			model,
			buildPrompt({
				transcript: redacted.text,
				changedPaths: input.changedPaths,
				related: renderRelatedMemories(related),
				injected: injectedListing
			})
		);
	} catch (error) {
		// Retriable by default. Almost everything that reaches here is transient —
		// a rate limit, an engine restarting, a token being refreshed — and the one
		// outcome that cannot be undone is throwing the turn away.
		const message = error instanceof Error ? error.message : String(error);
		debug.warn('memory', 'Episodic extraction failed', error);
		return { ok: false, error: message, countsAsAttempt: true };
	}

	// Feedback first: it is independent of whether anything new was extracted, and
	// a turn that recorded nothing can still have proved a memory wrong.
	const scored = applyFeedback(response.feedback ?? [], injectedIds);
	if (scored > 0) debug.log('memory', `Scored ${scored} injected memory/memories`);

	const memories = Array.isArray(response.memories) ? response.memories : [];
	let written = 0;

	// Memories written by THIS extraction, with their vectors, so each one can be
	// compared against the ones before it. Vector indexing is scheduled rather than
	// synchronous, so nothing written in this loop exists in `graph_vectors` yet —
	// which is how one turn about a single Svelte rule produced three memories
	// stating it, two of them at cosine 0.8955.
	const writtenThisTurn: { node: GraphNode; vector: Float32Array }[] = [];

	for (const memory of memories.slice(0, MAX_MEMORIES_PER_TURN)) {
		if (!memory?.label?.trim()) continue;

		// The model's own text is redacted too. It was asked not to record secrets,
		// and asking is not a control.
		const label = redactSecrets(memory.label.trim()).text.slice(0, 300);
		const body = redactSecrets((memory.body ?? '').trim()).text;
		if (!label) continue;

		const scope: GraphScope =
			memory.scope === 'global' ? 'global' : memory.scope === 'session' ? 'session' : 'project';
		// A global memory belongs to the user, not the repository it was noticed in,
		// so it is stored without a project — that is what lets it apply everywhere
		// and be found before any project is selected.
		const projectId = scope === 'global' ? null : input.projectId;
		const assertedBy: GraphAssertedBy =
			memory.assertedBy === 'user' ? 'user' : memory.assertedBy === 'assistant' ? 'assistant' : 'inferred';
		// A one-off instruction never travels: it was true of one task in one
		// session, and carrying it into another project is the failure this scope
		// exists to prevent.
		const reach: GraphReach = scope === 'session' ? 'here' : memory.reach === 'anywhere' ? 'anywhere' : 'here';

		// ── what this restates or contradicts ───────────────────────────────
		// The model's own verdicts come first — it read the turn — and are checked
		// against the ids it was actually shown. Anything it did not rule on falls
		// through to being stored on its own, which is the safe default: a duplicate
		// costs a line of budget, a discarded memory is gone.
		const verdicts = new Map<string, 'same' | 'opposite' | 'different'>();
		for (const relation of memory.relations ?? []) {
			if (!relation?.id) continue;
			const known = candidateIds.has(relation.id) || writtenThisTurn.some(entry => entry.node.id === relation.id);
			if (known) verdicts.set(relation.id, relation.relation);
		}

		const sameAs = [...verdicts.entries()].find(([, relation]) => relation === 'same')?.[0];
		const opposites = [...verdicts.entries()].filter(([, relation]) => relation === 'opposite').map(([id]) => id);

		// One narrow place cosine is still trusted to decide: against the memories
		// THIS response already produced. The model cannot relate its own outputs to
		// each other — they have no ids until they are written — and it does restate
		// itself: one turn about a single Svelte rule returned three memories saying
		// it three ways. Within one response the reversal risk that makes cosine
		// unusable elsewhere does not exist, because the model is describing one turn
		// rather than revising a belief, so a high score here really does mean "said
		// twice".
		const selfDuplicate =
			findRelatedCandidates({
				text: `${label}\n${body}`,
				subkind: memory.subkind,
				projectId,
				extra: writtenThisTurn
			}).find(
				candidate =>
					candidate.score >= SELF_DUPLICATE && writtenThisTurn.some(entry => entry.node.id === candidate.node.id)
			)?.node ?? null;

		const duplicate = selfDuplicate ?? (sameAs ? (graphQueries.getById(sameAs) ?? null) : null);

		if (duplicate) {
			// Reinforce through the existing node's own identity, which is what turns
			// a rephrasing into evidence for the memory it rephrases instead of a
			// second entry that competes with it.
			//
			// The reinforcement carries the NEW memory's authority and reach upward
			// (see `upsert`): a rule the user restated outright is now theirs, and one
			// recognised as travelling now travels, even though the stored text does
			// not change.
			graphQueries.upsert({
				kind: 'episodic',
				subkind: duplicate.subkind,
				scope: duplicate.scope,
				projectId: duplicate.projectId,
				sessionId: duplicate.sessionId,
				digest: duplicate.digest,
				label: duplicate.label,
				body: duplicate.body,
				confidence: Math.max(duplicate.confidence, clampConfidence(memory.confidence)),
				source: duplicate.source,
				assertedBy,
				reach,
				reachJudged: true
			});
			// Contradictions belong to the memory that actually makes the claim, which
			// is the one being reinforced.
			recordContradictions(duplicate.id, opposites, new Set([...candidateIds, ...writtenThisTurn.map(e => e.node.id)]));
			linkEntities(duplicate.id, memory.entities ?? []);
			continue;
		}

		const node = graphQueries.upsert({
			kind: 'episodic',
			subkind: memory.subkind,
			scope,
			projectId,
			sessionId: scope === 'global' ? null : input.sessionId,
			label,
			body,
			confidence: clampConfidence(memory.confidence),
			source: 'agent',
			assertedBy,
			reach,
			reachJudged: true
		});
		written++;

		const vector = embedder.embed(`${label}\n${body}`, { minTokens: 6 });
		if (vector) writtenThisTurn.push({ node, vector });

		// ── disagreements, recorded rather than acted on ────────────────────
		recordContradictions(node.id, opposites, new Set([...candidateIds, ...writtenThisTurn.map(e => e.node.id)]));

		// ── entities ────────────────────────────────────────────────────────
		linkEntities(node.id, memory.entities ?? []);

		// `about` edges are what make the two halves one graph: from here a question
		// about the code reaches this memory, and this memory names the code.
		for (const rawPath of memory.relatedPaths ?? []) {
			const path = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
			const targetId = input.fileNodes.get(path) ?? graphQueries.getByPath(input.projectId, path)?.id;
			if (!targetId) continue;
			graphQueries.link({ srcId: node.id, dstId: targetId, rel: 'about', source: 'agent' });
		}
	}

	if (written > 0) {
		debug.log('memory', `Episodic ingest: ${written} memory/memories from session ${input.sessionId.slice(0, 8)}`);
	}
	return { ok: true, written };
}

/** The injected memories, as the model sees them for adjudication. */
function renderInjected(ids: string[]): string {
	if (ids.length === 0) return '- (none were injected into this turn)';
	const nodes = graphQueries.getByIds(ids);
	if (nodes.length === 0) return '- (none were injected into this turn)';
	return nodes.map(node => `- [${node.id}] (${node.subkind}) ${node.label}`).join('\n');
}

function clampConfidence(value: unknown): number {
	const n = typeof value === 'number' ? value : 0.5;
	if (!Number.isFinite(n)) return 0.5;
	return Math.min(1, Math.max(0.1, n));
}

/**
 * Ask the configured model for structured memories, relations and verdicts.
 *
 * Two things here are not incidental.
 *
 * IT RUNS IN A NEUTRAL DIRECTORY, not the user's repository. Engines implement
 * `generateStructured` by opening one of their own sessions in `projectPath`, so
 * the repository's instruction files land in the model's context alongside the
 * transcript — and it writes them down. Measured: a span whose entire content was
 * "halo, nama saya Arga" produced "Arga is the user working on the Clopen
 * project", and another produced "Clopen uses Bun as the exclusive runtime —
 * Node.js and Deno are not supported", a sentence lifted from the repository's
 * CLAUDE.md that nobody in the conversation had said. It also made the call less
 * reliable: pointed at a repository, 3 of 12 runs failed outright (truncated
 * JSON, or the model answering about the directory instead of the task) against
 * 1 of 12 from an empty directory. Extraction is a text transformation; giving it
 * a codebase to look at can only contaminate it.
 *
 * IT HAS A DEADLINE. This is the only write path in the feature and it had no
 * timeout of its own, on top of a `drain()` loop with no deadline either — so one
 * hung call froze recording AND stood maintenance down until the process was
 * restarted, silently. Observed in testing: a single call that had not returned
 * after thirty-five minutes.
 */
async function requestExtraction(model: MemoryModelConfig, prompt: string): Promise<ExtractionResponse> {
	const engine = await initializeEngine(model.engine);
	if (!engine.generateStructured) {
		throw new Error(`Engine "${model.engine}" does not support structured generation`);
	}

	// The stored providerSlug/accountId can be stale — a model may have moved
	// provider or the account may be gone (see resolve-model.ts).
	const target = await resolveGenerationTarget(engine, model.modelId, model.providerSlug);
	const accountId = model.accountId ?? target.accountId;

	const abortController = new AbortController();
	const deadline = setTimeout(() => abortController.abort(), EXTRACTION_TIMEOUT_MS);
	try {
		const result = await Promise.race([
			engine.generateStructured<ExtractionResponse>({
				prompt,
				providerSlug: target.providerSlug,
				modelId: target.modelId,
				schema: MEMORY_SCHEMA,
				projectPath: getExtractionWorkdir(),
				abortController,
				...(accountId != null && { accountId })
			}),
			// The abort signal is honoured by some adapters and ignored by others, so
			// the race is what actually bounds the wait. A run that keeps going in the
			// background is wasted work; a run that keeps the queue is a stopped
			// feature.
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error(`Extraction timed out after ${Math.round(EXTRACTION_TIMEOUT_MS / 1000)}s`)),
					EXTRACTION_TIMEOUT_MS
				)
			)
		]);
		return result ?? {};
	} finally {
		clearTimeout(deadline);
	}
}

/**
 * An empty, Clopen-owned directory for the extraction model to open a session
 * in. Created once; its emptiness is the point.
 */
function getExtractionWorkdir(): string {
	const dir = join(getClopenDir(), 'memory', 'extract');
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}
