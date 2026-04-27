/**
 * db-client store — connections, schema, per-connection views.
 */

import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';
import type {
	DbClientConnection,
	DbClientConnectionInput,
	DbClientHealth,
	DbClientObjectDetails,
	DbClientQueryResult,
	DbClientSchemaNode,
	DbClientSchemaNodeType
} from '$shared/types/db-client';

export type DbClientView = 'query' | 'data' | 'structure';

export interface DbClientActiveObject {
	name: string;
	type: DbClientSchemaNodeType;
	database?: string;
	schema?: string;
}

export interface DbClientQueryDraft {
	text: string;
	result: DbClientQueryResult | null;
	error: string | null;
	running: boolean;
}

export interface DbClientConnectionView {
	activeView: DbClientView;
	activeObject: DbClientActiveObject | null;
	query: DbClientQueryDraft;
}

interface ColumnDefinitionInput {
	name: string;
	type: string;
	nullable?: boolean;
	default?: string | null;
	primary?: boolean;
	unique?: boolean;
	autoIncrement?: boolean;
}

interface TableDefinitionInput {
	name: string;
	columns: ColumnDefinitionInput[];
	primaryKey?: string[];
}

interface IndexDefinitionInput {
	name: string;
	columns: string[];
	unique?: boolean;
}

type AlterOperationInput =
	| { kind: 'add-column'; column: ColumnDefinitionInput }
	| { kind: 'drop-column'; name: string }
	| { kind: 'rename-column'; name: string; newName: string }
	| { kind: 'modify-column'; column: ColumnDefinitionInput };

interface DbClientState {
	connections: DbClientConnection[];
	activeConnectionId: string | null;
	schema: Record<string, DbClientSchemaNode[]>;
	objectDetails: Record<string, DbClientObjectDetails>;
	views: Record<string, DbClientConnectionView>;
	health: Record<string, DbClientHealth>;
	isLoading: boolean;
	isFormOpen: boolean;
	error: string | null;
}

const state = $state<DbClientState>({
	connections: [],
	activeConnectionId: null,
	schema: {},
	objectDetails: {},
	views: {},
	health: {},
	isLoading: false,
	isFormOpen: false,
	error: null
});

function detailsKey(connId: string, opts: { database?: string; schema?: string; name: string }): string {
	return `${connId}::${opts.database ?? ''}::${opts.schema ?? ''}::${opts.name}`;
}

function emptyView(): DbClientConnectionView {
	return {
		activeView: 'structure',
		activeObject: null,
		query: { text: '', result: null, error: null, running: false }
	};
}

function ensureView(connId: string): DbClientConnectionView {
	if (!state.views[connId]) state.views[connId] = emptyView();
	return state.views[connId];
}

