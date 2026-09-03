/**
 * Containers — a cleanup sweep that outlives the dialog that started it.
 *
 * A prune is the longest thing this feature does. Sweeping a few hundred unused
 * volumes is minutes of the daemon unlinking files, and nothing about closing a
 * modal should change that: the runtime carries on regardless, so the only
 * question is whether Clopen still knows what it is doing.
 *
 * Keeping that in the browser answered it badly. Component state dies with the
 * modal, so a sweep that finished while it was closed left no trace; store
 * state dies with a refresh, so the button came back enabled while the daemon
 * was still deleting and invited a second sweep on top of the first; and
 * neither was ever visible to a second device looking at the same host.
 *
 * So the job belongs to the host. Starting one returns the job, asking for it
 * returns whatever is current, and the result is pushed to everyone attached
 * when it lands. A host may only have one sweep at a time — asking again while
 * one runs hands back the running job rather than starting a second.
 */

import type { PruneJob, PruneKind, PruneOutcome } from '$shared/types/containers';
import { pruneResources } from './actions';
import { ws } from '../utils/ws';
import { debug } from '$shared/utils/logger';

interface HostJob {
	job: PruneJob;
	/** Users to push the result to, and to notify when it lands. */
	attached: Set<string>;
}

const hosts = new Map<string, HostJob>();

/** True while the host's last job has not finished. */
function isRunning(entry: HostJob | undefined): boolean {
	return entry !== undefined && entry.job.finishedAt === null;
}

/**
 * Start a sweep, or hand back the one already running.
 *
 * Never starts a second sweep on a host: two prunes racing on the same disk
 * produce two sets of half-true numbers, and the caller asking again is far
 * more likely to have lost track of the first than to actually want another.
 */
export function startPrune(
	hostId: string,
	kinds: PruneKind[],
	userId: string,
	/** The sweep itself, taken as an argument so it can be driven in a test. */
	sweep: (hostId: string, kinds: PruneKind[]) => Promise<PruneOutcome[]> = pruneResources
): PruneJob {
	const existing = hosts.get(hostId);
	if (isRunning(existing)) {
		existing!.attached.add(userId);
		return existing!.job;
	}

	const entry: HostJob = {
		job: {
			hostId,
			kinds,
			startedAt: new Date().toISOString(),
			finishedAt: null,
			outcomes: null
		},
		attached: new Set([userId])
	};
	hosts.set(hostId, entry);

	void (async () => {
		let outcomes;
		try {
			outcomes = await sweep(hostId, kinds);
		} catch (error) {
			debug.warn('containers', `prune failed on ${hostId}:`, error);
			const message = error instanceof Error ? error.message : String(error);
			outcomes = kinds.map((kind) => ({
				kind,
				ok: false,
				removed: 0,
				reclaimed: null,
				error: message
			}));
		}

		entry.job.outcomes = outcomes;
		entry.job.finishedAt = new Date().toISOString();

		// Everyone who attached hears how it went, whether or not their dialog is
		// still open — that is what makes closing it safe.
		for (const id of entry.attached) {
			ws.emit.user(id, 'containers:prune-changed', { job: entry.job });
		}
	})();

	return entry.job;
}

/**
 * The host's current sweep, or the last one whose result nobody has seen yet.
 *
 * Attaches the caller either way, so a dialog opened halfway through a sweep is
 * told when it ends without having to poll for it.
 */
export function pruneJobFor(hostId: string, userId: string): PruneJob | null {
	const entry = hosts.get(hostId);
	if (!entry) return null;
	entry.attached.add(userId);
	return entry.job;
}

/**
 * Forget a finished sweep, once someone has actually read the result.
 *
 * Explicit rather than timed: the report is the only record of what a sweep
 * removed, and dropping it on a schedule would mean a user who stepped away
 * comes back to a panel that quietly pretends nothing happened. A running job
 * is never dismissed — there is nothing to acknowledge yet.
 */
export function dismissPrune(hostId: string): void {
	const entry = hosts.get(hostId);
	if (entry && !isRunning(entry)) hosts.delete(hostId);
}

/** Drop every remembered job. Only for tests, which must not share a registry. */
export function resetPruneJobs(): void {
	hosts.clear();
}
