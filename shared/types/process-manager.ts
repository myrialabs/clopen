/**
 * Database Process Manager Types
 * Represents active sessions/queries across different database engines.
 */

export interface DBProcess {
	/** Process/session/operation ID as string */
	id: string;
	user?: string;
	host?: string;
	database?: string;
	/** Command type (e.g. SELECT, Query, sleep) */
	command?: string;
	/** Current state (e.g. executing, idle, waiting) */
	state?: string;
	/** SQL query text (truncated) */
	query?: string;
	/** How long this process has been running, in seconds */
	timeSeconds?: number;
	/** CPU time in milliseconds (MSSQL) */
	cpuMs?: number;
	/** Disk reads (MSSQL) */
	reads?: number;
	/** Disk writes (MSSQL) */
	writes?: number;
	/** Raw row from the database for display */
	raw: Record<string, unknown>;
}

export interface DBProcessList {
	processes: DBProcess[];
	fetchedAt: string;
	dbType: string;
}

/** Whether to cancel only the running query or terminate the whole connection */
export type KillMode = 'query' | 'connection';

export interface KillProcessResult {
	ok: boolean;
	message: string;
}
