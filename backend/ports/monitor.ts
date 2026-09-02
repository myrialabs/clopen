/**
 * Port manager — keeping the table live.
 *
 * No operating system offers a portable way to be *told* that a port opened.
 * macOS exposes no socket-table event API at all, Windows' change
 * notifications do not cover the TCP listener table, and Linux's `sock_diag`
 * netlink is a query interface — `ss --events` only reports destroyed sockets
 * and needs privileges besides. An event-driven implementation would therefore
 * exist on one platform and be partial even there.
 *
 * So this polls, and earns the right to by being cheap and quiet:
 *
 * - A warm local scan is one `lsof` plus a cached process table — tens of
 *   milliseconds — so a watched panel ticks every second and reads as live. An
 *   SSH host ticks every three: each scan is a round trip on the connection the
 *   terminal and file browser are also using.
 * - Results are diffed server-side and only pushed when something actually
 *   changed, so a static machine costs no traffic at all.
 * - With no panel open, the only work is the sidebar count, refreshed every
 *   fifteen seconds at roughly fifteen milliseconds a time.
 * - A remote host is scanned only while its tab is open, on a lease borrowed
 *   from the pool the terminal and file browser already keep warm.
 */

import type { PortScanResult } from '$shared/types/ports';
import { LOCAL_PORT_HOST } from '$shared/types/ports';
import { HostPortScanner, localPrincipal, type ScanPrincipal } from './scan-host';
import {
	LocalCommandRunner,
	SshCommandRunner,
	detectRemotePlatform,
	forgetRemotePlatform,
	localPlatform,
	type CommandRunner,
	type ProbePlatform
} from '../host/runner';
import { sshClientPool, type SshLease } from '../ssh/client-pool';
import { forgetClopenRootPid } from './ssh-lineage';
import { sshConnectionQueries } from '../database/queries';
import { ws } from '../utils/ws';
import { debug } from '$shared/utils/logger';

/** Panel open on this machine: a scan is milliseconds, so it can be brisk. */
const WATCH_INTERVAL_MS = 1_000;
/**
 * Panel open on an SSH host. Every scan there is a round trip over the same
 * connection the terminal and file browser are using, so it is paced to stay
 * out of their way while still reading as live.
 */
const REMOTE_WATCH_INTERVAL_MS = 3_000;
/** Panel closed: only the sidebar count, and only when a terminal is running. */
const BADGE_INTERVAL_MS = 15_000;

interface HostState {
	scanner: HostPortScanner;
	runner: CommandRunner;
	platform: ProbePlatform;
	lease: SshLease | null;
	/** User ids currently looking at this host. */
	watchers: Set<string>;
	timer: ReturnType<typeof setInterval> | null;
	last: PortScanResult | null;
	signature: string;
	scanning: boolean;
}

/**
 * What a client would notice changing. Deliberately excludes the timestamp and
 * live counters like cpu, so an idle machine produces an identical signature
 * tick after tick and nothing is sent.
 */
function signatureOf(result: PortScanResult): string {
	if (result.error) return `error:${result.error}`;
	return result.entries
		.map((entry) => `${entry.key}|${entry.origin.label}|${entry.peerCount}|${entry.publicUrl ?? ''}|${entry.workerPids.length}`)
		.join('\n');
}

class PortMonitor {
	private hosts = new Map<string, HostState>();
	/**
	 * Hosts being set up right now. Creating a host acquires an SSH lease, so two
	 * concurrent callers would each take one and only the last would be kept —
	 * the other lease then leaks for the life of the process, holding a
	 * connection open that nothing will ever release.
	 */
	private opening = new Map<string, Promise<HostState>>();
	private badgeTimer: ReturnType<typeof setInterval> | null = null;
	private badgeCount = 0;

	// -- host lifecycle ------------------------------------------------------

