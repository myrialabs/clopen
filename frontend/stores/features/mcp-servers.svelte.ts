/**
 * External MCP Servers Store
 *
 * Reactive store for Settings → MCP. Manages user-installed (external) MCP
 * servers and browsing the official MCP registry catalog. Distinct from the
 * internal custom-tool servers, which are defined in code and not listed here.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * A configurable field, captured from the catalog at install time so the
 * "Configure" modal renders the same labelled fields as install. `kind` decides
 * whether its value lands in `env` (stdio) or `headers` (remote auth).
 */
export interface McpConfigField {
	name: string;
	kind: 'env' | 'header';
	description?: string;
	isRequired: boolean;
	isSecret: boolean;
}

export interface InstalledMcpServer {
	id: number;
	slug: string;
	namespace: string;
	name: string;
	description: string | null;
	registryName: string | null;
	version: string | null;
	transport: McpTransport;
	command: string | null;
	args: string[];
	env: Record<string, string>;
	headers: Record<string, string>;
	configSchema: McpConfigField[];
	url: string | null;
	source: string;
	enabled: boolean;
	createdAt: string;
}

export interface CatalogEnvVar {
	name: string;
	description?: string;
	isRequired: boolean;
	isSecret: boolean;
	default?: string;
}

export interface CatalogServer {
	registryName: string;
	slug: string;
	title: string;
	description: string;
	version: string;
	transport: McpTransport;
	command?: string;
	args?: string[];
	url?: string;
	envVars: CatalogEnvVar[];
	headerVars: CatalogEnvVar[];
	packageHint?: string;
}

/** Connection health classified by the backend probe. */
export type McpHealthState = 'ok' | 'needs_auth' | 'needs_config' | 'unreachable' | 'error' | 'local';

export interface McpHealth {
	state: McpHealthState;
	toolCount?: number;
	message?: string;
}

export interface InstallPayload {
	slug: string;
	name: string;
	description?: string;
	registryName?: string;
	version?: string;
	transport: McpTransport;
	command?: string;
	args?: string[];
	url?: string;
	env?: Record<string, string>;
	headers?: Record<string, string>;
	configSchema?: McpConfigField[];
	source?: 'registry' | 'custom';
}

let installed = $state<InstalledMcpServer[]>([]);
let installedLoaded = $state(false);

// Per-server connection health (keyed by id). `checking` drives the spinner.
let statuses = $state<Record<number, McpHealth>>({});
let checking = $state<Record<number, boolean>>({});

let catalog = $state<CatalogServer[]>([]);
let catalogCursor = $state<string | null>(null);
let catalogSearch = $state('');
let catalogLoading = $state(false);
// True only while a *fresh* (non-append) load is running — drives the skeleton.
let catalogLoadingFresh = $state(false);
let catalogError = $state<string | null>(null);

let hasPendingChanges = $state(false);

// Monotonic id used to discard superseded/cancelled catalog requests. A
// response is only applied when its id still matches the latest request.
let catalogReqId = 0;

