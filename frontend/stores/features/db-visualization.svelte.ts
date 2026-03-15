/**
 * Database Visualization Store
 * State and actions for the Instant Data Visualization feature.
 * Dashboard items are persisted in localStorage.
 */

import type { ChartType, DashboardItem } from '$shared/types/db-visualization';
import { nanoid } from 'nanoid';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import { dbManagerState } from './db-manager.svelte';
import ws from '$frontend/utils/ws';

const DASHBOARD_KEY = 'clopen:viz:dashboard';

function loadDashboard(): DashboardItem[] {
	try {
		if (typeof localStorage === 'undefined') return [];
		const raw = localStorage.getItem(DASHBOARD_KEY);
		if (!raw) return [];
		return JSON.parse(raw) as DashboardItem[];
	} catch {
		return [];
	}
}

function persistDashboard(items: DashboardItem[]): void {
	try {
		localStorage.setItem(DASHBOARD_KEY, JSON.stringify(items));
	} catch {
		// Ignore storage errors (e.g., private browsing limits)
	}
}

// ─── State ────────────────────────────────────────────────────────────────────

export const dbVizState = $state({
	chartType: 'bar' as ChartType,
	xColumn: '',
	yColumns: [] as string[],
	chartTitle: '',
	dashboard: loadDashboard(),
	showDashboard: false,
	/**
	 * When a dashboard item is loaded, its snapshot data is stored here so the
	 * chart renders the saved data regardless of the current live query result.
	 * Cleared automatically when a new query is executed or the panel is closed.
	 * Capped at 1,000 rows to avoid excessive RAM usage.
	 */
	activeSnapshot: null as { columns: string[]; rows: Record<string, unknown>[] } | null,
	/** ISO timestamp of when the active snapshot was last fetched/loaded. */
	snapshotFetchedAt: null as string | null,
	/** Original SQL of the loaded dashboard item — used by refetchLive to re-execute. */
	snapshotSql: null as string | null,
	/** Connection ID of the loaded dashboard item — used by refetchLive. */
	snapshotConnectionId: null as string | null,
});

// ─── Actions ──────────────────────────────────────────────────────────────────

/**
 * Initialize default X/Y column selections for the given columns.
 * Only writes state when the current selection is invalid to avoid
 * spurious reactive updates.
 */
export function initVizColumns(columns: string[]): void {
	if (!columns.length) return;

	if (!dbVizState.xColumn || !columns.includes(dbVizState.xColumn)) {
		dbVizState.xColumn = columns[0];
	}

	const validY = dbVizState.yColumns.filter((c) => columns.includes(c));
	if (!validY.length) {
		dbVizState.yColumns = columns.length > 1 ? [columns[1]] : [columns[0]];
	} else if (validY.length < dbVizState.yColumns.length) {
		dbVizState.yColumns = validY;
	}
	// If all Y columns are valid, leave unchanged — no spurious write.
}

/**
 * Toggle a Y-axis column. For pie charts, replaces the selection (radio behavior).
 */
export function toggleYColumn(col: string): void {
	if (dbVizState.yColumns.includes(col)) {
		if (dbVizState.yColumns.length > 1) {
			dbVizState.yColumns = dbVizState.yColumns.filter((c) => c !== col);
		}
	} else {
		dbVizState.yColumns = [...dbVizState.yColumns, col];
	}
}

/**
 * Save the current chart configuration and a data snapshot to the dashboard.
 * If activeSnapshot is set (user is viewing saved data), that snapshot is used
 * instead of the live query result.
 */
export function saveChartToDashboard(
	sql?: string,
	effectiveData?: { columns: string[]; rows: Record<string, unknown>[] },
): void {
	// Prefer explicitly passed effective data, then active snapshot, then live result
	const source =
		effectiveData ??
		dbVizState.activeSnapshot ??
		(dbManagerState.queryResult
			? { columns: dbManagerState.queryResult.columns, rows: dbManagerState.queryResult.rows }
			: null);

	if (!source?.columns.length || !dbVizState.xColumn || !dbVizState.yColumns.length) return;

	const name = dbVizState.chartTitle.trim() || `Chart ${dbVizState.dashboard.length + 1}`;

	const item: DashboardItem = {
		id: nanoid(),
		chartConfig: {
			id: nanoid(),
			name,
			chartType: dbVizState.chartType,
			xColumn: dbVizState.xColumn,
			yColumns: [...dbVizState.yColumns],
			title: dbVizState.chartTitle.trim() || undefined,
			sql,
		},
		snapshotData: {
			columns: source.columns,
			rows: source.rows.slice(0, 500),
		},
		connectionId: dbManagerState.activeConnectionId ?? undefined,
		createdAt: new Date().toISOString(),
	};

	dbVizState.dashboard = [item, ...dbVizState.dashboard];
	persistDashboard(dbVizState.dashboard);

	addNotification({
		type: 'success',
		title: 'Dashboard',
		message: `"${name}" saved to dashboard`,
		duration: 3000,
	});
}

