/**
 * When episodic extraction runs, and what happens when it does not.
 *
 * ── why it no longer waits ──
 * Extraction calls a model through the SAME engine the user is chatting with, so
 * on a shared-process engine that request competes with the next chat turn. That
 * used to buy six seconds of enforced quiet before a summary could start.
 *
 * The trade was priced wrong. What the delay bought was a slightly shorter queue;
 * what it cost was that a memory did not exist until six seconds after the turn
 * that produced it — an agent could not read back what had just been established,
 * the graph visibly lagged the conversation it was meant to be following, and a
 * session where the user kept typing deferred its own extraction indefinitely.
 * Waiting to avoid a queue is only worth it when somebody is waiting on the
 * queue, and nobody is waiting on this one.
 *
 * So a finished turn is summarised NOW. The only thing that still holds it back
 * is an ACTIVE stream — a summary generated mid-answer competes with the answer —
 * and even that is bounded by MAX_DEFER_SECONDS, so a session that never goes
 * quiet is summarised anyway instead of accumulating a span longer than the
 * transcript budget can carry.
 *
 * ── why the queue is a TABLE ──
 * It used to be a `Map` in this module, which lost a turn's memories silently in
 * three different ways: a failed model call was caught, logged and dropped with no
 * second attempt; a restart discarded everything parked; and none of it was
 * visible, so memory simply did not grow and the only explanation was in the
 * server log. Extraction is the sole write path for the whole feature, which makes
 * "it failed once and gave up" an unusually expensive default.
 *
 * Now it is `memory_extraction_queue` (migration 066). A failure schedules a
 * retry with exponential backoff, exhausting the attempts marks the row FAILED
 * rather than deleting it, and startup puts failed rows back — because the usual
 * causes (no model configured, an expired account, an engine that was down) are
 * exactly the kind of thing that a restart means someone has just changed.
 *
 * ── what is banked ──
 * ONE ROW PER SESSION, holding the OLDEST turn boundary not yet summarised. The
 * transcript runs from that message to the end of the chain, so one extraction
 * covers every turn since. Keeping the newest, as the original did, silently
 * discarded everything in between.
 *
 * That merge now has a race to answer for, because extraction runs immediately: a
 * turn can finish while the previous one is still being read, and it merges into
 * the row already in flight. The runner therefore claims a REVISION and its
 * delete is conditional on it, so the merged-in turn is never thrown away with
 * the one that succeeded.
 *
 * Structural extraction is NOT queued — it reads the disk diff, touches no model,
 * costs microseconds, and its nodes should be searchable at once.
 */

import { memoryQueueQueries, type QueuedExtraction } from '$backend/database/queries/memory-queue-queries';
import { debug } from '$shared/utils/logger';
import { ingestEpisodicMemories, type EpisodicIngestInput } from './episodic';
import { scheduleVectorIndexing } from '../indexer';
import { notifyGraphChanged, notifyMemoryStatus } from '../notify';
import { resetGraphEmptiness } from '../context';

/**
 * Delay between a turn finishing and its summary starting. Zero: a finished turn
 * is summarised NOW.
 *
 * This used to be six seconds of enforced quiet, on the reasoning that
 * extraction talks to the same engine the user is chatting with and would queue
 * against their next message. That cost was real but it was priced wrong. What
 * the delay bought was a slightly shorter queue on shared-process engines; what
 * it cost was that a memory did not exist until six seconds after the turn that
 * produced it — so an agent could not read back what had just been established,
 * the graph visibly lagged the conversation it was supposed to be following,
 * and any session where the user kept typing pushed its own extraction out
 * indefinitely. Waiting to avoid a queue is only worth it if somebody is waiting
 * on the queue, and nobody is waiting on this one.
 *
 * The runner still takes one entry at a time, so extraction competes with at
 * most one request rather than with a burst.
 */
const IDLE_DELAY_SECONDS = 0;

