/**
 * Containers — keeping the list live.
 *
 * The same contract the port table runs on, for the same reason: neither Docker
 * nor Podman offers a portable way to be *told* that a container's state
 * changed. Docker has an event stream, Podman has a different one, neither
 * exists on a host that has only the other, and both would need a channel held
 * open per host. Polling a `ps` is one cheap command, works identically on both
 * runtimes and over both transports, and earns its keep by being quiet:
 *
 * - A watched host is listed every two seconds locally, every four over SSH,
 *   where each scan is a round trip on the connection the terminal and file
 *   browser are also using.
 * - Results are diffed server-side and pushed only when something actually
 *   changed, so a host whose containers are steady costs no traffic at all.
 * - With no panel open, the only work is the sidebar count on this machine, and
 *   only when this machine has a runtime at all.
 * - A remote host is scanned only while its tab is open, on a lease borrowed
 *   from the pool the terminal and file browser already keep warm.
 */

import type { ContainerScanResult } from '$shared/types/containers';
import { LOCAL_HOST_ID } from '$shared/types/host';
import { HostContainerScanner } from './scan';
import { forgetContainerPortIndex, noteContainerScan } from './port-index';
import { containerArgv, detectRuntime, forgetRuntime, tryRun } from './runtime';
import {
	LocalCommandRunner,
	SshCommandRunner,
	detectRemotePlatform,
	localPlatform,
	type CommandRunner,
	type ProbePlatform
} from '../host/runner';
import { sshClientPool, type SshLease } from '../ssh/client-pool';
import { sshConnectionQueries } from '../database/queries';
import { ws } from '../utils/ws';
import { debug } from '$shared/utils/logger';

/**
 * Panel open on this machine.
 *
 * Slower than the port table's one second, on purpose. A listing costs more —
 * on a machine with a few dozen containers it is well over a hundred
 * milliseconds, where a warm port scan is tens — and containers change state
 * far less often than sockets do. Two seconds still reads as live.
 */
const WATCH_INTERVAL_MS = 2_000;
/** Panel open on an SSH host, paced to stay out of the terminal's way. */
const REMOTE_WATCH_INTERVAL_MS = 4_000;
/** Panel closed: only the sidebar count on this machine. */
const BADGE_INTERVAL_MS = 15_000;

interface HostState {
	scanner: HostContainerScanner;
	runner: CommandRunner;
	platform: ProbePlatform;
	lease: SshLease | null;
	/** User ids currently looking at this host. */
	watchers: Set<string>;
	timer: ReturnType<typeof setInterval> | null;
	last: ContainerScanResult | null;
	signature: string;
	scanning: boolean;
}

/**
 * What a client would notice changing. Excludes the timestamp and the status
 * text's own clock — `Up 3 minutes` becomes `Up 4 minutes` on its own — so an
 * idle host produces an identical signature tick after tick and nothing is sent.
 */
function signatureOf(result: ContainerScanResult): string {
	if (result.error) return `error:${result.error}`;
	const containers = result.entries
		.map(
			(entry) =>
				`${entry.id}|${entry.state}|${entry.health}|${entry.name}|${entry.image}|${entry.ports
					.map((port) => `${port.protocol}${port.hostPort ?? '-'}:${port.containerPort}`)
					.join('/')}`
		)
		.join('\n');
	const images = result.images.map((image) => image.key).join(',');
	const volumes = result.volumes.map((volume) => `${volume.key}:${volume.usedBy.length}`).join(',');
	return `${result.runtime ?? 'none'}:${result.runtimeProblem}\n${containers}\n${images}\n${volumes}`;
}

class ContainerMonitor {
	private hosts = new Map<string, HostState>();
	/**
	 * Hosts being set up right now. Creating a host acquires an SSH lease, so two
	 * concurrent callers would each take one and only the last would be kept —
	 * the other then leaks for the life of the process.
	 */
	private opening = new Map<string, Promise<HostState>>();
	private badgeTimer: ReturnType<typeof setInterval> | null = null;
	private badgeCount = 0;

	// -- host lifecycle ------------------------------------------------------

	private async ensureHost(hostId: string): Promise<HostState> {
		const existing = this.hosts.get(hostId);
		if (existing) return existing;

		const opening = this.opening.get(hostId);
		if (opening) return opening;

		const created = this.createHost(hostId)
			.then((state) => {
				// Another caller may have finished first; keep theirs and let this
				// one's lease go rather than overwriting it.
				const settled = this.hosts.get(hostId);
				if (settled) {
					state.lease?.release();
					return settled;
				}
				this.hosts.set(hostId, state);
				return state;
			})
			.finally(() => {
				this.opening.delete(hostId);
			});

		this.opening.set(hostId, created);
		return created;
	}

