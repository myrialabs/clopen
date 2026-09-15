/**
 * Wire shapes for the Device settings panel.
 *
 * Lifted out of `AboutDeviceSettings.svelte` because its module script caches
 * both payloads for the prefetch that runs when the Settings modal opens, and a
 * `<script module>` block cannot see interfaces declared in the instance script.
 *
 * Mirrors the response schemas of `system:device-info` (`backend/ws/system/
 * device-info.ts`) and `projects:overview` (`backend/ws/projects/overview.ts`).
 */

export interface Gpu {
	model: string;
	vendor: string;
	vramMb: number | null;
	utilizationGpu: number | null;
	memoryUsedMb: number | null;
	memoryTotalMb: number | null;
}

export interface Disk {
	mount: string;
	type: string;
	sizeBytes: number;
	usedBytes: number;
	usePercent: number;
}

export interface DeviceInfo {
	hostname: string;
	platform: string;
	distro: string;
	release: string;
	kernel: string;
	arch: string;
	isVirtual: boolean;
	uptimeSec: number;
	cpu: {
		brand: string;
		manufacturer: string;
		physicalCores: number;
		logicalCores: number;
		speedGhz: number | null;
		loadPercent: number;
		loadAvg1: number | null;
	};
	memory: {
		totalBytes: number;
		usedBytes: number;
		freeBytes: number;
		swapTotalBytes: number;
		swapUsedBytes: number;
	};
	network: { iface: string; ip4: string; mac: string };
	battery: {
		hasBattery: boolean;
		percent: number | null;
		isCharging: boolean;
		acConnected: boolean;
		timeRemainingMinutes: number | null;
	};
	gpus: Gpu[];
	disks: Disk[];
}

/** `measuring` means no walk has finished yet, so the counts are not a total. */
export type StorageState = 'ready' | 'measuring' | 'unavailable';

export interface ProjectStorage {
	state: StorageState;
	sizeBytes: number;
	fileCount: number;
	dirCount: number;
	truncated: boolean;
	error: string | null;
}

export interface ProjectResourceEntry {
	id: string;
	name: string;
	path: string;
	created_at: string;
	last_opened_at: string;
	status: 'running' | 'idle';
	cpuPercent: number | null;
	memRssBytes: number | null;
	memPercent: number | null;
	storage: ProjectStorage;
}

export interface ProjectsOverview {
	totalProjects: number;
	runningCount: number;
	idleCount: number;
	measuredCount: number;
	measuringCount: number;
	unavailableCount: number;
	totalStorageBytes: number;
	totalFiles: number;
	totalDirs: number;
	projects: ProjectResourceEntry[];
	generatedAt: string;
}
