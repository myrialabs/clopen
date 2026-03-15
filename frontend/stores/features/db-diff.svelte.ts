/**
 * Database Diff Store - Svelte 5 Runes
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type { DBSchemaDiff, DBMigrationScript } from '$shared/types/db-diff';

// ─── State ────────────────────────────────────────────────────────────────────

export const dbDiffState = $state({
	sourceConnectionId: null as string | null,
	targetConnectionId: null as string | null,
	diff: null as DBSchemaDiff | null,
	migration: null as DBMigrationScript | null,
	isComparing: false,
	isGeneratingMigration: false,
	isApplying: false,
	showMigrationModal: false,
	filterStatus: 'changes' as 'all' | 'changes'
});

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function runDiffCompare(): Promise<void> {
	if (!dbDiffState.sourceConnectionId || !dbDiffState.targetConnectionId) return;
	if (dbDiffState.sourceConnectionId === dbDiffState.targetConnectionId) {
		addNotification({
			type: 'warning',
			title: 'Database Diff',
			message: 'Source and target must be different connections',
			duration: 4000
		});
		return;
	}

	dbDiffState.isComparing = true;
	dbDiffState.diff = null;
	dbDiffState.migration = null;

	try {
		const result = await ws.http('db:diff:compare', {
			sourceConnectionId: dbDiffState.sourceConnectionId,
			targetConnectionId: dbDiffState.targetConnectionId
		});
		dbDiffState.diff = result;
	} catch {
		addNotification({
			type: 'error',
			title: 'Database Diff',
			message: 'Failed to compare schemas',
			duration: 4000
		});
	} finally {
		dbDiffState.isComparing = false;
	}
}

export async function generateMigration(): Promise<void> {
	if (!dbDiffState.sourceConnectionId || !dbDiffState.targetConnectionId) return;
	dbDiffState.isGeneratingMigration = true;
	try {
		const result = await ws.http('db:diff:generate', {
			sourceConnectionId: dbDiffState.sourceConnectionId,
			targetConnectionId: dbDiffState.targetConnectionId
		});
		dbDiffState.migration = result;
		dbDiffState.showMigrationModal = true;
	} catch {
		addNotification({
			type: 'error',
			title: 'Database Diff',
			message: 'Failed to generate migration script',
			duration: 4000
		});
	} finally {
		dbDiffState.isGeneratingMigration = false;
	}
}

export async function applyMigration(): Promise<boolean> {
	if (!dbDiffState.sourceConnectionId || !dbDiffState.targetConnectionId) return false;
	dbDiffState.isApplying = true;
	try {
		const result = await ws.http('db:diff:apply', {
			sourceConnectionId: dbDiffState.sourceConnectionId,
			targetConnectionId: dbDiffState.targetConnectionId
		});
		if (result.ok) {
			addNotification({
				type: 'success',
				title: 'Migration Applied',
				message: `${result.appliedCount} statement(s) applied successfully`,
				duration: 4000
			});
			dbDiffState.showMigrationModal = false;
			await runDiffCompare();
			return true;
		} else {
			addNotification({
				type: 'error',
				title: 'Migration Failed',
				message: result.error ?? 'Apply failed',
				duration: 6000
			});
			return false;
		}
	} catch {
		addNotification({
			type: 'error',
			title: 'Migration Failed',
			message: 'Failed to apply migration',
			duration: 4000
		});
		return false;
	} finally {
		dbDiffState.isApplying = false;
	}
}

export function resetDiff(): void {
	dbDiffState.diff = null;
	dbDiffState.migration = null;
	dbDiffState.filterStatus = 'changes';
}
