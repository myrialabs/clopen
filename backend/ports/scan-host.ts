/**
 * Port manager — one host, one scan, one table.
 *
 * Ties the probe, the process table and the attribution together into the rows
 * the panel renders. Held per host so the process cache survives between ticks,
 * which is what makes a one-second poll cost a single cheap probe.
 */

import os from 'node:os';
import type {
	PortContainerRef,
	PortEntry,
	PortIpVersion,
	PortKillBlockedReason,
	PortLimitation,
	PortOrigin,
	PortPeer,
	PortProtocol,
	PortScanResult,
	PortSocket
} from '$shared/types/ports';
import { LOCAL_PORT_HOST } from '$shared/types/ports';
import { scanSockets, type ProbeMemo } from './scan';
import { ProcessTable } from './processes';
import { attribute, buildContext, groupListenerPids } from './attribute';
import { collectExposedPorts } from './registry';
import { resolveClopenPids } from './ssh-lineage';
import {
	addressesOverlap,
	containerPortIndex,
	refreshContainerPortIndex
} from '../containers/port-index';
import type { CommandRunner, ProbePlatform } from '../host/runner';

/** Who the scan is running as, which decides what it may signal. */
export interface ScanPrincipal {
	user: string | null;
	isRoot: boolean;
}

export function localPrincipal(): ScanPrincipal {
	let user: string | null = null;
	try {
		user = os.userInfo().username;
	} catch {
		// Some container images have no passwd entry for the running uid.
		user = null;
	}
	const uid = typeof process.getuid === 'function' ? process.getuid() : null;
	// Windows has no uid; an Administrator there still fails to signal some
	// processes, so the kill attempt reports the truth rather than predicting it.
	return { user, isRoot: uid === 0 };
}

const NO_CLOPEN_LINEAGE: PortLimitation = {
	code: 'no-session-attribution',
	message:
		'Nothing listening here belongs to Clopen’s own SSH connection. If you started a server from a Clopen terminal on this host and it is not listed under “Started from Clopen”, this host does not let Clopen read a process’s environment.'
};

/** How a published port describes itself: by the container, not the proxy. */
function containerOrigin(ref: PortContainerRef): PortOrigin {
	return {
		kind: 'container',
		// The runtime states this outright — there is nothing to infer.
		confidence: 'certain',
		label: ref.name,
		detail: `${ref.image} · container port ${ref.containerPort}`,
		containerId: ref.id
	};
}

function protocolPortKey(protocol: PortProtocol, port: number): string {
	return `${protocol}:${port}`;
}

