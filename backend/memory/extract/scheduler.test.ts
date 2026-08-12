/**
 * Extraction scheduling and its durability.
 *
 * Two behaviours are under test here and both were once silently wrong.
 *
 * WHICH TURN gets summarised when a session never pauses. Parking the NEWEST
 * boundary — the original behaviour — discarded every turn but the last, because
 * the transcript is built by slicing from the parked message to the end of the
 * chain. Parking the OLDEST makes one extraction cover the whole span.
 *
 * WHAT HAPPENS WHEN IT FAILS. The queue used to be a `Map` and a `catch` that
 * logged: a failed model call dropped the turn permanently, and a restart dropped
 * everything. Since extraction is the ONLY write path in the feature, "failed
 * once, gave up" is an unusually expensive default.
 *
 * `ingestEpisodicMemories` is mocked: what matters is which input reaches it,
 * when, and what the queue does with each kind of answer.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { DatabaseConnection } from '$shared/types/database/connection';
import * as migration066 from '$backend/database/migrations/066_create_memory_graph';

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

interface Call {
	sessionId: string;
	userMessageId: string;
	changedPaths: string[];
	injectedMemoryIds: string[];
}

const calls: Call[] = [];
type Reply = { ok: true; written: number } | { ok: false; error: string; countsAsAttempt: boolean };
let reply: Reply = { ok: true, written: 1 };

/**
 * Held open to keep an extraction in flight.
 *
 * Extraction now starts the moment a turn is queued, so "a turn arrives while the
 * previous one is still being summarised" — the case the revision counter exists
 * for — cannot be produced by simply calling the scheduler twice. This makes the
 * model call block until the test lets it finish.
 */
let gate: { promise: Promise<void>; open: () => void } | null = null;

function holdExtraction(): void {
	let open!: () => void;
	const promise = new Promise<void>(resolve => {
		open = resolve;
	});
	gate = { promise, open };
}

mock.module('./episodic', () => ({
	ingestEpisodicMemories: async (input: Call) => {
		calls.push({
			sessionId: input.sessionId,
			userMessageId: input.userMessageId,
			changedPaths: [...input.changedPaths],
			injectedMemoryIds: [...(input.injectedMemoryIds ?? [])]
		});
		if (gate) await gate.promise;
		return reply;
	}
}));

mock.module('../indexer', () => ({ scheduleVectorIndexing: () => {} }));
mock.module('../notify', () => ({ notifyGraphChanged: () => {}, notifyMemoryStatus: () => {} }));

const { memoryQueueQueries } = await import('$backend/database/queries/memory-queue-queries');
const { scheduleEpisodicIngest, deferEpisodicIngest, cancel, flushEpisodicIngest, hasPendingExtraction } =
	await import('./scheduler');

function turn(userMessageId: string, changedPaths: string[] = [], injected: string[] = []) {
	return {
		projectId: 'p',
		projectPath: '/tmp/p',
		sessionId: 's',
		userMessageId,
		changedPaths,
		fileNodes: new Map<string, string>(),
		injectedMemoryIds: injected
	};
}

/** Make everything queued eligible now, so `flush` sees it without waiting. */
function makeDue(): void {
	db.prepare(`UPDATE memory_extraction_queue SET ready_at = datetime('now', '-1 second')`).run();
}

/** Let the immediate drain that `scheduleEpisodicIngest` starts run to completion. */
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
	db = new Database(':memory:');
	migration066.up(db as unknown as DatabaseConnection);
	gate = null;
	calls.length = 0;
	reply = { ok: true, written: 1 };
});

