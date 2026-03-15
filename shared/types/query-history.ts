export interface QueryHistoryEntry {
	id: string;
	connectionId: string;
	connectionName: string;
	connectionType: string;
	sql: string;
	executionTimeMs: number;
	rowCount: number;
	error: string | null;
	executedAt: string;
	isFavorite: boolean;
}