/**
 * Ceiling on how long an entry may be pushed back by new activity.
 *
 * `deferEpisodicIngest` moves an entry while a stream is live so a summary is
 * never generated mid-answer. Without a ceiling that is unbounded: an
 * auto-continuing agent, or a user in a fast back-and-forth, defers the same
 * entry forever, its transcript grows past the character budget, and the head of
 * the span — where the decisions usually are — falls off the front.
 */
const MAX_DEFER_SECONDS = 120;

/** How often the runner asks the queue what is due. */
const TICK_MS = 4_000;

/**
 * Attempts before an entry is parked as failed.
 *
 * Generous, because the failures this is protecting against are transient by
 * nature — a rate limit, an engine restarting, a token being refreshed — and the
 * cost of one more attempt is a background model call nobody is waiting on, while
 * the cost of giving up is a conversation the user will never get back.
 */
const MAX_ATTEMPTS = 5;

/** Exponential backoff, capped. 30s, 2m, 8m, 32m, then an hour. */
function backoffSeconds(attempts: number): number {
	return Math.min(30 * 4 ** attempts, 3_600);
}

/** How long to wait before re-checking a condition the user has to fix. */
const NOT_CONFIGURED_RETRY_SECONDS = 300;

let timer: ReturnType<typeof setInterval> | null = null;
let draining = false;
let running = 0;

/** Park a finished turn. Merges into whatever this session already has queued. */
export function scheduleEpisodicIngest(input: EpisodicIngestInput): void {
	try {
		memoryQueueQueries.enqueue({
			sessionId: input.sessionId,
			projectId: input.projectId,
			projectPath: input.projectPath,
			userMessageId: input.userMessageId,
			changedPaths: input.changedPaths,
			deletedPaths: input.deletedPaths,
			injectedMemoryIds: input.injectedMemoryIds,
			delaySeconds: IDLE_DELAY_SECONDS
		});
		notifyMemoryStatus();
		start();
		// Do not wait for the next tick: the entry is due the instant it is written,
		// and a four-second poll would put back most of the delay just removed.
		void drain();
	} catch (error) {
		debug.warn('memory', 'Failed to queue extraction', error);
	}
}

/**
 * Called when a session starts streaming. Pushes its pending extraction back so
 * the model is never asked to summarise while the user is waiting on a reply.
 *
 * Bounded by `MAX_DEFER_SECONDS` from when the entry was created, so a session
 * that never goes quiet still gets summarised rather than accumulating a span
 * longer than the transcript budget can carry.
 */
export function deferEpisodicIngest(sessionId: string): void {
	try {
		memoryQueueQueries.deferUntilStreamEnds(sessionId, MAX_DEFER_SECONDS);
	} catch (error) {
		debug.warn('memory', 'Failed to defer extraction', error);
	}
}

/** Drop a session's pending extraction (the session was deleted or reset). */
export function cancel(sessionId: string): void {
	try {
		memoryQueueQueries.removeBySession(sessionId);
		notifyMemoryStatus();
	} catch (error) {
		debug.warn('memory', 'Failed to cancel extraction', error);
	}
}

/**
 * True when something is about to run, or is running.
 *
 * Read by `maintenance.ts` as its "somebody is working" signal: both compete for
 * the same engine, so the expensive background jobs stand down while this holds.
 *
 * "About to run" is the load-bearing word, and getting it wrong disabled the
 * entire maintenance loop on a default install. This used to answer "is any row
 * pending", but an entry that cannot run — no model configured — stays pending
 * forever by design, re-checking every few minutes so it starts the moment a
 * model is chosen. Every such entry made this permanently true, so duplicate
 * collapse, retention and consolidation never ran once, on exactly the instances
 * whose graphs most needed tidying. A row whose next attempt is an hour away is
 * not somebody working; it is somebody waiting.
 */
export function hasPendingExtraction(): boolean {
	if (running > 0) return true;
	try {
		return memoryQueueQueries.dueWithin(IMMINENT_SECONDS) > 0;
	} catch {
		return false;
	}
}

