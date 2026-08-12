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
	/**
	 * Wrap a synchronous block of statements in one transaction.
	 *
	 * Optional because it is a property of the driver, not of the contract: the
	 * local `bun:sqlite` connection provides it, and a caller that needs it must
	 * degrade gracefully when it is absent rather than assume. Callers get
	 * correctness either way — without it the statements simply run unbatched.
	 */
	transaction?<T>(fn: () => T): () => T;
}