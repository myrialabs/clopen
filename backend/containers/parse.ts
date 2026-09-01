/**
 * Containers — turning two runtimes' output into one model.
 *
 * Docker and Podman answer the same questions in different words. Docker's CLI
 * speaks Go templates and prints one JSON object per line; Podman prints a JSON
 * array with its own field names, its own timestamps (sometimes an epoch,
 * sometimes RFC 3339) and structured ports where Docker has a string. Every one
 * of those differences is resolved here, so nothing downstream — not the
 * scanner, not the WebSocket layer, not the UI — ever asks which runtime it is
 * looking at.
 *
 * Everything in this file is a pure function over command output, which is what
 * makes the awkward parts (a locale-formatted date, a port range, a compose
 * label) testable without a container runtime anywhere near the test.
 */

import type {
	ContainerDetail,
	ContainerDiskUsage,
	ContainerDiskUsageRow,
	ContainerEntry,
	ContainerHealth,
	ContainerImageEntry,
	ContainerNetworkEntry,
	ContainerPortBinding,
	ContainerState,
	ContainerStats,
	ContainerVolumeEntry
} from '$shared/types/containers';

/** Parse NDJSON, skipping anything that is not an object — warnings, banners. */
function readJsonLines(stdout: string): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = [];
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;
		try {
			const value = JSON.parse(trimmed);
			if (value && typeof value === 'object') rows.push(value as Record<string, unknown>);
		} catch {
			// A truncated line is one row lost, not a failed scan.
		}
	}
	return rows;
}

/** Parse a JSON array, tolerating the empty output an idle host produces. */
function readJsonArray(stdout: string): Record<string, unknown>[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	try {
		const value = JSON.parse(trimmed);
		if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object');
		if (value && typeof value === 'object') return [value as Record<string, unknown>];
	} catch {
		// Podman prints an array; if it printed something else, say nothing.
	}
	return [];
}

function str(value: unknown): string | null {
	if (typeof value === 'string') return value.trim() || null;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return null;
}

function num(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/**
 * A timestamp from either runtime, as an ISO string or null.
 *
 * Docker prints `2026-08-25 09:02:11 +0700 WIB` — a Go time layout whose
 * trailing zone abbreviation no `Date` can parse, and whose abbreviation is
 * locale-dependent besides. The offset that precedes it is unambiguous, so the
 * date is rebuilt from the parts and the abbreviation dropped. Podman prints
 * RFC 3339, or a Unix epoch in older versions. Anything else reports null
 * rather than a date that would be quietly wrong.
 */
export function parseTimestamp(value: unknown): string | null {
	if (value === null || value === undefined) return null;

	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value <= 0) return null;
		// Seconds below ~year 33658, milliseconds above it.
		const date = new Date(value > 1e12 ? value : value * 1000);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}

	if (typeof value !== 'string') return null;
	const text = value.trim();
	if (!text) return null;
	// Go's zero time: what both runtimes print for a container that never ran.
	if (text.startsWith('0001-01-01')) return null;

	if (/^\d+$/.test(text)) return parseTimestamp(Number(text));

	// Deliberately the only accepted shape. `new Date` as a fallback looks
	// harmless and is not: handed a French `mar. août 25 09:02:11 2026` it
	// returns 25 March without complaint, which is how a wrong date reaches a
	// user's screen looking exactly like a right one.
	const match = text.match(
		/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/
	);
	if (!match) return null;

	const [, day, time, fraction, zone] = match;
	// A zone with no colon (`+0700`) is Go's spelling; ISO wants `+07:00`.
	const offset = zone && zone !== 'Z' && !zone.includes(':')
		? `${zone.slice(0, 3)}:${zone.slice(3)}`
		: (zone ?? '');
	const date = new Date(`${day}T${time}${fraction ?? ''}${offset}`);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The lifecycle state, from whichever field the runtime filled in.
 *
 * Docker before 20.10 has no `State` column at all, so the status text is the
 * fallback: `Up 3 hours` and `Exited (0) 2 days ago` are the same sentence the
 * daemon would have put in `State`.
 */
