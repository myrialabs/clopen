/**
 * Database Automated Backup Store — Svelte 5 Runes
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type { BackupConfig, BackupRun } from '$shared/types/db-export';

// ─── State ────────────────────────────────────────────────────────────────────

export const dbBackupState = $state({
	isOpen: false,
	configs: [] as BackupConfig[],
	isLoading: false,
	isSaving: false,
	isRunning: false,
	/** Config being edited in the form (null = new) */
	editingConfig: null as BackupConfig | null,
	showForm: false,
	/** Run history keyed by configId */
	runHistory: {} as Record<string, BackupRun[]>,
	isLoadingHistory: false,
	expandedConfigId: null as string | null
});

// ─── Actions ──────────────────────────────────────────────────────────────────

export function openBackupPanel(): void {
	dbBackupState.isOpen = true;
}

export function closeBackupPanel(): void {
	dbBackupState.isOpen = false;
	dbBackupState.showForm = false;
	dbBackupState.editingConfig = null;
}

export function showNewConfigForm(): void {
	dbBackupState.editingConfig = null;
	dbBackupState.showForm = true;
}

export function showEditConfigForm(config: BackupConfig): void {
	dbBackupState.editingConfig = { ...config };
	dbBackupState.showForm = true;
}

export function cancelForm(): void {
	dbBackupState.showForm = false;
	dbBackupState.editingConfig = null;
}

export async function loadBackupConfigs(connectionId: string): Promise<void> {
	dbBackupState.isLoading = true;
	try {
		const result = await ws.http('db:backup:list', { connectionId });
		dbBackupState.configs = result ?? [];
	} catch {
		addNotification({ type: 'error', title: 'Backup', message: 'Failed to load backup configs', duration: 4000 });
	} finally {
		dbBackupState.isLoading = false;
	}
}

export async function createBackupConfig(
	data: Omit<BackupConfig, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastRunSuccess' | 'lastRunError'>
): Promise<BackupConfig | null> {
	dbBackupState.isSaving = true;
	try {
		const result = await ws.http('db:backup:create', data);
		dbBackupState.configs = [...dbBackupState.configs, result];
		addNotification({ type: 'success', title: 'Backup', message: 'Backup config created', duration: 3000 });
		dbBackupState.showForm = false;
		return result;
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Backup',
			message: err instanceof Error ? err.message : 'Failed to create backup config',
			duration: 5000
		});
		return null;
	} finally {
		dbBackupState.isSaving = false;
	}
}

export async function updateBackupConfig(
	id: string,
	connectionId: string,
	data: Partial<BackupConfig>
): Promise<BackupConfig | null> {
	dbBackupState.isSaving = true;
	try {
		const result = await ws.http('db:backup:update', { id, connectionId, ...data });
		dbBackupState.configs = dbBackupState.configs.map((c) => (c.id === id ? result : c));
		addNotification({ type: 'success', title: 'Backup', message: 'Backup config updated', duration: 3000 });
		dbBackupState.showForm = false;
		dbBackupState.editingConfig = null;
		return result;
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Backup',
			message: err instanceof Error ? err.message : 'Failed to update backup config',
			duration: 5000
		});
		return null;
	} finally {
		dbBackupState.isSaving = false;
	}
}

export async function deleteBackupConfig(id: string, connectionId: string): Promise<void> {
	try {
		await ws.http('db:backup:delete', { id, connectionId });
		dbBackupState.configs = dbBackupState.configs.filter((c) => c.id !== id);
		addNotification({ type: 'success', title: 'Backup', message: 'Backup config deleted', duration: 3000 });
	} catch {
		addNotification({ type: 'error', title: 'Backup', message: 'Failed to delete backup config', duration: 4000 });
	}
}

export async function runBackupNow(id: string, connectionId: string): Promise<void> {
	dbBackupState.isRunning = true;
	addNotification({ type: 'info', title: 'Backup', message: 'Starting backup…', duration: 3000 });
	try {
		const run = await ws.http('db:backup:run', { id, connectionId });
		// Update the last run info in the local config
		dbBackupState.configs = dbBackupState.configs.map((c) =>
			c.id === id
				? { ...c, lastRunAt: run.startedAt, lastRunSuccess: run.success, lastRunError: run.error }
				: c
		);
		// Prepend to run history if loaded
		if (dbBackupState.runHistory[id]) {
			dbBackupState.runHistory[id] = [run, ...dbBackupState.runHistory[id]];
		}
		if (run.success) {
			addNotification({
				type: 'success',
				title: 'Backup Complete',
				message: `Backup saved to ${run.storagePath ?? 'cloud storage'}`,
				duration: 6000
			});
		} else {
			addNotification({
				type: 'error',
				title: 'Backup Failed',
				message: run.error ?? 'Backup encountered an error',
				duration: 8000
			});
		}
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Backup Failed',
			message: err instanceof Error ? err.message : 'Backup failed',
			duration: 6000
		});
	} finally {
		dbBackupState.isRunning = false;
	}
}

export async function loadRunHistory(configId: string, connectionId: string): Promise<void> {
	dbBackupState.isLoadingHistory = true;
	try {
		const runs = await ws.http('db:backup:history', { configId, connectionId });
		dbBackupState.runHistory = { ...dbBackupState.runHistory, [configId]: runs ?? [] };
	} catch {
		addNotification({ type: 'error', title: 'Backup', message: 'Failed to load run history', duration: 4000 });
	} finally {
		dbBackupState.isLoadingHistory = false;
	}
}

export function toggleHistoryPanel(configId: string, connectionId: string): void {
	if (dbBackupState.expandedConfigId === configId) {
		dbBackupState.expandedConfigId = null;
	} else {
		dbBackupState.expandedConfigId = configId;
		if (!dbBackupState.runHistory[configId]) {
			loadRunHistory(configId, connectionId);
		}
	}
}
