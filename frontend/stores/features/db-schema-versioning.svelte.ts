/**
 * Schema Versioning Store - Svelte 5 Runes
 * Manages state for the Schema Version History panel and rollback flow.
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type { SchemaVersion, SchemaVersionSummary, SchemaVersionDiff } from '$shared/types/schema-versioning';

// ─── State ────────────────────────────────────────────────────────────────────

export const dbSchemaVersionState = $state({
	/** Whether the version history panel is visible */
	isOpen: false,
	connectionId: '',
	tableName: '',
	versions: [] as SchemaVersionSummary[],
	isLoading: false,

	/** Expanded full version detail */
	selectedVersion: null as SchemaVersion | null,
	isLoadingDetail: false,

	/** Diff modal between two versions */
	diffModal: {
		isOpen: false,
		diff: null as SchemaVersionDiff | null,
		isLoading: false
	},

	/** Rollback confirmation modal */
	rollbackModal: {
		isOpen: false,
		version: null as SchemaVersion | null,
		isExecuting: false
	},

	/** Label edit state */
	editingLabelId: null as string | null,
	editingLabelValue: ''
});

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function openVersionHistory(connectionId: string, tableName: string): Promise<void> {
	dbSchemaVersionState.connectionId = connectionId;
	dbSchemaVersionState.tableName = tableName;
	dbSchemaVersionState.isOpen = true;
	dbSchemaVersionState.selectedVersion = null;
	dbSchemaVersionState.diffModal.isOpen = false;
	dbSchemaVersionState.rollbackModal.isOpen = false;
	await loadVersions();
}

export function closeVersionHistory(): void {
	dbSchemaVersionState.isOpen = false;
	dbSchemaVersionState.selectedVersion = null;
}

export async function loadVersions(): Promise<void> {
	if (!dbSchemaVersionState.connectionId || !dbSchemaVersionState.tableName) return;
	dbSchemaVersionState.isLoading = true;
	try {
		const result = await ws.http('db:schema:version:list', {
			connectionId: dbSchemaVersionState.connectionId,
			tableName: dbSchemaVersionState.tableName
		});
		dbSchemaVersionState.versions = result ?? [];
	} catch {
		addNotification({ type: 'error', title: 'Schema Versions', message: 'Failed to load version history', duration: 4000 });
	} finally {
		dbSchemaVersionState.isLoading = false;
	}
}

export async function selectVersion(id: string): Promise<void> {
	if (dbSchemaVersionState.selectedVersion?.id === id) {
		dbSchemaVersionState.selectedVersion = null;
		return;
	}
	dbSchemaVersionState.isLoadingDetail = true;
	try {
		const result = await ws.http('db:schema:version:get', { id });
		dbSchemaVersionState.selectedVersion = (result ?? null) as typeof dbSchemaVersionState.selectedVersion;
	} catch {
		addNotification({ type: 'error', title: 'Schema Versions', message: 'Failed to load version details', duration: 4000 });
	} finally {
		dbSchemaVersionState.isLoadingDetail = false;
	}
}

export async function openDiff(versionIdA: string, versionIdB: string): Promise<void> {
	dbSchemaVersionState.diffModal.isOpen = true;
	dbSchemaVersionState.diffModal.diff = null;
	dbSchemaVersionState.diffModal.isLoading = true;
	try {
		const result = await ws.http('db:schema:version:diff', { versionIdA, versionIdB });
		dbSchemaVersionState.diffModal.diff = (result ?? null) as typeof dbSchemaVersionState.diffModal.diff;
	} catch {
		addNotification({ type: 'error', title: 'Schema Versions', message: 'Failed to compute diff', duration: 4000 });
	} finally {
		dbSchemaVersionState.diffModal.isLoading = false;
	}
}

export function closeDiff(): void {
	dbSchemaVersionState.diffModal.isOpen = false;
	dbSchemaVersionState.diffModal.diff = null;
}

export async function openRollback(id: string): Promise<void> {
	dbSchemaVersionState.rollbackModal.isOpen = true;
	dbSchemaVersionState.rollbackModal.version = null;
	dbSchemaVersionState.isLoadingDetail = true;
	try {
		const result = await ws.http('db:schema:version:get', { id });
		dbSchemaVersionState.rollbackModal.version = (result ?? null) as typeof dbSchemaVersionState.rollbackModal.version;
	} catch {
		addNotification({ type: 'error', title: 'Schema Versions', message: 'Failed to load version for rollback', duration: 4000 });
		dbSchemaVersionState.rollbackModal.isOpen = false;
	} finally {
		dbSchemaVersionState.isLoadingDetail = false;
	}
}

export function closeRollback(): void {
	dbSchemaVersionState.rollbackModal.isOpen = false;
	dbSchemaVersionState.rollbackModal.version = null;
}

export async function executeRollback(onSuccess?: () => void): Promise<void> {
	const version = dbSchemaVersionState.rollbackModal.version;
	if (!version) return;
	dbSchemaVersionState.rollbackModal.isExecuting = true;
	try {
		const result = await ws.http('db:schema:version:rollback', {
			connectionId: version.connectionId,
			versionId: version.id
		});
		if (result?.ok) {
			addNotification({
				type: 'success',
				title: 'Schema Rollback',
				message: `Successfully rolled back v${version.versionNumber} of ${version.tableName}`,
				duration: 5000
			});
			closeRollback();
			await loadVersions();
			onSuccess?.();
		} else {
			addNotification({ type: 'error', title: 'Schema Rollback', message: result?.error ?? 'Rollback failed', duration: 6000 });
		}
	} catch {
		addNotification({ type: 'error', title: 'Schema Rollback', message: 'Failed to execute rollback', duration: 4000 });
	} finally {
		dbSchemaVersionState.rollbackModal.isExecuting = false;
	}
}

export function startEditLabel(id: string, currentLabel: string | null): void {
	dbSchemaVersionState.editingLabelId = id;
	dbSchemaVersionState.editingLabelValue = currentLabel ?? '';
}

export function cancelEditLabel(): void {
	dbSchemaVersionState.editingLabelId = null;
	dbSchemaVersionState.editingLabelValue = '';
}

export async function saveLabel(): Promise<void> {
	const id = dbSchemaVersionState.editingLabelId;
	if (!id) return;
	const label = dbSchemaVersionState.editingLabelValue.trim();
	try {
		await ws.http('db:schema:version:label', { id, label });
		const idx = dbSchemaVersionState.versions.findIndex((v) => v.id === id);
		if (idx !== -1) dbSchemaVersionState.versions[idx].label = label || null;
		if (dbSchemaVersionState.selectedVersion?.id === id) {
			dbSchemaVersionState.selectedVersion.label = label || null;
		}
	} catch {
		addNotification({ type: 'error', title: 'Schema Versions', message: 'Failed to save label', duration: 4000 });
	} finally {
		cancelEditLabel();
	}
}

export async function exportVersion(id: string, direction: 'up' | 'down' = 'up'): Promise<void> {
	try {
		const result = await ws.http('db:schema:version:export', { id, direction });
		if (!result) return;
		const blob = new Blob([result.content], { type: 'text/sql' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = result.filename;
		a.click();
		URL.revokeObjectURL(url);
	} catch {
		addNotification({ type: 'error', title: 'Schema Versions', message: 'Failed to export version', duration: 4000 });
	}
}
