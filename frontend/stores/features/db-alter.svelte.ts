/**
 * Table Architect Store - Svelte 5 Runes
 * Manages ALTER TABLE visual operations state.
 */

import { nanoid } from 'nanoid';
import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type { DBType } from '$shared/types/db-manager';
import type { AlterChange, AlterPreview, DBColumnDef } from '$shared/types/alter-table';

// ─── State ────────────────────────────────────────────────────────────────────

export const dbAlterState = $state({
	isOpen: false,
	connectionId: '',
	tableName: '',
	schema: undefined as string | undefined,
	dbType: 'sqlite' as DBType,
	originalColumns: [] as DBColumnDef[],
	changes: [] as AlterChange[],
	isLoading: false,
	previewOpen: false,
	preview: null as AlterPreview | null,
	isGenerating: false,
	isApplying: false
});

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function openArchitect(
	connectionId: string,
	tableName: string,
	schema: string | undefined,
	dbType: DBType
): Promise<void> {
	dbAlterState.connectionId = connectionId;
	dbAlterState.tableName = tableName;
	dbAlterState.schema = schema;
	dbAlterState.dbType = dbType;
	dbAlterState.changes = [];
	dbAlterState.preview = null;
	dbAlterState.previewOpen = false;
	dbAlterState.isOpen = true;
	dbAlterState.isLoading = true;
	try {
		const cols = await ws.http('db:schema:columns', {
			connectionId,
			tableName,
			schema
		});
		dbAlterState.originalColumns = cols ?? [];
	} catch {
		addNotification({ type: 'error', title: 'Table Architect', message: 'Failed to load column definitions', duration: 4000 });
		dbAlterState.isOpen = false;
	} finally {
		dbAlterState.isLoading = false;
	}
}

export function closeArchitect(): void {
	dbAlterState.isOpen = false;
	dbAlterState.previewOpen = false;
	dbAlterState.changes = [];
	dbAlterState.preview = null;
}

export function addChange(change: Omit<AlterChange, 'id'>): void {
	dbAlterState.changes.push({ id: nanoid(), ...change });
}

export function updateChange(id: string, patch: Partial<AlterChange>): void {
	const idx = dbAlterState.changes.findIndex((c) => c.id === id);
	if (idx !== -1) {
		dbAlterState.changes[idx] = { ...dbAlterState.changes[idx], ...patch };
	}
}

export function removeChange(id: string): void {
	dbAlterState.changes = dbAlterState.changes.filter((c) => c.id !== id);
}

export function resetChanges(): void {
	dbAlterState.changes = [];
	dbAlterState.preview = null;
}

export async function previewSQL(): Promise<void> {
	if (!dbAlterState.changes.length) return;
	dbAlterState.isGenerating = true;
	try {
		const preview = await ws.http('db:schema:preview', {
			connectionId: dbAlterState.connectionId,
			tableName: dbAlterState.tableName,
			schema: dbAlterState.schema,
			changes: dbAlterState.changes
		});
		dbAlterState.preview = preview ?? null;
		dbAlterState.previewOpen = true;
	} catch {
		addNotification({ type: 'error', title: 'Table Architect', message: 'Failed to generate SQL preview', duration: 4000 });
	} finally {
		dbAlterState.isGenerating = false;
	}
}

export function closePreview(): void {
	dbAlterState.previewOpen = false;
}

export async function applyChanges(onSuccess?: () => void): Promise<void> {
	dbAlterState.isApplying = true;
	try {
		const result = await ws.http('db:schema:apply', {
			connectionId: dbAlterState.connectionId,
			tableName: dbAlterState.tableName,
			schema: dbAlterState.schema,
			changes: dbAlterState.changes
		});
		if (result?.ok) {
			addNotification({ type: 'success', title: 'Table Architect', message: 'Schema changes applied successfully', duration: 4000 });
			closeArchitect();
			onSuccess?.();
		} else {
			addNotification({ type: 'error', title: 'Table Architect', message: result?.error ?? 'Failed to apply changes', duration: 6000 });
		}
	} catch {
		addNotification({ type: 'error', title: 'Table Architect', message: 'Failed to apply schema changes', duration: 4000 });
	} finally {
		dbAlterState.isApplying = false;
	}
}
