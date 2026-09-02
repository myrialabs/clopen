/**
 * Containers — one host, one scan, one table.
 *
 * Held per watched host so the runtime probe and the image/volume catalogue
 * survive between ticks. That is what keeps a live panel down to a single
 * command per tick: the container list is what changes second to second, while
 * images and volumes change when someone builds or prunes, and re-reading them
 * every tick would triple the cost of the view for an answer that is almost
 * always identical.
 */

import type {
	ContainerEntry,
	ContainerImageEntry,
	ContainerLimitation,
	ContainerNetworkEntry,
	ContainerScanResult,
	ContainerVolumeEntry
} from '$shared/types/containers';
import type { CommandRunner, ProbePlatform } from '../host/runner';
import {
	containerArgv,
	detectRuntime,
	forgetRuntime,
	limitationFor,
	looksLikeRuntimeFailure,
	tryRun
} from './runtime';
import {
	linkUsage,
	parseDockerImages,
	parseDockerNetworks,
	parseDockerPs,
	parseDockerVolumes,
	parseMounts,
	parseNetworkMembership,
	parsePodmanImages,
	parsePodmanNetworks,
	parsePodmanPs,
	parsePodmanVolumes
} from './parse';
import { debug } from '$shared/utils/logger';
import { CONTAINER_TIMEOUTS } from '$shared/types/containers';

/** How long the image and volume lists are reused before being read again. */
const CATALOG_TTL_MS = 15_000;

/** Running first, then everything that could be started, then the wreckage. */
const STATE_ORDER: Record<ContainerEntry['state'], number> = {
	running: 0,
	paused: 1,
	restarting: 2,
	created: 3,
	exited: 4,
	removing: 5,
	dead: 6,
	unknown: 7
};

interface Catalog {
	images: ContainerImageEntry[];
	volumes: ContainerVolumeEntry[];
	networks: ContainerNetworkEntry[];
	limitations: ContainerLimitation[];
	readAt: number;
}

export class HostContainerScanner {
	private catalog: Catalog | null = null;
	/**
	 * A scan already running. Callers join it rather than starting a second one:
	 * a remote scan can outlast the poll interval, and two in flight would double
	 * the SSH channels for the same answer.
	 */
	private inFlight: Promise<ContainerScanResult> | null = null;

	constructor(
		private readonly hostId: string,
		private readonly hostName: string,
		private readonly runner: CommandRunner,
		private readonly platform: ProbePlatform
	) {}

	/** Read this host, joining a scan already in progress rather than racing it. */
	async scan(now = Date.now()): Promise<ContainerScanResult> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.runScan(now).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private empty(
		scannedAt: string,
		limitations: ContainerLimitation[],
		error: string | null = null
	): ContainerScanResult {
		return {
			hostId: this.hostId,
			scannedAt,
			runtime: null,
			runtimeVersion: null,
			runtimeProblem: 'none',
			entries: [],
			images: [],
			volumes: [],
			networks: [],
			limitations,
			error
		};
	}

	private async runScan(now: number): Promise<ContainerScanResult> {
		const scannedAt = new Date(now).toISOString();

		const info = await detectRuntime(this.hostId, this.runner, this.platform, now);
		if (info.problem !== 'none' || !info.runtime) {
			const message = limitationFor(info, this.hostName);
			return {
				...this.empty(scannedAt, message ? [{ code: problemCode(info.problem), message }] : []),
				runtimeProblem: info.problem
			};
		}

		const runtime = info.runtime;
		const listing = await tryRun(
			this.runner,
			containerArgv(runtime, this.platform, [
				'ps',
				'--all',
				'--no-trunc',
				'--format',
				runtime === 'docker' ? '{{json .}}' : 'json'
			]),
			CONTAINER_TIMEOUTS.list
		);

		if (listing.code !== 0) {
			// The runtime answered `version` and then refused to list: it went away
			// between the two, so the cached "this host has docker" must go too.
			if (looksLikeRuntimeFailure(listing)) forgetRuntime(this.hostId);
			const reason = listing.stderr.trim() || listing.stdout.trim() || `exit status ${listing.code}`;
			return {
				...this.empty(scannedAt, [], reason),
				runtime,
				runtimeVersion: info.version
			};
		}

		const entries =
			runtime === 'docker'
				? parseDockerPs(listing.stdout, this.hostId)
				: parsePodmanPs(listing.stdout, this.hostId);

		entries.sort(
			(a, b) =>
				STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
				(a.composeProject ?? '').localeCompare(b.composeProject ?? '') ||
				a.name.localeCompare(b.name)
		);

		const catalog = await this.readCatalog(runtime, now);
		linkUsage(
			entries,
			catalog.images,
			catalog.volumes,
			parseMounts(listing.stdout, runtime),
			catalog.networks,
			parseNetworkMembership(listing.stdout, runtime)
		);

		return {
			hostId: this.hostId,
			scannedAt,
			runtime,
			runtimeVersion: info.version,
			runtimeProblem: 'none',
			entries,
			images: catalog.images,
			volumes: catalog.volumes,
			networks: catalog.networks,
			limitations: catalog.limitations,
			error: null
		};
	}

