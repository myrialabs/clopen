/**
 * Database Manager Store - Svelte 5 Runes
 *
 * Multi-tab architecture: each open database session lives in a DBTabState.
 * The flat fields on dbManagerState (activeConnectionId, tables, etc.) always
 * reflect the currently active tab. Tab switching snapshots and restores them
 * instantly — no re-fetching unless the user explicitly refreshes.
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type {
	DBConnectionConfig,
	DBTable,
	DBColumn,
	DBQueryResult,
	DBRowFilter,
	DBTabState
} from '$shared/types/db-manager';
import { getConnectionTabColor } from '$shared/types/db-manager';

// ─── State ────────────────────────────────────────────────────────────────────

/** UI interaction state — quick search / shortcut guide visibility */
export const dbUiState = $state({
	showQuickSearch: false,
	showShortcutGuide: false,
});

export const dbManagerState = $state({
	// ─── Global (not per-tab) ─────────────────────────────────────────────
	connections: [] as DBConnectionConfig[],
	isLoadingConnections: false,
	isTesting: false,
	testResult: null as { success: boolean; message: string; version?: string; latencyMs?: number } | null,

	// ─── Tab management ───────────────────────────────────────────────────
	/** All open session tabs (max 10) */
	tabs: [] as DBTabState[],
	/** ID of the currently visible tab */
	activeTabId: null as string | null,

	// ─── Active-tab live state (mirrors the active DBTabState) ────────────
	activeConnectionId: null as string | null,
	activeTableName: null as string | null,
	activeTableSchema: null as string | null,
	tables: [] as DBTable[],
	columns: [] as DBColumn[],
	queryResult: null as DBQueryResult | null,
	browseResult: null as DBQueryResult | null,
	activeTab: 'browse' as 'browse' | 'query',
	currentSql: 'SELECT 1;',

	// ─── Loading indicators (active operations only) ──────────────────────
	isLoadingTables: false,
	isLoadingColumns: false,
	isLoadingQuery: false,
	isLoadingBrowse: false,

	// ─── SQL editor per-tab state ─────────────────────────────────────────
	explainResult: null as DBQueryResult | null,
	activeResultTab: 'results' as 'results' | 'plan' | 'history' | 'snippets' | 'audit' | 'ai' | 'visualize',

	// ─── Browse state ─────────────────────────────────────────────────────
	browsePage: 0,
	browsePageSize: 100,
	browseFilters: [] as DBRowFilter[],
	browseTotalCount: 0,
	isLoadingCount: false,

	// ─── Row selection / editing ──────────────────────────────────────────
	selectedRowKeys: [] as string[],
	editingRow: null as Record<string, unknown> | null,
	isInsertingRow: false,
	isSavingRow: false,
	isDeletingRows: false,

	// ─── Bulk action (global selection + bulk operations) ─────────────────
	/** true when the user has chosen "Select all N rows" (dataset-wide) */
	globalSelectionActive: false,
	/** Controls the BulkActionModal lifecycle */
	bulkModal: {
		show: false,
		operation: 'delete' as 'delete' | 'update',
		phase: 'confirm' as 'confirm' | 'running' | 'done',
		rowCount: 0,
		processed: 0,
		error: null as string | null,
		isGlobal: false,
		// update-specific
		updateColumn: '',
		updateValue: '',
		updateIsNull: false
	}
});

// ─── Derived helpers ──────────────────────────────────────────────────────────

export function getActiveConnection(): DBConnectionConfig | null {
	return dbManagerState.connections.find((c) => c.id === dbManagerState.activeConnectionId) ?? null;
}

/** Returns the first PK column name, or the first column as fallback */
export function getPkColumn(): { column: string; isFallback: boolean } | null {
	const cols = dbManagerState.columns;
	if (!cols.length) return null;
	const pk = cols.find((c) => c.primaryKey);
	if (pk) return { column: pk.name, isFallback: false };
	return { column: cols[0].name, isFallback: true };
}

// ─── Tab helpers ──────────────────────────────────────────────────────────────

