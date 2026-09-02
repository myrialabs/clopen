/**
 * Containers — what the port table needs to know about them.
 *
 * A published container port is the one case where the process holding a socket
 * is not the thing a user means. On Linux the listener is `docker-proxy`; with
 * the userland proxy disabled there is no listening socket at all and the port
 * is reached through a firewall rule, so the port scan cannot see it however
 * hard it looks. Either way the answer is the container, and only the runtime
 * can give it.
 *
 * So the port scan reads this index — and refreshes it through the transport it
 * already holds open for that host, rather than making the container monitor
 * open a second SSH lease for a host nobody is watching. The read is
 * deliberately synchronous and may be a few seconds stale: a port table that
 * ticks every second must never wait on a `docker ps`, and a mapping that
 * appears one tick late is invisible next to one that made the whole table
 * stutter.
 */

import type { ContainerScanResult } from '$shared/types/containers';
import type { PortContainerRef } from '$shared/types/ports';
import type { CommandRunner, ProbePlatform } from '../host/runner';
import { containerArgv, detectRuntime, tryRun } from './runtime';
import { parseDockerPs, parsePodmanPs } from './parse';
import { debug } from '$shared/utils/logger';

/** How stale the index may get before a port scan asks for a refresh. */
const TTL_MS = 5_000;

/**
 * One published port, as the port table needs it: who publishes it, and on
 * which addresses — the second half matters because a mapping with no listening
 * socket has no row to borrow an address from.
 */
export interface ContainerPortMapping {
	ref: PortContainerRef;
	addresses: string[];
}

/** Keyed `protocol:hostPort`. */
export type ContainerPortIndex = Map<string, ContainerPortMapping>;

interface HostIndex {
	index: ContainerPortIndex;
	readAt: number;
	refreshing: boolean;
}

const hosts = new Map<string, HostIndex>();

function buildIndex(result: ContainerScanResult): ContainerPortIndex {
	const index: ContainerPortIndex = new Map();
	if (!result.runtime) return index;

	for (const entry of result.entries) {
		// Only a running container holds a host port. A stopped one still lists
		// its mappings, and claiming those would blame it for someone else's port.
		if (entry.state !== 'running' && entry.state !== 'paused') continue;

		for (const binding of entry.ports) {
			if (binding.hostPort === null) continue;
			const key = `${binding.protocol}:${binding.hostPort}`;
			const address = binding.hostAddress || '*';

			// The same mapping arrives once per address family; the second one adds
			// an address to the first rather than becoming a second row.
			const existing = index.get(key);
			if (existing) {
				if (!existing.addresses.includes(address)) existing.addresses.push(address);
				continue;
			}

			index.set(key, {
				ref: {
					runtime: result.runtime,
					id: entry.id,
					shortId: entry.shortId,
					name: entry.name,
					image: entry.image,
					containerPort: binding.containerPort
				},
				addresses: [address]
			});
		}
	}

	return index;
}

/**
 * Feed a full container scan into the index.
 *
 * Called by the container monitor for every scan it runs, so a host whose
 * Containers panel is open never pays for a second listing to keep its ports
 * annotated.
 */
export function noteContainerScan(result: ContainerScanResult, now = Date.now()): void {
	hosts.set(result.hostId, {
		index: buildIndex(result),
		readAt: now,
		refreshing: hosts.get(result.hostId)?.refreshing ?? false
	});
}

/** The mappings last seen on a host, keyed `protocol:hostPort`. */
export function containerPortIndex(hostId: string): ContainerPortIndex {
	return hosts.get(hostId)?.index ?? new Map();
}

/**
 * Refresh a host's index in the background, using the caller's own transport.
 *
 * Costs nothing on a host with no runtime: `detectRuntime` remembers that
 * answer, so this returns before running anything.
 */
export function refreshContainerPortIndex(
	hostId: string,
	runner: CommandRunner,
	platform: ProbePlatform,
	now = Date.now()
): void {
	const existing = hosts.get(hostId);
	if (existing?.refreshing) return;
	if (existing && now - existing.readAt < TTL_MS) return;

	const state: HostIndex = existing ?? { index: new Map(), readAt: 0, refreshing: false };
	state.refreshing = true;
	hosts.set(hostId, state);

	void (async () => {
		try {
			const info = await detectRuntime(hostId, runner, platform, now);
			if (info.problem !== 'none' || !info.runtime) {
				state.index = new Map();
				return;
			}

			// Running containers only: the index exists to explain live ports.
			const listing = await tryRun(
				runner,
				containerArgv(info.runtime, platform, [
					'ps',
					'--no-trunc',
					'--format',
					info.runtime === 'docker' ? '{{json .}}' : 'json'
				]),
				15_000
			);
			if (listing.code !== 0) return;

			const entries =
				info.runtime === 'docker'
					? parseDockerPs(listing.stdout, hostId)
					: parsePodmanPs(listing.stdout, hostId);

			state.index = buildIndex({
				hostId,
				scannedAt: new Date(now).toISOString(),
				runtime: info.runtime,
				runtimeVersion: info.version,
				runtimeProblem: 'none',
				entries,
				images: [],
				volumes: [],
				networks: [],
				limitations: [],
				error: null
			});
		} catch (error) {
			debug.log('containers', `could not refresh the port index for ${hostId}:`, error);
		} finally {
			state.readAt = Date.now();
			state.refreshing = false;
		}
	})();
}

/**
 * Whether a socket's addresses and a mapping's could be the same thing.
 *
 * Almost always they are: a published port and its proxy socket cannot both
 * exist on a host without being the same path to the same container, because
 * the second bind would fail. The exception is narrow and real — a container
 * published on loopback while an unrelated process holds the same port on a LAN
 * address — and claiming that process for the container would be a confident
 * lie. A wildcard on either side overlaps everything, which is the common case.
 */
export function addressesOverlap(sockets: string[], mapped: string[]): boolean {
	const wildcard = (address: string): boolean =>
		address === '*' || address === '0.0.0.0' || address === '::' || address === '';
	if (sockets.some(wildcard) || mapped.some(wildcard)) return true;
	return sockets.some((address) => mapped.includes(address));
}

/** Drop a host's index when its connection goes away. */
export function forgetContainerPortIndex(hostId: string): void {
	hosts.delete(hostId);
}
