/**
 * Background maintenance for the Memory Graph.
 *
 * Three jobs that make the graph better rather than bigger — collapsing
 * duplicates, consolidating clusters into generalisations, and applying the
 * retention policy — none of which anything waits on.
 *
 * Timing is the whole design here. Consolidation calls a model, and it calls it
 * through the SAME engine the user chats with, which is the contention that
 * `extract/scheduler.ts` exists to avoid. So maintenance obeys the same rule and
 * one stricter: it runs only when NO session has an extraction parked or in
 * flight, which is a proxy for "nobody is mid-conversation". A user who works all
 * day simply gets their maintenance overnight, which is when it should happen
 * anyway.
 *
 * The cheap jobs (duplicate collapse, retention) are pure SQL and run on the same
 * tick regardless, because they cost microseconds and cannot compete with
 * anything.
 */

import { projectQueries } from '$backend/database/queries/project-queries';
import { debug } from '$shared/utils/logger';
import { getMemoryConfig } from './config';
import { consolidateMemories } from './consolidate';
import { hasPendingExtraction } from './extract/scheduler';
import { collapseDuplicates, reclassifyReach } from './judge';
import { applyRetention } from './retention';

/**
 * How often maintenance considers running. Not how often it runs — most ticks
 * find a busy instance, or nothing to do, and return immediately.
 */
const TICK_MS = 30 * 60_000;

/** Delay before the first tick, so it never lands during startup. */
const FIRST_TICK_MS = 5 * 60_000;

/**
 * Minimum gap between two consolidation passes.
 *
 * Consolidation costs a model call per cluster and its input barely changes
 * within a day, so running it every tick would spend tokens re-examining
 * clusters it already declined to summarise.
 */
const CONSOLIDATE_EVERY_MS = 12 * 60 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastConsolidation = 0;

/** Start the maintenance loop. Idempotent. */
export function startMemoryMaintenance(): void {
	if (timer) return;
	// `unref` so a pending tick never holds the process open on shutdown — this is
	// housekeeping, and nothing here is worth delaying an exit for.
	timer = setInterval(() => void tick(), TICK_MS);
	timer.unref?.();

	const first = setTimeout(() => void tick(), FIRST_TICK_MS);
	first.unref?.();
}

export function stopMemoryMaintenance(): void {
	if (!timer) return;
	clearInterval(timer);
	timer = null;
}

/**
 * Run one maintenance pass now, regardless of the schedule. Used by tests and
 * available for a future manual "tidy memory" action in Settings.
 */
export async function runMaintenanceNow(options?: { consolidate?: boolean }): Promise<void> {
	await pass(options?.consolidate ?? true);
}

async function tick(): Promise<void> {
	if (running) return;
	const config = getMemoryConfig();
	if (!config.enabled) return;

	// Somebody is mid-conversation. Consolidation would queue a model call against
	// their next message on a shared-process engine, and the cheap jobs can just as
	// well wait thirty minutes.
	if (hasPendingExtraction()) return;

	running = true;
	try {
		const consolidate = Date.now() - lastConsolidation >= CONSOLIDATE_EVERY_MS;
		await pass(consolidate);
		if (consolidate) lastConsolidation = Date.now();
	} finally {
		running = false;
	}
}

async function pass(consolidate: boolean): Promise<void> {
	try {
		applyRetention();

		if (!consolidate) return;

		// Both of these call a model, so they sit behind the same gate as
		// consolidation rather than running every tick. Duplicates first: collapsing
		// five copies of one fact into one is what frees the recall budget that
		// everything downstream spends, and reclassifying a memory that is about to
		// be merged away would be wasted work.
		if (hasPendingExtraction()) return;
		await collapseDuplicates();
		if (hasPendingExtraction()) return;
		await reclassifyReach();

		// Global memories first — they are the ones every project sees, so the
		// benefit of tidying them is the widest.
		const projects: { id: string | null; path: string }[] = [
			{ id: null, path: process.cwd() },
			...projectQueries.getAll().map(project => ({ id: project.id as string, path: project.path as string }))
		];

		for (const project of projects) {
			// Re-checked between projects: a user coming back mid-pass should not have
			// their first message queued behind the remaining ones.
			if (hasPendingExtraction()) {
				debug.log('memory', 'Maintenance yielded — a session became active');
				return;
			}
			await consolidateMemories(project.id, project.path);
		}
	} catch (error) {
		debug.warn('memory', 'Maintenance pass failed (non-fatal)', error);
	}
}
