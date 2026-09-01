/**
 * Containers — what the host is holding, measured off the request path.
 *
 * `system df` is the one container command whose cost is set by how much disk
 * the host holds rather than by how many containers it runs. The daemon walks
 * every image layer and stats every file in every volume to answer it. On a
 * developer machine with a few hundred volumes on a virtualised filesystem that
 * is over a minute, and the volumes are almost all of it — measured on one such
 * host: images 2.6s, containers 0.4s, build cache 0.3s, volumes 47s.
 *
 * That is too long to hold a request open for, and there is no shorter way to
 * ask: the runtimes' own CLIs expose no way to measure part of it, and reaching
 * for the Engine API's type filter would mean talking to a unix socket directly
 * rather than through the one CommandRunner that makes a local host and an SSH
 * host the same code.
 *
 * So the measurement is a background job. Asking for it returns whatever was
 * last measured — immediately, however old — and starts a fresh reading only if
 * the old one has gone stale. The fresh reading is pushed to whoever asked when
 * it lands. Nothing ever waits on a command whose duration is set by someone
 * else's disk.
 *
 * A host's reading outlives its connection. Clearing it on teardown would mean
 * the monitor importing this module while this one imports the monitor, to save
 * one small object per host that has ever been opened — and a reading that
 * survives a reconnect is re-measured by the staleness check anyway.
 */

import type { ContainerDiskUsage } from '$shared/types/containers';
import { DISK_USAGE_STALE_MS, DISK_USAGE_TIMEOUT_MS } from '$shared/types/containers';
import { containerMonitor } from './monitor';
import { containerArgv, detectRuntime, firstProblem, tryRun } from './runtime';
import { parseDiskUsage } from './parse';
import { ws } from '../utils/ws';
import { debug } from '$shared/utils/logger';

interface HostUsage {
	/** The last completed reading, kept until something invalidates it. */
	last: ContainerDiskUsage | null;
	/** Users to push the in-flight reading to when it lands. */
	waiting: Set<string>;
	measuring: boolean;
}

const hosts = new Map<string, HostUsage>();

function stateFor(hostId: string): HostUsage {
	const existing = hosts.get(hostId);
	if (existing) return existing;
	const created: HostUsage = { last: null, waiting: new Set(), measuring: false };
	hosts.set(hostId, created);
	return created;
}

/**
 * Whether a reading is old enough to be worth paying for another one.
 *
 * A reading with no usable stamp counts as stale: it came from somewhere that
 * did not say when it was taken, and guessing that it is current would pin a
 * wrong number on screen until something invalidated it.
 */
export function isDiskUsageStale(usage: ContainerDiskUsage | null, now: number): boolean {
	if (!usage?.measuredAt) return true;
	const measuredAt = Date.parse(usage.measuredAt);
	if (Number.isNaN(measuredAt)) return true;
	return now - measuredAt >= DISK_USAGE_STALE_MS;
}

/** Run the measurement itself. Slow by nature, so nothing calls this directly. */
async function measure(hostId: string): Promise<ContainerDiskUsage> {
	const measuredAt = new Date().toISOString();

	return containerMonitor.withHost(hostId, async (runner, platform) => {
		const info = await detectRuntime(hostId, runner, platform);
		if (info.problem !== 'none' || !info.runtime) {
			return {
				rows: [],
				error: 'This host has no container runtime available right now.',
				measuredAt
			};
		}

		const result = await tryRun(
			runner,
			containerArgv(info.runtime, platform, [
				'system',
				'df',
				'--format',
				info.runtime === 'docker' ? '{{json .}}' : 'json'
			]),
			DISK_USAGE_TIMEOUT_MS
		);
		if (result.code !== 0) {
			return {
				rows: [],
				error: firstProblem(result.stderr, result.stdout, result.code),
				measuredAt
			};
		}
		return { ...parseDiskUsage(result.stdout, info.runtime), measuredAt };
	});
}

/**
 * Start a reading if one is warranted, and register the caller for the result.
 *
 * A second caller arriving while a reading is in flight joins that one rather
 * than starting a second: two dialogs open on the same host must not make the
 * daemon walk the same disk twice.
 */
function startMeasuring(hostId: string, userId: string): void {
	const state = stateFor(hostId);
	state.waiting.add(userId);
	if (state.measuring) return;
	state.measuring = true;

	void (async () => {
		let usage: ContainerDiskUsage;
		try {
			usage = await measure(hostId);
		} catch (error) {
			debug.warn('containers', `could not measure disk usage on ${hostId}:`, error);
			usage = {
				rows: [],
				error: error instanceof Error ? error.message : String(error),
				measuredAt: new Date().toISOString()
			};
		}

		// A reading that failed is still a reading: caching it stops a broken host
		// being re-measured on every open. An invalidate clears it either way.
		state.last = usage;
		state.measuring = false;

		const waiting = [...state.waiting];
		state.waiting.clear();
		for (const id of waiting) {
			ws.emit.user(id, 'containers:disk-usage-measured', { hostId, usage });
		}
	})();
}

/**
 * What the dialog gets when it opens: the last reading, and whether a fresh one
 * is on its way.
 *
 * `force` is the Re-check button — the one case where someone has decided the
 * cached answer is not good enough and is willing to wait for a new one.
 */
export function requestDiskUsage(
	hostId: string,
	userId: string,
	force = false
): { usage: ContainerDiskUsage | null; measuring: boolean } {
	const state = stateFor(hostId);
	if (force || isDiskUsageStale(state.last, Date.now())) startMeasuring(hostId, userId);
	return { usage: state.last, measuring: state.measuring };
}

/**
 * Drop a host's reading, because something changed what it would say.
 *
 * Called after a prune or a removal: that is exactly when these numbers move,
 * and showing the figures the sweep was meant to fix would read as the sweep
 * having done nothing.
 */
export function invalidateDiskUsage(hostId: string): void {
	const state = hosts.get(hostId);
	if (state) state.last = null;
}