/** How soon a queued extraction has to be before maintenance stands down for it. */
const IMMINENT_SECONDS = 90;

/**
 * Start the runner and put previously-failed entries back in the queue.
 *
 * Idempotent, and safe to call from the enqueue path — the common case is a
 * server that has been idle since startup.
 */
export function startExtractionRunner(): void {
	if (timer) return;

	try {
		const revived = memoryQueueQueries.retryFailed();
		if (revived > 0) {
			debug.log('memory', `Re-queued ${revived} extraction(s) that had previously failed`);
		}
	} catch (error) {
		debug.warn('memory', 'Failed to revive the extraction queue', error);
	}

	timer = setInterval(() => void drain(), TICK_MS);
	// Housekeeping: never a reason to hold the process open at shutdown.
	timer.unref?.();
	void drain();
}

export function stopExtractionRunner(): void {
	if (!timer) return;
	clearInterval(timer);
	timer = null;
}

const start = startExtractionRunner;

/**
 * Run everything queued NOW, ignoring the idle delay.
 *
 * Called on shutdown, so a clean stop does not leave a turn's memories to a
 * process that may not come back for a while, and by tests that need the write to
 * have happened.
 */
export async function flushEpisodicIngest(budgetMs = 8_000): Promise<void> {
	let entries: QueuedExtraction[];
	try {
		entries = memoryQueueQueries.all().filter(entry => entry.status === 'pending');
	} catch {
		return;
	}

	// BOUNDED, because this runs inside graceful shutdown. Each entry is a model
	// call with no timeout of its own, so a handful of sessions against a stalled
	// or rate-limited engine could hold the process open for minutes — and the
	// whole point of the queue being a table is that nothing is lost by stopping:
	// whatever is left is picked up by the next start, which re-queues it anyway.
	const deadline = Date.now() + budgetMs;
	for (const entry of entries) {
		if (Date.now() >= deadline) {
			debug.log('memory', `Shutdown flush stopped at the ${budgetMs} ms budget; the rest stays queued`);
			return;
		}
		await runOne(entry);
	}
}

/**
 * Longest one drain may run before it yields.
 *
 * One slow entry delays every entry behind it, and `draining` being true
 * suppresses every later trigger — so a backlog against a slow model could hold
 * the flag for hours, during which `hasPendingExtraction()` keeps maintenance
 * stood down. Yielding on a deadline costs nothing: the queue is a table, the
 * timer fires again, and whatever is left is picked up with the same guarantees.
 */
const DRAIN_BUDGET_MS = 15 * 60_000;

/**
 * Extractions in flight at once.
 *
 * This used to be one, and the reason was real: extraction calls a model through
 * the same engine the user is chatting with, so several at once would queue
 * against their next message on a shared-process engine. Two changes since have
 * made that argument much weaker. Extraction opens its own session in a neutral
 * directory rather than the user's project, and it runs the moment a turn ends
 * rather than competing with an active one — `hasActiveStream` still holds a
 * banked turn while its session is streaming.
 *
 * What serial cost instead was visible immediately: forty finished chats meant
 * forty model calls end to end, each of them a minute or more, with the graph
 * catching up over the following hour and `hasPendingExtraction()` holding
 * maintenance down the whole time.
 *
 * Three is a compromise rather than a measurement. It is enough that a backlog
 * drains in a third of the time, and few enough that an engine with one shared
 * process is not swamped by memory work while somebody is trying to use it.
 */
const MAX_CONCURRENT = 3;

/**
 * Take due entries, up to `MAX_CONCURRENT` at a time.
 *
 * Claiming is safe under concurrency without a lock: `due()` orders by next
 * attempt and each runner's delete is conditional on the revision it claimed
 * (migration 066), so the worst a double-claim can do is extract the same span
 * twice — and the second write upserts onto the same digests, which is
 * reinforcement rather than duplication. Entries are still taken in batches
 * rather than as an unbounded pool so the ceiling is genuinely a ceiling.
 */
