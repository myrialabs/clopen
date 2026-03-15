/**
 * Database Visualization Types
 * Types for Instant Data Visualization feature in the DB Manager.
 */

export type ChartType = 'bar' | 'line' | 'pie' | 'area';

export interface ChartConfig {
	id: string;
	name: string;
	chartType: ChartType;
	xColumn: string;
	yColumns: string[];
	title?: string;
	/** The SQL query that produced the data snapshot */
	sql?: string;
}

export interface DashboardItem {
	id: string;
	chartConfig: ChartConfig;
	/** Snapshot of query data (capped at 500 rows) */
	snapshotData: {
		columns: string[];
		rows: Record<string, unknown>[];
	};
	connectionId?: string;
	createdAt: string;
}