export function normaliseState(state: string | null, statusText: string | null): ContainerState {
	const value = (state ?? '').trim().toLowerCase();
	switch (value) {
		case 'running':
		case 'paused':
		case 'restarting':
		case 'created':
		case 'exited':
		case 'dead':
		case 'removing':
			return value;
		case 'stopped':
			// Podman's word for what Docker calls `exited`.
			return 'exited';
		case 'configured':
			// Podman's word for a container that has never run.
			return 'created';
	}

	const status = (statusText ?? '').trim().toLowerCase();
	if (status.startsWith('up')) return status.includes('(paused)') ? 'paused' : 'running';
	if (status.startsWith('exited')) return 'exited';
	if (status.startsWith('created')) return 'created';
	if (status.startsWith('restarting')) return 'restarting';
	if (status.startsWith('removal') || status.startsWith('removing')) return 'removing';
	if (status.startsWith('dead')) return 'dead';
	return 'unknown';
}

/** The healthcheck verdict, which both runtimes report inside the status text. */
export function healthFrom(statusText: string | null, explicit?: unknown): ContainerHealth {
	const direct = (str(explicit) ?? '').toLowerCase();
	if (direct === 'healthy' || direct === 'unhealthy' || direct === 'starting') return direct;

	const status = (statusText ?? '').toLowerCase();
	if (status.includes('(healthy)')) return 'healthy';
	if (status.includes('(unhealthy)')) return 'unhealthy';
	if (status.includes('health: starting')) return 'starting';
	return 'none';
}

/**
 * Docker's `Ports` column: a comma-separated list mixing published mappings
 * (`0.0.0.0:8080->80/tcp`), the IPv6 mapping that shadows them (`:::8080->…`)
 * and bare exposed ports (`9000/tcp`). Ranges appear collapsed
 * (`0.0.0.0:8000-8002->8000-8002/tcp`) and are expanded, because a row that
 * says "8000" when the host also holds 8001 is the kind of half-truth this
 * feature exists to remove.
 */
export function parseDockerPortsField(value: string | null): ContainerPortBinding[] {
	if (!value) return [];
	const bindings: ContainerPortBinding[] = [];

	for (const part of value.split(',')) {
		const text = part.trim();
		if (!text) continue;

		const mapped = text.match(/^(.*):(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(tcp|udp)$/i);
		if (mapped) {
			const [, address, hostStart, hostEnd, containerStart, containerEnd, protocol] = mapped;
			const spanHost = Number(hostEnd ?? hostStart) - Number(hostStart);
			const spanContainer = Number(containerEnd ?? containerStart) - Number(containerStart);
			const span = Math.min(Math.max(spanHost, spanContainer), MAX_PORT_RANGE);
			for (let offset = 0; offset <= span; offset++) {
				bindings.push({
					hostAddress: address || null,
					hostPort: Number(hostStart) + offset,
					containerPort: Number(containerStart) + offset,
					protocol: protocol.toLowerCase() as 'tcp' | 'udp'
				});
			}
			continue;
		}

		const exposed = text.match(/^(\d+)(?:-(\d+))?\/(tcp|udp)$/i);
		if (exposed) {
			const [, start, end, protocol] = exposed;
			const span = Math.min(Number(end ?? start) - Number(start), MAX_PORT_RANGE);
			for (let offset = 0; offset <= span; offset++) {
				bindings.push({
					hostAddress: null,
					hostPort: null,
					containerPort: Number(start) + offset,
					protocol: protocol.toLowerCase() as 'tcp' | 'udp'
				});
			}
		}
	}

	return dedupeBindings(bindings);
}

/** A published range is expanded, but not without bound. */
const MAX_PORT_RANGE = 64;

/**
 * Docker publishes on IPv4 and IPv6 separately, so the same mapping arrives
 * twice under two addresses. The pair is one binding to a reader, so the second
 * address is folded into the first rather than repeated.
 */
function dedupeBindings(bindings: ContainerPortBinding[]): ContainerPortBinding[] {
	const seen = new Map<string, ContainerPortBinding>();
	for (const binding of bindings) {
		const key = `${binding.protocol}:${binding.hostPort ?? 'none'}:${binding.containerPort}`;
		const existing = seen.get(key);
		if (!existing) {
			seen.set(key, binding);
			continue;
		}
		// Prefer the address that says something: `0.0.0.0` over `::`.
		if (existing.hostAddress === '::' && binding.hostAddress && binding.hostAddress !== '::') {
			seen.set(key, binding);
		}
	}
	// Published ports first, in port order; the merely exposed ones after, since
	// they are the ones nobody can reach from outside the host.
	return [...seen.values()].sort(
		(a, b) =>
			Number(a.hostPort === null) - Number(b.hostPort === null) ||
			(a.hostPort ?? 0) - (b.hostPort ?? 0) ||
			a.containerPort - b.containerPort
	);
}

/** Podman's structured ports, including its `range` shorthand. */
function parsePodmanPorts(value: unknown): ContainerPortBinding[] {
	if (!Array.isArray(value)) return [];
	const bindings: ContainerPortBinding[] = [];

	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const row = raw as Record<string, unknown>;
		const containerPort = num(row.container_port ?? row.containerPort);
		if (containerPort === null) continue;
		const hostPort = num(row.host_port ?? row.hostPort);
		const protocol = (str(row.protocol) ?? 'tcp').toLowerCase() === 'udp' ? 'udp' : 'tcp';
		const span = Math.min(Math.max((num(row.range) ?? 1) - 1, 0), MAX_PORT_RANGE);

		for (let offset = 0; offset <= span; offset++) {
			bindings.push({
				hostAddress: str(row.host_ip ?? row.hostIP) ?? null,
				hostPort: hostPort === null || hostPort === 0 ? null : hostPort + offset,
				containerPort: containerPort + offset,
				protocol
			});
		}
	}

	return dedupeBindings(bindings);
}

