/**
 * db-client store — Phase 1 skeleton.
 * Connections CRUD + test. Schema, query, structure, and data CRUD
 * arrive in Phase 2.
 */

import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';
import type {
	DbClientConnection,
	DbClientConnectionInput,
	DbClientHealth
} from '$shared/types/db-client';

interface DbClientState {
	connections: DbClientConnection[];
	activeConnectionId: string | null;
	health: Record<string, DbClientHealth>;
	isLoading: boolean;
	error: string | null;
}

const state = $state<DbClientState>({
	connections: [],
	activeConnectionId: null,
	health: {},
	isLoading: false,
	error: null
});

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
	get health(): Record<string, DbClientHealth> {
		return state.health;
	},
	get isLoading(): boolean {
		return state.isLoading;
	},
	get error(): string | null {
		return state.error;
	},
	get liveCount(): number {
		return Object.values(state.health).filter((h) => h?.ok).length;
	},

	setActive(id: string | null): void {
		state.activeConnectionId = id;
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
	}
};