function createEmptyTabState(id: string, connectionId: string, label: string, color: string): DBTabState {
	return {
		id,
		connectionId,
		label,
		color,
		activeTableName: null,
		activeTableSchema: null,
		tables: [],
		columns: [],
		queryResult: null,
		browseResult: null,
		activePanel: 'browse',
		currentSql: 'SELECT 1;',
		browsePage: 0,
		browsePageSize: 100,
		browseFilters: [],
		browseTotalCount: 0,
		selectedRowKeys: [],
		explainResult: null,
		activeResultTab: 'results',
	};
}

/** Snapshot current live state into the active tab object */
function saveCurrentTabState(): void {
	if (!dbManagerState.activeTabId) return;
	const tab = dbManagerState.tabs.find(t => t.id === dbManagerState.activeTabId);
	if (!tab) return;
	tab.activeTableName = dbManagerState.activeTableName;
	tab.activeTableSchema = dbManagerState.activeTableSchema;
	tab.tables = [...dbManagerState.tables];
	tab.columns = [...dbManagerState.columns];
	tab.queryResult = dbManagerState.queryResult;
	tab.browseResult = dbManagerState.browseResult;
	tab.activePanel = dbManagerState.activeTab;
	tab.currentSql = dbManagerState.currentSql;
	tab.browsePage = dbManagerState.browsePage;
	tab.browsePageSize = dbManagerState.browsePageSize;
	tab.browseFilters = [...dbManagerState.browseFilters];
	tab.browseTotalCount = dbManagerState.browseTotalCount;
	tab.selectedRowKeys = [...dbManagerState.selectedRowKeys];
	tab.explainResult = dbManagerState.explainResult;
	tab.activeResultTab = dbManagerState.activeResultTab;
}

/** Restore a tab's snapshot into the live state — instant, no network calls */
function restoreTabState(tab: DBTabState): void {
	dbManagerState.activeTabId = tab.id;
	dbManagerState.activeConnectionId = tab.connectionId;
	dbManagerState.activeTableName = tab.activeTableName;
	dbManagerState.activeTableSchema = tab.activeTableSchema;
	dbManagerState.tables = [...tab.tables];
	dbManagerState.columns = [...tab.columns];
	dbManagerState.queryResult = tab.queryResult;
	dbManagerState.browseResult = tab.browseResult;
	dbManagerState.activeTab = tab.activePanel;
	dbManagerState.currentSql = tab.currentSql;
	dbManagerState.browsePage = tab.browsePage;
	dbManagerState.browsePageSize = tab.browsePageSize;
	dbManagerState.browseFilters = [...tab.browseFilters];
	dbManagerState.browseTotalCount = tab.browseTotalCount;
	dbManagerState.selectedRowKeys = [...tab.selectedRowKeys];
	dbManagerState.explainResult = tab.explainResult;
	dbManagerState.activeResultTab = tab.activeResultTab;
	// Clear transient UI state for the new tab
	dbManagerState.editingRow = null;
	dbManagerState.isInsertingRow = false;
}

// ─── Tab Management ───────────────────────────────────────────────────────────

/**
 * Switch to an existing tab. Saves current tab state first, then restores the
 * target tab's cached state — no re-fetching unless tables were never loaded.
 */
export function switchToTab(tabId: string): void {
	if (dbManagerState.activeTabId === tabId) return;
	saveCurrentTabState();
	const tab = dbManagerState.tabs.find(t => t.id === tabId);
	if (!tab) return;
	restoreTabState(tab);
}

/**
 * Open or focus a tab for the given connection.
 * If a tab already exists for that connection, switches to it.
 * Otherwise creates a new tab and loads its tables.
 */
export async function openConnectionTab(connectionId: string): Promise<void> {
	const existing = dbManagerState.tabs.find(t => t.connectionId === connectionId);
	if (existing) {
		switchToTab(existing.id);
		return;
	}
	await openNewTabForConnection(connectionId);
}

/**
 * Always opens a brand-new tab for the given connection, even if one already exists.
 * Respects the 10-tab maximum.
 */