export const dbClientStore = {
	get connections(): DbClientConnection[] {
		return state.connections;
	},
	get activeConnectionId(): string | null {
		return state.activeConnectionId;
	},
	get activeConnection(): DbClientConnection | null {
		const id = state.activeConnectionId;
		if (!id) return null;
		return state.connections.find((c) => c.id === id) ?? null;
	},
	get schema(): Record<string, DbClientSchemaNode[]> {
		return state.schema;
	},
	get objectDetails(): Record<string, DbClientObjectDetails> {
		return state.objectDetails;
	},
	get views(): Record<string, DbClientConnectionView> {
		return state.views;
	},
	get health(): Record<string, DbClientHealth> {
		return state.health;
	},
	get isLoading(): boolean {
		return state.isLoading;
	},
	get isFormOpen(): boolean {
		return state.isFormOpen;
	},
	get error(): string | null {
		return state.error;
	},
	get liveCount(): number {
		return Object.values(state.health).filter((h) => h?.ok).length;
	},

	setFormOpen(open: boolean): void {
		state.isFormOpen = open;
	},

	getView(connId: string): DbClientConnectionView {
		return ensureView(connId);
	},

	setActive(id: string | null): void {
		state.activeConnectionId = id;
		if (id) ensureView(id);
	},

	setView(connId: string, view: DbClientView): void {
		ensureView(connId).activeView = view;
	},

	setActiveObject(connId: string, obj: DbClientActiveObject | null): void {
		ensureView(connId).activeObject = obj;
	},

	setQueryText(connId: string, text: string): void {
		ensureView(connId).query.text = text;
	},

	setQueryResult(connId: string, result: DbClientQueryResult | null): void {
		ensureView(connId).query.result = result;
	},

	setQueryError(connId: string, error: string | null): void {
		ensureView(connId).query.error = error;
	},

	setQueryRunning(connId: string, running: boolean): void {
		ensureView(connId).query.running = running;
	},

	async list(): Promise<DbClientConnection[]> {
		state.isLoading = true;
		state.error = null;
		try {
			const result = await ws.http('db-client:list', {});
			state.connections = (result ?? []) as DbClientConnection[];
			return state.connections;
		} catch (err) {
			debug.error('db-client', 'list failed:', err);
			state.error = err instanceof Error ? err.message : 'Failed to list connections';
			throw err;
		} finally {
			state.isLoading = false;
		}
	},

	async create(input: DbClientConnectionInput): Promise<DbClientConnection> {
		const conn = (await ws.http('db-client:create', input)) as DbClientConnection;
		state.connections = [conn, ...state.connections];
		return conn;
	},

	async update(id: string, patch: Partial<DbClientConnectionInput>): Promise<DbClientConnection> {
		const conn = (await ws.http('db-client:update', { id, patch })) as DbClientConnection;
		state.connections = state.connections.map((c) => (c.id === id ? conn : c));
		return conn;
	},

	async remove(id: string): Promise<void> {
		await ws.http('db-client:delete', { id });
		state.connections = state.connections.filter((c) => c.id !== id);
		delete state.health[id];
		delete state.schema[id];
		delete state.views[id];
		if (state.activeConnectionId === id) state.activeConnectionId = null;
	},

	async test(input: DbClientConnectionInput | { id: string }): Promise<DbClientHealth> {
		const result = (await ws.http('db-client:test', input)) as DbClientHealth;
		if ('id' in input) {
			state.health[input.id] = result;
		}
		return result;
	},

	async refreshHealth(id: string): Promise<DbClientHealth> {
		const result = (await ws.http('db-client:health', { id })) as DbClientHealth;
		state.health[id] = result;
		return result;
	},

	// ── Schema ───────────────────────────────────────────────────────────

	async listDatabases(connId: string): Promise<DbClientSchemaNode[]> {
		const result = (await ws.http('db-client:list-databases', { connectionId: connId })) as DbClientSchemaNode[];
		return result;
	},

	async listObjects(connId: string, opts?: { database?: string; schema?: string }): Promise<DbClientSchemaNode[]> {
		const result = (await ws.http('db-client:list-objects', {
			connectionId: connId,
			database: opts?.database,
			schema: opts?.schema
		})) as DbClientSchemaNode[];
		state.schema[connId] = result;
		return result;
	},

	async refreshSchema(connId: string, opts?: { database?: string; schema?: string }): Promise<DbClientSchemaNode[]> {
		return this.listObjects(connId, opts);
	},

	async getObjectDetails(connId: string, opts: {
		database?: string;
		schema?: string;
		name: string;
		type: DbClientSchemaNodeType;
	}): Promise<DbClientObjectDetails> {
		const result = (await ws.http('db-client:object-details', {
			connectionId: connId,
			database: opts.database,
			schema: opts.schema,
			name: opts.name,
			type: opts.type
		})) as DbClientObjectDetails;
		state.objectDetails[detailsKey(connId, opts)] = result;
		return result;
	},

	// ── Query execution ──────────────────────────────────────────────────

	async executeRead(connId: string, query: string, opts?: { database?: string; limit?: number }): Promise<DbClientQueryResult> {
		return (await ws.http('db-client:execute-read', {
			connectionId: connId,
			query,
			database: opts?.database,
			limit: opts?.limit
		})) as DbClientQueryResult;
	},

	async executeWrite(connId: string, query: string, opts?: { database?: string }): Promise<DbClientQueryResult> {
		return (await ws.http('db-client:execute-write', {
			connectionId: connId,
			query,
			database: opts?.database
		})) as DbClientQueryResult;
	},

	async cancel(connId: string): Promise<void> {
		await ws.http('db-client:cancel', { connectionId: connId });
	},

	// ── Data CRUD ────────────────────────────────────────────────────────

	async insertRow(connId: string, table: string, row: Record<string, unknown>, opts?: { database?: string; schema?: string }): Promise<DbClientQueryResult> {
		return (await ws.http('db-client:data:insert', {
			connectionId: connId,
			table,
			row,
			database: opts?.database,
			schema: opts?.schema
		})) as DbClientQueryResult;
	},

	async updateRow(connId: string, table: string, pk: Record<string, unknown>, changes: Record<string, unknown>, opts?: { database?: string; schema?: string }): Promise<DbClientQueryResult> {
		return (await ws.http('db-client:data:update', {
			connectionId: connId,
			table,
			pk,
			changes,
			database: opts?.database,
			schema: opts?.schema
		})) as DbClientQueryResult;
	},

	async deleteRows(connId: string, table: string, pks: Record<string, unknown>[], opts?: { database?: string; schema?: string }): Promise<DbClientQueryResult> {
		return (await ws.http('db-client:data:delete', {
			connectionId: connId,
			table,
			pks,
			database: opts?.database,
			schema: opts?.schema
		})) as DbClientQueryResult;
	},

	// ── Structure ────────────────────────────────────────────────────────

	async createDatabase(connId: string, name: string): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:create-database', {
			connectionId: connId,
			name
		})) as { ok: boolean; ddl: string };
	},

	async createTable(connId: string, definition: TableDefinitionInput, opts?: { database?: string; schema?: string }): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:create-table', {
			connectionId: connId,
			definition,
			database: opts?.database,
			schema: opts?.schema
		})) as { ok: boolean; ddl: string };
	},

	async alterTable(connId: string, name: string, operations: AlterOperationInput[], opts?: { database?: string; schema?: string }): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:alter-table', {
			connectionId: connId,
			name,
			operations,
			database: opts?.database,
			schema: opts?.schema
		})) as { ok: boolean; ddl: string };
	},

	async dropTable(connId: string, name: string, opts?: { database?: string; schema?: string }): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:drop-table', {
			connectionId: connId,
			name,
			database: opts?.database,
			schema: opts?.schema
		})) as { ok: boolean; ddl: string };
	},

	async truncateTable(connId: string, name: string, opts?: { database?: string; schema?: string }): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:truncate-table', {
			connectionId: connId,
			name,
			database: opts?.database,
			schema: opts?.schema
		})) as { ok: boolean; ddl: string };
	},

	async renameTable(connId: string, name: string, newName: string, opts?: { database?: string; schema?: string }): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:rename-table', {
			connectionId: connId,
			name,
			newName,
			database: opts?.database,
			schema: opts?.schema
		})) as { ok: boolean; ddl: string };
	},

	async createIndex(connId: string, tableName: string, indexDef: IndexDefinitionInput, opts?: { database?: string; schema?: string }): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:create-index', {
			connectionId: connId,
			tableName,
			indexDef,
			database: opts?.database,
			schema: opts?.schema
		})) as { ok: boolean; ddl: string };
	},

	async dropIndex(connId: string, tableName: string, indexName: string, opts?: { database?: string; schema?: string }): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:drop-index', {
			connectionId: connId,
			tableName,
			indexName,
			database: opts?.database,
			schema: opts?.schema
		})) as { ok: boolean; ddl: string };
	}
};