/** Docker's `Labels` column: `k=v,k=v`. Podman hands over an object already. */
function parseLabels(value: unknown): Map<string, string> {
	const labels = new Map<string, string>();

	if (value && typeof value === 'object' && !Array.isArray(value)) {
		for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
			const text = str(raw);
			if (text !== null) labels.set(key, text);
		}
		return labels;
	}

	const text = str(value);
	if (!text) return labels;
	for (const pair of text.split(',')) {
		const index = pair.indexOf('=');
		if (index <= 0) continue;
		labels.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
	}
	return labels;
}

const COMPOSE_PROJECT_LABELS = ['com.docker.compose.project', 'io.podman.compose.project'];
const COMPOSE_SERVICE_LABELS = ['com.docker.compose.service', 'io.podman.compose.service'];

function firstLabel(labels: Map<string, string>, keys: string[]): string | null {
	for (const key of keys) {
		const value = labels.get(key);
		if (value) return value;
	}
	return null;
}

function shortId(id: string): string {
	return id.length > 12 ? id.slice(0, 12) : id;
}

/**
 * A status line for a runtime that did not write one.
 *
 * Podman's JSON leaves `Status` empty in some versions, and an empty cell in
 * the column a user reads first is worse than a sentence assembled from the
 * state and the start time — which is exactly how Docker builds its own.
 */
function synthesiseStatus(state: ContainerState, startedAt: string | null, exitCode: number | null): string {
	if (state === 'running' || state === 'paused') {
		const suffix = state === 'paused' ? ' (Paused)' : '';
		if (!startedAt) return `Up${suffix}`;
		return `Up ${describeSpan(Date.parse(startedAt))}${suffix}`;
	}
	if (state === 'exited') return exitCode === null ? 'Exited' : `Exited (${exitCode})`;
	return state.charAt(0).toUpperCase() + state.slice(1);
}

/** `3 hours`, `2 days` — the coarse span both runtimes print. */
function describeSpan(since: number, now = Date.now()): string {
	const seconds = Math.max(1, Math.round((now - since) / 1000));
	if (seconds < 60) return `${seconds} seconds`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
	const days = Math.round(hours / 24);
	return `${days} day${days === 1 ? '' : 's'}`;
}

