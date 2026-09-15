/**
 * What actually reaches the prompt.
 *
 * Two failures here were invisible from anywhere else, because both produce a
 * turn that simply has no memory in it — which is indistinguishable from a graph
 * that had nothing to say.
 *
 * THE BLOCK CAME OUT EMPTY ON THE TURNS WITH THE MOST TO OFFER. Retrieval used
 * to rank the codebase alongside the memories while the block only ever showed
 * memories, so a project's file and symbol nodes could take every slot. That half
 * is gone (migration 076), and the test that guarded the filtering went with it;
 * what remains worth pinning is that the block still fills from the memories the
 * question earns.
 *
 * THE DIRECTIVE WAS SENT INTO AN EMPTY GRAPH. A few hundred characters on every
 * turn of every session on every engine, telling an agent about a store with
 * nothing in it.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { DatabaseConnection } from '$shared/types/database/connection';
import * as migration066 from '$backend/database/migrations/066_create_memory_graph';
import * as migration076 from '$backend/database/migrations/076_remove_memory_code_graph';

let db: Database;

// The whole module surface, not just `getDatabase`. `mock.module` replaces the
// module for the entire test PROCESS, so a partial stub leaves any file that runs
// afterwards unable to import the missing names — surfacing as
// "Export named 'closeDatabase' not found" in a test that never touched memory.
mock.module('$backend/database', () => ({
	getDatabase: () => db,
	initializeDatabase: async () => db,
	closeDatabase: () => {},
	resetDatabase: async () => {},
	getDatabaseInfo: async () => ({}),
	vacuumDatabase: async () => {}
}));

mock.module('./config', () => ({
	getMemoryConfig: () => ({
		enabled: true,
		recordMemories: true,
		autoRecall: true,
		model: null
	}),
	setMemoryConfig: () => {}
}));

// Recall is gated on the embedding artifact being installed and loaded, which is
// a property of the MACHINE, not of the behaviour under test. Mocked so these
// tests assert what the block contains rather than whether this checkout happens
// to have a 44 MB download sitting in ~/.clopen.
mock.module('./readiness', () => ({
	getMemoryReadiness: () => ({
		enabled: true,
		canRecall: true,
		canRecord: true,
		setupRequired: false,
		blockers: [],
		embedding: {
			ready: true,
			phase: 'installed',
			attempts: 0,
			error: null,
			failure: null,
			permanent: false,
			nextAttemptAt: null,
			receivedBytes: 0,
			totalBytes: 0
		},
		model: { configured: true, engine: 'opencode', modelId: 'test-model' }
	})
}));

const { graphQueries } = await import('$backend/database/queries/graph-queries');
const { buildMemoryContext, resetGraphEmptiness, takeInjectedMemories } = await import('./context');

const PROJECT = 'project-a';

function memory(label: string, body: string) {
	return graphQueries.upsert({
		subkind: 'decision',
		projectId: PROJECT,
		label,
		body,
		confidence: 0.8
	});
}

beforeEach(() => {
	db = new Database(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	migration066.up(db as unknown as DatabaseConnection);
	migration076.up(db as unknown as DatabaseConnection);
	resetGraphEmptiness();
});

describe('the injected block', () => {
	it('says nothing at all while the graph is empty', () => {
		expect(buildMemoryContext({ query: 'how does the stream manager work', projectId: PROJECT, sessionId: 's' })).toBeNull();
	});

	it('appears as soon as there is something to say', () => {
		memory('The stream manager owns snapshot capture', 'It captures in its finally block.');
		resetGraphEmptiness();

		const block = buildMemoryContext({
			query: 'how does the stream manager work',
			projectId: PROJECT,
			sessionId: 's'
		});
		expect(block).not.toBeNull();
		expect(block!.text).toContain('<clopen-memory>');
	});

	it('carries as many memories as the question earns, never more than the ceiling', () => {
		// There is no setting for this any more. A character budget did not bound what
		// it claimed to, and a count could not be right for both "ok, continue" and a
		// turn that lands on a well-known subject. Each turn now keeps the hits that
		// stay close to its own best match.
		for (let i = 0; i < 40; i++) {
			memory(`Decision number ${i} about routing`, 'A reason long enough to cost real budget. '.repeat(4));
		}
		resetGraphEmptiness();

		const block = buildMemoryContext({ query: 'decision about routing', projectId: PROJECT, sessionId: 's' })!;
		const lines = block.text.split('\n').filter(line => line.startsWith('- ('));
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThanOrEqual(12);
	});

	it('takes only a few when the ranking never falls away', () => {
		// A plateau is a ranker with no opinion. Forty memories phrased alike, against
		// a query that matches all of them equally, used to fill the block with twelve
		// weak lines — the relative floor cannot tell that from twelve strong ones,
		// because it is the same shape. Not falling away is the signal.
		for (let i = 0; i < 40; i++) {
			memory(`Interchangeable note ${i}`, 'Every one of these says the same kind of thing as the others.');
		}
		resetGraphEmptiness();

		const block = buildMemoryContext({ query: 'interchangeable note thing', projectId: PROJECT, sessionId: 's' })!;
		const lines = block.text.split('\n').filter(l => l.startsWith('- ('));
		expect(lines.length).toBeLessThanOrEqual(3);
	});

	it('sends fewer memories for a question the graph barely matches', () => {
		// The point of a relative cutoff: a weak question should not drag in the same
		// number of lines as a strong one merely because a fixed count said so.
		for (let i = 0; i < 40; i++) {
			memory(`Decision number ${i} about routing`, 'A reason long enough to cost real budget. '.repeat(4));
		}
		memory('Deployment runs through a distinctivetoken pipeline', 'Nothing else mentions it.');
		resetGraphEmptiness();

		const strong = buildMemoryContext({ query: 'decision about routing', projectId: PROJECT, sessionId: 'a' })!;
		const weak = buildMemoryContext({ query: 'distinctivetoken', projectId: PROJECT, sessionId: 'b' })!;

		const count = (block: { text: string }) => block.text.split('\n').filter(l => l.startsWith('- (')).length;
		expect(count(weak)).toBeLessThan(count(strong));
	});

	it('trims a verbose memory rather than letting it eat the block', () => {
		memory('One very wordy decision about routing', 'An explanation that simply keeps going. '.repeat(40));
		resetGraphEmptiness();

		const block = buildMemoryContext({ query: 'wordy decision routing', projectId: PROJECT, sessionId: 's' })!;
		for (const line of block.text.split('\n')) expect(line.length).toBeLessThanOrEqual(300);
	});

	it('hands the injected ids over exactly once', () => {
		// They are adjudicated by the extraction that reads the turn they were given
		// to. Reading rather than consuming would let a skipped extraction score the
		// same memories twice.
		memory('A memory to be judged', 'Something distinctive to match on.');
		resetGraphEmptiness();
		const block = buildMemoryContext({ query: 'distinctive memory judged', projectId: PROJECT, sessionId: 's' })!;

		expect(takeInjectedMemories('s')).toEqual(block.nodeIds);
		expect(takeInjectedMemories('s')).toEqual([]);
	});

	it('names the project a transferred memory was learned in', () => {
		// Cross-project recall is only usable if the agent can tell "a convention
		// proven in the other repo" from "a description of this codebase". Without
		// the name, a travelling memory reads as a claim about the project in front
		// of it.
		graphQueries.upsert({
			subkind: 'pattern',
			scope: 'project',
			projectId: 'project-b',
			label: 'Guard factories keep authorisation off individual route files',
			body: 'Proven elsewhere.',
			confidence: 0.9,
			source: 'agent',
			reach: 'anywhere'
		});
		resetGraphEmptiness();

		const block = buildMemoryContext({
			query: 'guard factories authorisation route files',
			projectId: PROJECT,
			sessionId: 's',
			projectNames: new Map([['project-b', 'oneinbox']])
		})!;
		expect(block.text).toContain('learned in oneinbox');
	});

	it('sends what the user stated whether or not the turn is about it', () => {
		// The failure this whole split exists for. A standing instruction has no
		// topical overlap with an unrelated question, so similarity search will
		// always rank it below whatever was actually asked — measured, human-stated
		// rules reached the prompt on 3 of 20 opportunities.
		graphQueries.upsert({
			subkind: 'preference',
			scope: 'global',
			projectId: null,
			label: 'Never use the agent tool',
			body: 'Forbidden outright, to conserve tokens.',
			confidence: 0.95,
			source: 'user',
			assertedBy: 'user'
		});
		memory('Routing is handled by the gateway', 'Nothing to do with tooling.');
		resetGraphEmptiness();

		const block = buildMemoryContext({ query: 'how does routing work here', projectId: PROJECT, sessionId: 's' })!;
		expect(block.text).toContain('STANDING INSTRUCTIONS');
		expect(block.text).toContain('Never use the agent tool');
	});

	it('does not repeat a standing instruction in the recalled section', () => {
		graphQueries.upsert({
			subkind: 'preference',
			scope: 'global',
			projectId: null,
			label: 'Never use the agent tool for distinctive analysis',
			body: 'Forbidden outright.',
			confidence: 0.95,
			source: 'user',
			assertedBy: 'user'
		});
		resetGraphEmptiness();

		const block = buildMemoryContext({
			query: 'distinctive analysis agent tool',
			projectId: PROJECT,
			sessionId: 's'
		})!;
		const occurrences = block.text.split('Never use the agent tool for distinctive analysis').length - 1;
		expect(occurrences).toBe(1);
	});

	it('does not put an inference into the standing section', () => {
		// Only what a person stated gets imperative framing. A model's conclusion
		// about how the user works is background, and promoting it would make the
		// most privileged position in the prompt reachable by inference.
		graphQueries.upsert({
			subkind: 'preference',
			scope: 'global',
			projectId: null,
			label: 'The user probably prefers terse replies',
			body: 'Guessed from their message lengths.',
			confidence: 0.6,
			source: 'agent',
			assertedBy: 'inferred'
		});
		resetGraphEmptiness();

		const block = buildMemoryContext({ query: 'terse replies preference', projectId: PROJECT, sessionId: 's' })!;
		expect(block.text).not.toContain('STANDING INSTRUCTIONS');
	});
});
