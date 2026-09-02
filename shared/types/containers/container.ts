/**
 * Containers — the shape of "what is running on this host, and how to reach it".
 *
 * One model serves the machine Clopen runs on and any saved SSH host, so the
 * same table, detail pane, log view and shell render either. Docker and Podman
 * answer the same questions in slightly different words; the differences are
 * flattened here rather than pushed into the UI, and anything a runtime cannot
 * report is `null` with the reason carried in `limitations` — never a guess
 * dressed as a fact.
 */

import { LOCAL_HOST_ID, type HostId } from '../host';

/** The runtimes Clopen knows how to drive. Detected, never configured. */
export type ContainerRuntime = 'docker' | 'podman';

/**
 * Lifecycle states, normalised across both runtimes. `unknown` is kept rather
 * than folded into `exited`: a state Clopen does not recognise must not be
 * rendered as one it does.
 */
export type ContainerState =
	| 'running'
	| 'paused'
	| 'restarting'
	| 'created'
	| 'exited'
	| 'dead'
	| 'removing'
	| 'unknown';

/** A healthcheck verdict. `none` means the image declares no healthcheck. */
export type ContainerHealth = 'healthy' | 'unhealthy' | 'starting' | 'none';

/**
 * One published port. `hostPort` is null when the port is exposed by the image
 * but not published to the host — the container can be reached from its own
 * network and nowhere else, which is worth showing rather than hiding.
 */
export interface ContainerPortBinding {
	/** The address on the host the port is bound to, e.g. `0.0.0.0`. */
	hostAddress: string | null;
	hostPort: number | null;
	containerPort: number;
	protocol: 'tcp' | 'udp';
}

/** One row in the container table. */
export interface ContainerEntry {
	/** Stable across scans, so the UI can diff without rebuilding the table. */
	key: string;
	/** Full id, used for every action so a name collision cannot misfire. */
	id: string;
	/** Twelve characters of the id, which is how the runtime prints it. */
	shortId: string;
	name: string;
	image: string;
	state: ContainerState;
	/** The runtime's own words, e.g. `Up 3 hours (healthy)`. */
	statusText: string;
	health: ContainerHealth;
	/** ISO timestamp, or null when the runtime printed a date nothing can parse. */
	createdAt: string | null;
	/** ISO timestamp of the current run; null unless the container is running. */
	startedAt: string | null;
	ports: ContainerPortBinding[];
	/** Set from the compose labels, so a stack reads as a stack. */
	composeProject: string | null;
	composeService: string | null;
	/** The entrypoint command, as the runtime reports it. */
	command: string | null;
	/**
	 * False when this host would refuse the action anyway — a container the
	 * account cannot touch is shown, but not offered as something to stop.
	 */
	canManage: boolean;
}

/** An image on the host. Read-only: building and pulling are out of scope. */
export interface ContainerImageEntry {
	key: string;
	id: string;
	repository: string;
	tag: string;
	/** Human size exactly as the runtime printed it. */
	size: string;
	createdAt: string | null;
	/** True for `<none>:<none>` layers left behind by a rebuild. */
	dangling: boolean;
	/** Names of containers currently using it, so deleting is never a surprise. */
	usedBy: string[];
}

/** A network on the host. */
export interface ContainerNetworkEntry {
	key: string;
	id: string;
	name: string;
	driver: string;
	scope: string;
	internal: boolean;
	createdAt: string | null;
	usedBy: string[];
	/**
	 * True for the networks the runtime creates itself — `bridge`, `host`,
	 * `none`, `podman`. They cannot be removed, and offering to would only
	 * produce an error the user cannot act on.
	 */
	predefined: boolean;
}

/** A volume on the host. */
export interface ContainerVolumeEntry {
	key: string;
	name: string;
	driver: string;
	mountpoint: string | null;
	createdAt: string | null;
	usedBy: string[];
}

/**
 * A capability this host could not deliver. Surfaced in the UI so an empty
 * table reads as "this host cannot tell us" rather than "nothing is running".
 */