export async function openNewTabForConnection(connectionId: string): Promise<void> {
	if (dbManagerState.tabs.length >= 10) {
		addNotification({ type: 'warning', title: 'Tab limit reached', message: 'Close a tab before opening another', duration: 3000 });
		return;
	}
	const conn = dbManagerState.connections.find(c => c.id === connectionId);
	if (!conn) return;
	const tabId = crypto.randomUUID();
	const color = getConnectionTabColor(conn.name, conn.color);
	const tab = createEmptyTabState(tabId, connectionId, conn.name, color);
	saveCurrentTabState();
	dbManagerState.tabs.push(tab);
	restoreTabState(tab);
	await loadTablesForActive();
}

/** Close a tab. If it was active, switches to the nearest tab. */
export function closeTab(tabId: string): void {
	const idx = dbManagerState.tabs.findIndex(t => t.id === tabId);
	if (idx === -1) return;
	const wasActive = dbManagerState.activeTabId === tabId;
	dbManagerState.tabs.splice(idx, 1);

	if (!wasActive) return;

	if (dbManagerState.tabs.length === 0) {
		dbManagerState.activeTabId = null;
		dbManagerState.activeConnectionId = null;
		dbManagerState.activeTableName = null;
		dbManagerState.activeTableSchema = null;
		dbManagerState.tables = [];
		dbManagerState.columns = [];
		dbManagerState.queryResult = null;
		dbManagerState.browseResult = null;
		dbManagerState.activeTab = 'browse';
		dbManagerState.currentSql = 'SELECT 1;';
		dbManagerState.browsePage = 0;
		dbManagerState.browseFilters = [];
		dbManagerState.browseTotalCount = 0;
		dbManagerState.selectedRowKeys = [];
		dbManagerState.explainResult = null;
		dbManagerState.activeResultTab = 'results';
		dbManagerState.editingRow = null;
		dbManagerState.isInsertingRow = false;
	} else {
		// Switch to adjacent tab without double-saving (closed tab state is discarded)
		const newTab = dbManagerState.tabs[Math.min(idx, dbManagerState.tabs.length - 1)];
		dbManagerState.activeTabId = null; // prevent saveCurrentTabState in switchToTab from writing stale data
		restoreTabState(newTab);
	}
}

// ─── Connection Actions ───────────────────────────────────────────────────────

export async function loadConnections(): Promise<void> {
	dbManagerState.isLoadingConnections = true;
	try {
		const result = await ws.http('db:connections:list', {});
		dbManagerState.connections = result ?? [];
	} catch {
		addNotification({ type: 'error', title: 'DB Manager', message: 'Failed to load connections', duration: 4000 });
	} finally {
		dbManagerState.isLoadingConnections = false;
	}
}

export async function createConnection(
	data: Omit<DBConnectionConfig, 'id' | 'createdAt' | 'updatedAt'>
): Promise<DBConnectionConfig | null> {
	try {
		const result = await ws.http('db:connections:create', data);
		dbManagerState.connections = [...dbManagerState.connections, result];
		return result;
	} catch {
		addNotification({ type: 'error', title: 'DB Manager', message: 'Failed to create connection', duration: 4000 });
		return null;
	}
}

export async function updateConnection(
	id: string,
	data: Partial<DBConnectionConfig>
): Promise<DBConnectionConfig | null> {
	try {
		const result = await ws.http('db:connections:update', { id, ...data });
		dbManagerState.connections = dbManagerState.connections.map((c) =>
			c.id === id ? result : c
		);
		// Sync label/color of any open tabs for this connection
		for (const tab of dbManagerState.tabs) {
			if (tab.connectionId === id) {
				tab.label = result.name;
				tab.color = getConnectionTabColor(result.name, result.color);
			}
		}
		return result;
	} catch {
		addNotification({ type: 'error', title: 'DB Manager', message: 'Failed to update connection', duration: 4000 });
		return null;
	}
}

