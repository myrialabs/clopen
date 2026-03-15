/**
 * SQL-to-REST API Generator Store
 */

import ws from '$frontend/utils/ws';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type {
	SqlApiEndpoint,
	SqlApiEndpointCreateInput,
	SqlApiEndpointUpdateInput,
	SqlApiKey,
	SqlApiKeyWithSecret,
	SqlApiRequestLog,
	SqlApiParam
} from '$shared/types/sql-rest-api';

// ─── State ────────────────────────────────────────────────────────────────────

export const dbRestApiState = $state({
	endpoints: [] as SqlApiEndpoint[],
	isLoading: false,
	search: '',

	/** Form modal */
	isFormOpen: false,
	editEndpoint: null as SqlApiEndpoint | null,

	/** Key management modal */
	isKeyModalOpen: false,
	keyEndpoint: null as SqlApiEndpoint | null,
	keys: [] as SqlApiKey[],
	isKeysLoading: false,

	/** Last created key secret — shown once then discarded */
	newKeySecret: null as string | null,

	/** Docs modal */
	isDocsOpen: false,

	/** Request log modal */
	isLogOpen: false,
	logEndpoint: null as SqlApiEndpoint | null,
	logs: [] as SqlApiRequestLog[],
	isLogsLoading: false
});

// ─── Derived helpers ──────────────────────────────────────────────────────────

export function getFilteredEndpoints(): SqlApiEndpoint[] {
	const search = dbRestApiState.search.toLowerCase();
	if (!search) return dbRestApiState.endpoints;
	return dbRestApiState.endpoints.filter((e) =>
		e.name.toLowerCase().includes(search) ||
		e.slug.toLowerCase().includes(search) ||
		e.description.toLowerCase().includes(search)
	);
}

// ─── Endpoint actions ─────────────────────────────────────────────────────────

export async function fetchEndpoints(connectionId?: string): Promise<void> {
	dbRestApiState.isLoading = true;
	try {
		const endpoints = await ws.http('db:rest-api:list', { connectionId });
		dbRestApiState.endpoints = endpoints ?? [];
	} catch {
		// Non-fatal
	} finally {
		dbRestApiState.isLoading = false;
	}
}

export async function createEndpoint(input: SqlApiEndpointCreateInput): Promise<boolean> {
	try {
		const endpoint = await ws.http('db:rest-api:create', input);
		dbRestApiState.endpoints = [endpoint, ...dbRestApiState.endpoints];
		addNotification({ type: 'success', title: 'REST API endpoint created', message: `/${endpoint.slug} is now live`, duration: 3000 });
		return true;
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'REST API',
			message: err instanceof Error ? err.message : 'Failed to create endpoint',
			duration: 4000
		});
		return false;
	}
}

export async function updateEndpoint(input: SqlApiEndpointUpdateInput): Promise<boolean> {
	try {
		const updated = await ws.http('db:rest-api:update', input);
		if (!updated) return false;
		dbRestApiState.endpoints = dbRestApiState.endpoints.map((e) =>
			e.id === updated.id ? updated : e
		);
		addNotification({ type: 'success', title: 'REST API endpoint updated', message: `/${updated.slug} saved`, duration: 2500 });
		return true;
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'REST API',
			message: err instanceof Error ? err.message : 'Failed to update endpoint',
			duration: 4000
		});
		return false;
	}
}

export async function deleteEndpoint(id: string): Promise<void> {
	try {
		await ws.http('db:rest-api:delete', { id });
		dbRestApiState.endpoints = dbRestApiState.endpoints.filter((e) => e.id !== id);
		addNotification({ type: 'success', title: 'REST API endpoint deleted', message: 'Endpoint removed', duration: 2500 });
	} catch {
		addNotification({ type: 'error', title: 'REST API', message: 'Failed to delete endpoint', duration: 3000 });
	}
}

export async function extractParams(sqlTemplate: string): Promise<SqlApiParam[]> {
	try {
		const names = await ws.http('db:rest-api:extract-params', { sqlTemplate });
		return (names ?? []).map((name: string) => ({
			name,
			type: 'string' as const,
			description: '',
			required: true
		}));
	} catch {
		return [];
	}
}

