/**
 * Containers — starting, stopping, removing, and clearing up after.
 *
 * Every action addresses a container or an image by its full id, and a volume
 * or a network by its name, and every one of those is checked against a
 * pattern before it reaches a command line. Names arrive over a socket, and an
 * argument that begins with a dash is a flag; `assertContainerId` and
 * `assertResourceName` are the gate that stops one becoming the other. Nothing
 * here ever runs through `sudo`: an account that may not talk to the runtime is
 * told so.
 */

import type {
	ContainerAction,
	ContainerActionResult,
	ContainerDetail,
	ContainerResourceKind,
	ContainerRuntime,
	ContainerStats,
	PruneKind,
	PruneOutcome
} from '$shared/types/containers';
import { CONTAINER_TIMEOUTS } from '$shared/types/containers';
import { containerMonitor } from './monitor';
import { invalidateDiskUsage } from './disk-usage';
import { containerArgv, detectRuntime, firstProblem, tryRun } from './runtime';
import { parseInspect, parsePruneOutput, parseStats } from './parse';
import { debug } from '$shared/utils/logger';

/** Both runtimes identify a container or an image with hex. */
const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;
/** An image id may carry the digest algorithm that produced it. */
const IMAGE_ID = /^(sha256:)?[a-f0-9]{12,64}$/i;
/**
 * The character set both runtimes allow in a volume or network name. Anchored
 * at both ends and required to start with an alphanumeric, so nothing that
 * could be read as a flag or a path ever gets through.
 */
const RESOURCE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function isContainerId(value: string): boolean {
	return CONTAINER_ID.test(value);
}

export function assertContainerId(value: string): string {
	if (!isContainerId(value)) throw new Error('That is not a container id.');
	return value;
}

/** Validate whatever identifies a resource of this kind, or refuse it. */
export function assertResourceId(kind: ContainerResourceKind, value: string): string {
	const ok =
		kind === 'container'
			? CONTAINER_ID.test(value)
			: kind === 'image'
				? IMAGE_ID.test(value)
				: RESOURCE_NAME.test(value);
	if (!ok) throw new Error(`That is not a ${kind} Clopen can address.`);
	return value;
}


/** The argv for each action, which is where `remove` stops being one word. */
function actionArgv(action: ContainerAction, containerId: string): string[] {
	switch (action) {
		case 'remove':
			return ['rm', containerId];
		case 'force-remove':
			// The runtime stops it first. Offered separately from `remove` so the
			// confirmation can say that outright rather than surprising anyone.
			return ['rm', '--force', containerId];
		default:
			return [action, containerId];
	}
}

export async function runContainerAction(
	hostId: string,
	containerId: string,
	action: ContainerAction
): Promise<ContainerActionResult> {
	assertContainerId(containerId);

	const result = await containerMonitor.withHost(hostId, async (runner, platform) => {
		const info = await detectRuntime(hostId, runner, platform);
		if (info.problem !== 'none' || !info.runtime) {
			return { ok: false, error: 'This host has no container runtime available right now.' };
		}

		const outcome = await tryRun(
			runner,
			containerArgv(info.runtime, platform, actionArgv(action, containerId)),
			CONTAINER_TIMEOUTS.action
		);
		if (outcome.code === 0) return { ok: true, error: null };

		const reason = firstProblem(outcome.stderr, outcome.stdout, outcome.code);
		debug.warn('containers', `${action} failed for ${containerId} on ${hostId}: ${reason}`);
		return { ok: false, error: reason };
	});

	// The table is a second or two old at most, but an action is the one moment
	// a user expects it to be instant.
	containerMonitor.invalidate(hostId);
	// Starting and stopping do not move the disk figures enough to be worth
	// re-measuring for; removing a container does.
	if (action === 'remove' || action === 'force-remove') invalidateDiskUsage(hostId);
	return result;
}

/** The argv that removes one resource of each kind. */
function removeArgv(kind: ContainerResourceKind, id: string, force: boolean): string[] {
	switch (kind) {
		case 'container':
			return force ? ['rm', '--force', id] : ['rm', id];
		case 'image':
			return force ? ['image', 'rm', '--force', id] : ['image', 'rm', id];
		case 'volume':
			return force ? ['volume', 'rm', '--force', id] : ['volume', 'rm', id];
		case 'network':
			return ['network', 'rm', id];
	}
}

/**
 * Remove one image, volume or network.
 *
 * Deliberately not forgiving: the runtime refuses to remove anything still in
 * use, and that refusal is passed straight through rather than being retried
 * with `--force`. A volume a running container has mounted is not a volume the
 * user meant to delete, whatever the button said.
 */
export async function removeResource(
	hostId: string,
	kind: ContainerResourceKind,
	id: string,
	force = false
): Promise<ContainerActionResult> {
	assertResourceId(kind, id);

	const result = await containerMonitor.withHost(hostId, async (runner, platform) => {
		const info = await detectRuntime(hostId, runner, platform);
		if (info.problem !== 'none' || !info.runtime) {
			return { ok: false, error: 'This host has no container runtime available right now.' };
		}

		const outcome = await tryRun(
			runner,
			containerArgv(info.runtime, platform, removeArgv(kind, id, force)),
			CONTAINER_TIMEOUTS.action
		);
		if (outcome.code === 0) return { ok: true, error: null };

		const reason = firstProblem(outcome.stderr, outcome.stdout, outcome.code);
		debug.warn('containers', `could not remove ${kind} ${id} on ${hostId}: ${reason}`);
		return { ok: false, error: reason };
	});

	containerMonitor.invalidate(hostId);
	invalidateDiskUsage(hostId);
	return result;
}