/**
 * Remove a saved chart from the dashboard.
 */
export function removeDashboardItem(id: string): void {
	dbVizState.dashboard = dbVizState.dashboard.filter((item) => item.id !== id);
	persistDashboard(dbVizState.dashboard);
}

/**
 * Load a saved dashboard item. Restores the chart config AND sets the snapshot
 * data so the chart renders the saved data even if the live query result has
 * changed or has different columns.
 */
export function loadDashboardItem(item: DashboardItem): void {
	dbVizState.chartType = item.chartConfig.chartType;
	dbVizState.xColumn = item.chartConfig.xColumn;
	dbVizState.yColumns = [...item.chartConfig.yColumns];
	dbVizState.chartTitle = item.chartConfig.title ?? '';
	// Cap at 1,000 rows in memory (saved data may be up to 500, but be explicit)
	dbVizState.activeSnapshot = {
		columns: item.snapshotData.columns,
		rows: item.snapshotData.rows.slice(0, 1000),
	};
	// Use the original creation time so the banner shows how stale the data is
	dbVizState.snapshotFetchedAt = item.createdAt;
	// Store SQL + connection so refetchLive can re-execute the same query
	dbVizState.snapshotSql = item.chartConfig.sql ?? null;
	dbVizState.snapshotConnectionId = item.connectionId ?? null;
	dbVizState.showDashboard = false;
}

/**
 * Refresh the active snapshot by re-executing the dashboard item's original SQL
 * against the database. Does NOT modify the editor's current SQL.
 * Falls back to the current live query result if no saved SQL is available.
 * Caps at 1,000 rows.
 */
export async function refetchLive(): Promise<void> {
	const sql = dbVizState.snapshotSql;
	const connectionId = dbVizState.snapshotConnectionId ?? dbManagerState.activeConnectionId;

	if (sql && connectionId) {
		try {
			dbVizState.snapshotFetchedAt = null; // Show loading state
			const result = await ws.http('db:query:execute', {
				connectionId,
				sql,
				activeTable: dbManagerState.activeTableName ?? undefined,
			});
			if (!result?.columns?.length) {
				addNotification({ type: 'warning', title: 'Visualization', message: 'Query returned no data', duration: 3000 });
				return;
			}
			dbVizState.activeSnapshot = {
				columns: result.columns,
				rows: result.rows.slice(0, 1000),
			};
			dbVizState.snapshotFetchedAt = new Date().toISOString();
			const rowCount = Math.min(result.rows.length, 1000);
			const suffix = result.rows.length > 1000 ? ` (first 1,000 of ${result.rows.length.toLocaleString()})` : '';
			addNotification({
				type: 'success',
				title: 'Visualization',
				message: `Snapshot refreshed — ${rowCount.toLocaleString()} rows${suffix}`,
				duration: 2500,
			});
		} catch {
			addNotification({ type: 'error', title: 'Visualization', message: 'Failed to refresh snapshot', duration: 4000 });
			dbVizState.snapshotFetchedAt = dbVizState.snapshotFetchedAt; // Restore previous
		}
		return;
	}

	// Fallback: grab whatever is already loaded in the live result panel
	const qr = dbManagerState.queryResult;
	if (!qr?.columns.length) {
		addNotification({
			type: 'warning',
			title: 'Visualization',
			message: 'No saved SQL found and no live query result available — run a query first',
			duration: 4000,
		});
		return;
	}
	dbVizState.activeSnapshot = {
		columns: qr.columns,
		rows: qr.rows.slice(0, 1000),
	};
	dbVizState.snapshotFetchedAt = new Date().toISOString();
	const rowCount = Math.min(qr.rows.length, 1000);
	const suffix = qr.rows.length > 1000 ? ` (first 1,000 of ${qr.rows.length.toLocaleString()})` : '';
	addNotification({
		type: 'success',
		title: 'Visualization',
		message: `Snapshot refreshed — ${rowCount.toLocaleString()} rows${suffix}`,
		duration: 2500,
	});
}