async function drain(): Promise<void> {
	if (draining) return;
	draining = true;
	const deadline = Date.now() + DRAIN_BUDGET_MS;
	try {
		for (;;) {
			const due = memoryQueueQueries.due(MAX_CONCURRENT);
			if (due.length === 0) return;

			// `allSettled`, not `all`: one entry throwing must not abandon the others
			// mid-flight. `runOne` already handles its own failures, so this is a
			// backstop against something unexpected in the bookkeeping around it.
			await Promise.allSettled(due.map(entry => runOne(entry)));

			if (Date.now() >= deadline) {
				debug.log(
					'memory',
					`Extraction drain yielded at the ${DRAIN_BUDGET_MS / 60_000} minute budget; the rest stays queued`
				);
				return;
			}
		}
	} catch (error) {
		debug.warn('memory', 'Extraction drain failed', error);
	} finally {
		draining = false;
	}
}

async function runOne(entry: QueuedExtraction): Promise<void> {
	running++;
	notifyMemoryStatus();
	try {
		const result = await ingestEpisodicMemories({
			projectId: entry.projectId,
			projectPath: entry.projectPath,
			sessionId: entry.sessionId,
			userMessageId: entry.userMessageId,
			changedPaths: entry.changedPaths,
			deletedPaths: entry.deletedPaths,
			// Rebuilt from the graph rather than carried through the queue: a Map of
			// path → node id does not serialise usefully, and `getByPath` finds the
			// same nodes. The only cost is a lookup per path.
			fileNodes: new Map<string, string>(),
			injectedMemoryIds: entry.injectedMemoryIds
		});

		if (result.ok) {
			// Quoting the revision this run claimed. Extraction starts the instant a
			// turn ends, so a later turn can finish and merge into this row while the
			// model is still reading the earlier one — and an unconditional delete
			// would take that turn's boundary and paths with it. A refused delete
			// means the row moved on and the next pass covers what was added.
			if (!memoryQueueQueries.remove(entry.id, entry.revision)) {
				debug.log('memory', `Session ${entry.sessionId.slice(0, 8)} banked another turn mid-extraction`);
			}
			if (result.written > 0) {
				scheduleVectorIndexing();
				// The graph has content now, so turn-start injection stops suppressing
				// its own block (see `context.ts`).
				resetGraphEmptiness();
				notifyGraphChanged('memories', entry.projectId);
			}
			return;
		}

		// Not a failure of this turn — a condition the user has to resolve. Waiting
		// costs nothing and the entry stays exactly where it is.
		if (!result.countsAsAttempt) {
			memoryQueueQueries.recordFailure(entry.id, result.error, NOT_CONFIGURED_RETRY_SECONDS, {
				countsAsAttempt: false
			});
			return;
		}

		const attempts = entry.attempts + 1;
		if (attempts >= MAX_ATTEMPTS) {
			memoryQueueQueries.markFailed(entry.id, result.error);
			debug.warn(
				'memory',
				`Extraction for session ${entry.sessionId.slice(0, 8)} failed ${attempts}x, parked: ${result.error}`
			);
			return;
		}

		memoryQueueQueries.recordFailure(entry.id, result.error, backoffSeconds(entry.attempts));
		debug.log(
			'memory',
			`Extraction attempt ${attempts} failed, retrying in ${backoffSeconds(entry.attempts)}s: ${result.error}`
		);
	} catch (error) {
		// A throw from outside `ingestEpisodicMemories` — a database problem, most
		// likely. Treated as retriable for the same reason as everything else here:
		// dropping the entry is the one outcome that cannot be undone.
		const message = error instanceof Error ? error.message : String(error);
		try {
			memoryQueueQueries.recordFailure(entry.id, message, backoffSeconds(entry.attempts));
		} catch {
			debug.error('memory', 'Extraction failed and could not be re-queued', error);
		}
	} finally {
		running--;
		notifyMemoryStatus();
	}
}

/** How many extractions are running this instant — part of the status payload. */
export function runningExtractions(): number {
	return running;
}
