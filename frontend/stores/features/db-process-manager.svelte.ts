/**
 * Database Process Manager Store — Svelte 5 Runes
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type { DBProcess, DBProcessList, KillMode } from '$shared/types/process-manager';

// ─── State ────────────────────────────────────────────────────────────────────

export const processManagerState = $state({
	isOpen: false,
	connectionId: null as string | null,
	dbType: '',
	processes: [] as DBProcess[],
	fetchedAt: null as string | null,
	isLoading: false,
	killingId: null as string | null,
	/** Auto-refresh interval handle */
	_intervalId: null as ReturnType<typeof setInterval> | null,
	autoRefresh: false,
	refreshIntervalSec: 5
});

// ─── Actions ──────────────────────────────────────────────────────────────────

export function openProcessManager(connectionId: string): void {
	processManagerState.connectionId = connectionId;
	processManagerState.isOpen = true;
	processManagerState.processes = [];
	processManagerState.fetchedAt = null;
	fetchProcesses();
}

export function closeProcessManager(): void {
	processManagerState.isOpen = false;
	stopAutoRefresh();
}

export async function fetchProcesses(): Promise<void> {
	if (!processManagerState.connectionId) return;
	processManagerState.isLoading = true;
	try {
		const result: DBProcessList = await ws.http('db:processes:list', {
			connectionId: processManagerState.connectionId
		});
		processManagerState.processes = result.processes;
		processManagerState.fetchedAt = result.fetchedAt;
		processManagerState.dbType = result.dbType;
	} catch {
		addNotification({
			type: 'error',
			title: 'Process Manager',
			message: 'Failed to fetch processes',
			duration: 4000
		});
	} finally {
		processManagerState.isLoading = false;
	}
}

export async function killProcess(processId: string, mode: KillMode): Promise<void> {
	if (!processManagerState.connectionId) return;
	processManagerState.killingId = processId;
	try {
		const result = await ws.http('db:processes:kill', {
			connectionId: processManagerState.connectionId,
			processId,
			mode
		});
		if (result.ok) {
			addNotification({
				type: 'success',
				title: 'Process Manager',
				message: result.message,
				duration: 3000
			});
			await fetchProcesses();
		} else {
			addNotification({
				type: 'error',
				title: 'Kill Failed',
				message: result.message,
				duration: 5000
			});
		}
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Kill Failed',
			message: err instanceof Error ? err.message : 'Unknown error',
			duration: 5000
		});
	} finally {
		processManagerState.killingId = null;
	}
}

export function startAutoRefresh(): void {
	if (processManagerState._intervalId) return;
	processManagerState.autoRefresh = true;
	processManagerState._intervalId = setInterval(
		() => fetchProcesses(),
		processManagerState.refreshIntervalSec * 1000
	);
}

export function stopAutoRefresh(): void {
	if (processManagerState._intervalId) {
		clearInterval(processManagerState._intervalId);
		processManagerState._intervalId = null;
	}
	processManagerState.autoRefresh = false;
}

export function toggleAutoRefresh(): void {
	if (processManagerState.autoRefresh) {
		stopAutoRefresh();
	} else {
		startAutoRefresh();
	}
}
