/**
 * SQL Snippets Cloud Store — CRUD, search, tag filtering, share links
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type { SqlSnippet, SqlSnippetCreateInput, SqlSnippetUpdateInput } from '$shared/types/sql-snippets';

// ─── State ────────────────────────────────────────────────────────────────────

export const dbSnippetsState = $state({
	snippets: [] as SqlSnippet[],
	isLoading: false,
	search: '',
	activeTag: null as string | null,
	/** Snippet open in the preview modal */
	previewSnippet: null as SqlSnippet | null,
	/** Snippet open in the form modal (null = creating new) */
	editSnippet: null as SqlSnippet | null,
	isFormOpen: false,
	isPreviewOpen: false,
	/** Snippet currently generating / sharing */
	sharingId: null as string | null
});

// ─── Derived helpers ──────────────────────────────────────────────────────────

export function getFilteredSnippets(): SqlSnippet[] {
	const search = dbSnippetsState.search.toLowerCase();
	const tag = dbSnippetsState.activeTag;
	return dbSnippetsState.snippets.filter((s) => {
		const matchesSearch =
			!search ||
			s.title.toLowerCase().includes(search) ||
			s.description.toLowerCase().includes(search) ||
			s.sql.toLowerCase().includes(search) ||
			s.tags.some((t) => t.toLowerCase().includes(search));
		const matchesTag = !tag || s.tags.includes(tag);
		return matchesSearch && matchesTag;
	});
}

export function getAllTags(): string[] {
	const set = new Set<string>();
	for (const s of dbSnippetsState.snippets) {
		for (const t of s.tags) set.add(t);
	}
	return Array.from(set).sort();
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function fetchSnippets(): Promise<void> {
	dbSnippetsState.isLoading = true;
	try {
		const snippets = await ws.http('db:snippets:list', {});
		dbSnippetsState.snippets = snippets ?? [];
	} catch {
		// Non-fatal
	} finally {
		dbSnippetsState.isLoading = false;
	}
}

export async function createSnippet(input: SqlSnippetCreateInput): Promise<boolean> {
	try {
		const snippet = await ws.http('db:snippets:create', input);
		dbSnippetsState.snippets = [snippet, ...dbSnippetsState.snippets];
		addNotification({ type: 'success', title: 'Snippet saved', message: `"${snippet.title}" added to library`, duration: 3000 });
		return true;
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Snippets',
			message: err instanceof Error ? err.message : 'Failed to create snippet',
			duration: 4000
		});
		return false;
	}
}

export async function updateSnippet(input: SqlSnippetUpdateInput): Promise<boolean> {
	try {
		const updated = await ws.http('db:snippets:update', input);
		if (!updated) return false;
		dbSnippetsState.snippets = dbSnippetsState.snippets.map((s) =>
			s.id === updated.id ? updated : s
		);
		if (dbSnippetsState.previewSnippet?.id === updated.id) {
			dbSnippetsState.previewSnippet = updated;
		}
		addNotification({ type: 'success', title: 'Snippet updated', message: `"${updated.title}" saved`, duration: 2500 });
		return true;
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Snippets',
			message: err instanceof Error ? err.message : 'Failed to update snippet',
			duration: 4000
		});
		return false;
	}
}

export async function deleteSnippet(id: string): Promise<void> {
	try {
		await ws.http('db:snippets:delete', { id });
		dbSnippetsState.snippets = dbSnippetsState.snippets.filter((s) => s.id !== id);
		if (dbSnippetsState.previewSnippet?.id === id) closePreview();
		addNotification({ type: 'success', title: 'Snippet deleted', message: 'Snippet removed from library', duration: 2500 });
	} catch {
		addNotification({ type: 'error', title: 'Snippets', message: 'Failed to delete snippet', duration: 3000 });
	}
}

export async function generateShareLink(id: string): Promise<string | null> {
	dbSnippetsState.sharingId = id;
	try {
		const updated = await ws.http('db:snippets:share', { id, generate: true });
		if (!updated) return null;
		dbSnippetsState.snippets = dbSnippetsState.snippets.map((s) =>
			s.id === updated.id ? updated : s
		);
		if (dbSnippetsState.previewSnippet?.id === updated.id) {
			dbSnippetsState.previewSnippet = updated;
		}
		return updated.shareToken;
	} catch {
		addNotification({ type: 'error', title: 'Snippets', message: 'Failed to generate share link', duration: 3000 });
		return null;
	} finally {
		dbSnippetsState.sharingId = null;
	}
}

export async function revokeShareLink(id: string): Promise<void> {
	dbSnippetsState.sharingId = id;
	try {
		const updated = await ws.http('db:snippets:share', { id, generate: false });
		if (!updated) return;
		dbSnippetsState.snippets = dbSnippetsState.snippets.map((s) =>
			s.id === updated.id ? updated : s
		);
		if (dbSnippetsState.previewSnippet?.id === updated.id) {
			dbSnippetsState.previewSnippet = updated;
		}
	} catch {
		addNotification({ type: 'error', title: 'Snippets', message: 'Failed to revoke share link', duration: 3000 });
	} finally {
		dbSnippetsState.sharingId = null;
	}
}

export function openPreview(snippet: SqlSnippet): void {
	dbSnippetsState.previewSnippet = snippet;
	dbSnippetsState.isPreviewOpen = true;
}

export function closePreview(): void {
	dbSnippetsState.isPreviewOpen = false;
	dbSnippetsState.previewSnippet = null;
}

export function openForm(snippet?: SqlSnippet): void {
	dbSnippetsState.editSnippet = snippet ?? null;
	dbSnippetsState.isFormOpen = true;
}

export function closeForm(): void {
	dbSnippetsState.isFormOpen = false;
	dbSnippetsState.editSnippet = null;
}