export const mcpServersStore = {
	get installed() { return installed; },
	get installedLoaded() { return installedLoaded; },
	get statuses() { return statuses; },
	get checking() { return checking; },
	get catalog() { return catalog; },
	get catalogCursor() { return catalogCursor; },
	get catalogSearch() { return catalogSearch; },
	get catalogLoading() { return catalogLoading; },
	get catalogLoadingFresh() { return catalogLoadingFresh; },
	get catalogError() { return catalogError; },
	get hasPendingChanges() { return hasPendingChanges; },
	set hasPendingChanges(v: boolean) { hasPendingChanges = v; },

	/** Set of registry names already installed (for "Installed" badges in Browse). */
	get installedRegistryNames(): Set<string> {
		return new Set(installed.map(s => s.registryName).filter((n): n is string => !!n));
	},

	/**
	 * Map of MCP server key → human title, used by the Chat tool renderer to
	 * show "Browser Automation" instead of the raw `browser-automation` key.
	 * Keyed by both namespace and slug so either form resolves.
	 */
	get serverTitles(): Record<string, string> {
		const map: Record<string, string> = {};
		for (const s of installed) {
			map[s.namespace] = s.name;
			map[s.slug] = s.name;
		}
		return map;
	},

	// ========================================================================
	// Installed servers
	// ========================================================================

	async fetchInstalled(): Promise<InstalledMcpServer[]> {
		if (installedLoaded) return installed;
		return this.refreshInstalled();
	},

	async refreshInstalled(): Promise<InstalledMcpServer[]> {
		try {
			const result = await ws.http('mcp:list', {});
			installed = result.servers;
			installedLoaded = true;
			return installed;
		} catch (error) {
			debug.error('settings', 'Failed to list MCP servers:', error);
			installed = [];
			installedLoaded = true;
			return [];
		}
	},

	async install(payload: InstallPayload): Promise<InstalledMcpServer> {
		const result = await ws.http('mcp:install', payload);
		await this.refreshInstalled();
		// Probe the just-installed server so its status shows immediately.
		this.checkStatus(result.server.id);
		return result.server;
	},

	async toggle(id: number, enabled: boolean): Promise<void> {
		await ws.http('mcp:toggle', { id, enabled });
		await this.refreshInstalled();
		// Probe a freshly-enabled server so its connection status appears without a
		// manual re-check (disabled servers render a static "Disabled" instead).
		if (enabled) this.checkStatus(id);
	},

	async updateConfig(
		id: number,
		env: Record<string, string>,
		headers: Record<string, string>,
		command?: string,
		args?: string[]
	): Promise<void> {
		await ws.http('mcp:update-config', {
			id,
			env,
			headers,
			...(command !== undefined ? { command } : {}),
			...(args !== undefined ? { args } : {})
		});
		await this.refreshInstalled();
	},

	async uninstall(id: number): Promise<void> {
		await ws.http('mcp:uninstall', { id });
		await this.refreshInstalled();
	},

	/** Probe one server's connection health and cache the result. */
	async checkStatus(id: number): Promise<void> {
		checking = { ...checking, [id]: true };
		try {
			const result = await ws.http('mcp:status', { id });
			statuses = { ...statuses, [id]: result.status };
		} catch (error) {
			debug.error('settings', `Failed to probe MCP server ${id}:`, error);
			statuses = { ...statuses, [id]: { state: 'error', message: 'Status check failed' } };
		} finally {
			checking = { ...checking, [id]: false };
		}
	},

	/**
	 * Start the centralized OAuth sign-in: open the authorization URL in a new
	 * tab (Clopen runs the whole flow and its stable callback stores the token),
	 * then poll status until the server reports connected. The resulting token is
	 * injected into every engine, so one sign-in covers all of them.
	 */
	async authenticate(id: number): Promise<void> {
		checking = { ...checking, [id]: true };
		try {
			const { authorizationUrl } = await ws.http('mcp:oauth-start', { id });
			window.open(authorizationUrl, '_blank', 'noopener');
		} catch (error) {
			debug.error('settings', `MCP OAuth start failed for ${id}:`, error);
			statuses = { ...statuses, [id]: { state: 'error', message: error instanceof Error ? error.message : 'Sign-in failed' } };
			checking = { ...checking, [id]: false };
			return;
		}
		// Poll for completion (the callback stores the token out-of-band).
		for (let i = 0; i < 60; i++) {
			await new Promise(resolve => setTimeout(resolve, 2000));
			try {
				const result = await ws.http('mcp:status', { id });
				if (result.status.state !== 'needs_auth') {
					statuses = { ...statuses, [id]: result.status };
					break;
				}
			} catch { /* keep polling */ }
		}
		checking = { ...checking, [id]: false };
	},

	/** Probe every enabled, non-internal server (used when the panel opens). */
	async checkAllStatuses(): Promise<void> {
		const targets = installed.filter(s => s.enabled && s.source !== 'internal');
		await Promise.all(targets.map(s => this.checkStatus(s.id)));
	},

	// ========================================================================
	// Registry catalog
	// ========================================================================

	async searchCatalog(search: string): Promise<void> {
		catalogSearch = search;
		catalogCursor = null;
		// Keep old results visible until the new ones arrive (less flicker).
		await this.loadCatalog(false);
	},

	async loadMoreCatalog(): Promise<void> {
		if (!catalogCursor) return;
		await this.loadCatalog(true);
	},

	/** Abort an in-flight search: discard its result and clear the loading state. */
	cancelSearch(): void {
		catalogReqId++;
		catalogLoading = false;
		catalogLoadingFresh = false;
	},

	async loadCatalog(append: boolean): Promise<void> {
		const reqId = ++catalogReqId;
		catalogLoading = true;
		if (!append) catalogLoadingFresh = true;
		catalogError = null;
		try {
			const result = await ws.http('mcp:catalog', {
				search: catalogSearch || undefined,
				cursor: append ? (catalogCursor ?? undefined) : undefined,
				limit: 30
			});
			if (reqId !== catalogReqId) return; // superseded or cancelled
			catalog = append ? [...catalog, ...result.servers] : result.servers;
			catalogCursor = result.nextCursor;
		} catch (error) {
			if (reqId !== catalogReqId) return;
			debug.error('settings', 'Failed to load MCP catalog:', error);
			catalogError = error instanceof Error ? error.message : 'Failed to reach the MCP registry';
			if (!append) catalog = [];
		} finally {
			if (reqId === catalogReqId) {
				catalogLoading = false;
				catalogLoadingFresh = false;
			}
		}
	},

	reset() {
		installed = [];
		installedLoaded = false;
		statuses = {};
		checking = {};
		catalog = [];
		catalogCursor = null;
		catalogSearch = '';
		catalogLoading = false;
		catalogError = null;
	}
};