	private async createHost(hostId: string): Promise<HostState> {
		if (hostId === LOCAL_HOST_ID) {
			const runner = new LocalCommandRunner();
			const platform = localPlatform();
			return {
				scanner: new HostContainerScanner(hostId, 'this machine', runner, platform),
				runner,
				platform,
				lease: null,
				watchers: new Set(),
				timer: null,
				last: null,
				signature: '',
				scanning: false
			};
		}

		const connection = sshConnectionQueries.get(hostId);
		if (!connection) throw new Error('That SSH host no longer exists.');

		const lease = await sshClientPool.acquire(hostId);
		try {
			const runner = new SshCommandRunner(connection.name, lease.client);
			const platform = await detectRemotePlatform(hostId, runner);
			return {
				scanner: new HostContainerScanner(hostId, connection.name, runner, platform),
				runner,
				platform,
				lease,
				watchers: new Set(),
				timer: null,
				last: null,
				signature: '',
				scanning: false
			};
		} catch (error) {
			lease.release();
			throw error;
		}
	}

	private disposeHost(hostId: string): void {
		const state = this.hosts.get(hostId);
		if (!state) return;
		if (state.timer) clearInterval(state.timer);
		state.lease?.release();
		this.hosts.delete(hostId);
		if (hostId !== LOCAL_HOST_ID) {
			forgetRuntime(hostId);
			forgetContainerPortIndex(hostId);
		}
	}

	// -- scanning ------------------------------------------------------------

	/**
	 * Run one scan and push it to watchers if anything changed. Overlapping ticks
	 * are dropped rather than queued: a slow host would otherwise build a backlog
	 * of listings that are all stale by the time they run.
	 */
	private async tick(hostId: string): Promise<void> {
		const state = this.hosts.get(hostId);
		if (!state || state.scanning) return;

		state.scanning = true;
		try {
			const result = await state.scanner.scan();
			state.last = result;
			// The port table reads this for free while a Containers panel is open.
			noteContainerScan(result);

			if (hostId === LOCAL_HOST_ID) this.publishBadge(countRunning(result));

			const signature = signatureOf(result);
			if (signature === state.signature) return;
			state.signature = signature;

			for (const userId of state.watchers) {
				ws.emit.user(userId, 'containers:changed', { result });
			}
		} catch (error) {
			debug.warn('containers', `scan failed for ${hostId}:`, error);
		} finally {
			state.scanning = false;
		}
	}

	private ensureTimer(hostId: string): void {
		const state = this.hosts.get(hostId);
		if (!state || state.timer) return;
		state.timer = setInterval(
			() => {
				void this.tick(hostId);
			},
			hostId === LOCAL_HOST_ID ? WATCH_INTERVAL_MS : REMOTE_WATCH_INTERVAL_MS
		);
		// A poll for a panel nobody is looking at must not hold the process open.
		state.timer.unref?.();
	}

	// -- public API ----------------------------------------------------------

	/** Start watching a host for a user, and return the first listing immediately. */
	async watch(hostId: string, userId: string): Promise<ContainerScanResult> {
		const state = await this.ensureHost(hostId);

		state.watchers.add(userId);

		// Scan through the scanner's own guard, so this first read cannot run
		// alongside a tick on the same connection.
		const result = state.last ?? (await state.scanner.scan());
		state.last = result;
		state.signature = signatureOf(result);
		noteContainerScan(result);
		if (hostId === LOCAL_HOST_ID) this.publishBadge(countRunning(result));

		this.ensureTimer(hostId);
		return result;
	}

	/** Stop watching. The host is torn down once nobody is left looking. */
	unwatch(hostId: string, userId: string): void {
		const state = this.hosts.get(hostId);
		if (!state) return;

		state.watchers.delete(userId);
		if (state.watchers.size > 0) return;

		// The local host keeps its scanner: the badge ticker reuses it, and the
		// image catalogue would otherwise be re-read from scratch on every open.
		if (hostId === LOCAL_HOST_ID) {
			if (state.timer) clearInterval(state.timer);
			state.timer = null;
			return;
		}
		this.disposeHost(hostId);
	}

	/** A one-shot listing, for a host the caller is not watching. */
	async scanOnce(hostId: string): Promise<ContainerScanResult> {
		const existing = this.hosts.get(hostId);
		if (existing) return existing.scanner.scan();

		const state = await this.createHost(hostId);
		try {
			return await state.scanner.scan();
		} finally {
			// The lease goes back, but the runtime answer stays: it is keyed by host
			// with its own expiry, and an action that lists then acts would
			// otherwise re-probe the host twice for something that cannot have
			// changed in between.
			state.lease?.release();
		}
	}

