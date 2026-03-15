/**
 * SQL Editor Store — schema cache, query history, execution plan, result tabs, AI assistant
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type { DBColumn } from '$shared/types/db-manager';
import type { QueryHistoryEntry } from '$shared/types/query-history';
import { dbManagerState } from './db-manager.svelte';

// ─── State ────────────────────────────────────────────────────────────────────

export const dbSqlEditorState = $state({
	// Schema cache for IntelliSense
	schemaCache: {} as Record<string, DBColumn[]>,
	schemaLoadedForConnectionId: null as string | null,
	isLoadingSchema: false,
	// Query history
	historyEntries: [] as QueryHistoryEntry[],
	isLoadingHistory: false,
	historySearch: '',
	// Execution plan
	isLoadingExplain: false,
	// AI SQL Assistant
	aiPrompt: '',
	aiGeneratedSql: null as string | null,
	aiGeneratedExplanation: null as string | null,
	aiExplainSummary: null as string | null,
	aiExplainSteps: [] as string[],
	isGeneratingSql: false,
	isExplainingWithAi: false,
	aiError: null as string | null,
	aiEngine: 'claude-code',
	aiModel: 'claude-code:haiku'
});

// ─── Actions ──────────────────────────────────────────────────────────────────

/**
 * Preload all table schemas for the given connection (capped at 100 tables)
 * to populate IntelliSense autocomplete.
 */
export async function loadSchemaForCompletion(connectionId: string): Promise<void> {
	if (dbSqlEditorState.schemaLoadedForConnectionId === connectionId) return;

	dbSqlEditorState.isLoadingSchema = true;
	try {
		// Get table list from current state (already loaded by db-manager)
		const tables = dbManagerState.tables.slice(0, 100);
		if (!tables.length) return;

		const results = await Promise.allSettled(
			tables.map((tbl) =>
				ws.http('db:explore:columns', {
					connectionId,
					tableName: tbl.name,
					schema: tbl.schema
				})
			)
		);

		const newCache: Record<string, DBColumn[]> = {};
		results.forEach((result, idx) => {
			if (result.status === 'fulfilled' && result.value) {
				newCache[tables[idx].name] = result.value;
			}
		});

		dbSqlEditorState.schemaCache = newCache;
		dbSqlEditorState.schemaLoadedForConnectionId = connectionId;
	} catch {
		// Non-fatal — autocomplete just won't have schema
	} finally {
		dbSqlEditorState.isLoadingSchema = false;
	}
}

export async function fetchHistory(connectionId?: string): Promise<void> {
	dbSqlEditorState.isLoadingHistory = true;
	try {
		const entries = await ws.http('db:history:list', {
			connectionId: connectionId ?? undefined
		});
		dbSqlEditorState.historyEntries = entries ?? [];
	} catch {
		// Non-fatal
	} finally {
		dbSqlEditorState.isLoadingHistory = false;
	}
}

export async function runExplain(connectionId: string, sql: string): Promise<void> {
	dbSqlEditorState.isLoadingExplain = true;
	dbManagerState.explainResult = null;
	dbManagerState.activeResultTab = 'plan';
	try {
		const result = await ws.http('db:query:explain', { connectionId, sql });
		dbManagerState.explainResult = result;
		if (result.error) {
			addNotification({ type: 'error', title: 'Explain Failed', message: result.error, duration: 5000 });
		}
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'Explain Failed',
			message: err instanceof Error ? err.message : 'Failed to explain query',
			duration: 5000
		});
	} finally {
		dbSqlEditorState.isLoadingExplain = false;
	}
}

export async function deleteHistoryEntry(id: string): Promise<void> {
	try {
		await ws.http('db:history:delete', { id });
		dbSqlEditorState.historyEntries = dbSqlEditorState.historyEntries.filter((e) => e.id !== id);
	} catch {
		addNotification({ type: 'error', title: 'History', message: 'Failed to delete entry', duration: 3000 });
	}
}

export async function toggleFavorite(id: string): Promise<void> {
	try {
		await ws.http('db:history:favorite', { id });
		dbSqlEditorState.historyEntries = dbSqlEditorState.historyEntries.map((e) =>
			e.id === id ? { ...e, isFavorite: !e.isFavorite } : e
		);
	} catch {
		addNotification({ type: 'error', title: 'History', message: 'Failed to update favorite', duration: 3000 });
	}
}

export async function clearHistory(connectionId: string): Promise<void> {
	try {
		await ws.http('db:history:clear', { connectionId });
		dbSqlEditorState.historyEntries = dbSqlEditorState.historyEntries.filter(
			(e) => e.connectionId !== connectionId
		);
	} catch {
		addNotification({ type: 'error', title: 'History', message: 'Failed to clear history', duration: 3000 });
	}
}

export function setResultTab(tab: 'results' | 'plan' | 'history' | 'snippets' | 'audit' | 'ai' | 'visualize'): void {
	dbManagerState.activeResultTab = tab;
}

// ─── AI Assistant Actions ──────────────────────────────────────────────────────

export async function generateSqlFromNl(connectionId: string): Promise<void> {
	if (!dbSqlEditorState.aiPrompt.trim()) return;
	dbSqlEditorState.isGeneratingSql = true;
	dbSqlEditorState.aiGeneratedSql = null;
	dbSqlEditorState.aiGeneratedExplanation = null;
	dbSqlEditorState.aiError = null;
	try {
		const result = await ws.http('db:ai:generate-sql', {
			connectionId,
			prompt: dbSqlEditorState.aiPrompt,
			engine: dbSqlEditorState.aiEngine,
			model: dbSqlEditorState.aiModel
		}, 180000);
		dbSqlEditorState.aiGeneratedSql = result.sql;
		dbSqlEditorState.aiGeneratedExplanation = result.explanation;
	} catch (err) {
		dbSqlEditorState.aiError = err instanceof Error ? err.message : 'Failed to generate SQL';
		addNotification({ type: 'error', title: 'AI Assistant', message: dbSqlEditorState.aiError!, duration: 5000 });
	} finally {
		dbSqlEditorState.isGeneratingSql = false;
	}
}

export async function explainQueryWithAi(connectionId: string, sql: string): Promise<void> {
	if (!sql.trim()) return;
	dbSqlEditorState.isExplainingWithAi = true;
	dbSqlEditorState.aiExplainSummary = null;
	dbSqlEditorState.aiExplainSteps = [];
	dbSqlEditorState.aiError = null;
	try {
		const result = await ws.http('db:ai:explain-query', {
			connectionId,
			sql,
			engine: dbSqlEditorState.aiEngine,
			model: dbSqlEditorState.aiModel
		}, 180000);
		dbSqlEditorState.aiExplainSummary = result.summary;
		dbSqlEditorState.aiExplainSteps = result.steps;
	} catch (err) {
		dbSqlEditorState.aiError = err instanceof Error ? err.message : 'Failed to explain query';
		addNotification({ type: 'error', title: 'AI Assistant', message: dbSqlEditorState.aiError!, duration: 5000 });
	} finally {
		dbSqlEditorState.isExplainingWithAi = false;
	}
}

export function clearAiState(): void {
	dbSqlEditorState.aiPrompt = '';
	dbSqlEditorState.aiGeneratedSql = null;
	dbSqlEditorState.aiGeneratedExplanation = null;
	dbSqlEditorState.aiExplainSummary = null;
	dbSqlEditorState.aiExplainSteps = [];
	dbSqlEditorState.aiError = null;
}