export async function deleteConnection(id: string): Promise<void> {
	try {
		await ws.http('db:connections:delete', { id });
		dbManagerState.connections = dbManagerState.connections.filter((c) => c.id !== id);
		// Close all open tabs for the deleted connection
		const tabIds = dbManagerState.tabs.filter(t => t.connectionId === id).map(t => t.id);
		for (const tabId of tabIds) {
			closeTab(tabId);
		}
	} catch {
		addNotification({ type: 'error', title: 'DB Manager', message: 'Failed to delete connection', duration: 4000 });
	}
}

export async function testConnectionConfig(
	data: Omit<DBConnectionConfig, 'id' | 'name' | 'createdAt' | 'updatedAt'>
): Promise<void> {
	dbManagerState.isTesting = true;
	dbManagerState.testResult = null;
	try {
		const result = await ws.http('db:connections:test', data);
		dbManagerState.testResult = result;
	} catch {
		dbManagerState.testResult = { success: false, message: 'Connection test failed' };
	} finally {
		dbManagerState.isTesting = false;
	}
}

// ─── Table Navigation ─────────────────────────────────────────────────────────

/**
 * Kept for backward compat — delegates to openConnectionTab.
 * Switches to an existing tab or opens a new one.
 */
export async function selectConnection(connectionId: string): Promise<void> {
	await openConnectionTab(connectionId);
}

export async function loadTablesForActive(): Promise<void> {
	if (!dbManagerState.activeConnectionId) return;
	const tabId = dbManagerState.activeTabId;
	dbManagerState.isLoadingTables = true;
	dbManagerState.tables = [];
	try {
		const result = await ws.http('db:explore:tables', {
			connectionId: dbManagerState.activeConnectionId
		});
		if (dbManagerState.activeTabId === tabId) {
			dbManagerState.tables = result ?? [];
		} else {
			const tab = dbManagerState.tabs.find(t => t.id === tabId);
			if (tab) tab.tables = result ?? [];
		}
	} catch {
		addNotification({ type: 'error', title: 'DB Manager', message: 'Failed to load tables', duration: 4000 });
	} finally {
		if (dbManagerState.activeTabId === tabId) dbManagerState.isLoadingTables = false;
	}
}

export async function selectTable(tableName: string, schema?: string): Promise<void> {
	dbManagerState.activeTableName = tableName;
	dbManagerState.activeTableSchema = schema ?? null;
	dbManagerState.browsePage = 0;
	dbManagerState.browseFilters = [];
	dbManagerState.selectedRowKeys = [];
	dbManagerState.globalSelectionActive = false;
	dbManagerState.activeTab = 'browse';
	await Promise.all([
		loadColumnsForTable(tableName, schema),
		browseTableData(tableName, schema),
		loadTotalCount(tableName, schema)
	]);
}

export async function loadColumnsForTable(tableName: string, schema?: string): Promise<void> {
	if (!dbManagerState.activeConnectionId) return;
	const tabId = dbManagerState.activeTabId;
	dbManagerState.isLoadingColumns = true;
	try {
		const result = await ws.http('db:explore:columns', {
			connectionId: dbManagerState.activeConnectionId,
			tableName,
			schema
		});
		if (dbManagerState.activeTabId === tabId) {
			dbManagerState.columns = result ?? [];
		} else {
			const tab = dbManagerState.tabs.find(t => t.id === tabId);
			if (tab) tab.columns = result ?? [];
		}
	} catch {
		if (dbManagerState.activeTabId === tabId) dbManagerState.columns = [];
	} finally {
		if (dbManagerState.activeTabId === tabId) dbManagerState.isLoadingColumns = false;
	}
}

// ─── Browse & Filter ──────────────────────────────────────────────────────────