	/** The runner and platform for a host, so an action can reuse the transport. */
	async withHost<T>(
		hostId: string,
		fn: (runner: CommandRunner, platform: ProbePlatform) => Promise<T>
	): Promise<T> {
		const existing = this.hosts.get(hostId);
		if (existing) {
			// Take a lease of this operation's own, rather than riding the watch's.
			// A prune or a disk reading outlives the panel that started it — that is
			// the point of them — and closing that panel ends the watch, releases
			// its lease, and leaves the pool free to sweep the connection out from
			// under a command that is still running. Refcounting the transport for
			// the length of the operation is what makes closing the panel harmless.
			const lease = existing.lease ? await sshClientPool.acquire(hostId) : null;
			try {
				return await fn(existing.runner, existing.platform);
			} finally {
				lease?.release();
			}
		}

		const state = await this.createHost(hostId);
		try {
			return await fn(state.runner, state.platform);
		} finally {
			state.lease?.release();
		}
	}

	/**
	 * Force the next tick to push, after an action that changed the list. The
	 * image and volume catalogue is dropped too: starting a container is exactly
	 * when a volume's "in use" answer changes.
	 */
	invalidate(hostId: string): void {
		const state = this.hosts.get(hostId);
		if (!state) return;
		state.signature = '';
		state.scanner.invalidateCatalog();
		void this.tick(hostId);
	}

	/** Whether a container exists on a host — the check before exec or logs. */
	async findContainer(hostId: string, containerId: string) {
		const result = await this.scanOnce(hostId);
		return result.entries.find((entry) => entry.id === containerId) ?? null;
	}

	// -- sidebar count -------------------------------------------------------

	private publishBadge(count: number): void {
		if (count === this.badgeCount) return;
		this.badgeCount = count;
		ws.emit.global('containers:badge', { count });
	}

	/**
	 * The count behind the sidebar dot: containers running on this machine.
	 *
	 * Deliberately not a scan. The badge runs forever, whether or not anyone ever
	 * opens the panel, and a scan reads the image and volume catalogues too — on
	 * a developer's machine that is hundreds of volumes listed every fifteen
	 * seconds to produce a single number. `ps --quiet` answers the actual
	 * question and nothing else.
	 *
	 * Returned as well as published, because a client that has just loaded needs
	 * the current number and pushes only carry changes — a page refresh would
	 * otherwise sit at zero until something happened to move it.
	 */
	async refreshBadge(): Promise<number> {
		const local = this.hosts.get(LOCAL_HOST_ID);
		// A watched panel is already listing; reuse what it last saw.
		if (local?.timer && local.last) return countRunning(local.last);

		try {
			const state = await this.ensureHost(LOCAL_HOST_ID);
			const info = await detectRuntime(LOCAL_HOST_ID, state.runner, state.platform);
			// No runtime is a real answer, and a cached one: zero costs no command.
			if (info.problem !== 'none' || !info.runtime) {
				this.publishBadge(0);
				return 0;
			}

			const result = await tryRun(
				state.runner,
				containerArgv(info.runtime, state.platform, ['ps', '--quiet', '--filter', 'status=running']),
				10_000
			);
			if (result.code !== 0) return this.badgeCount;

			const count = result.stdout.split('\n').filter((line) => line.trim().length > 0).length;
			this.publishBadge(count);
			return count;
		} catch (error) {
			debug.warn('containers', 'badge count failed:', error);
			return this.badgeCount;
		}
	}

	/**
	 * The periodic count. A machine with no runtime costs one cached lookup and
	 * no command at all, because the runtime probe remembers that answer.
	 */
	private async badgeTick(): Promise<void> {
		const local = this.hosts.get(LOCAL_HOST_ID);
		if (local?.timer) return; // A watched panel already refreshes the count.
		await this.refreshBadge();
	}

	start(): void {
		if (this.badgeTimer) return;
		this.badgeTimer = setInterval(() => {
			void this.badgeTick();
		}, BADGE_INTERVAL_MS);
		this.badgeTimer.unref?.();
	}

	stop(): void {
		if (this.badgeTimer) clearInterval(this.badgeTimer);
		this.badgeTimer = null;
		for (const hostId of [...this.hosts.keys()]) this.disposeHost(hostId);
	}
}

function countRunning(result: ContainerScanResult): number {
	return result.entries.filter((entry) => entry.state === 'running').length;
}

export const containerMonitor = new ContainerMonitor();