// ─── API Key actions ──────────────────────────────────────────────────────────

export async function fetchKeys(endpointId: string): Promise<void> {
	dbRestApiState.isKeysLoading = true;
	try {
		const keys = await ws.http('db:rest-api:keys:list', { endpointId });
		dbRestApiState.keys = keys ?? [];
	} catch {
		// Non-fatal
	} finally {
		dbRestApiState.isKeysLoading = false;
	}
}

export async function createKey(endpointId: string, name: string, expiresAt: string | null): Promise<SqlApiKeyWithSecret | null> {
	try {
		const result: { key: SqlApiKey; secret: string } = await ws.http('db:rest-api:keys:create', { endpointId, name, expiresAt });
		dbRestApiState.keys = [result.key, ...dbRestApiState.keys];
		dbRestApiState.newKeySecret = result.secret;
		addNotification({ type: 'success', title: 'API key created', message: `"${name}" — copy the secret now, it won't be shown again`, duration: 5000 });
		return { ...result.key, key: result.secret };
	} catch (err) {
		addNotification({
			type: 'error',
			title: 'API Key',
			message: err instanceof Error ? err.message : 'Failed to create key',
			duration: 4000
		});
		return null;
	}
}

export async function deleteKey(id: string): Promise<void> {
	try {
		await ws.http('db:rest-api:keys:delete', { id });
		dbRestApiState.keys = dbRestApiState.keys.filter((k) => k.id !== id);
		addNotification({ type: 'success', title: 'API key revoked', message: 'Key deleted', duration: 2500 });
	} catch {
		addNotification({ type: 'error', title: 'API Key', message: 'Failed to delete key', duration: 3000 });
	}
}

export async function toggleKey(id: string, enabled: boolean): Promise<void> {
	try {
		await ws.http('db:rest-api:keys:toggle', { id, enabled });
		dbRestApiState.keys = dbRestApiState.keys.map((k) =>
			k.id === id ? { ...k, enabled } : k
		);
	} catch {
		addNotification({ type: 'error', title: 'API Key', message: 'Failed to toggle key', duration: 3000 });
	}
}

// ─── Request log actions ──────────────────────────────────────────────────────

export async function fetchLogs(endpointId: string): Promise<void> {
	dbRestApiState.isLogsLoading = true;
	try {
		const logs = await ws.http('db:rest-api:logs', { endpointId });
		dbRestApiState.logs = logs ?? [];
	} catch {
		// Non-fatal
	} finally {
		dbRestApiState.isLogsLoading = false;
	}
}

// ─── Modal helpers ────────────────────────────────────────────────────────────

export function openForm(endpoint?: SqlApiEndpoint): void {
	dbRestApiState.editEndpoint = endpoint ?? null;
	dbRestApiState.isFormOpen = true;
}

export function closeForm(): void {
	dbRestApiState.isFormOpen = false;
	dbRestApiState.editEndpoint = null;
}

export function openKeyModal(endpoint: SqlApiEndpoint): void {
	dbRestApiState.keyEndpoint = endpoint;
	dbRestApiState.isKeyModalOpen = true;
	dbRestApiState.newKeySecret = null;
	fetchKeys(endpoint.id);
}

export function closeKeyModal(): void {
	dbRestApiState.isKeyModalOpen = false;
	dbRestApiState.keyEndpoint = null;
	dbRestApiState.keys = [];
	dbRestApiState.newKeySecret = null;
}

export function openDocs(): void {
	dbRestApiState.isDocsOpen = true;
}

export function closeDocs(): void {
	dbRestApiState.isDocsOpen = false;
}

export function openLogModal(endpoint: SqlApiEndpoint): void {
	dbRestApiState.logEndpoint = endpoint;
	dbRestApiState.isLogOpen = true;
	fetchLogs(endpoint.id);
}

export function closeLogModal(): void {
	dbRestApiState.isLogOpen = false;
	dbRestApiState.logEndpoint = null;
	dbRestApiState.logs = [];
}