export async function browseTableData(tableName?: string, schema?: string): Promise<void> {
	if (!dbManagerState.activeConnectionId) return;
	const tbl = tableName ?? dbManagerState.activeTableName;
	const sch = schema ?? dbManagerState.activeTableSchema ?? undefined;
	if (!tbl) return;
	const tabId = dbManagerState.activeTabId;

	dbManagerState.isLoadingBrowse = true;
	dbManagerState.browseResult = null;
	try {
		const result = await ws.http('db:explore:data', {
			connectionId: dbManagerState.activeConnectionId,
			tableName: tbl,
			schema: sch,
			limit: dbManagerState.browsePageSize,
			offset: dbManagerState.browsePage * dbManagerState.browsePageSize,
			filters: dbManagerState.browseFilters.length ? dbManagerState.browseFilters : undefined
		});
		if (dbManagerState.activeTabId === tabId) {
			dbManagerState.browseResult = result;
			dbManagerState.selectedRowKeys = [];
		} else {
			const tab = dbManagerState.tabs.find(t => t.id === tabId);
			if (tab) { tab.browseResult = result; tab.selectedRowKeys = []; }
		}
	} catch {
		addNotification({ type: 'error', title: 'DB Manager', message: 'Failed to load table data', duration: 4000 });
	} finally {
		if (dbManagerState.activeTabId === tabId) dbManagerState.isLoadingBrowse = false;
	}
}

export async function loadTotalCount(tableName?: string, schema?: string): Promise<void> {
	if (!dbManagerState.activeConnectionId) return;
	const tbl = tableName ?? dbManagerState.activeTableName;
	const sch = schema ?? dbManagerState.activeTableSchema ?? undefined;
	if (!tbl) return;
	const tabId = dbManagerState.activeTabId;

	dbManagerState.isLoadingCount = true;
	try {
		const count = await ws.http('db:data:count', {
			connectionId: dbManagerState.activeConnectionId,
			tableName: tbl,
			schema: sch,
			filters: dbManagerState.browseFilters.length ? dbManagerState.browseFilters : undefined
		});
		if (dbManagerState.activeTabId === tabId) {
			dbManagerState.browseTotalCount = count ?? 0;
		} else {
			const tab = dbManagerState.tabs.find(t => t.id === tabId);
			if (tab) tab.browseTotalCount = count ?? 0;
		}
	} catch {
		if (dbManagerState.activeTabId === tabId) dbManagerState.browseTotalCount = 0;
	} finally {
		if (dbManagerState.activeTabId === tabId) dbManagerState.isLoadingCount = false;
	}
}

export async function setFilters(filters: DBRowFilter[]): Promise<void> {
	dbManagerState.browseFilters = filters;
	dbManagerState.browsePage = 0;
	dbManagerState.selectedRowKeys = [];
	dbManagerState.globalSelectionActive = false;
	await Promise.all([browseTableData(), loadTotalCount()]);
}

export async function goToPage(page: number): Promise<void> {
	dbManagerState.browsePage = page;
	dbManagerState.selectedRowKeys = [];
	dbManagerState.globalSelectionActive = false;
	await browseTableData();
}

export async function setPageSize(size: number): Promise<void> {
	dbManagerState.browsePageSize = size;
	dbManagerState.browsePage = 0;
	dbManagerState.selectedRowKeys = [];
	await Promise.all([browseTableData(), loadTotalCount()]);
}

// ─── Row CRUD ─────────────────────────────────────────────────────────────────

export async function insertRowAction(data: Record<string, unknown>): Promise<boolean> {
	if (!dbManagerState.activeConnectionId || !dbManagerState.activeTableName) return false;
	dbManagerState.isSavingRow = true;
	try {
		const pkInfo = getPkColumn();
		const result = await ws.http('db:data:insert', {
			connectionId: dbManagerState.activeConnectionId,
			tableName: dbManagerState.activeTableName,
			schema: dbManagerState.activeTableSchema ?? undefined,
			rowData: data,
			pkColumn: pkInfo?.column ?? undefined
		});
		if (result.error) {
			addNotification({ type: 'error', title: 'Insert Failed', message: result.error, duration: 5000 });
			return false;
		}
		addNotification({ type: 'success', title: 'Row Inserted', message: 'New row added successfully', duration: 3000 });
		await Promise.all([browseTableData(), loadTotalCount()]);
		return true;
	} catch (error) {
		addNotification({ type: 'error', title: 'Insert Failed', message: error instanceof Error ? error.message : 'Insert failed', duration: 5000 });
		return false;
	} finally {
		dbManagerState.isSavingRow = false;
	}
}

