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
	DbClientOverview,
	DbClientQueryResult,
	DbClientSchemaNode,
	DbClientSchemaNodeType
} from '$shared/types/db-client';

export type DbClientView = 'overview' | 'query' | 'data' | 'structure' | 'er';

/** The per-object views, scoped to whichever object is active. */
const TABLE_VIEWS: DbClientView[] = ['data', 'structure', 'er'];
const ROUTINE_VIEWS: DbClientView[] = ['structure'];

/** Pick the view to show when opening `obj`: keep the user's current view when
 *  it's valid for this object type (so switching objects remembers the tab),
 *  else fall back — coercing routine-invalid fallbacks (data/er) to structure. */
function resolveTableView(current: DbClientView, obj: DbClientActiveObject, fallback: DbClientView): DbClientView {
	const isRoutine = obj.type === 'function' || obj.type === 'procedure';
	const allowed = isRoutine ? ROUTINE_VIEWS : TABLE_VIEWS;
	if (allowed.includes(current)) return current;
	if (isRoutine && (fallback === 'data' || fallback === 'er')) return 'structure';
	return fallback;
}

/** Drop duplicate (type, name) schema nodes, keeping the first occurrence.
 *  Guards keyed {#each} consumers against duplicate names (e.g. overloaded
 *  SQL functions that share one name across signatures). */
