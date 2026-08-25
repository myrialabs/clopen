/**
 * ssh-client store — connections, per-connection view state, terminal tabs,
 * the SFTP browser's current directory, and port forwards.
 *
 * Mirrors the db-client store: the server owns the data, this owns which
 * connection is selected and what the user was last looking at on it. View
 * state is persisted per connection so reopening the panel lands where the user
 * left off.
 */

import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';
import type {
	SftpArchiveFormat,
	SftpArchiveInfo,
	SftpBulkResult,
	SftpCompressResult,
	SftpConflict,
	SftpConflictStrategy,
	SftpDiskUsage,
	SftpEntry,
	SftpExtractOptions,
	SftpExtractResult,
	SftpFileContent,
	SftpListing,
	SshConnection,
	SshConnectionInput,
	SshForward,
	SshForwardInput,
	SshForwardStatus,
	SshHealth,
	SshKnownHost
} from '$shared/types/ssh';

export type SshView = 'terminal' | 'files' | 'forwards' | 'overview';

/** One terminal tab. `sessionId` is the PtyKit session it renders. */
export interface SshTerminalTab {
	sessionId: string;
	title: string;
}

export interface SshConnectionView {
	activeView: SshView;
	tabs: SshTerminalTab[];
	activeSessionId: string | null;
	/** Remote directory the file browser is showing. */
	currentPath: string;
}

interface SshClientState {
	connections: SshConnection[];
	activeConnectionId: string | null;
	views: Record<string, SshConnectionView>;
	health: Record<string, SshHealth>;
	listings: Record<string, SftpListing>;
	forwards: Record<string, SshForward[]>;
	forwardStatuses: Record<string, Record<string, SshForwardStatus>>;
	diskUsage: Record<string, SftpDiskUsage>;
	knownHosts: SshKnownHost[];
	isLoading: boolean;
	isFormOpen: boolean;
	error: string | null;
	/** Bumped to ask the file browser to re-list its current directory. */
	listingNonce: number;
}

const state = $state<SshClientState>({
	connections: [],
	activeConnectionId: null,
	views: {},
	health: {},
	listings: {},
	forwards: {},
	forwardStatuses: {},
	diskUsage: {},
	knownHosts: [],
	isLoading: false,
	isFormOpen: false,
	error: null,
	listingNonce: 0
});

const VIEW_STORAGE_VERSION = 1;

function viewStorageKey(connectionId: string): string {
	return `clopen::ssh-client::view::${connectionId}`;
}

function emptyView(): SshConnectionView {
	return { activeView: 'terminal', tabs: [], activeSessionId: null, currentPath: '' };
}

/**
 * Persist the view. Terminal tabs are stored too: PtyKit keeps remote shells
 * alive across a refresh, so remembering their ids is what lets the tabs come
 * back attached rather than as new shells.
 */
function saveView(connectionId: string): void {
	if (typeof window === 'undefined' || !window.localStorage) return;
	const view = state.views[connectionId];
	if (!view) return;
	try {
		localStorage.setItem(
			viewStorageKey(connectionId),
			JSON.stringify({ v: VIEW_STORAGE_VERSION, ...view })
		);
	} catch (error) {
		debug.error('ssh', 'Failed to save view to localStorage', error);
	}
}

function loadView(connectionId: string): SshConnectionView | null {
	if (typeof window === 'undefined' || !window.localStorage) return null;
	try {
		const serialized = localStorage.getItem(viewStorageKey(connectionId));
		if (!serialized) return null;
		const parsed = JSON.parse(serialized) as Partial<SshConnectionView> & { v?: number };
		// Drop data written by an older, incompatible shape.
		if (parsed.v !== VIEW_STORAGE_VERSION) return null;
		const base = emptyView();
		return {
			activeView: parsed.activeView ?? base.activeView,
			tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
			activeSessionId: parsed.activeSessionId ?? null,
			currentPath: typeof parsed.currentPath === 'string' ? parsed.currentPath : ''
		};
	} catch (error) {
		debug.error('ssh', 'Failed to load view from localStorage', error);
		return null;
	}
}

function ensureView(connectionId: string): SshConnectionView {
	if (!state.views[connectionId]) {
		state.views[connectionId] = loadView(connectionId) ?? emptyView();
	}
	return state.views[connectionId];
}

/** PtyKit session ids are opaque; scope them to the host so they never collide. */
function newSessionId(connectionId: string): string {
	return `ssh-${connectionId}-${crypto.randomUUID().slice(0, 8)}`;
}