export type ContainerLimitationCode =
	| 'no-runtime'
	| 'daemon-unreachable'
	| 'permission-denied'
	| 'images-unavailable'
	| 'volumes-unavailable'
	| 'networks-unavailable'
	| 'no-start-times';

export interface ContainerLimitation {
	code: ContainerLimitationCode;
	message: string;
}

/** How the host answered when asked what runtime it has. */
export interface ContainerRuntimeInfo {
	runtime: ContainerRuntime | null;
	version: string | null;
	/**
	 * Why there is no usable runtime. Split out because the three causes need
	 * three different things from the user, and "no containers" is the wrong
	 * answer to all of them.
	 */
	problem: 'none' | 'not-installed' | 'daemon-unreachable' | 'permission-denied';
	/** The runtime's own error, when it gave one. */
	detail: string | null;
}

export interface ContainerScanResult {
	hostId: HostId;
	/** ISO timestamp of the scan that produced this. */
	scannedAt: string;
	runtime: ContainerRuntime | null;
	runtimeVersion: string | null;
	runtimeProblem: ContainerRuntimeInfo['problem'];
	entries: ContainerEntry[];
	images: ContainerImageEntry[];
	volumes: ContainerVolumeEntry[];
	networks: ContainerNetworkEntry[];
	limitations: ContainerLimitation[];
	/** Set when the scan failed outright; the lists are then empty. */
	error: string | null;
}

/** What a row offers to do. All of these are admin-only on the server. */
export type ContainerAction =
	| 'start'
	| 'stop'
	| 'restart'
	| 'pause'
	| 'unpause'
	| 'remove'
	/** `remove` on something still running: it is stopped first, by the runtime. */
	| 'force-remove';

export interface ContainerActionResult {
	ok: boolean;
	error: string | null;
}

/** The four things a host holds that this feature can remove. */
export type ContainerResourceKind = 'container' | 'image' | 'volume' | 'network';

/**
 * The three that are removed as themselves. A container is removed through its
 * own lifecycle instead, because whether it is still running changes both the
 * command and what the confirmation has to say.
 */
export type RemovableResourceKind = Exclude<ContainerResourceKind, 'container'>;

/**
 * What a clean-up sweep can reclaim.
 *
 * Split by what each one costs to get back rather than lumped into one button.
 * Removing a stopped container is nothing; removing an unused image means
 * pulling or building it again, which on a slow connection is an afternoon.
 */
export type PruneKind =
	| 'containers'
	| 'dangling-images'
	| 'images'
	| 'volumes'
	| 'networks'
	| 'build-cache';

export interface PruneOutcome {
	kind: PruneKind;
	ok: boolean;
	/** Entries the runtime listed as removed. Zero is a normal answer. */
	removed: number;
	/** Space the runtime says it freed, in its own words. Null if it did not say. */
	reclaimed: string | null;
	error: string | null;
}

/**
 * A cleanup sweep, as the server remembers it.
 *
 * The sweep belongs to the host, not to the dialog that started it. Closing the
 * dialog — or refreshing the browser, or opening the panel on another device —
 * must not lose track of a `prune` that is still deleting, and must not invite
 * a second one on top of it. So the server owns the job and the dialog attaches
 * to whatever it finds.
 */
export interface PruneJob {
	hostId: string;
	kinds: PruneKind[];
	startedAt: string;
	/** Null while the sweep is still running. */
	finishedAt: string | null;
	/** One line per kind, filled in when the sweep ends. */
	outcomes: PruneOutcome[] | null;
}

/** One line of `system df`: how much of a resource is in use, and how much is not. */
export interface ContainerDiskUsageRow {
	kind: 'images' | 'containers' | 'volumes' | 'build-cache';
	total: number | null;
	active: number | null;
	/** Sizes stay as the runtime printed them — it is the authority on its own units. */
	size: string;
	reclaimable: string;
}