describe('banking a turn', () => {
	it('summarises a finished turn immediately, without waiting for a quiet period', async () => {
		scheduleEpisodicIngest(turn('msg-1', ['a.ts']));
		await settle();

		expect(calls).toHaveLength(1);
		expect(calls[0].userMessageId).toBe('msg-1');
		// Gone from the queue: it was summarised, not parked.
		expect(memoryQueueQueries.get('s')).toBeNull();
	});

	it('keeps the oldest boundary when turns arrive faster than they can be summarised', async () => {
		holdExtraction();
		scheduleEpisodicIngest(turn('msg-1', ['a.ts']));
		await settle();
		expect(calls).toHaveLength(1);

		// Two more turns land while the first is still with the model. They merge
		// into the row in flight and keep the oldest boundary that is still
		// unsummarised, so one later extraction covers the whole span.
		scheduleEpisodicIngest(turn('msg-2', ['b.ts']));
		scheduleEpisodicIngest(turn('msg-3', ['c.ts']));

		gate!.open();
		gate = null;
		await settle();

		expect(calls).toHaveLength(2);
		// Still msg-1, deliberately. The merge keeps the oldest boundary because the
		// transcript runs from it to the end of the chain, and nothing here can know
		// how much of that span the in-flight extraction actually got through. The
		// second pass therefore re-reads a superset rather than risking a gap —
		// re-extracting a turn costs a duplicate that the digest and the cosine check
		// both absorb, while skipping one loses it for good.
		expect(calls[1].userMessageId).toBe('msg-1');
		expect(memoryQueueQueries.get('s')).toBeNull();
	});

	it('never deletes a turn that merged in while the previous one was running', async () => {
		// The race the revision counter exists for. An unconditional delete on
		// success would take the merged-in turn's boundary and paths with it —
		// silently, on the only write path in the feature.
		holdExtraction();
		scheduleEpisodicIngest(turn('msg-1', ['a.ts'], ['mem-1']));
		await settle();

		scheduleEpisodicIngest(turn('msg-2', ['b.ts'], ['mem-2']));
		gate!.open();
		gate = null;
		await settle();

		expect(calls).toHaveLength(2);
		expect(calls[1].changedPaths.sort()).toEqual(['a.ts', 'b.ts']);
		expect(calls[1].injectedMemoryIds.sort()).toEqual(['mem-1', 'mem-2']);
	});

	it('reports imminent work, which is what maintenance stands down for', async () => {
		expect(hasPendingExtraction()).toBe(false);
		holdExtraction();
		scheduleEpisodicIngest(turn('msg-1'));
		expect(hasPendingExtraction()).toBe(true);

		gate!.open();
		gate = null;
		await settle();
		expect(hasPendingExtraction()).toBe(false);
	});

	it('ignores an entry whose next attempt is far away', () => {
		// An entry waiting on something the user has to fix — no model configured —
		// stays pending by design. Counting that as "somebody is working" stood the
		// whole maintenance loop down permanently on a default install.
		memoryQueueQueries.enqueue({
			sessionId: 's',
			projectId: 'p',
			projectPath: '/tmp/p',
			userMessageId: 'msg-1',
			changedPaths: [],
			delaySeconds: 3_600
		});
		expect(memoryQueueQueries.status().pending).toBe(1);
		expect(hasPendingExtraction()).toBe(false);
	});

	it('drops a cancelled session without running it', async () => {
		// Queued directly, with a delay, so it is still parked when the session is
		// deleted — which is the situation `cancel` exists for.
		memoryQueueQueries.enqueue({
			sessionId: 's',
			projectId: 'p',
			projectPath: '/tmp/p',
			userMessageId: 'msg-1',
			changedPaths: [],
			delaySeconds: 60
		});
		cancel('s');

		await flushEpisodicIngest();
		expect(calls).toHaveLength(0);
	});

	it('holds a banked turn while its session is streaming', async () => {
		memoryQueueQueries.enqueue({
			sessionId: 's',
			projectId: 'p',
			projectPath: '/tmp/p',
			userMessageId: 'msg-1',
			changedPaths: [],
			delaySeconds: 0
		});
		deferEpisodicIngest('s');

		// Pushed out of reach, so a summary is never generated mid-answer.
		expect(memoryQueueQueries.dueWithin(0)).toBe(0);

		makeDue();
		await flushEpisodicIngest();
		expect(calls[0].userMessageId).toBe('msg-1');
	});

	it('survives a restart, because the queue is a table', () => {
		holdExtraction();
		scheduleEpisodicIngest(turn('msg-1', ['a.ts']));
		// Nothing in memory is consulted: a fresh read of the table is all a new
		// process would have.
		const entry = memoryQueueQueries.get('s');
		expect(entry?.userMessageId).toBe('msg-1');
		expect(entry?.changedPaths).toEqual(['a.ts']);
	});
});

