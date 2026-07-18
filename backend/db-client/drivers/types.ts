/**
 * db-client — unified driver adapter interface.
 *
 * Phase 1 implemented: connect / close / health.
 * Phase 2 adds: schema introspection, query execution, data CRUD,
 * and structure management. Methods that don't apply to every driver
 * (e.g. table operations on Redis) remain optional.
 */

import type {
	DbClientConnection,
	DbClientHealth,
	DbClientObjectDetails,
	DbClientOverview,
	DbClientQueryResult,
	DbClientSchemaNode,
	DbClientSchemaNodeType,
	DbDriver
} from '$shared/types/db-client';

export interface SchemaOpts {
	database?: string;
	schema?: string;
}

export interface ColumnDefinition {
	name: string;
	type: string;
	nullable?: boolean;
	default?: string | null;
	primary?: boolean;
	unique?: boolean;
	autoIncrement?: boolean;
}

export interface TableDefinition {
	name: string;
	columns: ColumnDefinition[];
	primaryKey?: string[];
}

export interface IndexDefinition {
	name: string;
	columns: string[];
	unique?: boolean;
}

export type AlterOperation =
	| { kind: 'add-column'; column: ColumnDefinition }
	| { kind: 'drop-column'; name: string }
	| { kind: 'rename-column'; name: string; newName: string }
	| { kind: 'modify-column'; column: ColumnDefinition };

/**
 * A connection-bound executor handed to `withTransaction`'s callback. Every
 * call runs on the same transaction's connection, so a batch of statements
 * commits or rolls back atomically.
 */
export interface DbClientTxContext {
	executeRead(q: string, params?: unknown[], opts?: { database?: string; limit?: number }): Promise<DbClientQueryResult>;
	executeWrite(q: string, params?: unknown[], opts?: { database?: string }): Promise<DbClientQueryResult>;
}

export interface DbClientDriverAdapter {
	readonly kind: DbDriver;

	connect(conn: DbClientConnection, tunnelPort?: number): Promise<void>;
	close(): Promise<void>;
	isAlive(): boolean;
	health(): Promise<DbClientHealth>;

	overview?(opts?: SchemaOpts): Promise<DbClientOverview>;
	listDatabases?(): Promise<DbClientSchemaNode[]>;
	listSchemas?(database?: string): Promise<DbClientSchemaNode[]>;
	listObjects?(database?: string, schema?: string): Promise<DbClientSchemaNode[]>;
	getObjectDetails?(
		name: string,
		type: DbClientSchemaNodeType,
		database?: string,
		schema?: string
	): Promise<DbClientObjectDetails>;

	executeRead?(q: string, params?: unknown[], opts?: { database?: string; limit?: number }): Promise<DbClientQueryResult>;
	executeWrite?(q: string, params?: unknown[], opts?: { database?: string }): Promise<DbClientQueryResult>;
	explain?(q: string, opts?: { database?: string }): Promise<DbClientQueryResult>;
	cancel?(): Promise<void>;

	/**
	 * Run `fn` inside a single database transaction on one dedicated
	 * connection. Implemented only by drivers that can guarantee atomicity
	 * (a pooled driver must reserve a connection). If `fn` throws, the
	 * transaction is rolled back and the error re-thrown. Absence of this
	 * method signals the caller to fall back to non-transactional execution.
	 */
	withTransaction?<T>(fn: (tx: DbClientTxContext) => Promise<T>, opts?: { database?: string }): Promise<T>;

	// Structure
	createDatabase?(name: string): Promise<string>;
	dropDatabase?(name: string): Promise<string>;
	renameDatabase?(name: string, newName: string): Promise<string>;
	/** Empty every table/collection in a database without dropping the schema. */
	resetDatabase?(opts?: SchemaOpts): Promise<string>;
	/** Redis FLUSHDB — wipe every key in the selected logical database. */
	flushDatabase?(): Promise<string>;
	createTable?(definition: TableDefinition, opts?: SchemaOpts): Promise<string>;
	alterTable?(name: string, operations: AlterOperation[], opts?: SchemaOpts): Promise<string>;
	dropTable?(name: string, opts?: SchemaOpts): Promise<string>;
	truncateTable?(name: string, opts?: SchemaOpts): Promise<string>;
	/** Truncate and reset the auto-increment / sequence / identity counter. */
	resetTable?(name: string, opts?: SchemaOpts): Promise<string>;
	renameTable?(name: string, newName: string, opts?: SchemaOpts): Promise<string>;
	duplicateTable?(name: string, newName: string, opts?: SchemaOpts & { withData?: boolean }): Promise<string>;
	/** Best-effort CREATE statement for an object (DDL), for copy-to-clipboard. */
	getCreateStatement?(name: string, type: DbClientSchemaNodeType, opts?: SchemaOpts): Promise<string>;
	createIndex?(tableName: string, def: IndexDefinition, opts?: SchemaOpts): Promise<string>;
	dropIndex?(tableName: string, indexName: string, opts?: SchemaOpts): Promise<string>;
	createView?(name: string, query: string, opts?: SchemaOpts): Promise<string>;
	dropView?(name: string, opts?: SchemaOpts): Promise<string>;

	// Data CRUD (parameterized)
	insertRow?(table: string, row: Record<string, unknown>, opts?: SchemaOpts): Promise<DbClientQueryResult>;
	updateRow?(table: string, pk: Record<string, unknown>, changes: Record<string, unknown>, opts?: SchemaOpts): Promise<DbClientQueryResult>;
	deleteRows?(table: string, pks: Record<string, unknown>[], opts?: SchemaOpts): Promise<DbClientQueryResult>;
}