function dedupeSchemaNodes(nodes: DbClientSchemaNode[]): DbClientSchemaNode[] {
	const seen = new Set<string>();
	return nodes.filter((n) => {
		const key = `${n.type}:${n.name}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** A single data-grid filter condition, carried with the active object so
 *  foreign-key navigation survives back/forward history. */
export interface DbClientDataFilter {
	column: string;
	op: string;
	value: string;
}

export interface DbClientActiveObject {
	name: string;
	type: DbClientSchemaNodeType;
	database?: string;
	schema?: string;
	/** Pre-applied filter (e.g. set when jumping along a foreign key). */
	filter?: DbClientDataFilter | null;
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
	openTables: DbClientActiveObject[];
}

/** A point in a connection's navigation history (for back/forward). */
export interface DbClientNavSnapshot {
	view: DbClientView;
	object: DbClientActiveObject | null;
	database: string | null;
}

interface DbClientNavHistory {
	stack: DbClientNavSnapshot[];
	index: number;
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
	dataNonce: number;
	schemaNonce: number;
	openedDatabase: Record<string, string | null>;
	navHistory: Record<string, DbClientNavHistory>;
	// Bumped on every object (re)selection or history jump, so the data grid can
	// re-evaluate a pre-applied filter exactly once per navigation.
	navObjectTick: number;
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
	error: null,
	dataNonce: 0,
	schemaNonce: 0,
	openedDatabase: {},
	navHistory: {},
	navObjectTick: 0
});

function detailsKey(connId: string, opts: { database?: string; schema?: string; name: string }): string {
	return `${connId}::${opts.database ?? ''}::${opts.schema ?? ''}::${opts.name}`;
}

function emptyView(): DbClientConnectionView {
	return {
		activeView: 'overview',
		activeObject: null,
		query: { text: '', result: null, error: null, running: false },
		openTables: []
	};
}

const VIEW_STORAGE_VERSION = 1;
const viewSaveTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function viewStorageKey(connId: string): string {
	return `clopen::db-client::view::${connId}`;
}

function writeView(connId: string): void {
	if (typeof window === 'undefined' || !window.localStorage) return;
	const view = state.views[connId];
	if (!view) return;
	try {
		localStorage.setItem(
			viewStorageKey(connId),
			JSON.stringify({
				v: VIEW_STORAGE_VERSION,
				activeView: view.activeView,
				activeObject: view.activeObject,
				query: { text: view.query.text },
				openTables: view.openTables,
				openedDatabase: state.openedDatabase[connId] ?? null
			})
		);
	} catch (e) {
		debug.error('session', 'Failed to save view to localStorage', e);
	}
}

/**
 * Persist a connection's view immediately. Used for structural changes
 * (open/close/rename tab, open/close table, navigation) so a delete is durable
 * before any following action — never lost to a pending debounce.
 */
function saveView(connId: string): void {
	if (typeof window === 'undefined') return;
	const existing = viewSaveTimers[connId];
	if (existing) {
		clearTimeout(existing);
		delete viewSaveTimers[connId];
	}
	writeView(connId);
}

/**
 * Debounced persist — only for the high-frequency query-text path, where a
 * write on every keystroke would be wasteful.
 */
function scheduleSaveView(connId: string): void {
	if (typeof window === 'undefined') return;
	const existing = viewSaveTimers[connId];
	if (existing) clearTimeout(existing);
	viewSaveTimers[connId] = setTimeout(() => {
		delete viewSaveTimers[connId];
		writeView(connId);
	}, 300);
}

function loadView(connId: string): DbClientConnectionView | null {
	if (typeof window === 'undefined' || !window.localStorage) return null;
	try {
		const serialized = localStorage.getItem(viewStorageKey(connId));
		if (!serialized) return null;
		const parsed = JSON.parse(serialized) as { v?: number; openedDatabase?: string | null };
		// Drop data written by an older, incompatible shape.
		if (parsed.v !== VIEW_STORAGE_VERSION) return null;
		
		const r = parsed as Partial<DbClientConnectionView> & { openedDatabase?: string | null };
		const base = emptyView();
		
		if (r.openedDatabase !== undefined) {
			state.openedDatabase = { ...state.openedDatabase, [connId]: r.openedDatabase };
		}
		
		return {
			activeView: r.activeView ?? base.activeView,
			activeObject: r.activeObject ?? null,
			query: { text: typeof r.query?.text === 'string' ? r.query.text : '', result: null, error: null, running: false },
			openTables: Array.isArray(r.openTables) ? r.openTables : []
		};
	} catch (e) {
		debug.error('session', 'Failed to load view from localStorage', e);
		return null;
	}
}

function ensureView(connId: string): DbClientConnectionView {
	if (!state.views[connId]) {
		state.views[connId] = loadView(connId) ?? emptyView();
	}
	return state.views[connId];
}

function filterKey(f: DbClientDataFilter | null | undefined): string {
	return f ? `${f.column}\u0000${f.op}\u0000${f.value}` : '';
}

// Tracks the navObjectTick a connection's relation filter was last applied for.
// Kept outside $state so reading/marking it never participates in reactivity
// (the data grid claims it inside an untracked block).
const filterAppliedTicks = new Map<string, number>();

function navSnapshotEqual(a: DbClientNavSnapshot, b: DbClientNavSnapshot): boolean {
	return (
		a.view === b.view &&
		(a.database ?? null) === (b.database ?? null) &&
		(a.object?.name ?? null) === (b.object?.name ?? null) &&
		(a.object?.type ?? null) === (b.object?.type ?? null) &&
		(a.object?.database ?? null) === (b.object?.database ?? null) &&
		(a.object?.schema ?? null) === (b.object?.schema ?? null) &&
		filterKey(a.object?.filter) === filterKey(b.object?.filter)
	);
}

function applyNavSnapshot(connId: string, snap: DbClientNavSnapshot): void {
	// Mutate openedDatabase + view together; the recording effect runs once
	// after the batch and sees a state equal to `snap`, so it won't re-append.
	state.openedDatabase = { ...state.openedDatabase, [connId]: snap.database };
	const view = ensureView(connId);
	// Hand out a fresh copy so consuming the live object's filter (after the grid
	// applies it) never mutates the stored snapshot.
	view.activeObject = snap.object ? { ...snap.object } : null;
	view.activeView = snap.view;
	state.navObjectTick++;
	saveView(connId);
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
	get dataNonce(): number {
		return state.dataNonce;
	},
	/** Signal open data views to reload (e.g. after truncate/reset/empty). */
	touchData(): void {
		state.dataNonce++;
	},
	get schemaNonce(): number {
		return state.schemaNonce;
	},
	/** Ask the sidebar tree to re-fetch its current scope (after DDL changes). */
	requestSchemaReload(): void {
		state.schemaNonce++;
	},
	get openedDatabase(): Record<string, string | null> {
		return state.openedDatabase;
	},
	/** The database currently browsed in the sidebar for a connection (tree drivers). */
	setOpenedDatabase(connId: string, database: string | null): void {
		state.openedDatabase = { ...state.openedDatabase, [connId]: database };
		saveView(connId);
	},

	// ── Navigation history (back/forward) ────────────────────────────────

	/**
	 * Record the connection's current (view, object, database) as a history
	 * entry. No-op when it matches the current position — so replaying a back/
	 * forward jump doesn't append a duplicate. Truncates any forward entries.
	 */
	recordNav(connId: string): void {
		const view = state.views[connId];
		const snap: DbClientNavSnapshot = {
			view: view?.activeView ?? 'overview',
			// Snapshot a copy: the live object's filter is consumed once applied,
			// and that must not retroactively strip the filter from history.
			object: view?.activeObject ? { ...view.activeObject } : null,
			database: state.openedDatabase[connId] ?? null
		};
		const hist = state.navHistory[connId] ?? { stack: [], index: -1 };
		const current = hist.stack[hist.index];
		if (current && navSnapshotEqual(current, snap)) return;
		const stack = [...hist.stack.slice(0, hist.index + 1), snap];
		state.navHistory = { ...state.navHistory, [connId]: { stack, index: stack.length - 1 } };
	},

	canNavBack(connId: string | null | undefined): boolean {
		if (!connId) return false;
		const hist = state.navHistory[connId];
		return !!hist && hist.index > 0;
	},

	canNavForward(connId: string | null | undefined): boolean {
		if (!connId) return false;
		const hist = state.navHistory[connId];
		return !!hist && hist.index < hist.stack.length - 1;
	},

	navBack(connId: string): void {
		const hist = state.navHistory[connId];
		if (!hist || hist.index <= 0) return;
		const index = hist.index - 1;
		applyNavSnapshot(connId, hist.stack[index]);
		state.navHistory = { ...state.navHistory, [connId]: { ...hist, index } };
	},

	navForward(connId: string): void {
		const hist = state.navHistory[connId];
		if (!hist || hist.index >= hist.stack.length - 1) return;
		const index = hist.index + 1;
		applyNavSnapshot(connId, hist.stack[index]);
		state.navHistory = { ...state.navHistory, [connId]: { ...hist, index } };
	},

	get navObjectTick(): number {
		return state.navObjectTick;
	},

	/**
	 * Claim the pre-applied filter for one navigation. Returns true the first time
	 * it's called for a given (connection, tick) and false afterwards, so the data
	 * grid applies a relation filter exactly once per navigation — re-mounting it
	 * (switching tabs) or reloading the same object sees the same tick and skips,
	 * while each back/forward jump bumps the tick and so re-applies. The active
	 * object is never mutated, so history snapshots keep their filter regardless of
	 * effect ordering.
	 */
	claimFilterApplication(connId: string, tick: number): boolean {
		if (filterAppliedTicks.get(connId) === tick) return false;
		filterAppliedTicks.set(connId, tick);
		return true;
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
		saveView(connId);
	},

	setQueryView(connId: string): void {
		ensureView(connId).activeView = 'query';
		saveView(connId);
	},

	setActiveObject(connId: string, obj: DbClientActiveObject | null): void {
		ensureView(connId).activeObject = obj;
		// A (re)selection is a navigation — let the data grid re-evaluate even when
		// the table name is unchanged (e.g. re-opening the current table clears a
		// leftover relation filter).
		state.navObjectTick++;
		saveView(connId);
	},

	openTable(
		connId: string,
		obj: DbClientActiveObject,
		defaultView: DbClientView = 'data',
		opts?: { remember?: boolean }
	): void {
		const view = ensureView(connId);
		const exists = view.openTables.find(
			(t) => t.name === obj.name && (t.database ?? null) === (obj.database ?? null)
		);
		if (!exists) {
			view.openTables = [...view.openTables, obj];
		}
		view.activeObject = obj;
		// When remembering, keep the current table-scoped view (Data/Structure/Log/
		// ERD) across object switches; otherwise honor the explicit defaultView.
		view.activeView = opts?.remember
			? resolveTableView(view.activeView, obj, defaultView)
			: defaultView;
		state.navObjectTick++;
		saveView(connId);
	},

	closeTable(connId: string, index: number): void {
		const view = ensureView(connId);
		if (index < 0 || index >= view.openTables.length) return;
		const closedTab = view.openTables[index];
		const isActive = view.activeObject && 
			view.activeObject.name === closedTab.name && 
			(view.activeObject.database ?? null) === (closedTab.database ?? null);
		
		view.openTables = view.openTables.filter((_, i) => i !== index);

		if (isActive) {
			const connection = state.connections.find(c => c.id === connId);
			const defaultDb = connection?.database ?? null;
			const closedDb = closedTab.database ?? defaultDb;
			const sameDbTables = view.openTables.filter(t => (t.database ?? defaultDb) === closedDb);

			if (sameDbTables.length > 0) {
				// Find the tab in sameDbTables that is closest to the closed tab's index
				let bestTable = sameDbTables[0];
				let minDiff = Infinity;
				for (const t of sameDbTables) {
					const origIdx = view.openTables.indexOf(t);
					const diff = Math.abs(origIdx - index);
					if (diff < minDiff) {
						minDiff = diff;
						bestTable = t;
					}
				}
				view.activeObject = bestTable;
			} else {
				view.activeObject = null;
				view.activeView = 'overview';
			}
		}
		state.navObjectTick++;
		saveView(connId);
	},

	closeAllTables(connId: string): void {
		const view = ensureView(connId);
		view.openTables = [];
		view.activeObject = null;
		view.activeView = 'overview';
		state.navObjectTick++;
		saveView(connId);
	},

	setQueryText(connId: string, text: string): void {
		const view = ensureView(connId);
		view.query.text = text;
		scheduleSaveView(connId);
	},

	setQueryResult(connId: string, result: DbClientQueryResult | null): void {
		const view = ensureView(connId);
		view.query.result = result;
	},

	setQueryError(connId: string, error: string | null): void {
		const view = ensureView(connId);
		view.query.error = error;
	},

	setQueryRunning(connId: string, running: boolean): void {
		const view = ensureView(connId);
		view.query.running = running;
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
		delete state.openedDatabase[id];
		delete state.navHistory[id];
		filterAppliedTicks.delete(id);
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

	async overview(connId: string, opts?: { database?: string; schema?: string }): Promise<DbClientOverview> {
		return (await ws.http('db-client:overview', {
			connectionId: connId,
			database: opts?.database,
			schema: opts?.schema
		})) as DbClientOverview;
	},

	async listDatabases(connId: string): Promise<DbClientSchemaNode[]> {
		const result = (await ws.http('db-client:list-databases', { connectionId: connId })) as DbClientSchemaNode[];
		return dedupeSchemaNodes(result);
	},

	async listObjects(connId: string, opts?: { database?: string; schema?: string }): Promise<DbClientSchemaNode[]> {
		const result = (await ws.http('db-client:list-objects', {
			connectionId: connId,
			database: opts?.database,
			schema: opts?.schema
		})) as DbClientSchemaNode[];
		// Collapse duplicate (type, name) pairs — e.g. overloaded SQL functions
		// that share one name — so the keyed {#each} blocks rendering this list
		// (sidebar tree, export picker) never hit a duplicate-key crash.
		const deduped = dedupeSchemaNodes(result);
		// Reassign the container (not just the key) so cross-component $derived
		// consumers re-run even when refreshed externally (e.g. after a drop).
		state.schema = { ...state.schema, [connId]: deduped };
		return deduped;
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

	/**
	 * Execute a multi-statement batch. Each statement is classified and routed
	 * on the backend; the returned result carries a per-statement report under
	 * `.batch`.
	 */
	async executeBatch(connId: string, query: string, opts?: { database?: string; limit?: number }): Promise<DbClientQueryResult> {
		return (await ws.http('db-client:execute-batch', {
			connectionId: connId,
			query,
			database: opts?.database,
			limit: opts?.limit
		})) as DbClientQueryResult;
	},

	async cancel(connId: string): Promise<void> {
		await ws.http('db-client:cancel', { connectionId: connId });
	},

	async getErSchema(connId: string, opts?: { database?: string; schema?: string }): Promise<{
		tables: Array<{
			name: string;
			columns: Array<{ name: string; type: string; isPrimary: boolean; isUnique: boolean }>;
			foreignKeys: Array<{ column: string; refTable: string; refColumn: string }>;
		}>;
	}> {
		return (await ws.http('db-client:get-er-schema', {
			connectionId: connId,
			database: opts?.database,
			schema: opts?.schema
		})) as any;
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

	async dropDatabase(connId: string, name: string): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:drop-database', {
			connectionId: connId,
			name
		})) as { ok: boolean; ddl: string };
	},

	async renameDatabase(connId: string, name: string, newName: string): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:rename-database', {
			connectionId: connId,
			name,
			newName
		})) as { ok: boolean; ddl: string };
	},

	async resetDatabase(connId: string, opts?: { database?: string; schema?: string }): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:reset-database', {
			connectionId: connId,
			database: opts?.database,
			schema: opts?.schema
		})) as { ok: boolean; ddl: string };
	},

	async flushDatabase(connId: string): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:flush-database', {
			connectionId: connId
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

	async resetTable(connId: string, name: string, opts?: { database?: string; schema?: string }): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:reset-table', {
			connectionId: connId,
			name,
			database: opts?.database,
			schema: opts?.schema
		})) as { ok: boolean; ddl: string };
	},

	async duplicateTable(connId: string, name: string, newName: string, opts?: { database?: string; schema?: string; withData?: boolean }): Promise<{ ok: boolean; ddl: string }> {
		return (await ws.http('db-client:structure:duplicate-table', {
			connectionId: connId,
			name,
			newName,
			database: opts?.database,
			schema: opts?.schema,
			withData: opts?.withData
		})) as { ok: boolean; ddl: string };
	},

	async getCreateStatement(connId: string, name: string, type: DbClientSchemaNodeType, opts?: { database?: string; schema?: string }): Promise<string> {
		const result = (await ws.http('db-client:structure:create-statement', {
			connectionId: connId,
			name,
			type,
			database: opts?.database,
			schema: opts?.schema
		})) as { ok: boolean; statement: string };
		return result.statement;
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