describe('when extraction fails', () => {
	it('keeps the turn and schedules a retry', async () => {
		reply = { ok: false, error: 'rate limited', countsAsAttempt: true };
		scheduleEpisodicIngest(turn('msg-1'));

		await flushEpisodicIngest();

		const entry = memoryQueueQueries.get('s');
		expect(entry).not.toBeNull();
		expect(entry!.attempts).toBe(1);
		expect(entry!.lastError).toBe('rate limited');
		expect(entry!.status).toBe('pending');
	});

	it('gives up only after repeated failures, and keeps the row', async () => {
		reply = { ok: false, error: 'engine down', countsAsAttempt: true };
		scheduleEpisodicIngest(turn('msg-1'));

		for (let i = 0; i < 6; i++) {
			makeDue();
			await flushEpisodicIngest();
		}

		const entry = memoryQueueQueries.get('s');
		expect(entry!.status).toBe('failed');
		// Kept rather than deleted, so it stays visible and can be retried.
		expect(entry!.lastError).toBe('engine down');
	});

	it('does not burn attempts when no model is configured', async () => {
		// Retrying harder will never configure a model. Spending the attempt budget
		// on it would park the turn as failed within minutes, for something the user
		// fixes by visiting a settings page — after which the turn should still be
		// there.
		reply = { ok: false, error: 'No model is configured', countsAsAttempt: false };
		scheduleEpisodicIngest(turn('msg-1'));

		for (let i = 0; i < 4; i++) {
			makeDue();
			await flushEpisodicIngest();
		}

		const entry = memoryQueueQueries.get('s');
		expect(entry!.attempts).toBe(0);
		expect(entry!.status).toBe('pending');
	});

	it('runs the banked turn once the model starts working', async () => {
		reply = { ok: false, error: 'No model is configured', countsAsAttempt: false };
		scheduleEpisodicIngest(turn('msg-1', ['a.ts']));
		makeDue();
		await flushEpisodicIngest();
		expect(calls).toHaveLength(1);

		reply = { ok: true, written: 2 };
		makeDue();
		await flushEpisodicIngest();

		expect(calls).toHaveLength(2);
		expect(calls[1].userMessageId).toBe('msg-1');
		expect(memoryQueueQueries.get('s')).toBeNull();
	});

	it('puts failed entries back on request', async () => {
		reply = { ok: false, error: 'engine down', countsAsAttempt: true };
		scheduleEpisodicIngest(turn('msg-1'));
		for (let i = 0; i < 6; i++) {
			makeDue();
			await flushEpisodicIngest();
		}
		expect(memoryQueueQueries.get('s')!.status).toBe('failed');

		expect(memoryQueueQueries.retryFailed()).toBe(1);
		const entry = memoryQueueQueries.get('s')!;
		expect(entry.status).toBe('pending');
		expect(entry.attempts).toBe(0);
	});

	it('drops the turn when there was simply nothing to record', async () => {
		// A conversation that established nothing durable is a success, not a
		// failure, and must not sit in the queue forever being retried.
		reply = { ok: true, written: 0 };
		scheduleEpisodicIngest(turn('msg-1'));

		await flushEpisodicIngest();
		expect(memoryQueueQueries.get('s')).toBeNull();
	});
});

describe('queue status', () => {
	it('counts what is waiting, retrying and stuck', async () => {
		reply = { ok: false, error: 'nope', countsAsAttempt: true };
		scheduleEpisodicIngest(turn('msg-1'));
		makeDue();
		await flushEpisodicIngest();

		const status = memoryQueueQueries.status();
		expect(status.pending).toBe(1);
		expect(status.retrying).toBe(1);
		expect(status.failed).toBe(0);
		expect(status.lastError).toBe('nope');
	});
});
