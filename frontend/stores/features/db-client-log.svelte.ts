/**
 * In-memory query activity log for db-client.
 * Keeps the last MAX_ENTRIES log lines per connection.
 */

export type QueryLogEntryType = 'executing' | 'result' | 'error';

export interface QueryLogEntry {
	at: Date;
	type: QueryLogEntryType;
	message: string;
}

const MAX_ENTRIES = 500;

/** Reactive map: connectionId → QueryLogEntry[] */
const logs = $state<Record<string, QueryLogEntry[]>>({});

export const dbClientLog = {
	getLog(connId: string): QueryLogEntry[] {
		return logs[connId] ?? [];
	},

	append(connId: string, entry: QueryLogEntry): void {
		const existing = logs[connId] ?? [];
		const next = [...existing, entry];
		logs[connId] = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
	},

	clear(connId: string): void {
		logs[connId] = [];
	},

	load(connId: string, entries: QueryLogEntry[]): void {
		logs[connId] = entries;
	}
};
