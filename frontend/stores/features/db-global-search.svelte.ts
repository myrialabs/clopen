/**
 * Global Database Search Store - Svelte 5 Runes
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type { GlobalSearchResult, GlobalSearchMatch } from '$shared/types/db-manager';

export interface GlobalSearchSuggestion {
	value: string;
	tableName: string;
	tableSchema?: string;
	columnName: string;
}

// ─── State ────────────────────────────────────────────────────────────────────

export const dbGlobalSearchState = $state({
	isOpen: false,
	query: '',
	isSearching: false,
	isSuggesting: false,
	result: null as GlobalSearchResult | null,
	suggestions: [] as GlobalSearchSuggestion[],
	focusedMatch: null as GlobalSearchMatch | null
});

// ─── Actions ─────────────────────────────────────────────────────────────────

export function openGlobalSearch(): void {
	dbGlobalSearchState.isOpen = true;
	dbGlobalSearchState.result = null;
	dbGlobalSearchState.suggestions = [];
	dbGlobalSearchState.focusedMatch = null;
}

export function closeGlobalSearch(): void {
	dbGlobalSearchState.isOpen = false;
	dbGlobalSearchState.suggestions = [];
}

export function clearSuggestions(): void {
	dbGlobalSearchState.suggestions = [];
}

export async function fetchSuggestions(
	connectionId: string,
	query: string
): Promise<void> {
	if (!query.trim() || query.trim().length < 1) {
		dbGlobalSearchState.suggestions = [];
		return;
	}
	dbGlobalSearchState.isSuggesting = true;
	try {
		const result = await ws.http('db:search:suggest', {
			connectionId,
			query: query.trim(),
			maxSuggestions: 12
		});
		dbGlobalSearchState.suggestions = result ?? [];
	} catch {
		dbGlobalSearchState.suggestions = [];
	} finally {
		dbGlobalSearchState.isSuggesting = false;
	}
}

export async function runGlobalSearch(
	connectionId: string,
	query: string,
	options: { maxMatchesPerTable?: number; maxTotalMatches?: number } = {}
): Promise<void> {
	if (!query.trim()) return;
	dbGlobalSearchState.isSearching = true;
	dbGlobalSearchState.suggestions = [];
	dbGlobalSearchState.result = null;
	dbGlobalSearchState.focusedMatch = null;
	try {
		const result = await ws.http('db:search:global', {
			connectionId,
			query: query.trim(),
			maxMatchesPerTable: options.maxMatchesPerTable,
			maxTotalMatches: options.maxTotalMatches
		});
		dbGlobalSearchState.result = result;
		if (result.error) {
			addNotification({ type: 'error', title: 'Search Error', message: result.error, duration: 5000 });
		}
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Search Failed',
			message: err instanceof Error ? err.message : 'Global search failed',
			duration: 4000
		});
	} finally {
		dbGlobalSearchState.isSearching = false;
	}
}

export function focusMatch(match: GlobalSearchMatch): void {
	dbGlobalSearchState.focusedMatch = match;
}
