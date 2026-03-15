<script lang="ts">
	import { fade, scale, slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { tick } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ConnectionForm from './ConnectionForm.svelte';
	import SchemaExplorer from './SchemaExplorer.svelte';
	import QueryPanel from './QueryPanel.svelte';
	import TableArchitectModal from './TableArchitectModal.svelte';
	import ERDDiagram from './ERDDiagram.svelte';
	import BackupPanel from './BackupPanel.svelte';
	import ProcessManagerPanel from './ProcessManagerPanel.svelte';
	import HealthDashboardPanel from './HealthDashboardPanel.svelte';
	import DataGeneratorModal from './DataGeneratorModal.svelte';
	import DiffPanel from './DiffPanel.svelte';
	import SqlRestApiPanel from './SqlRestApiPanel.svelte';
	import TabBar from './TabBar.svelte';
	import QuickTableSearch from './QuickTableSearch.svelte';
	import ShortcutGuideModal from './ShortcutGuideModal.svelte';
	import type { DBConnectionConfig } from '$shared/types/db-manager';
	import { DB_TYPE_LABELS, DB_TYPE_COLORS, DB_SUPPORT } from '$shared/types/db-manager';
	import { ALTER_SUPPORTED_TYPES } from '$shared/types/alter-table';
	import {
		dbManagerState,
		dbUiState,
		getActiveConnection,
		loadConnections,
		deleteConnection,
		openConnectionTab,
		openNewTabForConnection,
		switchToTab,
		closeTab,
		selectTable,
		resetTestResult
	} from '$frontend/stores/features/db-manager.svelte';
	import {
		dbErdState,
		loadERDMetadata,
		resetERD
	} from '$frontend/stores/features/db-erd.svelte';
	import {
		dbBackupState,
		openBackupPanel,
		loadBackupConfigs
	} from '$frontend/stores/features/db-backup.svelte';
	import {
		processManagerState,
		openProcessManager,
		closeProcessManager
	} from '$frontend/stores/features/db-process-manager.svelte';
	import { dbDiffState, resetDiff } from '$frontend/stores/features/db-diff.svelte';
	import { fetchEndpoints } from '$frontend/stores/features/db-sql-rest-api.svelte';
	import {
		dbHealthState,
		openHealthDashboard,
		closeHealthDashboard
	} from '$frontend/stores/features/db-health.svelte';
	import {
		dbGlobalSearchState,
		openGlobalSearch,
		closeGlobalSearch
	} from '$frontend/stores/features/db-global-search.svelte';
	import GlobalSearchPanel from './GlobalSearchPanel.svelte';
	import SchemaVersionPanel from './SchemaVersionPanel.svelte';
	import {
		dbSchemaVersionState,
		closeVersionHistory
	} from '$frontend/stores/features/db-schema-versioning.svelte';

	const activeConnection = $derived(getActiveConnection());

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	type RightPanel = 'empty' | 'new-connection' | 'edit-connection' | 'connected' | 'diff';

	let rightPanel = $state<RightPanel>('empty');
	let editingConnection = $state<DBConnectionConfig | null>(null);
	let showDeleteConfirm = $state<string | null>(null);
	let showERD = $state(false);
	let showRestApi = $state(false);

	// Reference to QueryPanel — used to trigger query execution, explain, and editor focus
	let queryPanelRef: { focusEditor: () => void; runQuery: () => Promise<void>; explainQuery: () => Promise<void> } | undefined = $state();

	// ERD is only available for SQL databases with FK support
	const supportsERD = $derived(
		activeConnection ? ALTER_SUPPORTED_TYPES.includes(activeConnection.type) : false
	);

	// When modal opens, load connections
	$effect(() => {
		if (isOpen) {
			loadConnections();
		}
	});

	// When an active tab exists, show connected view; clear it when no tabs remain
	$effect(() => {
		if (dbManagerState.activeTabId) {
			if (!['new-connection', 'edit-connection', 'diff'].includes(rightPanel)) {
				rightPanel = 'connected';
			}
			if (dbManagerState.activeConnectionId) {
				loadBackupConfigs(dbManagerState.activeConnectionId);
			}
		} else if (rightPanel === 'connected') {
			rightPanel = 'empty';
		}
	});

	/**
	 * Core shortcut dispatcher — called from both the inner modal div and the window listener.
	 * Returns true if a shortcut was handled so callers can decide whether to stop propagation.
	 */
	async function processShortcuts(e: KeyboardEvent): Promise<boolean> {
		if (!isOpen) return false;

		const isMod = e.ctrlKey || e.metaKey;

		// ── Escape: close overlays in reverse order ──────────────────────────
		if (e.key === 'Escape') {
			if (dbUiState.showQuickSearch) { dbUiState.showQuickSearch = false; return true; }
			if (dbUiState.showShortcutGuide) { dbUiState.showShortcutGuide = false; return true; }
			onClose();
			return true;
		}

		// ── Cmd/Ctrl+P: Quick Table Search ───────────────────────────────────
		// When Monaco is focused it fires the command handler in SqlEditor directly;
		// this branch covers all other focus contexts inside the modal.
		if (isMod && e.key === 'p') {
			e.preventDefault();
			dbUiState.showQuickSearch = !dbUiState.showQuickSearch;
			return true;
		}

		// ── Cmd/Ctrl+(Shift+)Enter: Execute / Explain active query ───────────────
		// Monaco handles these via addCommand when the editor is focused; this covers other focus contexts.
		if (isMod && e.key === 'Enter') {
			const target = e.target as HTMLElement;
			const isMonacoInput = target.classList.contains('inputarea');
			if (!isMonacoInput && dbManagerState.activeConnectionId && dbManagerState.activeTab === 'query') {
				e.preventDefault();
				if (e.shiftKey) {
					await queryPanelRef?.explainQuery();
				} else if (!dbManagerState.isLoadingQuery) {
					await queryPanelRef?.runQuery();
				}
			}
			return true;
		}

		// ── Cmd/Ctrl+I: Toggle ERD diagram ────────────────────────────────────
		if (isMod && !e.shiftKey && e.key === 'i') {
			if (rightPanel === 'connected' && supportsERD) {
				e.preventDefault();
				if (showERD) { showERD = false; } else { await handleShowERD(); }
				return true;
			}
		}

		// ── Cmd/Ctrl+Shift+F: Toggle Global Search ────────────────────────────
		if (isMod && e.shiftKey && e.key === 'F') {
			if (rightPanel === 'connected' && dbManagerState.activeConnectionId) {
				e.preventDefault();
				dbGlobalSearchState.isOpen ? closeGlobalSearch() : openGlobalSearch();
				return true;
			}
		}

		// ── Cmd/Ctrl+Shift+H: Toggle Health Dashboard ─────────────────────────
		if (isMod && e.shiftKey && e.key === 'H') {
			if (rightPanel === 'connected' && dbManagerState.activeConnectionId) {
				e.preventDefault();
				if (dbHealthState.isOpen) { closeHealthDashboard(); }
				else { openHealthDashboard(dbManagerState.activeConnectionId); }
				return true;
			}
		}

		// ── Cmd/Ctrl+Shift+M: Toggle Process Manager ──────────────────────────
		if (isMod && e.shiftKey && e.key === 'M') {
			if (rightPanel === 'connected' && dbManagerState.activeConnectionId) {
				e.preventDefault();
				if (processManagerState.isOpen) { closeProcessManager(); }
				else { openProcessManager(dbManagerState.activeConnectionId); }
				return true;
			}
		}

		// ── Cmd/Ctrl+Shift+B: Toggle Backup Panel ─────────────────────────────
		if (isMod && e.shiftKey && e.key === 'B') {
			if (rightPanel === 'connected' && dbManagerState.activeConnectionId) {
				e.preventDefault();
				if (dbBackupState.isOpen) { dbBackupState.isOpen = false; }
				else { openBackupPanel(); }
				return true;
			}
		}

		// ── Cmd/Ctrl+Shift+R: Toggle REST API Generator ───────────────────────
		if (isMod && e.shiftKey && e.key === 'R') {
			if (rightPanel === 'connected' && dbManagerState.activeConnectionId) {
				e.preventDefault();
				showRestApi = !showRestApi;
				if (showRestApi) { fetchEndpoints(dbManagerState.activeConnectionId); }
				return true;
			}
		}

		// ── Cmd/Ctrl+1–9: Switch connection by index ─────────────────────────
		if (isMod && /^[1-9]$/.test(e.key)) {
			const idx = parseInt(e.key) - 1;
			const conn = dbManagerState.connections[idx];
			if (conn) {
				e.preventDefault();
				await handleSelectConnection(conn);
				// Restore focus to the SQL editor after the DOM update + Monaco init
				await tick();
				setTimeout(() => queryPanelRef?.focusEditor(), 250);
			}
			return true;
		}

		// ── ?: Toggle shortcut guide (outside editable contexts) ─────────────
		if (e.key === '?' && !isMod && !e.altKey) {
			const target = e.target as HTMLElement;
			const isEditable =
				target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				target.isContentEditable ||
				target.closest('.monaco-editor') !== null;
			if (!isEditable) {
				e.preventDefault();
				dbUiState.showShortcutGuide = !dbUiState.showShortcutGuide;
				return true;
			}
		}

		return false;
	}

	/**
	 * Handler attached to the inner modal container.
	 * Processes shortcuts then stops propagation so shortcuts don't leak to the host app.
	 */
	async function handleModalKeydown(e: KeyboardEvent): Promise<void> {
		await processShortcuts(e);
		e.stopPropagation();
	}

	/**
	 * Window-level handler — fires when focus is on the backdrop or completely outside
	 * the modal inner content (e.g., on a browser chrome element that somehow sends events).
	 */
	async function handleWindowKeydown(e: KeyboardEvent): Promise<void> {
		// Guard: only act when modal is open and event didn't originate inside the modal
		// (inner modal div's stopPropagation prevents those from reaching the window).
		if (!isOpen) return;
		await processShortcuts(e);
	}

	function handleNewConnection() {
		resetTestResult();
		editingConnection = null;
		rightPanel = 'new-connection';
	}

	function handleEditConnection(conn: DBConnectionConfig, e: MouseEvent) {
		e.stopPropagation();
		resetTestResult();
		editingConnection = conn;
		rightPanel = 'edit-connection';
	}

	function handleConnectionSaved(conn: DBConnectionConfig) {
		rightPanel = 'empty';
		editingConnection = null;
	}

	async function handleSelectConnection(conn: DBConnectionConfig) {
		editingConnection = null;
		resetTestResult();
		showERD = false;
		resetERD();
		await openConnectionTab(conn.id);
		rightPanel = "connected";
	}

	async function handleShowERD() {
		if (!activeConnection) return;
		showERD = true;
		await loadERDMetadata(activeConnection.id);
	}

	function handleERDTableClick(tableName: string, schema?: string) {
		showERD = false;
		selectTable(tableName, schema);
	}

	async function handleDeleteConnection(id: string) {
		await deleteConnection(id);
		showDeleteConfirm = null;
		if (rightPanel === 'edit-connection' && editingConnection?.id === id) {
			rightPanel = 'empty';
			editingConnection = null;
		}
	}

	function getConnectionLabel(conn: DBConnectionConfig): string {
		if (conn.type === 'sqlite') return conn.path ? conn.path.split(/[\\/]/).pop() ?? conn.path : '';
		return [conn.host, conn.database].filter(Boolean).join(' / ');
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<!-- Table Architect modal (rendered outside the main modal to avoid stacking context issues) -->
<TableArchitectModal onApplied={() => {}} />

{#if isOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-[100] flex items-center justify-center md:p-4 bg-black/60 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-label="Database Manager"
		tabindex="-1"
		onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
		in:fade={{ duration: 200, easing: cubicOut }}
		out:fade={{ duration: 150, easing: cubicOut }}
	>
		<!-- Modal -->
		<div
			class="flex flex-col w-full max-w-[1100px] h-[88dvh] max-h-[780px] bg-slate-50 dark:bg-slate-950 border border-violet-500/20 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.4)] max-md:max-w-full max-md:h-dvh max-md:max-h-dvh max-md:rounded-none"
			role="dialog"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={handleModalKeydown}
			in:scale={{ duration: 250, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
		>
			<div class="flex flex-1 min-h-0">
				<!-- ─── Left Sidebar: Connections ─────────────────────── -->
				<aside class="flex flex-col w-60 shrink-0 bg-white dark:bg-slate-900/98 border-r border-slate-200 dark:border-slate-800">
					<!-- Sidebar header -->
					<header class="flex items-center justify-between py-4 px-4 border-b border-slate-200 dark:border-slate-800">
						<div class="flex items-center gap-2.5">
							<div class="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center">
								<Icon name="lucide:database" class="w-4 h-4 text-violet-600" />
							</div>
							<span class="text-sm font-bold text-slate-900 dark:text-slate-100">Database Manager</span>
						</div>
						<div class="flex items-center gap-0.5">
							<button
								type="button"
								class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10 transition-all"
								onclick={() => (dbUiState.showShortcutGuide = true)}
								aria-label="Keyboard shortcuts (?)"
								title="Keyboard shortcuts (?)"
							>
								<Icon name="lucide:keyboard" class="w-4 h-4" />
							</button>
							<button
								type="button"
								class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-violet-500/10 transition-all"
								onclick={onClose}
								aria-label="Close"
							>
								<Icon name="lucide:x" class="w-4 h-4" />
							</button>
						</div>
					</header>

					<!-- Connection list -->
					<nav class="flex-1 overflow-y-auto p-2">
						{#if dbManagerState.isLoadingConnections}
							<div class="flex items-center justify-center py-6 text-slate-400 text-xs gap-2">
								<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
									<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
									<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
								</svg>
								Loading...
							</div>
						{:else if dbManagerState.connections.length === 0}
							<div class="flex flex-col items-center justify-center py-8 gap-3 text-center">
								<Icon name="lucide:database" class="w-8 h-8 text-slate-300 dark:text-slate-700" />
								<p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed px-2">
									No connections yet.<br/>Add your first database connection.
								</p>
							</div>
						{:else}
							{#each dbManagerState.connections as conn (conn.id)}
								{@const isActive = dbManagerState.activeConnectionId === conn.id}
								{@const tabCount = dbManagerState.tabs.filter(t => t.connectionId === conn.id).length}
								{@const typeColor = DB_TYPE_COLORS[conn.type]}
								<div
									class="flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all duration-100 group relative mb-0.5
										{isActive
											? 'bg-violet-500/10 dark:bg-violet-500/15'
											: 'hover:bg-slate-100 dark:hover:bg-slate-800/60'}"
									role="button"
									tabindex="0"
									onclick={() => handleSelectConnection(conn)}
									onkeydown={(e) => e.key === 'Enter' && handleSelectConnection(conn)}
								>
									<!-- Type dot -->
									<div
										class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
										style="background-color: {typeColor}18"
									>
										<span style="color: {typeColor}"><Icon name="lucide:database" class="w-3.5 h-3.5" /></span>
									</div>

									<!-- Connection info -->
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-1.5">
											<span class="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">
												{conn.name}
											</span>
											{#if isActive}
												<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>
											{/if}
											{#if tabCount > 0}
												<span class="ml-auto shrink-0 min-w-[16px] h-4 px-1 rounded-full text-3xs font-bold flex items-center justify-center" style="background-color: {dbManagerState.tabs.find(t => t.connectionId === conn.id)?.color ?? '#8b5cf6'}22; color: {dbManagerState.tabs.find(t => t.connectionId === conn.id)?.color ?? '#8b5cf6'}">{tabCount}</span>
											{/if}
										</div>
										<span class="text-3xs text-slate-400 dark:text-slate-500 truncate block">
											{DB_TYPE_LABELS[conn.type]}{getConnectionLabel(conn) ? ' · ' + getConnectionLabel(conn) : ''}
										</span>
									</div>

									<!-- Actions (show on hover) -->
									<div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
										<button
											type="button"
											class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10 transition-all"
											onclick={(e) => { e.stopPropagation(); openNewTabForConnection(conn.id); }}
											title="Open in new tab"
										>
											<Icon name="lucide:panel-right-open" class="w-3 h-3" />
										</button>
										<button
											type="button"
											class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
											onclick={(e) => handleEditConnection(conn, e)}
											title="Edit"
										>
											<Icon name="lucide:pencil" class="w-3 h-3" />
										</button>
										<button
											type="button"
											class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-all"
											onclick={(e) => { e.stopPropagation(); showDeleteConfirm = conn.id; }}
											title="Delete"
										>
											<Icon name="lucide:trash-2" class="w-3 h-3" />
										</button>
									</div>

									<!-- Delete confirm popover -->
									{#if showDeleteConfirm === conn.id}
										<div
											class="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg p-3 w-44"
											onclick={(e) => e.stopPropagation()}
										>
											<p class="text-xs text-slate-700 dark:text-slate-300 mb-2 font-medium">Delete this connection?</p>
											<div class="flex items-center gap-1.5">
												<button
													type="button"
													class="flex-1 py-1.5 text-xs text-white bg-red-500 hover:bg-red-600 rounded-md transition-colors"
													onclick={() => handleDeleteConnection(conn.id)}
												>
													Delete
												</button>
												<button
													type="button"
													class="flex-1 py-1.5 text-xs text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-md transition-colors"
													onclick={() => (showDeleteConfirm = null)}
												>
													Cancel
												</button>
											</div>
										</div>
									{/if}
								</div>
							{/each}
						{/if}
					</nav>

					<!-- Add connection + Diff buttons -->
					<footer class="p-3 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-1.5">
						<button
							type="button"
							class="flex items-center gap-2 w-full py-2.5 px-3 rounded-lg text-sm font-medium transition-all duration-150
								{rightPanel === 'new-connection'
									? 'bg-violet-600 text-white'
									: 'bg-violet-500/10 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300 hover:bg-violet-500/20 dark:hover:bg-violet-500/25 border border-violet-500/20'}"
							onclick={handleNewConnection}
						>
							<Icon name="lucide:plus" class="w-4 h-4" />
							New Connection
						</button>
						<button
							type="button"
							class="flex items-center gap-2 w-full py-2 px-3 rounded-lg text-xs font-medium transition-all duration-150
								{rightPanel === 'diff'
									? 'bg-violet-600 text-white'
									: 'text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10'}"
							onclick={() => {
								resetDiff();
								rightPanel = 'diff';
							}}
						>
							<Icon name="lucide:git-compare" class="w-4 h-4" />
							Schema Diff
						</button>
					</footer>
				</aside>

				<!-- ─── Right Panel ──────────────────────────────────── -->
				<div class="flex flex-1 min-w-0 min-h-0">
					{#if rightPanel === 'empty'}
						<!-- Empty state -->
						<div class="flex flex-col items-center justify-center flex-1 gap-4 p-8 text-center">
							<div class="w-16 h-16 rounded-2xl bg-violet-500/10 flex items-center justify-center">
								<Icon name="lucide:database" class="w-8 h-8 text-violet-500/60" />
							</div>
							<div>
								<h3 class="text-base font-semibold text-slate-700 dark:text-slate-300">Database Manager</h3>
								<p class="text-sm text-slate-400 dark:text-slate-500 mt-1 max-w-xs">
									Select a connection to browse tables and run queries, or create a new connection.
								</p>
							</div>
							<button
								type="button"
								class="flex items-center gap-2 px-4 py-2.5 bg-violet-600 hover:bg-violet-700 rounded-lg text-sm font-medium text-white transition-all"
								onclick={handleNewConnection}
							>
								<Icon name="lucide:plus" class="w-4 h-4" />
								Add Connection
							</button>
						</div>

					{:else if rightPanel === 'new-connection' || rightPanel === 'edit-connection'}
						<!-- Connection form -->
						<div class="flex-1 overflow-hidden">
							<ConnectionForm
								connection={rightPanel === 'edit-connection' ? editingConnection : null}
								onSaved={handleConnectionSaved}
								onCancel={() => {
									rightPanel = dbManagerState.activeTabId ? 'connected' : 'empty';
									editingConnection = null;
									resetTestResult();
								}}
							/>
						</div>

					{:else if rightPanel === 'connected'}
						<!-- Connected: Tab bar + lazy-rendered active-tab session (lazy loading) -->
						<div class="flex flex-1 min-w-0 min-h-0 flex-col">
							<!-- Persistent tab bar - only the active tab DOM is rendered below -->
							<TabBar />

							{#if activeConnection}
							<!-- Connection info bar for the active tab -->
							<div class="flex items-center gap-2.5 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-slate-50/40 dark:bg-slate-900/30">
								<div
									class="w-2 h-2 rounded-full"
									style="background-color: {DB_TYPE_COLORS[activeConnection.type]}"
								></div>
								<span class="text-xs font-semibold text-slate-700 dark:text-slate-300">
									{activeConnection.name}
								</span>
								<span class="text-xs text-slate-400 dark:text-slate-500">
									{DB_TYPE_LABELS[activeConnection.type]}
									{#if getConnectionLabel(activeConnection)}
										· {getConnectionLabel(activeConnection)}
									{/if}
								</span>
								{#if DB_SUPPORT[activeConnection.type] !== 'full'}
									<span class="ml-1 px-1.5 py-0.5 text-3xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded">
										Config only
									</span>
								{/if}
								<div class="flex-1"></div>
								<!-- ERD toggle (SQL databases only) -->
								{#if supportsERD}
									<button
										type="button"
										class="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all
											{showERD
												? 'bg-violet-600 text-white'
												: 'text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10'}"
										onclick={showERD ? () => (showERD = false) : handleShowERD}
										title={showERD ? 'Close ERD view' : 'Show Entity Relationship Diagram'}
									>
										<Icon name="lucide:share-2" class="w-3.5 h-3.5" />
										ERD
									</button>
								{/if}
								<!-- Process Manager button -->
								<button
									type="button"
									class="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all
										{processManagerState.isOpen
											? 'bg-violet-600 text-white'
											: 'text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10'}"
									onclick={() => {
										if (processManagerState.isOpen) {
											closeProcessManager();
										} else if (dbManagerState.activeConnectionId) {
											openProcessManager(dbManagerState.activeConnectionId);
										}
									}}
									title="Process Manager — monitor and kill active sessions"
								>
									<Icon name="lucide:activity" class="w-3.5 h-3.5" />
									Processes
								</button>

								<!-- Backup button -->
								<button
									type="button"
									class="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all
										{dbBackupState.isOpen
											? 'bg-violet-600 text-white'
											: 'text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10'}"
									onclick={openBackupPanel}
									title="Automated Backups"
								>
									<Icon name="lucide:shield-check" class="w-3.5 h-3.5" />
									Backup
								</button>

								<!-- REST API button -->
								<button
									type="button"
									class="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all
										{showRestApi
											? 'bg-violet-600 text-white'
											: 'text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10'}"
									onclick={() => {
										showRestApi = !showRestApi;
										if (showRestApi && dbManagerState.activeConnectionId) {
											fetchEndpoints(dbManagerState.activeConnectionId);
										}
									}}
									title="SQL-to-REST API Generator"
								>
									<Icon name="lucide:cable" class="w-3.5 h-3.5" />
									REST API
								</button>

								<!-- Health Dashboard button -->
								<button
									type="button"
									class="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all
										{dbHealthState.isOpen
											? 'bg-violet-600 text-white'
											: 'text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10'}"
									onclick={() => {
										if (dbHealthState.isOpen) {
											closeHealthDashboard();
										} else if (dbManagerState.activeConnectionId) {
											openHealthDashboard(dbManagerState.activeConnectionId);
										}
									}}
									title="Database Health Dashboard"
								>
									<Icon name="lucide:heart-pulse" class="w-3.5 h-3.5" />
									Health
								</button>

								<!-- Global Search button -->
								<button
									type="button"
									class="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all
										{dbGlobalSearchState.isOpen
											? 'bg-violet-600 text-white'
											: 'text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10'}"
									onclick={() => {
										if (dbGlobalSearchState.isOpen) {
											closeGlobalSearch();
										} else {
											openGlobalSearch();
										}
									}}
									title="Global Database Search — find values across all tables"
								>
									<Icon name="lucide:search" class="w-3.5 h-3.5" />
									Search
								</button>

								<button
									type="button"
									class="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors ml-1"
									onclick={(e) => activeConnection && handleEditConnection(activeConnection, e)}
								>
									<Icon name="lucide:settings-2" class="w-3.5 h-3.5" />
								</button>
							</div>

							<!-- ERD view or normal Schema+Query view -->
							{#if showERD}
								<div class="flex-1 min-h-0 overflow-hidden">
									{#if dbErdState.isLoading}
										<div class="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
											<svg class="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24">
												<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
												<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
											</svg>
											<span class="text-sm">Loading schema…</span>
										</div>
									{:else if dbErdState.metadata}
										{#if dbErdState.metadata.tables.length === 0}
											<div class="flex flex-col items-center justify-center h-full gap-3 text-slate-400 text-sm">
												<Icon name="lucide:table-2" class="w-8 h-8 opacity-30" />
												<span>No tables found</span>
											</div>
										{:else}
											<ERDDiagram
												metadata={dbErdState.metadata}
												onTableClick={handleERDTableClick}
											/>
										{/if}
									{:else}
										<div class="flex flex-col items-center justify-center h-full gap-3 text-slate-400 text-sm">
											<Icon name="lucide:share-2" class="w-8 h-8 opacity-30" />
											<span>Failed to load ERD</span>
											<button
												type="button"
												class="text-xs text-violet-600 dark:text-violet-400 hover:underline"
												onclick={handleShowERD}
											>Retry</button>
										</div>
									{/if}
								</div>
							{:else}
								<!-- Normal: schema tree + query/browse panel -->
								<div class="flex flex-1 min-w-0 min-h-0">
									<div class="w-48 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
										<SchemaExplorer />
									</div>
									<div class="flex-1 min-w-0 min-h-0 flex flex-col bg-white dark:bg-slate-950/80">
										<QueryPanel bind:this={queryPanelRef} />
									</div>
								</div>
							{/if}
						{:else}
							<!-- Connection was removed while tab is open -->
							<div class="flex flex-col items-center justify-center flex-1 gap-3 p-8 text-center">
								<p class="text-sm text-slate-400 dark:text-slate-500">Connection no longer available.</p>
								<button type="button" class="text-xs text-violet-600 dark:text-violet-400 hover:underline" onclick={() => closeTab(dbManagerState.activeTabId!)}>Close tab</button>
							</div>
						{/if}
						</div>

					{:else if rightPanel === 'diff'}
						<!-- Diff panel -->
						<div class="flex flex-1 min-w-0 min-h-0 bg-white dark:bg-slate-950/80">
							<DiffPanel connections={dbManagerState.connections} />
						</div>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}

{#if isOpen && dbUiState.showQuickSearch}
	<QuickTableSearch onClose={() => (dbUiState.showQuickSearch = false)} />
{/if}

{#if isOpen && dbUiState.showShortcutGuide}
	<ShortcutGuideModal onClose={() => (dbUiState.showShortcutGuide = false)} />
{/if}

{#if dbBackupState.isOpen && dbManagerState.activeConnectionId}
	<BackupPanel connectionId={dbManagerState.activeConnectionId} />
{/if}

<ProcessManagerPanel />

<HealthDashboardPanel />

<DataGeneratorModal />

{#if dbGlobalSearchState.isOpen && dbManagerState.activeConnectionId}
	<GlobalSearchPanel connectionId={dbManagerState.activeConnectionId} />
{/if}

{#if dbSchemaVersionState.isOpen && dbManagerState.activeConnectionId && dbManagerState.activeTableName}
	<div
		class="fixed inset-0 z-[200] flex items-start justify-end p-4"
		in:fade={{ duration: 150 }}
		out:fade={{ duration: 100 }}
	>
		<!-- Backdrop -->
		<div
			class="absolute inset-0 bg-black/30 backdrop-blur-sm"
			onclick={closeVersionHistory}
			onkeydown={(e) => e.key === 'Escape' && closeVersionHistory()}
			role="button"
			tabindex="0"
			aria-label="Close schema version history"
		></div>

		<!-- Panel -->
		<div
			class="relative z-10 w-full max-w-sm h-full max-h-[calc(100dvh-2rem)] flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl overflow-hidden"
			in:slide={{ duration: 200, axis: 'x' }}
			out:slide={{ duration: 150, axis: 'x' }}
		>
			<SchemaVersionPanel
				connectionId={dbManagerState.activeConnectionId}
				tableName={dbManagerState.activeTableName}
				onRollbackSuccess={() => {}}
			/>
		</div>
	</div>
{/if}

{#if showRestApi && dbManagerState.activeConnectionId}
	<div
		class="fixed inset-0 z-[200] flex items-start justify-end p-4"
		in:fade={{ duration: 150 }}
		out:fade={{ duration: 100 }}
	>
		<!-- Backdrop -->
		<div
			class="absolute inset-0 bg-black/30 backdrop-blur-sm"
			onclick={() => (showRestApi = false)}
			onkeydown={(e) => e.key === 'Escape' && (showRestApi = false)}
			role="button"
			tabindex="0"
			aria-label="Close REST API panel"
		></div>

		<!-- Panel -->
		<div
			class="relative z-10 w-full max-w-lg h-full max-h-[calc(100dvh-2rem)] flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl overflow-hidden"
			in:slide={{ duration: 200, axis: 'x' }}
			out:slide={{ duration: 150, axis: 'x' }}
		>
			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<div class="flex items-center gap-2.5">
					<div class="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center">
						<Icon name="lucide:cable" class="w-4 h-4 text-violet-600" />
					</div>
					<h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">REST API Generator</h2>
				</div>
				<button
					type="button"
					onclick={() => (showRestApi = false)}
					class="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>
			<!-- Panel content -->
			<div class="flex-1 min-h-0">
				<SqlRestApiPanel connectionId={dbManagerState.activeConnectionId} />
			</div>
		</div>
	</div>
{/if}