	/**
	 * Images, volumes and networks, re-read only when the cached set has aged
	 * out. A failure here degrades those tabs and nothing else — the container
	 * list is the point of the view and must not disappear because `volume ls`
	 * did.
	 */
	private async readCatalog(runtime: 'docker' | 'podman', now: number): Promise<Catalog> {
		if (this.catalog && now - this.catalog.readAt < CATALOG_TTL_MS) return this.catalog;

		const limitations: ContainerLimitation[] = [];
		const format = runtime === 'docker' ? '{{json .}}' : 'json';

		const imagesResult = await tryRun(
			this.runner,
			containerArgv(runtime, this.platform, ['images', '--format', format]),
			CONTAINER_TIMEOUTS.list
		);
		let images: ContainerImageEntry[] = this.catalog?.images ?? [];
		if (imagesResult.code === 0) {
			images =
				runtime === 'docker'
					? parseDockerImages(imagesResult.stdout)
					: parsePodmanImages(imagesResult.stdout);
		} else {
			debug.log('containers', `images unavailable on ${this.hostName}:`, imagesResult.stderr);
			limitations.push({
				code: 'images-unavailable',
				message: `${this.hostName} did not return an image list${
					imagesResult.stderr.trim() ? `: ${imagesResult.stderr.trim().split('\n')[0]}` : '.'
				}`
			});
		}

		const volumesResult = await tryRun(
			this.runner,
			containerArgv(runtime, this.platform, ['volume', 'ls', '--format', format]),
			CONTAINER_TIMEOUTS.list
		);
		let volumes: ContainerVolumeEntry[] = this.catalog?.volumes ?? [];
		if (volumesResult.code === 0) {
			volumes =
				runtime === 'docker'
					? parseDockerVolumes(volumesResult.stdout)
					: parsePodmanVolumes(volumesResult.stdout);
		} else {
			debug.log('containers', `volumes unavailable on ${this.hostName}:`, volumesResult.stderr);
			limitations.push({
				code: 'volumes-unavailable',
				message: `${this.hostName} did not return a volume list${
					volumesResult.stderr.trim() ? `: ${volumesResult.stderr.trim().split('\n')[0]}` : '.'
				}`
			});
		}

		const networksResult = await tryRun(
			this.runner,
			containerArgv(runtime, this.platform, ['network', 'ls', '--format', format]),
			CONTAINER_TIMEOUTS.list
		);
		let networks: ContainerNetworkEntry[] = this.catalog?.networks ?? [];
		if (networksResult.code === 0) {
			networks =
				runtime === 'docker'
					? parseDockerNetworks(networksResult.stdout)
					: parsePodmanNetworks(networksResult.stdout);
		} else {
			debug.log('containers', `networks unavailable on ${this.hostName}:`, networksResult.stderr);
			limitations.push({
				code: 'networks-unavailable',
				message: `${this.hostName} did not return a network list${
					networksResult.stderr.trim() ? `: ${networksResult.stderr.trim().split('\n')[0]}` : '.'
				}`
			});
		}

		images.sort(
			(a, b) => Number(a.dangling) - Number(b.dangling) || a.repository.localeCompare(b.repository)
		);
		volumes.sort((a, b) => a.name.localeCompare(b.name));
		// The runtime's own networks last: they are furniture, not something the
		// user made, and they can never be acted on.
		networks.sort(
			(a, b) => Number(a.predefined) - Number(b.predefined) || a.name.localeCompare(b.name)
		);

		this.catalog = { images, volumes, networks, limitations, readAt: now };
		return this.catalog;
	}

	/** Force the next scan to re-read images and volumes, after an action. */
	invalidateCatalog(): void {
		this.catalog = null;
	}
}

function problemCode(
	problem: 'none' | 'not-installed' | 'daemon-unreachable' | 'permission-denied'
): ContainerLimitation['code'] {
	switch (problem) {
		case 'not-installed':
			return 'no-runtime';
		case 'permission-denied':
			return 'permission-denied';
		default:
			return 'daemon-unreachable';
	}
}
