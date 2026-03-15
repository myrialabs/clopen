/**
 * ERD Store - Svelte 5 Runes
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type { ERDMetadata } from '$shared/types/erd';

// ─── State ────────────────────────────────────────────────────────────────────

export const dbErdState = $state({
	metadata: null as ERDMetadata | null,
	isLoading: false,
	loadedForConnectionId: null as string | null
});

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function loadERDMetadata(connectionId: string): Promise<void> {
	if (dbErdState.isLoading) return;
	dbErdState.isLoading = true;
	dbErdState.metadata = null;
	dbErdState.loadedForConnectionId = connectionId;
	try {
		const result = await ws.http('db:erd:metadata', { connectionId });
		dbErdState.metadata = result;
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'ERD',
			message: err instanceof Error ? err.message : 'Failed to load ERD metadata',
			duration: 4000
		});
	} finally {
		dbErdState.isLoading = false;
	}
}

export function resetERD(): void {
	dbErdState.metadata = null;
	dbErdState.loadedForConnectionId = null;
}