/**
 * The argv for a sweep.
 *
 * `volumes` is the one place the two runtimes had to be reconciled rather than
 * passed through. Podman's `volume prune` removes every unused volume; Docker's
 * removes only the anonymous ones unless it is given `--all`, which older
 * Docker does not have. So Docker is asked with `--all` and falls back without
 * it, and both runtimes end up meaning the same thing — which is what the
 * confirmation says they mean.
 */
function pruneArgv(kind: PruneKind, runtime: ContainerRuntime): string[] {
	switch (kind) {
		case 'containers':
			return ['container', 'prune', '--force'];
		case 'dangling-images':
			return ['image', 'prune', '--force'];
		case 'images':
			return ['image', 'prune', '--all', '--force'];
		case 'volumes':
			return runtime === 'docker'
				? ['volume', 'prune', '--all', '--force']
				: ['volume', 'prune', '--force'];
		case 'networks':
			return ['network', 'prune', '--force'];
		case 'build-cache':
			return ['builder', 'prune', '--force'];
	}
}

/** True when a command failed because the runtime is too old for a flag. */
function unknownFlag(stderr: string): boolean {
	return /unknown flag|unknown shorthand|flag provided but not defined|unrecognized option/i.test(
		stderr
	);
}

/**
 * Run a set of sweeps, one after another.
 *
 * Sequential rather than parallel: both runtimes serialise this work behind
 * their own lock anyway, and on an SSH host every one of these is a command on
 * a shared connection. A failure in one kind does not stop the rest — a host
 * with no build cache should not cost the user their volume sweep.
 */
export async function pruneResources(hostId: string, kinds: PruneKind[]): Promise<PruneOutcome[]> {
	const outcomes = await containerMonitor.withHost(hostId, async (runner, platform) => {
		const info = await detectRuntime(hostId, runner, platform);
		if (info.problem !== 'none' || !info.runtime) {
			return kinds.map((kind) => ({
				kind,
				ok: false,
				removed: 0,
				reclaimed: null,
				error: 'This host has no container runtime available right now.'
			}));
		}
		const runtime = info.runtime;

		const results: PruneOutcome[] = [];
		for (const kind of kinds) {
			let outcome = await tryRun(
				runner,
				containerArgv(runtime, platform, pruneArgv(kind, runtime)),
				CONTAINER_TIMEOUTS.prune
			);

			// Docker before 23 has no `volume prune --all`, and removed every unused
			// volume without it. Dropping the flag there keeps the meaning identical.
			if (outcome.code !== 0 && kind === 'volumes' && unknownFlag(outcome.stderr)) {
				outcome = await tryRun(
					runner,
					containerArgv(runtime, platform, ['volume', 'prune', '--force']),
					CONTAINER_TIMEOUTS.prune
				);
			}

			if (outcome.code !== 0) {
				const error = firstProblem(outcome.stderr, outcome.stdout, outcome.code);
				debug.warn('containers', `prune ${kind} failed on ${hostId}: ${error}`);
				results.push({ kind, ok: false, removed: 0, reclaimed: null, error });
				continue;
			}

			const { removed, reclaimed } = parsePruneOutput(outcome.stdout);
			results.push({ kind, ok: true, removed, reclaimed, error: null });
		}
		return results;
	});

	containerMonitor.invalidate(hostId);
	// A sweep is exactly when these numbers move, and showing the figures it was
	// meant to fix would read as the sweep having done nothing.
	invalidateDiskUsage(hostId);
	return outcomes;
}

/**
 * One sample of what a container is consuming, read when asked for.
 *
 * Not polled and not part of the listing: `stats` samples over a window and
 * takes a second or more even with `--no-stream`, which is fine for a question
 * someone asked and far too expensive for a table that ticks.
 */
export async function readStats(hostId: string, containerId: string): Promise<ContainerStats | null> {
	assertContainerId(containerId);

	return containerMonitor.withHost(hostId, async (runner, platform) => {
		const info = await detectRuntime(hostId, runner, platform);
		if (info.problem !== 'none' || !info.runtime) return null;

		const result = await tryRun(
			runner,
			containerArgv(info.runtime, platform, [
				'stats',
				'--no-stream',
				'--format',
				info.runtime === 'docker' ? '{{json .}}' : 'json',
				containerId
			]),
			CONTAINER_TIMEOUTS.stats
		);
		if (result.code !== 0) {
			debug.log('containers', `stats failed for ${containerId}:`, result.stderr);
			return null;
		}
		return parseStats(result.stdout);
	});
}

/** Everything `inspect` knows, read only when a detail pane asks for it. */
export async function inspectContainer(
	hostId: string,
	containerId: string
): Promise<ContainerDetail | null> {
	assertContainerId(containerId);

	return containerMonitor.withHost(hostId, async (runner, platform) => {
		const info = await detectRuntime(hostId, runner, platform);
		if (info.problem !== 'none' || !info.runtime) return null;

		const result = await tryRun(
			runner,
			containerArgv(info.runtime, platform, ['inspect', '--format', '{{json .}}', containerId]),
			CONTAINER_TIMEOUTS.inspect
		);
		if (result.code !== 0) {
			debug.log('containers', `inspect failed for ${containerId}:`, result.stderr);
			return null;
		}
		return parseInspect(result.stdout);
	});
}

