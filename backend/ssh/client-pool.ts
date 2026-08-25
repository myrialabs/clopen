/**
 * ssh-client — one live ssh2 client per saved connection, shared by everything.
 *
 * SSH multiplexes channels over a single transport, so a host's terminal tabs,
 * its file browser and its port forwards all ride one authenticated connection
 * — the user authenticates once, not once per feature.
 *
 * Leases decide when that connection may close. A terminal tab or a running
 * forward holds a lease for as long as it lives; a one-shot SFTP call holds one
 * for the length of the call. An entry with no leases is swept after IDLE_MS.
 */

import type { Client as SshClient } from 'ssh2';
import { sshConnectionQueries } from '../database/queries';
import { closeChain, dial, type DialResult } from './connect';
import { debug } from '$shared/utils/logger';

/** How long a lease-free connection stays warm before being dropped. */
const IDLE_MS = 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

interface PoolEntry {
	dialed: DialResult;
	leases: number;
	lastUsedAt: number;
	alive: boolean;
}

export interface SshLease {
	client: SshClient;
	/** Release this lease. Idempotent — calling it twice does not double-count. */
	release(): void;
}

class SshClientPool {
	private entries = new Map<string, PoolEntry>();
	private pending = new Map<string, Promise<PoolEntry>>();
	/**
	 * Hosts the user explicitly disconnected. The pool dials on demand, so
	 * without this a "Disconnect" would be undone by the next keystroke in a
	 * terminal or click in the file browser — the button has to actually mean
	 * something. Runtime-only: a restart starts every host reconnectable.
	 */
	private suspended = new Set<string>();
	private sweeperHandle: ReturnType<typeof setInterval> | null = null;

	private startSweeper(): void {
		if (this.sweeperHandle) return;
		this.sweeperHandle = setInterval(() => this.sweepIdle(), SWEEP_INTERVAL_MS);
		// Don't keep the process alive just for this timer.
		(this.sweeperHandle as unknown as { unref?: () => void }).unref?.();
	}

	private async openEntry(connectionId: string): Promise<PoolEntry> {
		const connection = sshConnectionQueries.get(connectionId);
		if (!connection) throw new Error('ssh connection not found');

		const dialed = await dial(connection);
		const entry: PoolEntry = { dialed, leases: 0, lastUsedAt: Date.now(), alive: true };

		// A dropped transport must not be handed to the next caller. Mark the
		// entry dead and drop it so the following acquire dials fresh.
		const invalidate = (): void => {
			if (!entry.alive) return;
			entry.alive = false;
			if (this.entries.get(connectionId) === entry) {
				this.entries.delete(connectionId);
			}
			debug.log('ssh', `connection ${connectionId} closed`);
		};
		dialed.client.on('close', invalidate);
		dialed.client.on('end', invalidate);
		dialed.client.on('error', (error: Error) => {
			debug.warn('ssh', `connection ${connectionId} error: ${error.message}`);
			invalidate();
		});

		sshConnectionQueries.markUsed(connectionId);
		return entry;
	}

	/**
	 * Take a lease on the connection, dialing it if needed. Concurrent callers
	 * for the same host share one dial rather than racing two handshakes.
	 */
	async acquire(connectionId: string): Promise<SshLease> {
		if (this.suspended.has(connectionId)) {
			throw new Error('This host is disconnected — use Connect to open it again');
		}
		this.startSweeper();

		const existing = this.entries.get(connectionId);
		if (existing?.alive) {
			return this.leaseOf(connectionId, existing);
		}

		let inFlight = this.pending.get(connectionId);
		if (!inFlight) {
			inFlight = this.openEntry(connectionId).finally(() => this.pending.delete(connectionId));
			this.pending.set(connectionId, inFlight);
		}

		const entry = await inFlight;
		// Another caller's dial may already be registered; prefer whichever entry
		// is live so both callers end up on the same transport.
		const current = this.entries.get(connectionId);
		if (current?.alive && current !== entry) {
			closeChain(entry.dialed.chain);
			return this.leaseOf(connectionId, current);
		}
		this.entries.set(connectionId, entry);
		return this.leaseOf(connectionId, entry);
	}

	private leaseOf(connectionId: string, entry: PoolEntry): SshLease {
		entry.leases++;
		entry.lastUsedAt = Date.now();
		let released = false;
		return {
			client: entry.dialed.client,
			release: () => {
				if (released) return;
				released = true;
				entry.leases = Math.max(0, entry.leases - 1);
				entry.lastUsedAt = Date.now();
				debug.log('ssh', `lease released for ${connectionId} (${entry.leases} remaining)`);
			}
		};
	}

	/** Run one operation under a lease, releasing it even if the operation throws. */
	async use<T>(connectionId: string, operation: (client: SshClient) => Promise<T>): Promise<T> {
		const lease = await this.acquire(connectionId);
		try {
			return await operation(lease.client);
		} finally {
			lease.release();
		}
	}

	/** True when the host currently has a live, authenticated transport. */
	isLive(connectionId: string): boolean {
		return this.entries.get(connectionId)?.alive === true;
	}

	/** True when the user disconnected this host and has not reconnected it. */
	isSuspended(connectionId: string): boolean {
		return this.suspended.has(connectionId);
	}

	/** Close the host and refuse to redial it until `resume` is called. */
	suspend(connectionId: string): void {
		this.suspended.add(connectionId);
		this.release(connectionId);
	}

	/** Allow the host to be dialed again. */
	resume(connectionId: string): void {
		this.suspended.delete(connectionId);
	}

	/** Close a host's transport now, whatever its leases. Used on edit and delete. */
	release(connectionId: string): void {
		const entry = this.entries.get(connectionId);
		if (!entry) return;
		this.entries.delete(connectionId);
		entry.alive = false;
		closeChain(entry.dialed.chain);
	}

	private sweepIdle(): void {
		const now = Date.now();
		for (const [connectionId, entry] of this.entries) {
			if (entry.leases > 0) continue;
			if (!entry.alive || now - entry.lastUsedAt > IDLE_MS) {
				debug.log('ssh', `idle sweep: closing ${connectionId}`);
				this.entries.delete(connectionId);
				entry.alive = false;
				closeChain(entry.dialed.chain);
			}
		}
	}

	closeAll(): void {
		this.suspended.clear();
		for (const connectionId of [...this.entries.keys()]) {
			this.release(connectionId);
		}
		if (this.sweeperHandle) {
			clearInterval(this.sweeperHandle);
			this.sweeperHandle = null;
		}
	}
}

export const sshClientPool = new SshClientPool();