export async function updateRowAction(pkColumn: string, pkValue: unknown, data: Record<string, unknown>): Promise<boolean> {
	if (!dbManagerState.activeConnectionId || !dbManagerState.activeTableName) return false;
	dbManagerState.isSavingRow = true;
	try {
		const result = await ws.http('db:data:update', {
			connectionId: dbManagerState.activeConnectionId,
			tableName: dbManagerState.activeTableName,
			schema: dbManagerState.activeTableSchema ?? undefined,
			pkColumn,
			pkValue,
			rowData: data
		});
		if (result.error) {
			addNotification({ type: 'error', title: 'Update Failed', message: result.error, duration: 5000 });
			return false;
		}
		addNotification({ type: 'success', title: 'Row Updated', message: 'Row updated successfully', duration: 3000 });
		await browseTableData();
		return true;
	} catch (error) {
		addNotification({ type: 'error', title: 'Update Failed', message: error instanceof Error ? error.message : 'Update failed', duration: 5000 });
		return false;
	} finally {
		dbManagerState.isSavingRow = false;
	}
}

export async function deleteRowsAction(pkColumn: string, pkValues: unknown[]): Promise<boolean> {
	if (!dbManagerState.activeConnectionId || !dbManagerState.activeTableName) return false;
	dbManagerState.isDeletingRows = true;
	try {
		const result = await ws.http('db:data:delete', {
			connectionId: dbManagerState.activeConnectionId,
			tableName: dbManagerState.activeTableName,
			schema: dbManagerState.activeTableSchema ?? undefined,
			pkColumn,
			pkValues
		});
		if (result.error) {
			addNotification({ type: 'error', title: 'Delete Failed', message: result.error, duration: 5000 });
			return false;
		}
		addNotification({ type: 'success', title: 'Rows Deleted', message: `${pkValues.length} row(s) deleted`, duration: 3000 });
		dbManagerState.selectedRowKeys = [];
		await Promise.all([browseTableData(), loadTotalCount()]);
		return true;
	} catch (error) {
		addNotification({ type: 'error', title: 'Delete Failed', message: error instanceof Error ? error.message : 'Delete failed', duration: 5000 });
		return false;
	} finally {
		dbManagerState.isDeletingRows = false;
	}
}

// ─── Query ────────────────────────────────────────────────────────────────────

export async function executeQuery(): Promise<void> {
	if (!dbManagerState.activeConnectionId || !dbManagerState.currentSql.trim()) return;
	const tabId = dbManagerState.activeTabId;
	dbManagerState.isLoadingQuery = true;
	dbManagerState.queryResult = null;
	try {
		const result = await ws.http('db:query:execute', {
			connectionId: dbManagerState.activeConnectionId,
			sql: dbManagerState.currentSql,
			activeTable: dbManagerState.activeTableName ?? undefined
		});
		if (dbManagerState.activeTabId === tabId) {
			dbManagerState.queryResult = result;
		} else {
			const tab = dbManagerState.tabs.find(t => t.id === tabId);
			if (tab) tab.queryResult = result;
		}
	} catch {
		addNotification({ type: 'error', title: 'DB Manager', message: 'Query failed', duration: 4000 });
	} finally {
		if (dbManagerState.activeTabId === tabId) dbManagerState.isLoadingQuery = false;
	}
}

// ─── Bulk Actions ─────────────────────────────────────────────────────────────

/** Open the bulk-delete confirmation modal for current selection or global dataset. */
export function openBulkDelete(): void {
	const isGlobal = dbManagerState.globalSelectionActive;
	const rowCount = isGlobal
		? dbManagerState.browseTotalCount
		: dbManagerState.selectedRowKeys.length;
	dbManagerState.bulkModal = {
		show: true,
		operation: 'delete',
		phase: 'confirm',
		rowCount,
		processed: 0,
		error: null,
		isGlobal,
		updateColumn: dbManagerState.columns[0]?.name ?? '',
		updateValue: '',
		updateIsNull: false
	};
}

