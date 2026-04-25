/**
 * db-client — unified driver adapter interface.
 *
 * Phase 1 implements: connect / close / health (and helpers needed for
 * health checks). Schema, query execution, structure, and data CRUD
 * arrive in Phase 2 — those methods are declared as optional here so
 * each driver can roll them in without breaking the interface.
 */

import type {
	DbClientConnection,
	DbClientHealth,
	DbClientObjectDetails,
	DbClientQueryResult,
	DbClientSchemaNode,
	DbClientSchemaNodeType,
	DbDriver
} from '$shared/types/db-client';

export interface SchemaOpts {
	database?: string;
	schema?: string;
}

export interface DbClientDriverAdapter {
	readonly kind: DbDriver;

	connect(conn: DbClientConnection, tunnelPort?: number): Promise<void>;
	close(): Promise<void>;
	isAlive(): boolean;
	health(): Promise<DbClientHealth>;

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
}