export const sshClientStore = {
	get connections(): SshConnection[] {
		return state.connections;
	},
	get activeConnectionId(): string | null {
		return state.activeConnectionId;
	},
	get activeConnection(): SshConnection | null {
		const id = state.activeConnectionId;
		if (!id) return null;
		return state.connections.find((connection) => connection.id === id) ?? null;
	},
	get health(): Record<string, SshHealth> {
		return state.health;
	},
	get knownHosts(): SshKnownHost[] {
		return state.knownHosts;
	},
	get listings(): Record<string, SftpListing> {
		return state.listings;
	},
	get diskUsage(): Record<string, SftpDiskUsage> {
		return state.diskUsage;
	},
	get forwards(): Record<string, SshForward[]> {
		return state.forwards;
	},
	get forwardStatuses(): Record<string, Record<string, SshForwardStatus>> {
		return state.forwardStatuses;
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
	get listingNonce(): number {
		return state.listingNonce;
	},

	/** How many hosts are currently reachable — drives the tools-menu badge. */
	get liveCount(): number {
		return Object.values(state.health).filter((health) => health?.ok).length;
	},

	/**
	 * Whether the host has a usable connection right now. The terminal and file
	 * browser are gated on this, so Disconnect visibly stops them rather than
	 * being quietly undone by the next request.
	 */
	isConnected(connectionId: string | null | undefined): boolean {
		if (!connectionId) return false;
		return state.health[connectionId]?.ok === true;
	},

	setFormOpen(open: boolean): void {
		state.isFormOpen = open;
	},

	setError(message: string | null): void {
		state.error = message;
	},

	getView(connectionId: string): SshConnectionView {
		return ensureView(connectionId);
	},

	setActive(id: string | null): void {
		state.activeConnectionId = id;
		if (id) ensureView(id);
	},

	setView(connectionId: string, view: SshView): void {
		ensureView(connectionId).activeView = view;
		saveView(connectionId);
	},

	// ── Terminal tabs ────────────────────────────────────────────────────

	openTab(connectionId: string): SshTerminalTab {
		const view = ensureView(connectionId);
		const tab: SshTerminalTab = {
			sessionId: newSessionId(connectionId),
			title: `Shell ${view.tabs.length + 1}`
		};
		view.tabs = [...view.tabs, tab];
		view.activeSessionId = tab.sessionId;
		view.activeView = 'terminal';
		saveView(connectionId);
		return tab;
	},

	/**
	 * Adopt a tab for a session that already exists on the server — a shell another
	 * viewer opened, or one this browser opened before a refresh. Idempotent.
	 */
	adoptTab(connectionId: string, sessionId: string): void {
		const view = ensureView(connectionId);
		if (view.tabs.some((tab) => tab.sessionId === sessionId)) return;
		view.tabs = [...view.tabs, { sessionId, title: `Shell ${view.tabs.length + 1}` }];
		if (!view.activeSessionId) view.activeSessionId = sessionId;
		saveView(connectionId);
	},

	closeTab(connectionId: string, sessionId: string): void {
		const view = ensureView(connectionId);
		const index = view.tabs.findIndex((tab) => tab.sessionId === sessionId);
		if (index === -1) return;
		view.tabs = view.tabs.filter((tab) => tab.sessionId !== sessionId);
		if (view.activeSessionId === sessionId) {
			// Fall back to the neighbour that took its place, else the last tab.
			const next = view.tabs[index] ?? view.tabs[view.tabs.length - 1] ?? null;
			view.activeSessionId = next?.sessionId ?? null;
		}
		saveView(connectionId);
	},

	setActiveTab(connectionId: string, sessionId: string): void {
		ensureView(connectionId).activeSessionId = sessionId;
		saveView(connectionId);
	},

	renameTab(connectionId: string, sessionId: string, title: string): void {
		const view = ensureView(connectionId);
		view.tabs = view.tabs.map((tab) => (tab.sessionId === sessionId ? { ...tab, title } : tab));
		saveView(connectionId);
	},

	// ── Connections ──────────────────────────────────────────────────────

	async list(): Promise<SshConnection[]> {
		state.isLoading = true;
		state.error = null;
		try {
			const result = await ws.http('ssh:list', {});
			state.connections = (result ?? []) as SshConnection[];
			return state.connections;
		} catch (error) {
			debug.error('ssh', 'list failed:', error);
			state.error = error instanceof Error ? error.message : 'Failed to list connections';
			throw error;
		} finally {
			state.isLoading = false;
		}
	},

	async create(input: SshConnectionInput): Promise<SshConnection> {
		const connection = (await ws.http('ssh:create', input)) as SshConnection;
		state.connections = [connection, ...state.connections];
		return connection;
	},

	async update(id: string, patch: Partial<SshConnectionInput>): Promise<SshConnection> {
		const connection = (await ws.http('ssh:update', { id, patch })) as SshConnection;
		state.connections = state.connections.map((existing) =>
			existing.id === id ? connection : existing
		);
		// The old transport is gone server-side, so the cached state is stale too.
		delete state.health[id];
		delete state.listings[id];
		return connection;
	},

	async remove(id: string): Promise<void> {
		await ws.http('ssh:delete', { id });
		state.connections = state.connections.filter((connection) => connection.id !== id);
		delete state.health[id];
		delete state.views[id];
		delete state.listings[id];
		delete state.forwards[id];
		delete state.forwardStatuses[id];
		delete state.diskUsage[id];
		if (state.activeConnectionId === id) state.activeConnectionId = null;
	},

	async test(input: SshConnectionInput | { id: string }): Promise<SshHealth> {
		const result = (await ws.http('ssh:test', input)) as SshHealth;
		if ('id' in input) state.health[input.id] = result;
		return result;
	},

	/** Open the host and start its auto-start forwards. */
	async activate(id: string): Promise<SshHealth> {
		const result = (await ws.http('ssh:activate', { id })) as SshHealth;
		state.health[id] = result;
		return result;
	},

	async disconnect(id: string): Promise<SshHealth> {
		const result = (await ws.http('ssh:disconnect', { id })) as SshHealth;
		state.health[id] = result;
		delete state.forwardStatuses[id];
		return result;
	},

	async trustHostKey(id: string): Promise<SshHealth> {
		const result = (await ws.http('ssh:trust-host-key', { id })) as SshHealth;
		state.health[id] = result;
		await this.loadKnownHosts();
		return result;
	},

	async loadKnownHosts(): Promise<SshKnownHost[]> {
		state.knownHosts = ((await ws.http('ssh:known-hosts', {})) ?? []) as SshKnownHost[];
		return state.knownHosts;
	},

	async forgetHostKey(host: string, port: number): Promise<void> {
		await ws.http('ssh:forget-host-key', { host, port });
		await this.loadKnownHosts();
	},

	// ── SFTP ─────────────────────────────────────────────────────────────

	/** Ask the file browser to re-list whatever it is showing. */
	requestListingReload(): void {
		state.listingNonce++;
	},

	async listFiles(connectionId: string, path: string): Promise<SftpListing> {
		const listing = (await ws.http('ssh:sftp-list', { connectionId, path })) as SftpListing;
		state.listings[connectionId] = listing;
		const view = ensureView(connectionId);
		view.currentPath = listing.path;
		saveView(connectionId);
		return listing;
	},

	/**
	 * List a directory without making it the browser's current one. Used by the
	 * move/copy destination picker, which must not move the view underneath the
	 * selection the user is about to act on.
	 */
	async browseFiles(connectionId: string, path: string): Promise<SftpListing> {
		return (await ws.http('ssh:sftp-list', { connectionId, path })) as SftpListing;
	},

	async statFile(connectionId: string, path: string): Promise<SftpEntry> {
		return (await ws.http('ssh:sftp-stat', { connectionId, path })) as SftpEntry;
	},

	async makeDirectory(connectionId: string, path: string): Promise<void> {
		await ws.http('ssh:sftp-mkdir', { connectionId, path });
	},

	async createFile(connectionId: string, path: string): Promise<void> {
		await ws.http('ssh:sftp-create-file', { connectionId, path });
	},

	async renameFile(connectionId: string, fromPath: string, toPath: string): Promise<void> {
		await ws.http('ssh:sftp-rename', { connectionId, fromPath, toPath });
	},

	async chmodFile(connectionId: string, path: string, mode: number): Promise<void> {
		await ws.http('ssh:sftp-chmod', { connectionId, path, mode });
	},

	async deleteFile(connectionId: string, path: string, recursive: boolean): Promise<void> {
		await ws.http('ssh:sftp-delete', { connectionId, path, recursive });
	},

	async readFile(connectionId: string, path: string): Promise<SftpFileContent> {
		return (await ws.http('ssh:sftp-read', { connectionId, path })) as SftpFileContent;
	},

	async writeFile(connectionId: string, path: string, text: string): Promise<void> {
		await ws.http('ssh:sftp-write', { connectionId, path, text });
	},

	async loadDiskUsage(connectionId: string, path: string): Promise<SftpDiskUsage> {
		const usage = (await ws.http('ssh:sftp-disk-usage', { connectionId, path })) as SftpDiskUsage;
		state.diskUsage[connectionId] = usage;
		return usage;
	},

	async deleteFiles(connectionId: string, paths: string[], recursive: boolean): Promise<SftpBulkResult> {
		return (await ws.http('ssh:sftp-delete-many', { connectionId, paths, recursive })) as SftpBulkResult;
	},

	/**
	 * The names a copy or move would land on top of. Asked before the transfer
	 * runs so the user picks what happens, rather than reading about it after.
	 */
	async checkTransferConflicts(
		connectionId: string,
		paths: string[],
		destinationDirectory: string,
		operation: 'move' | 'copy'
	): Promise<SftpConflict[]> {
		return (await ws.http('ssh:sftp-check-conflicts', {
			connectionId,
			paths,
			destinationDirectory,
			operation
		})) as SftpConflict[];
	},

	async moveFiles(
		connectionId: string,
		paths: string[],
		destinationDirectory: string,
		onConflict: SftpConflictStrategy = 'skip'
	): Promise<SftpBulkResult> {
		return (await ws.http('ssh:sftp-move', {
			connectionId,
			paths,
			destinationDirectory,
			onConflict
		})) as SftpBulkResult;
	},

	async copyFiles(
		connectionId: string,
		paths: string[],
		destinationDirectory: string,
		onConflict: SftpConflictStrategy = 'skip'
	): Promise<SftpBulkResult> {
		return (await ws.http('ssh:sftp-copy', {
			connectionId,
			paths,
			destinationDirectory,
			onConflict
		})) as SftpBulkResult;
	},

	async compressFiles(
		connectionId: string,
		paths: string[],
		archivePath: string,
		format: SftpArchiveFormat,
		onConflict: SftpConflictStrategy = 'skip'
	): Promise<SftpCompressResult> {
		return (await ws.http('ssh:sftp-compress', {
			connectionId,
			paths,
			archivePath,
			format,
			onConflict
		})) as SftpCompressResult;
	},

	/** What an archive holds and what it would collide with, read before extracting. */
	async inspectArchive(
		connectionId: string,
		archivePath: string,
		destinationDirectory: string
	): Promise<SftpArchiveInfo> {
		return (await ws.http('ssh:sftp-inspect-archive', {
			connectionId,
			archivePath,
			destinationDirectory
		})) as SftpArchiveInfo;
	},

	async extractArchive(
		connectionId: string,
		archivePath: string,
		destinationDirectory: string,
		options: SftpExtractOptions = { mode: 'smart', onConflict: 'rename' }
	): Promise<SftpExtractResult> {
		return (await ws.http('ssh:sftp-extract', {
			connectionId,
			archivePath,
			destinationDirectory,
			mode: options.mode,
			folderName: options.folderName,
			onConflict: options.onConflict
		})) as SftpExtractResult;
	},

	// ── Port forwards ────────────────────────────────────────────────────

	async loadForwards(connectionId: string): Promise<SshForward[]> {
		const result = (await ws.http('ssh:forward-list', { connectionId })) as {
			forwards: SshForward[];
			statuses: SshForwardStatus[];
		};
		state.forwards[connectionId] = result.forwards;
		state.forwardStatuses[connectionId] = Object.fromEntries(
			result.statuses.map((status) => [status.id, status])
		);
		return result.forwards;
	},

	async createForward(connectionId: string, input: SshForwardInput): Promise<SshForward> {
		await ws.http('ssh:forward-create', { connectionId, input });
		const forwards = await this.loadForwards(connectionId);
		return forwards[forwards.length - 1];
	},

	async updateForward(
		connectionId: string,
		id: string,
		patch: Partial<SshForwardInput>
	): Promise<void> {
		await ws.http('ssh:forward-update', { id, patch });
		await this.loadForwards(connectionId);
	},

	async deleteForward(connectionId: string, id: string): Promise<void> {
		await ws.http('ssh:forward-delete', { id });
		await this.loadForwards(connectionId);
	},

	async startForward(connectionId: string, id: string): Promise<SshForwardStatus> {
		const status = (await ws.http('ssh:forward-start', { id })) as SshForwardStatus;
		state.forwardStatuses[connectionId] = {
			...(state.forwardStatuses[connectionId] ?? {}),
			[id]: status
		};
		return status;
	},

	async stopForward(connectionId: string, id: string): Promise<SshForwardStatus> {
		const status = (await ws.http('ssh:forward-stop', { id })) as SshForwardStatus;
		state.forwardStatuses[connectionId] = {
			...(state.forwardStatuses[connectionId] ?? {}),
			[id]: status
		};
		return status;
	}
};