export interface ContainerDiskUsage {
	rows: ContainerDiskUsageRow[];
	error: string | null;
	/**
	 * When this reading was taken, so the dialog can say how old it is.
	 *
	 * A reading is shown from cache rather than re-measured on every open,
	 * because `system df` is the one container command whose cost is set by how
	 * much disk the host holds rather than by how many containers it runs: the
	 * daemon walks every image layer and every volume to answer it. On a host
	 * with a few hundred volumes on a virtualised filesystem that is over a
	 * minute, and almost all of it is the volumes.
	 */
	measuredAt: string | null;
}

/**
 * How long each container command may run, and therefore how long a caller has
 * to be prepared to wait for it.
 *
 * Both ends read these. The backend hands them to the runtime as the command
 * budget; the frontend hands them to `ws.http` as the request budget, plus
 * `TRANSPORT_GRACE_MS`. They have to come from one place, because a transport
 * that gives up before the command does turns every slow-but-successful run
 * into a reported failure — a prune that is still deleting, a container that is
 * still stopping — and the caller then has no way to find out it worked.
 */
export const CONTAINER_TIMEOUTS = {
	/** `stop` waits out the container's grace period, which can be long. */
	action: 120_000,
	/** A prune walks and unlinks everything it removes. */
	prune: 300_000,
	/** One `ps`, `images`, `volume ls` or `network ls`. */
	list: 20_000,
	/** A full listing: the four above, plus detecting the runtime. */
	scan: 90_000,
	/** `stats` samples over a window before it prints. */
	stats: 30_000,
	inspect: 20_000
} as const;

/**
 * The extra the transport allows on top of the command's own budget.
 *
 * Enough to cover the round trip and the runtime's own teardown, so the command
 * is always the thing that gives up first and the caller always hears why.
 */
export const TRANSPORT_GRACE_MS = 15_000;

/**
 * How long a disk reading stays good before the dialog measures again.
 *
 * The figures only move when something is created or removed, and a prune
 * invalidates them outright, so re-measuring on every open would spend a minute
 * of the daemon's time to redraw numbers that had not changed.
 */
export const DISK_USAGE_STALE_MS = 300_000;

/**
 * How long the measurement itself may run before it is abandoned.
 *
 * Nothing waits on this — it is pushed when it lands — so the budget is here to
 * stop a wedged daemon holding a slot forever, not to bound anyone's spinner.
 */
export const DISK_USAGE_TIMEOUT_MS = 600_000;

/** A single sample of what one container is consuming, read on demand. */
export interface ContainerStats {
	cpuPercent: number | null;
	memoryUsage: string | null;
	memoryPercent: number | null;
	networkIO: string | null;
	blockIO: string | null;
	pids: number | null;
}

/** Everything `inspect` adds to a row, fetched only when a detail pane opens. */
export interface ContainerDetail {
	id: string;
	name: string;
	image: string;
	imageId: string | null;
	command: string | null;
	createdAt: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	state: ContainerState;
	health: ContainerHealth;
	exitCode: number | null;
	restartCount: number | null;
	restartPolicy: string | null;
	pid: number | null;
	workingDir: string | null;
	user: string | null;
	networks: Array<{ name: string; ipAddress: string | null }>;
	mounts: Array<{ source: string; destination: string; readOnly: boolean; kind: string }>;
	ports: ContainerPortBinding[];
	env: string[];
	labels: Array<{ key: string; value: string }>;
}

/** One push of container output while a log stream is being followed. */
export interface ContainerLogChunk {
	streamId: string;
	hostId: HostId;
	containerId: string;
	/** Newline-terminated text exactly as the container wrote it. */
	data: string;
	/** Set once when the stream ends, with the reason if it was not asked for. */
	done?: boolean;
	error?: string | null;
}

export const LOCAL_CONTAINER_HOST: HostId = LOCAL_HOST_ID;

/** Lines kept per stream. A chatty container must not grow without limit. */
export const CONTAINER_LOG_BUFFER_LINES = 2000;