/** Open the bulk-update confirmation modal for current selection or global dataset. */
export function openBulkUpdate(): void {
	const isGlobal = dbManagerState.globalSelectionActive;
	const rowCount = isGlobal
		? dbManagerState.browseTotalCount
		: dbManagerState.selectedRowKeys.length;
	dbManagerState.bulkModal = {
		show: true,
		operation: 'update',
		phase: 'confirm',
		rowCount,
		processed: 0,
		error: null,
		isGlobal,
		updateColumn: dbManagerState.columns[0]?.name ?? '',
		updateValue: '',
		updateIsNull: false
	};
}

/** Close the bulk modal. If the operation succeeded, refreshes browse data. */
export function closeBulkModal(): void {
	if (dbManagerState.bulkModal.phase === 'running') return;
	const succeeded = dbManagerState.bulkModal.phase === 'done' && !dbManagerState.bulkModal.error;
	dbManagerState.bulkModal.show = false;
	if (succeeded) {
		dbManagerState.globalSelectionActive = false;
		dbManagerState.selectedRowKeys = [];
		Promise.all([browseTableData(), loadTotalCount()]);
	}
}

/** Execute the pending bulk delete. Transitions modal through running → done. */
export async function executeBulkDelete(): Promise<void> {
	if (!dbManagerState.activeConnectionId || !dbManagerState.activeTableName) return;
	const modal = dbManagerState.bulkModal;
	modal.phase = 'running';
	modal.processed = 0;
	modal.error = null;

	try {
		const pkInfo = getPkColumn();
		const base = {
			connectionId: dbManagerState.activeConnectionId,
			tableName: dbManagerState.activeTableName,
			schema: dbManagerState.activeTableSchema ?? undefined
		};

		const result = modal.isGlobal
			? await ws.http('db:bulk:delete', {
					...base,
					mode: 'filter' as const,
					filters: dbManagerState.browseFilters.length ? dbManagerState.browseFilters : undefined
				})
			: await ws.http('db:bulk:delete', {
					...base,
					mode: 'pks' as const,
					pkColumn: pkInfo?.column,
					pkValues: dbManagerState.selectedRowKeys
				});

		if (result.error) {
			modal.error = result.error;
		} else {
			modal.processed = result.affectedRows;
		}
	} catch (err) {
		modal.error = err instanceof Error ? err.message : 'Bulk delete failed';
	} finally {
		modal.phase = 'done';
	}
}

/** Execute the pending bulk update. Transitions modal through running → done. */
export async function executeBulkUpdate(): Promise<void> {
	if (!dbManagerState.activeConnectionId || !dbManagerState.activeTableName) return;
	const modal = dbManagerState.bulkModal;
	if (!modal.updateColumn) return;
	modal.phase = 'running';
	modal.processed = 0;
	modal.error = null;

	try {
		const pkInfo = getPkColumn();
		const base = {
			connectionId: dbManagerState.activeConnectionId,
			tableName: dbManagerState.activeTableName,
			schema: dbManagerState.activeTableSchema ?? undefined,
			column: modal.updateColumn,
			value: modal.updateIsNull ? null : (modal.updateValue || null)
		};

		const result = modal.isGlobal
			? await ws.http('db:bulk:update', {
					...base,
					mode: 'filter' as const,
					filters: dbManagerState.browseFilters.length ? dbManagerState.browseFilters : undefined
				})
			: await ws.http('db:bulk:update', {
					...base,
					mode: 'pks' as const,
					pkColumn: pkInfo?.column,
					pkValues: dbManagerState.selectedRowKeys
				});

		if (result.error) {
			modal.error = result.error;
		} else {
			modal.processed = result.affectedRows;
		}
	} catch (err) {
		modal.error = err instanceof Error ? err.message : 'Bulk update failed';
	} finally {
		modal.phase = 'done';
	}
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

export function resetTestResult(): void {
	dbManagerState.testResult = null;
}