	/** The host's state, created once however many callers ask at the same time. */
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
		if (hostId === LOCAL_PORT_HOST) {
			const runner = new LocalCommandRunner();
			const platform = localPlatform();
			return {
				scanner: new HostPortScanner(hostId, 'this machine', runner, platform, localPrincipal()),
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
			const principal: ScanPrincipal = {
				user: connection.username,
				isRoot: connection.username === 'root'
			};
			return {
				scanner: new HostPortScanner(hostId, connection.name, runner, platform, principal),
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
		if (hostId !== LOCAL_PORT_HOST) {
			forgetRemotePlatform(hostId);
			forgetClopenRootPid(hostId);
		}
	}

	// -- scanning ------------------------------------------------------------

	/**
	 * Run one scan and push it to watchers if anything changed. Overlapping
	 * ticks are dropped rather than queued: a slow host would otherwise build a
	 * backlog of scans that are all stale by the time they run.
	 */
	private async tick(hostId: string): Promise<void> {
		const state = this.hosts.get(hostId);
		if (!state || state.scanning) return;

		state.scanning = true;
		try {
			const result = await state.scanner.scan();
			state.last = result;

			if (hostId === LOCAL_PORT_HOST) this.publishBadge(countSessionPorts(result));

			const signature = signatureOf(result);
			if (signature === state.signature) return;
			state.signature = signature;

			for (const userId of state.watchers) {
				ws.emit.user(userId, 'ports:changed', { result });
			}
		} catch (error) {
			debug.warn('ports', `scan failed for ${hostId}:`, error);
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
			hostId === LOCAL_PORT_HOST ? WATCH_INTERVAL_MS : REMOTE_WATCH_INTERVAL_MS
		);
		// A poll for a panel nobody is looking at must not hold the process open.
		state.timer.unref?.();
	}

	// -- public API ----------------------------------------------------------

	/** Start watching a host for a user, and return the first scan immediately. */
	async watch(hostId: string, userId: string): Promise<PortScanResult> {
		const state = await this.ensureHost(hostId);

		state.watchers.add(userId);

		// Scan before starting the timer, and through the scanner's own guard, so
		// this first read cannot run alongside a tick on the same connection.
		const result = state.last ?? (await state.scanner.scan());
		state.last = result;
		state.signature = signatureOf(result);
		if (hostId === LOCAL_PORT_HOST) this.publishBadge(countSessionPorts(result));

		this.ensureTimer(hostId);
		return result;
	}

	/** Stop watching. The host is torn down once nobody is left looking. */
	unwatch(hostId: string, userId: string): void {
		const state = this.hosts.get(hostId);
		if (!state) return;

		state.watchers.delete(userId);
		if (state.watchers.size > 0) return;

		// The local host keeps its scanner: the badge ticker reuses the process
		// cache, and rebuilding it costs a full sweep.
		if (hostId === LOCAL_PORT_HOST) {
			if (state.timer) clearInterval(state.timer);
			state.timer = null;
			return;
		}
		this.disposeHost(hostId);
	}

	/** A one-shot scan, for a host the caller is not watching. */
	async scanOnce(hostId: string): Promise<PortScanResult> {
		const existing = this.hosts.get(hostId);
		if (existing) return existing.scanner.scan();

		const state = await this.createHost(hostId);
		try {
			return await state.scanner.scan();
		} finally {
			state.lease?.release();
			if (hostId !== LOCAL_PORT_HOST) {
				forgetRemotePlatform(hostId);
				forgetClopenRootPid(hostId);
			}
		}
	}

	/** The runner and platform for a host, so an action can reuse the transport. */
	async withHost<T>(hostId: string, fn: (runner: CommandRunner, platform: ProbePlatform) => Promise<T>): Promise<T> {
		const existing = this.hosts.get(hostId);
		if (existing) return fn(existing.runner, existing.platform);

		const state = await this.createHost(hostId);
		try {
			return await fn(state.runner, state.platform);
		} finally {
			state.lease?.release();
		}
	}

	/** Force the next tick to push, after an action that changed the table. */
	invalidate(hostId: string): void {
		const state = this.hosts.get(hostId);
		if (state) state.signature = '';
		void this.tick(hostId);
	}

	// -- sidebar count -------------------------------------------------------

	private publishBadge(count: number): void {
		if (count === this.badgeCount) return;
		this.badgeCount = count;
		ws.emit.global('ports:badge', { count });
	}

	/**
	 * The count behind the sidebar dot: ports Clopen started on this machine.
	 *
	 * Returned as well as published, because a client that has just loaded needs
	 * the current number and pushes only carry changes — a page refresh would
	 * otherwise sit at zero until something happened to move it.
	 */
	async refreshBadge(): Promise<number> {
		const local = this.hosts.get(LOCAL_PORT_HOST);
		// A watched panel is already scanning; reuse what it last saw.
		if (local?.timer && local.last) return countSessionPorts(local.last);

		try {
			const state = await this.ensureHost(LOCAL_PORT_HOST);
			const result = await state.scanner.scan();
			state.last = result;
			const count = countSessionPorts(result);
			this.publishBadge(count);
			return count;
		} catch (error) {
			debug.warn('ports', 'badge scan failed:', error);
			return this.badgeCount;
		}
	}

	/**
	 * The periodic count.
	 *
	 * This used to skip the scan when no terminal session existed, on the
	 * grounds that nothing could then have been started from Clopen. That stops
	 * being true once the count includes everything Clopen spawns — an engine,
	 * an MCP server, the preview browser — none of which need a terminal. The
	 * guard would have reported a confident zero over a running engine, so it
	 * is gone: a scan every fifteen seconds costs about fifteen milliseconds.
	 */
	private async badgeTick(): Promise<void> {
		const local = this.hosts.get(LOCAL_PORT_HOST);
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

function countSessionPorts(result: PortScanResult): number {
	return result.entries.filter((entry) => entry.origin.kind === 'session').length;
}

export const portMonitor = new PortMonitor();
