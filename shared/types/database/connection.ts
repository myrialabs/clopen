export interface DatabaseConnection {
	query(sql: string): {
		all(...params: unknown[]): unknown[];
		get(...params: unknown[]): unknown;
		run(...params: unknown[]): unknown;
		finalize(): void;
	};
	prepare(query: string): {
		all(...params: unknown[]): unknown[];
		get(...params: unknown[]): unknown;
		run(...params: unknown[]): unknown;
		finalize(): void;
	};
	exec(query: string): unknown;
	close(): void;
}