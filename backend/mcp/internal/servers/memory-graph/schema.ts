/**
 * Tool schema for the Memory Graph.
 *
 * One tool, discriminated on `action`, following the Browser Automation server:
 * a registry of actions inside a single tool rather than a dozen sibling tools.
 * That keeps the graph's whole surface in one description the agent reads once,
 * and lets a related pair of steps (recall, then walk a node's neighbours) be
 * decided without another round trip through the tool list.
 */

import { z } from 'zod';

const subkind = z
	.enum(['decision', 'pattern', 'failure', 'preference', 'observation'])
	.describe(
		'decision = a choice and its reason; pattern = a convention that holds; failure = something that broke and why; preference = how the user wants things done; observation = a durable fact'
	);

const relation = z
	.enum([
		'imports',
		'calls',
		'defines',
		'contains',
		'caused_by',
		'supersedes',
		'contradicts',
		'generalizes',
		'about',
		'relates_to'
	])
	.describe(
		'about links a memory to code it concerns; supersedes marks a memory as replacing an older one; contradicts flags a conflict; relates_to is a plain association'
	);

const recall = z.object({
	action: z.literal('recall'),
	query: z.string().min(1).describe('What you want to know, in natural language. Any language works.'),
	scope: z
		.enum(['project', 'all'])
		.optional()
		.describe(
			'project (default): this project plus global memories. all: every project — use when the question is not about the current codebase, or to find how something was solved elsewhere.'
		),
	kind: z
		.enum(['episodic', 'structural', 'both'])
		.optional()
		.describe('episodic = decisions/patterns/failures; structural = files/symbols/dependencies; both (default)'),
	limit: z.number().int().min(1).max(40).optional().describe('Maximum results. Default 10.')
});

/**
 * There is no `remember` action, and that is deliberate.
 *
 * Memories are written by ONE path: the automatic extraction that reads each
 * finished turn (`backend/memory/extract/episodic.ts`). A second write path made
 * the store unpredictable — the same fact could arrive either way, phrased
 * differently, at different times, and an agent had no way to know which had
 * already happened.
 *
 * Nothing is lost by removing it. When the user says "remember that I prefer X",
 * extraction reads that sentence in the transcript and stores it, with the same
 * schema and the same duplicate and revision handling as everything else. Asking
 * the agent to also call a tool was asking it to do work the system was already
 * doing, in a way that could disagree with itself.
 *
 * What remains here is what extraction CANNOT do: look things up on demand, walk
 * the graph, and correct what is already stored.
 */

/**
 * Correcting a memory in place, rather than storing a competing one.
 *
 * Without this the only way to fix a memory was `remember` (which leaves the
 * wrong one in the graph) or `forget` followed by `remember` (which loses its
 * edges and its history). A memory that is nearly right is the common case, and
 * it deserves an edit.
 */
const update = z.object({
	action: z.literal('update'),
	nodeId: z.string().min(1).describe('Node id from a previous recall result.'),
	label: z.string().optional().describe('Replacement one-sentence claim. Omit to keep the current one.'),
	body: z.string().optional().describe('Replacement reasoning. Omit to keep the current one.'),
	subkind: subkind.optional().describe('Correct the kind, when it was filed wrong.')
});

const restore = z.object({
	action: z.literal('restore'),
	nodeId: z.string().min(1).describe('Node id to bring back out of the archive.')
});

const neighbours = z.object({
	action: z.literal('neighbours'),
	nodeId: z.string().min(1).describe('Node id from a previous recall result.'),
	hops: z.number().int().min(1).max(3).optional().describe('How far to walk. Default 1.')
});

const timeline = z.object({
	action: z.literal('timeline'),
	limit: z.number().int().min(1).max(60).optional().describe('How many recent memories. Default 20.'),
	thisSessionOnly: z.boolean().optional().describe('Restrict to memories recorded during this conversation.')
});

const link = z.object({
	action: z.literal('link'),
	fromId: z.string().min(1).describe('Source node id.'),
	toId: z.string().min(1).describe('Target node id.'),
	relation
});

const forget = z.object({
	action: z.literal('forget'),
	nodeId: z.string().min(1).describe('Node id to retire.'),
	reason: z
		.string()
		.optional()
		.describe('Why it is no longer true. Recorded in the log; the node is archived, not destroyed.')
});

const stats = z.object({
	action: z.literal('stats')
});

export const memorySchema = z.discriminatedUnion('action', [
	recall,
	update,
	neighbours,
	timeline,
	link,
	forget,
	restore,
	stats
]);

export const memoryToolSchema = {
	operations: z
		.array(memorySchema)
		.min(1)
		.describe('Operations to run in order. Batch anything that does not depend on a previous result.')
};
