/**
 * Database Manager Types
 * Shared types for the built-in database management feature.
 */

export type { SSHTunnelConfig, SSHAuthMethod } from './ssh-tunnel';

export type DBType =
	| 'sqlite'
	| 'postgresql'
	| 'mysql'
	| 'mariadb'
	| 'mongodb'
	| 'redis'
	| 'mssql';

export const DB_TYPE_LABELS: Record<DBType, string> = {
	sqlite: 'SQLite',
	postgresql: 'PostgreSQL',
	mysql: 'MySQL',
	mariadb: 'MariaDB',
	mongodb: 'MongoDB',
	redis: 'Redis',
	mssql: 'SQL Server'
};

export const DB_TYPE_COLORS: Record<DBType, string> = {
	sqlite: '#0f9d58',
	postgresql: '#336791',
	mysql: '#00758f',
	mariadb: '#c0765a',
	mongodb: '#47a248',
	redis: '#d82c20',
	mssql: '#e74c3c'
};

// Ordered for UI display (most commonly used first)
export const DB_TYPES: DBType[] = ['postgresql', 'mysql', 'mariadb', 'sqlite', 'mongodb', 'redis', 'mssql'];

export const DB_DEFAULT_PORTS: Record<DBType, number | null> = {
	sqlite: null,
	postgresql: 5432,
	mysql: 3306,
	mariadb: 3306,
	mongodb: 27017,
	redis: 6379,
	mssql: 1433
};

/** Whether a DB type has full query support, basic connection, or config-only */
export type DBSupport = 'full' | 'config-only';

export const DB_SUPPORT: Record<DBType, DBSupport> = {
	sqlite: 'full',
	postgresql: 'full',
	mysql: 'full',
	mariadb: 'full',
	mongodb: 'full',
	redis: 'full',
	mssql: 'full'
};

export interface DBConnectionConfig {
	id: string;
	name: string;
	type: DBType;
	color?: string;
	// SQLite specific
	path?: string;
	// Server-based
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string;
	ssl?: boolean;
	// SSH Tunnel (optional — for accessing DBs on private networks)
	sshTunnel?: import('./ssh-tunnel').SSHTunnelConfig;
	// Metadata
	createdAt: string;
	updatedAt: string;
	lastConnectedAt?: string;
}

export interface DBTable {
	name: string;
	schema?: string;
	type: 'table' | 'view';
	rowCount?: number;
}

export interface DBColumn {
	name: string;
	type: string;
	nullable: boolean;
	primaryKey: boolean;
	unique?: boolean;
	defaultValue?: string | null;
}

export type DBFilterOperator = 'eq' | 'neq' | 'like' | 'gt' | 'lt' | 'null' | 'notnull';

export interface DBRowFilter {
	column: string;
	operator: DBFilterOperator;
	value?: string;
}

export interface DBQueryResult {
	columns: string[];
	rows: Record<string, unknown>[];
	rowCount: number;
	executionTimeMs: number;
	affectedRows?: number;
	totalCount?: number;
	error?: string;
}

export interface DBConnectionTestResult {
	success: boolean;
	message: string;
	version?: string;
	latencyMs?: number;
}

export interface GlobalSearchMatch {
	tableName: string;
	tableSchema?: string;
	columnName: string;
	row: Record<string, unknown>;
	pkColumn?: string;
}

export interface GlobalSearchResult {
	query: string;
	matches: GlobalSearchMatch[];
	tablesSearched: number;
	columnsSearched: number;
	executionTimeMs: number;
	truncated: boolean;
	error?: string;
}

// ─── Multi-Tab ─────────────────────────────────────────────────────────────────

/** Color palette for tab identification — distinct, legible in dark & light mode */
export const DB_TAB_COLORS = [
	'#8b5cf6', // violet
	'#3b82f6', // blue
	'#10b981', // emerald
	'#f59e0b', // amber
	'#ef4444', // red
	'#ec4899', // pink
	'#14b8a6', // teal
	'#f97316', // orange
	'#6366f1', // indigo
	'#84cc16', // lime
] as const;

/** Returns a stable tab color from a connection name hash, or a stored custom color. */
export function getConnectionTabColor(name: string, storedColor?: string): string {
	if (storedColor) return storedColor;
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = ((hash << 5) - hash) + name.charCodeAt(i);
		hash |= 0;
	}
	return DB_TAB_COLORS[Math.abs(hash) % DB_TAB_COLORS.length];
}

// ─── Bulk Action ───────────────────────────────────────────────────────────────

export interface DBBulkActionResult {
	affectedRows: number;
	executionTimeMs: number;
	error?: string;
}

/** Complete state snapshot for one open database session tab */
export interface DBTabState {
	id: string;
	connectionId: string;
	/** Display label (connection name) */
	label: string;
	/** Unique color derived from connection name */
	color: string;
	// ─── Persisted per-tab state ─────────────────────────────────────────
	activeTableName: string | null;
	activeTableSchema: string | null;
	tables: DBTable[];
	columns: DBColumn[];
	queryResult: DBQueryResult | null;
	browseResult: DBQueryResult | null;
	activePanel: 'browse' | 'query';
	currentSql: string;
	browsePage: number;
	browsePageSize: number;
	browseFilters: DBRowFilter[];
	browseTotalCount: number;
	selectedRowKeys: string[];
	// ─── SQL editor per-tab state ─────────────────────────────────────────
	explainResult: DBQueryResult | null;
	activeResultTab: 'results' | 'plan' | 'history' | 'snippets' | 'audit' | 'ai' | 'visualize';
}