/** `docker ps --all --no-trunc --format {{json .}}`. */
export function parseDockerPs(stdout: string, hostId: string): ContainerEntry[] {
	return readJsonLines(stdout)
		.map((row): ContainerEntry | null => {
			const id = str(row.ID ?? row.Id);
			if (!id) return null;

			const statusText = str(row.Status) ?? '';
			const state = normaliseState(str(row.State), statusText);
			const labels = parseLabels(row.Labels);
			// `Names` carries every name a container answers to; the first is the
			// one the runtime itself prints.
			const name = (str(row.Names) ?? '').split(',')[0].trim() || shortId(id);

			return {
				key: `${hostId}:${id}`,
				id,
				shortId: shortId(id),
				name,
				image: str(row.Image) ?? 'unknown',
				state,
				statusText: statusText || synthesiseStatus(state, null, null),
				health: healthFrom(statusText),
				createdAt: parseTimestamp(row.CreatedAt),
				startedAt: null,
				ports: parseDockerPortsField(str(row.Ports)),
				composeProject: firstLabel(labels, COMPOSE_PROJECT_LABELS),
				composeService: firstLabel(labels, COMPOSE_SERVICE_LABELS),
				command: str(row.Command),
				canManage: state !== 'removing'
			};
		})
		.filter((entry): entry is ContainerEntry => entry !== null);
}

/** `podman ps --all --no-trunc --format json`. */
export function parsePodmanPs(stdout: string, hostId: string): ContainerEntry[] {
	return readJsonArray(stdout)
		.filter((row) => row.IsInfra !== true)
		.map((row): ContainerEntry | null => {
			const id = str(row.Id ?? row.ID);
			if (!id) return null;

			const names = Array.isArray(row.Names) ? row.Names.map(str).filter(Boolean) : [str(row.Names)];
			const startedAt = parseTimestamp(row.StartedAt);
			const state = normaliseState(str(row.State), str(row.Status));
			const labels = parseLabels(row.Labels);
			const command = Array.isArray(row.Command)
				? row.Command.map((part) => str(part) ?? '').join(' ').trim() || null
				: str(row.Command);

			return {
				key: `${hostId}:${id}`,
				id,
				shortId: shortId(id),
				name: (names[0] as string | null) ?? shortId(id),
				image: str(row.Image) ?? 'unknown',
				state,
				statusText: str(row.Status) ?? synthesiseStatus(state, startedAt, num(row.ExitCode)),
				health: healthFrom(str(row.Status), row.Health ?? row.HealthStatus),
				createdAt: parseTimestamp(row.Created ?? row.CreatedAt),
				startedAt: state === 'running' || state === 'paused' ? startedAt : null,
				ports: parsePodmanPorts(row.Ports),
				composeProject: firstLabel(labels, COMPOSE_PROJECT_LABELS),
				composeService: firstLabel(labels, COMPOSE_SERVICE_LABELS),
				command,
				canManage: state !== 'removing'
			};
		})
		.filter((entry): entry is ContainerEntry => entry !== null);
}