/** Peers connected to each listening port, keyed `protocol:port`. */
function collectPeers(sockets: PortSocket[]): Map<string, PortPeer[]> {
	const peers = new Map<string, PortPeer[]>();

	for (const socket of sockets) {
		if (socket.state !== 'established' || socket.peerAddress === null || socket.peerPort === null) continue;
		const key = protocolPortKey(socket.protocol, socket.port);
		const list = peers.get(key);
		const peer: PortPeer = {
			address: socket.peerAddress,
			port: socket.peerPort,
			processName: socket.processName
		};
		if (list) list.push(peer);
		else peers.set(key, [peer]);
	}

	return peers;
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

/**
 * One host's scanner. Construct once per watched host so the process table and
 * its cwd cache persist; drop it when the host stops being watched.
 */
export class HostPortScanner {
	private readonly processes: ProcessTable;
	/** Which probe answered for this host; the chain is walked once. */
	private readonly probeMemo: ProbeMemo = {};
	/**
	 * A scan already running. Callers join it instead of starting a second one:
	 * a remote scan can outlast the poll interval, and two in flight would double
	 * the SSH channels while writing to the same process cache.
	 */
	private inFlight: Promise<PortScanResult> | null = null;

	constructor(
		private readonly hostId: string,
		private readonly hostName: string,
		private readonly runner: CommandRunner,
		private readonly platform: ProbePlatform,
		private readonly principal: ScanPrincipal
	) {
		this.processes = new ProcessTable(runner, platform);
	}

	private get isLocal(): boolean {
		return this.hostId === LOCAL_PORT_HOST;
	}

	/**
	 * Whether this scan could plausibly signal a process. Ownership is the only
	 * thing knowable in advance; anything subtler is left to the kill attempt,
	 * which reports what the OS actually said.
	 */
	private killability(
		pid: number | null,
		ownerUser: string | null,
		isClopenItself: boolean
	): { canKill: boolean; reason: PortKillBlockedReason | null } {
		if (isClopenItself) return { canKill: false, reason: 'is-clopen-itself' };
		if (pid === null) return { canKill: false, reason: 'unknown-pid' };
		if (pid <= 1) return { canKill: false, reason: 'system-process' };
		if (this.principal.isRoot) return { canKill: true, reason: null };
		if (ownerUser && this.principal.user && ownerUser !== this.principal.user) {
			return { canKill: false, reason: 'not-permitted' };
		}
		return { canKill: true, reason: null };
	}

	/** Read this host, joining a scan already in progress rather than racing it. */
	async scan(now = Date.now()): Promise<PortScanResult> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.runScan(now).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async runScan(now: number): Promise<PortScanResult> {
		const scannedAt = new Date(now).toISOString();

		let sockets: PortSocket[];
		let limitations: PortLimitation[];
		let probe: string;
		try {
			const result = await scanSockets(this.runner, this.platform, this.probeMemo);
			sockets = result.sockets;
			limitations = result.limitations;
			probe = result.probe;
		} catch (error) {
			return {
				hostId: this.hostId,
				scannedAt,
				platform: this.platform,
				probe: 'none',
				entries: [],
				limitations: [],
				error: error instanceof Error ? error.message : String(error)
			};
		}

		const listening = sockets.filter((socket) => socket.state === 'listen');
		const pids = unique(listening.map((socket) => socket.pid).filter((pid): pid is number => pid !== null));

		const processes = await this.processes.refresh(pids, now);
		limitations = [...limitations, ...this.processes.getLimitations()];

		// On an SSH host, a process is Clopen's if it belongs to Clopen's own SSH
		// connection — the same tier as locally, established from the far end.
		const clopenPids = this.isLocal
			? new Set<number>()
			: await resolveClopenPids(this.hostId, this.runner, this.platform, pids, processes);
		if (!this.isLocal && clopenPids.size === 0 && pids.length > 0) {
			limitations.push(NO_CLOPEN_LINEAGE);
		}

		const context = buildContext({
			platform: this.platform,
			processes,
			hostId: this.hostId,
			hostName: this.hostName,
			isLocal: this.isLocal,
			clopenPids
		});
		const peers = collectPeers(sockets);
		const exposed = this.isLocal ? collectExposedPorts() : new Map<number, string>();
		// Read now, refresh behind us: a table that ticks every second must never
		// wait on a `docker ps`, and a mapping that lands one tick late is
		// invisible next to one that made the whole table stutter.
		const containers = containerPortIndex(this.hostId);
		refreshContainerPortIndex(this.hostId, this.runner, this.platform, now);

		// Bucket the listening sockets per protocol+port first; a port is the
		// unit the user thinks in, and the addresses under it are detail.
		const buckets = new Map<string, PortSocket[]>();
		for (const socket of listening) {
			const key = protocolPortKey(socket.protocol, socket.port);
			const bucket = buckets.get(key);
			if (bucket) bucket.push(socket);
			else buckets.set(key, [socket]);
		}

		const entries: PortEntry[] = [];
		/** Mappings that found a socket to sit on; the rest get their own row. */
		const annotated = new Set<string>();

		for (const [key, bucket] of buckets) {
			const { protocol, port } = bucket[0];
			const bucketPids = unique(bucket.map((socket) => socket.pid).filter((pid): pid is number => pid !== null));
			const groups = groupListenerPids(bucketPids, processes);

			// Sockets whose owner the probe could not name still deserve a row —
			// an unexplained open port is exactly what someone opens this for.
			const orphans = bucket.filter((socket) => socket.pid === null);
			if (orphans.length > 0) groups.push({ owner: -1, members: [] });

			for (const { owner, members } of groups) {
				const memberPids = new Set(members);
				const groupSockets =
					owner === -1
						? orphans
						: bucket.filter((socket) => socket.pid !== null && memberPids.has(socket.pid));
				if (groupSockets.length === 0) continue;

				const representative = groupSockets[0];
				const pid = owner === -1 ? null : owner;
				const process = pid !== null ? (processes.get(pid) ?? null) : null;
				const attributed = attribute({ ...representative, pid }, context);
				// A published container port outranks whatever holds the socket: the
				// listener is the runtime's own proxy, and signalling it would either
				// fail or be undone by the daemon a moment later. Clopen's own
				// listeners are the exception — those it does know better.
				const candidate = attributed.kind === 'clopen' ? undefined : containers.get(key);
				const groupAddresses = unique(groupSockets.map((socket) => socket.address));
				const mapping =
					candidate && addressesOverlap(groupAddresses, candidate.addresses) ? candidate : undefined;
				if (mapping) annotated.add(key);
				const origin = mapping ? containerOrigin(mapping.ref) : attributed;
				const ownerUser = process?.user ?? representative.user;
				const { canKill, reason } = mapping
					? { canKill: false, reason: 'managed-by-container' as PortKillBlockedReason }
					: this.killability(pid, ownerUser, origin.ownerFeature === 'server');

				entries.push({
					key: `${this.hostId}:${key}:${pid ?? 'unknown'}`,
					protocol,
					port,
					addresses: [...groupAddresses].sort(),
					ipVersions: unique(groupSockets.map((socket) => socket.ipVersion)).sort(),
					pid,
					process,
					workerPids: members,
					origin,
					peers: peers.get(key) ?? [],
					peerCount: (peers.get(key) ?? []).length,
					publicUrl: exposed.get(port) ?? null,
					container: mapping?.ref ?? null,
					canKill,
					killBlockedReason: reason
				});
			}
		}

		// Mappings with no socket behind them still get a row. Docker publishes
		// through a firewall rule when its userland proxy is off, and Podman's
		// rootless networking often leaves nothing for the probe to find either —
		// so without this the port a user can actually reach would be missing from
		// the one table that claims to list what is reachable.
		for (const [mappingKey, mapping] of containers) {
			if (annotated.has(mappingKey)) continue;
			const [protocolText, portText] = mappingKey.split(':');
			const port = Number(portText);
			if (!Number.isFinite(port)) continue;
			const protocol = protocolText === 'udp' ? 'udp' : 'tcp';

			entries.push({
				key: `${this.hostId}:${mappingKey}:container`,
				protocol,
				port,
				addresses: [...mapping.addresses].sort(),
				ipVersions: unique(
					mapping.addresses.map((address): PortIpVersion => (address.includes(':') ? 'v6' : 'v4'))
				).sort(),
				pid: null,
				process: null,
				workerPids: [],
				origin: containerOrigin(mapping.ref),
				peers: peers.get(mappingKey) ?? [],
				peerCount: (peers.get(mappingKey) ?? []).length,
				publicUrl: exposed.get(port) ?? null,
				container: mapping.ref,
				canKill: false,
				killBlockedReason: 'managed-by-container'
			});
		}

		entries.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));

		return {
			hostId: this.hostId,
			scannedAt,
			platform: this.platform,
			probe,
			entries,
			limitations,
			error: null
		};
	}
}
