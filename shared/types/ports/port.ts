/**
 * Port manager — the shape of "what is listening, and who opened it".
 *
 * One model serves both the machine running Clopen and any saved SSH host, so
 * the same table, the same attribution and the same detail pane render either.
 * Where a platform cannot answer a question the field is `null` and the reason
 * is reported in `limitations` — a port with an unknown owner says so rather
 * than guessing.
 */

import { LOCAL_HOST_ID, type HostId } from '../host';

export type PortProtocol = 'tcp' | 'udp';

export type PortIpVersion = 'v4' | 'v6';

/**
 * Only the three states worth acting on. Everything transient (TIME_WAIT,
 * SYN_SENT, the rest of the TCP state machine) collapses into `other` — it
 * describes a socket that is closing, not a port anyone owns.
 */
export type PortSocketState = 'listen' | 'established' | 'other';

/** A socket row exactly as the OS probe reported it, before any attribution. */
export interface PortSocket {
	protocol: PortProtocol;
	ipVersion: PortIpVersion;
	/** Local bind address. `*` means every interface. */
	address: string;
	port: number;
	state: PortSocketState;
	/** Null when the probe could not see the owner — see `PortLimitationCode`. */
	pid: number | null;
	/** Short on Linux `ss`, full path on macOS `lsof`, absent on Windows netstat. */
	processName: string | null;
	user: string | null;
	peerAddress: string | null;
	peerPort: number | null;
}

/** Process facts behind a socket, resolved once per pid and cached. */
export interface PortProcess {
	pid: number;
	parentPid: number | null;
	user: string | null;
	/** Full argv when the platform exposes it, else the executable name. */
	command: string;
	/** ISO timestamp. Also disambiguates a reused pid from the cached one. */
	startedAt: string | null;
	/**
	 * Working directory — the strongest hint at *which project* a dev server
	 * belongs to. Unavailable on Windows, and on Unix only for our own user.
	 */
	cwd: string | null;
}

/**
 * How confident the attribution is. `certain` means Clopen either opened the
 * listener itself or watched the process being born; `guess` means the label
 * was inferred from the command line and may be wrong.
 */
export type PortOriginConfidence = 'certain' | 'guess';

/**
 * The four tiers the UI groups by:
 * - `clopen`    — a listener Clopen opened, registered by the feature that owns it
 * - `session`   — a process descended from a Clopen terminal session
 * - `container` — a port a container runtime publishes on this host
 * - `external`  — everything else on the machine
 */
export type PortOriginKind = 'clopen' | 'session' | 'container' | 'external';

/** Which Clopen feature owns a `clopen` port, so it can be stopped properly. */
export type PortOwnerFeature =
	| 'server'
	| 'tunnel'
	| 'ssh-forward'
	| 'db-client-tunnel'
	| 'preview-browser'
	| 'mcp'
	| 'engine';

export interface PortOrigin {
	kind: PortOriginKind;
	confidence: PortOriginConfidence;
	/** Short human label, e.g. "Clopen server" or "Vite dev server". */
	label: string;
	/** Second line: the host being forwarded to, the project, the raw command. */
	detail: string | null;
	/** Set when `kind` is `clopen`. */
	ownerFeature?: PortOwnerFeature;
	/** Identifies the owning record (forward id, tunnel id, …) for the stop path. */
	ownerId?: string;
	/** Set when `kind` is `session` — the PTY session the process descends from. */
	sessionId?: string;
	/** Project the session belongs to, so the UI can name it. */
	projectId?: string;
	/** Set when the lineage ends at an sshd session rather than a Clopen one. */
	remoteSessionUser?: string;
	/** Set when `kind` is `container` — the container publishing this port. */
	containerId?: string;
}

/**
 * The container publishing a port, when one does.
 *
 * A published port is a fact the runtime states outright, so this is never a
 * guess. It is also the only owner worth naming: the listening process is
 * `docker-proxy` or the daemon itself, and with the userland proxy disabled
 * there is no listening socket at all — the port is reached through a firewall
 * rule. Either way the thing to act on is the container.
 */