/** Bytes as the runtimes print them, for a Podman size that arrives as a number. */
function humanSize(bytes: number | null): string {
	if (bytes === null) return 'unknown';
	const units = ['B', 'kB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

/** `docker images --format {{json .}}`. */
export function parseDockerImages(stdout: string): ContainerImageEntry[] {
	return readJsonLines(stdout)
		.map((row): ContainerImageEntry | null => {
			const id = str(row.ID ?? row.Id);
			if (!id) return null;
			const repository = str(row.Repository) ?? '<none>';
			const tag = str(row.Tag) ?? '<none>';
			return {
				key: `${id}:${repository}:${tag}`,
				id,
				repository,
				tag,
				size: str(row.Size) ?? 'unknown',
				createdAt: parseTimestamp(row.CreatedAt),
				dangling: repository === '<none>' && tag === '<none>',
				usedBy: []
			};
		})
		.filter((entry): entry is ContainerImageEntry => entry !== null);
}

/** `podman images --format json`. One row per repo:tag, like Docker's table. */
export function parsePodmanImages(stdout: string): ContainerImageEntry[] {
	const images: ContainerImageEntry[] = [];

	for (const row of readJsonArray(stdout)) {
		const id = str(row.Id ?? row.ID);
		if (!id) continue;
		const size = humanSize(num(row.Size));
		const createdAt = parseTimestamp(row.Created ?? row.CreatedAt);
		const tags = Array.isArray(row.Names)
			? row.Names.map(str).filter((tag): tag is string => tag !== null)
			: Array.isArray(row.RepoTags)
				? row.RepoTags.map(str).filter((tag): tag is string => tag !== null)
				: [];

		if (tags.length === 0) {
			images.push({
				key: `${id}:<none>:<none>`,
				id,
				repository: '<none>',
				tag: '<none>',
				size,
				createdAt,
				dangling: true,
				usedBy: []
			});
			continue;
		}

		for (const tag of tags) {
			const at = tag.lastIndexOf(':');
			// A registry port (`localhost:5000/app`) also contains a colon, so the
			// split only counts when nothing after it looks like a path.
			const hasTag = at > 0 && !tag.slice(at + 1).includes('/');
			images.push({
				key: `${id}:${tag}`,
				id,
				repository: hasTag ? tag.slice(0, at) : tag,
				tag: hasTag ? tag.slice(at + 1) : 'latest',
				size,
				createdAt,
				dangling: false,
				usedBy: []
			});
		}
	}

	return images;
}

/** `docker volume ls --format {{json .}}`. Docker reports no creation time. */
export function parseDockerVolumes(stdout: string): ContainerVolumeEntry[] {
	return readJsonLines(stdout)
		.map((row): ContainerVolumeEntry | null => {
			const name = str(row.Name);
			if (!name) return null;
			return {
				key: name,
				name,
				driver: str(row.Driver) ?? 'local',
				mountpoint: str(row.Mountpoint),
				createdAt: parseTimestamp(row.CreatedAt),
				usedBy: []
			};
		})
		.filter((entry): entry is ContainerVolumeEntry => entry !== null);
}

/** `podman volume ls --format json`. */
export function parsePodmanVolumes(stdout: string): ContainerVolumeEntry[] {
	return readJsonArray(stdout)
		.map((row): ContainerVolumeEntry | null => {
			const name = str(row.Name);
			if (!name) return null;
			return {
				key: name,
				name,
				driver: str(row.Driver) ?? 'local',
				mountpoint: str(row.Mountpoint),
				createdAt: parseTimestamp(row.CreatedAt),
				usedBy: []
			};
		})
		.filter((entry): entry is ContainerVolumeEntry => entry !== null);
}

/**
 * The networks the runtime creates and owns.
 *
 * Listed so they can be shown, and named so they are never offered as
 * something to delete: a `network rm bridge` fails on every host, and an action
 * that can only fail should not be on screen.
 */
const PREDEFINED_NETWORKS = new Set(['bridge', 'host', 'none', 'podman', 'ingress', 'docker_gwbridge']);

/** `docker network ls --no-trunc --format {{json .}}`. */
export function parseDockerNetworks(stdout: string): ContainerNetworkEntry[] {
	return readJsonLines(stdout)
		.map((row): ContainerNetworkEntry | null => {
			const id = str(row.ID ?? row.Id);
			const name = str(row.Name);
			if (!id || !name) return null;
			return {
				key: id,
				id,
				name,
				driver: str(row.Driver) ?? 'bridge',
				scope: str(row.Scope) ?? 'local',
				internal: row.Internal === true || str(row.Internal) === 'true',
				createdAt: parseTimestamp(row.CreatedAt),
				usedBy: [],
				predefined: PREDEFINED_NETWORKS.has(name)
			};
		})
		.filter((entry): entry is ContainerNetworkEntry => entry !== null);
}

/**
 * `podman network ls --format json`. Podman spells its network fields in
 * lower case where Docker capitalises them, so both spellings are read.
 */
export function parsePodmanNetworks(stdout: string): ContainerNetworkEntry[] {
	return readJsonArray(stdout)
		.map((row): ContainerNetworkEntry | null => {
			const id = str(row.id ?? row.ID ?? row.Id);
			const name = str(row.name ?? row.Name);
			if (!name) return null;
			return {
				// Podman's rootless networks have no id in some versions; the name is
				// unique either way and is what `network rm` takes.
				key: id ?? name,
				id: id ?? name,
				name,
				driver: str(row.driver ?? row.Driver) ?? 'bridge',
				scope: str(row.scope ?? row.Scope) ?? 'local',
				internal: row.internal === true || row.Internal === true,
				createdAt: parseTimestamp(row.created ?? row.Created ?? row.CreatedAt),
				usedBy: [],
				predefined: PREDEFINED_NETWORKS.has(name)
			};
		})
		.filter((entry): entry is ContainerNetworkEntry => entry !== null);
}

/**
 * Which containers use each image and volume.
 *
 * Computed from the container list already in hand rather than asked of the
 * runtime: a second round trip per image would cost more than the answer is
 * worth, and the answer is exact either way.
 */
export function linkUsage(
	entries: ContainerEntry[],
	images: ContainerImageEntry[],
	volumes: ContainerVolumeEntry[],
	mountsByContainer: Map<string, string[]>,
	networks: ContainerNetworkEntry[] = [],
	networksByContainer: Map<string, string[]> = new Map()
): void {
	for (const image of images) {
		const tagged = `${image.repository}:${image.tag}`;
		image.usedBy = entries
			.filter((entry) => {
				const used = entry.image;
				if (used === tagged || used === image.repository) return true;
				// Podman prints fully qualified names; Docker's short form is a suffix.
				if (used.endsWith(`/${tagged}`)) return true;
				return used.startsWith(image.id) || image.id.startsWith(used);
			})
			.map((entry) => entry.name);
	}

	for (const volume of volumes) {
		volume.usedBy = entries
			.filter((entry) => (mountsByContainer.get(entry.id) ?? []).includes(volume.name))
			.map((entry) => entry.name);
	}

	for (const network of networks) {
		network.usedBy = entries
			.filter((entry) => (networksByContainer.get(entry.id) ?? []).includes(network.name))
			.map((entry) => entry.name);
	}
}

/** The networks each container is attached to, from either runtime's `ps`. */
export function parseNetworkMembership(
	stdout: string,
	runtime: 'docker' | 'podman'
): Map<string, string[]> {
	const membership = new Map<string, string[]>();
	const rows = runtime === 'docker' ? readJsonLines(stdout) : readJsonArray(stdout);

	for (const row of rows) {
		const id = str(row.ID ?? row.Id);
		if (!id) continue;
		const raw = row.Networks;
		const names = Array.isArray(raw)
			? raw.map((name) => str(name)).filter((name): name is string => name !== null)
			: (str(raw) ?? '')
					.split(',')
					.map((name) => name.trim())
					.filter(Boolean);
		membership.set(id, names);
	}

	return membership;
}

/** The volume names each container mounts, from either runtime's `ps` output. */
export function parseMounts(stdout: string, runtime: 'docker' | 'podman'): Map<string, string[]> {
	const mounts = new Map<string, string[]>();
	const rows = runtime === 'docker' ? readJsonLines(stdout) : readJsonArray(stdout);

	for (const row of rows) {
		const id = str(row.ID ?? row.Id);
		if (!id) continue;
		const raw = row.Mounts;
		const names = Array.isArray(raw)
			? raw
					.map((mount) =>
						typeof mount === 'string' ? mount : str((mount as Record<string, unknown>)?.Name)
					)
					.filter((name): name is string => name !== null)
			: (str(raw) ?? '')
					.split(',')
					.map((name) => name.trim())
					.filter(Boolean);
		mounts.set(id, names);
	}

	return mounts;
}

/**
 * `inspect --format {{json .}}` from either runtime.
 *
 * Podman deliberately mirrors Docker's inspect schema, so one reader serves
 * both. Fields either runtime may omit are reported as null rather than
 * defaulted, because "this host did not say" and "zero" are different answers.
 */
export function parseInspect(stdout: string): ContainerDetail | null {
	const rows = stdout.trim().startsWith('[') ? readJsonArray(stdout) : readJsonLines(stdout);
	const row = rows[0];
	if (!row) return null;

	const id = str(row.Id ?? row.ID);
	if (!id) return null;

	const state = (row.State ?? {}) as Record<string, unknown>;
	const config = (row.Config ?? {}) as Record<string, unknown>;
	const hostConfig = (row.HostConfig ?? {}) as Record<string, unknown>;
	const networkSettings = (row.NetworkSettings ?? {}) as Record<string, unknown>;
	const health = (state.Health ?? {}) as Record<string, unknown>;

	const statusText = str(state.Status);
	const command = Array.isArray(config.Cmd)
		? config.Cmd.map((part) => str(part) ?? '').join(' ').trim() || null
		: str(row.Path);

	const networks: ContainerDetail['networks'] = [];
	const rawNetworks = (networkSettings.Networks ?? {}) as Record<string, unknown>;
	for (const [name, raw] of Object.entries(rawNetworks)) {
		const value = (raw ?? {}) as Record<string, unknown>;
		networks.push({ name, ipAddress: str(value.IPAddress) });
	}

	const mounts: ContainerDetail['mounts'] = [];
	if (Array.isArray(row.Mounts)) {
		for (const raw of row.Mounts) {
			const mount = (raw ?? {}) as Record<string, unknown>;
			const destination = str(mount.Destination);
			if (!destination) continue;
			mounts.push({
				source: str(mount.Source) ?? str(mount.Name) ?? '',
				destination,
				readOnly: mount.RW === false || mount.ReadOnly === true,
				kind: str(mount.Type) ?? 'bind'
			});
		}
	}

	const ports: ContainerPortBinding[] = [];
	const rawPorts = (networkSettings.Ports ?? {}) as Record<string, unknown>;
	for (const [spec, raw] of Object.entries(rawPorts)) {
		const match = spec.match(/^(\d+)\/(tcp|udp)$/i);
		if (!match) continue;
		const containerPort = Number(match[1]);
		const protocol = match[2].toLowerCase() as 'tcp' | 'udp';
		if (!Array.isArray(raw) || raw.length === 0) {
			ports.push({ hostAddress: null, hostPort: null, containerPort, protocol });
			continue;
		}
		for (const binding of raw) {
			const value = (binding ?? {}) as Record<string, unknown>;
			ports.push({
				hostAddress: str(value.HostIp) ?? null,
				hostPort: num(value.HostPort),
				containerPort,
				protocol
			});
		}
	}

	const labels: ContainerDetail['labels'] = [];
	for (const [key, value] of parseLabels(config.Labels)) labels.push({ key, value });
	labels.sort((a, b) => a.key.localeCompare(b.key));

	const restartPolicy = (hostConfig.RestartPolicy ?? {}) as Record<string, unknown>;

	return {
		id,
		// Docker prefixes the name with a slash; nobody reads it that way.
		name: (str(row.Name) ?? shortId(id)).replace(/^\//, ''),
		image: str(config.Image) ?? str((row.Image as unknown) ?? null) ?? 'unknown',
		imageId: str(row.Image),
		command,
		createdAt: parseTimestamp(row.Created),
		startedAt: parseTimestamp(state.StartedAt),
		finishedAt: parseTimestamp(state.FinishedAt),
		state: normaliseState(statusText, statusText),
		health: healthFrom(null, health.Status),
		exitCode: num(state.ExitCode),
		restartCount: num(row.RestartCount),
		restartPolicy: str(restartPolicy.Name),
		pid: num(state.Pid),
		workingDir: str(config.WorkingDir),
		user: str(config.User),
		networks,
		mounts,
		ports: dedupeBindings(ports),
		env: Array.isArray(config.Env)
			? config.Env.map((line) => str(line)).filter((line): line is string => line !== null)
			: [],
		labels
	};
}

/**
 * What a `prune` actually did.
 *
 * Both runtimes print a list of what went and, usually, a total. "Usually" is
 * the problem: Docker states the space it freed and Podman often does not, and
 * Docker's image prune lists untag operations alongside deletions. So the space
 * is reported when the runtime gives it and left null when it does not — a
 * reclaimed figure invented here would be the least trustworthy number on the
 * screen.
 */
export function parsePruneOutput(stdout: string): { removed: number; reclaimed: string | null } {
	let reclaimed: string | null = null;
	let removed = 0;

	for (const raw of stdout.split('\n')) {
		const line = raw.trim();
		if (!line) continue;

		const total = line.match(/^Total reclaimed space:\s*(.+)$/i);
		if (total) {
			reclaimed = total[1].trim();
			continue;
		}

		// Section headers Docker prints above each list.
		if (/^deleted [a-z ]+:$/i.test(line) || /^deleted:?$/i.test(line)) continue;
		// `untagged: repo:tag` is a name being dropped, not a thing being deleted;
		// counting it would report twice as many removals as actually happened.
		if (/^untagged:/i.test(line)) continue;

		removed++;
	}

	return { removed, reclaimed };
}

/** Map either runtime's word for a resource onto the four this feature knows. */
function diskUsageKind(type: string): ContainerDiskUsageRow['kind'] | null {
	const value = type.trim().toLowerCase();
	if (value.startsWith('image')) return 'images';
	if (value.startsWith('container')) return 'containers';
	if (value.includes('volume')) return 'volumes';
	if (value.includes('cache')) return 'build-cache';
	return null;
}

/**
 * `system df`, which is the only honest answer to "what would cleaning up get
 * me back". Docker prints one JSON object per resource with human sizes;
 * Podman prints an array, and in some versions gives the sizes as raw bytes.
 */
/** The reading itself; the caller stamps it with when it was taken. */
export function parseDiskUsage(
	stdout: string,
	runtime: 'docker' | 'podman'
): Omit<ContainerDiskUsage, 'measuredAt'> {
	const rows = runtime === 'docker' ? readJsonLines(stdout) : readJsonArray(stdout);
	const parsed: ContainerDiskUsageRow[] = [];

	for (const row of rows) {
		const kind = diskUsageKind(str(row.Type ?? row.type) ?? '');
		if (!kind) continue;

		const sizeRaw = row.Size ?? row.size;
		const reclaimableRaw = row.Reclaimable ?? row.reclaimable;

		parsed.push({
			kind,
			total: num(row.TotalCount ?? row.Total ?? row.total),
			active: num(row.Active ?? row.active),
			size: typeof sizeRaw === 'number' ? humanSize(sizeRaw) : (str(sizeRaw) ?? 'unknown'),
			reclaimable:
				typeof reclaimableRaw === 'number'
					? humanSize(reclaimableRaw)
					: (str(reclaimableRaw) ?? 'unknown')
		});
	}

	return { rows: parsed, error: null };
}

/** A percentage a runtime printed as `1.84%`. */
function percent(value: unknown): number | null {
	const text = str(value);
	if (!text) return null;
	const parsed = Number.parseFloat(text.replace('%', ''));
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One `stats --no-stream` sample.
 *
 * The two runtimes agree on almost nothing here — Docker capitalises, Podman
 * has used at least three spellings across its versions — so every field is
 * looked up under each name it has been known by, and anything still missing
 * stays null rather than becoming a zero that reads like a measurement.
 */
export function parseStats(stdout: string): ContainerStats | null {
	const rows = stdout.trim().startsWith('[') ? readJsonArray(stdout) : readJsonLines(stdout);
	const row = rows[0];
	if (!row) return null;

	const memUsage = str(row.MemUsage ?? row.mem_usage ?? row.MemoryUsage);
	const memLimit = str(row.MemLimit ?? row.mem_limit);

	return {
		cpuPercent: percent(row.CPUPerc ?? row.CPU ?? row.cpu_percent ?? row.cpu),
		// Podman reports usage and limit separately where Docker prints one string.
		memoryUsage: memUsage && memLimit && !memUsage.includes('/') ? `${memUsage} / ${memLimit}` : memUsage,
		memoryPercent: percent(row.MemPerc ?? row.mem_percent ?? row.MemPercent),
		networkIO: str(row.NetIO ?? row.net_io ?? row.NetInput),
		blockIO: str(row.BlockIO ?? row.block_io),
		pids: num(row.PIDs ?? row.pids ?? row.PIDS)
	};
}