export interface PortContainerRef {
	runtime: 'docker' | 'podman';
	/** Full container id, so an action can address it unambiguously. */
	id: string;
	/** Twelve-character id, which is how the runtime's own output reads. */
	shortId: string;
	name: string;
	image: string;
	/** The port inside the container this host port is mapped to. */
	containerPort: number;
}

/** A peer currently connected to a listening port. */
export interface PortPeer {
	address: string;
	port: number;
	/** Present when the probe could attribute the peer socket to a process. */
	processName: string | null;
}

/** Why a port cannot be stopped from here. */
export type PortKillBlockedReason =
	| 'is-clopen-itself'
	| 'unknown-pid'
	| 'not-permitted'
	| 'system-process'
	| 'managed-by-container';

/** One row in the table: a port, its owner, and what is connected to it. */
export interface PortEntry {
	/** Stable across scans, so the UI can diff without rebuilding the table. */
	key: string;
	protocol: PortProtocol;
	port: number;
	/** Every address this pid binds the port on, e.g. `127.0.0.1` and `::1`. */
	addresses: string[];
	ipVersions: PortIpVersion[];
	pid: number | null;
	process: PortProcess | null;
	/**
	 * Every process holding this port, when a server pre-forks workers that
	 * inherit the listening socket. One row is reported for the group, and this
	 * says how wide the group is.
	 */
	workerPids: number[];
	origin: PortOrigin;
	peers: PortPeer[];
	peerCount: number;
	/**
	 * Set when a Cloudflare tunnel points at this port. A tunnel dials the port
	 * rather than binding it, so this is exposure, not ownership — the port
	 * still belongs to whatever process is listening, and this says it is also
	 * reachable from the public internet.
	 */
	publicUrl: string | null;
	/**
	 * Set when a container runtime publishes this port. Like `publicUrl` this
	 * describes how the port is reached rather than replacing whoever holds it,
	 * and it is what lets the row point at the container instead of offering to
	 * signal a proxy process that would only come back.
	 */
	container: PortContainerRef | null;
	canKill: boolean;
	killBlockedReason: PortKillBlockedReason | null;
}

/**
 * A capability the scan could not deliver on this host. Surfaced in the UI so
 * a missing owner reads as "this platform cannot tell us" rather than a bug.
 */
export type PortLimitationCode =
	| 'pids-need-root'
	| 'no-cwd-support'
	| 'no-process-args'
	| 'no-session-attribution'
	| 'probe-fallback';

export interface PortLimitation {
	code: PortLimitationCode;
	message: string;
}

/**
 * `local` is the machine running Clopen; any other id is an SSH connection.
 * Both names point at the same value: host identity is shared by every
 * host-scoped feature, and ports keep their own spelling only for readability.
 */
export type PortHostId = HostId;

export const LOCAL_PORT_HOST: PortHostId = LOCAL_HOST_ID;

export interface PortScanResult {
	hostId: PortHostId;
	/** ISO timestamp of the scan that produced these entries. */
	scannedAt: string;
	platform: string;
	/**
	 * Which probe actually read the socket table. Reported because how much a
	 * row can say depends entirely on this — `netstat` on Windows names no
	 * process, `/proc/net` needs a second lookup for one — and because a host
	 * that answers with less than expected is otherwise impossible to explain.
	 */
	probe: string;
	entries: PortEntry[];
	limitations: PortLimitation[];
	/** Set when the scan failed outright; `entries` is then empty. */
	error: string | null;
}

/** What a kill attempt did, reported honestly including refusals. */
export interface PortKillResult {
	ok: boolean;
	/** Pids actually signalled, children first. */
	killedPids: number[];
	/** Set when the port belonged to a feature and was stopped, not signalled. */
	stoppedFeature: PortOwnerFeature | null;
	error: string | null;
}
