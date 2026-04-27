<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import DriverIcon from '../shared/DriverIcon.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { debug } from '$shared/utils/logger';
	import type { DbClientSchemaNode } from '$shared/types/db-client';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		connectionId: string;
		onContextMenu?: (e: MouseEvent, node: DbClientSchemaNode) => void;
		onBackToConnections?: () => void;
		onCreateTable?: (database?: string) => void;
	}

	const { connectionId, onContextMenu, onBackToConnections, onCreateTable }: Props = $props();

	let loading = $state(false);
	let error = $state<string | null>(null);
	let databases = $state<DbClientSchemaNode[]>([]);
	let currentDb = $state<string | null>(null);

	let createDbOpen = $state(false);
	let createDbName = $state('');
	let createDbError = $state<string | null>(null);
	let createDbSaving = $state(false);
	let createDbInputEl = $state<HTMLInputElement | null>(null);

	const connection = $derived(
		dbClientStore.connections.find((c) => c.id === connectionId) ?? null
	);
	const driver = $derived(connection?.driver);

	const useDatabaseTree = $derived(
		!!connection && !connection.database && (driver === 'mysql' || driver === 'postgres' || driver === 'mongodb')
	);

	const objects = $derived<DbClientSchemaNode[]>(dbClientStore.schema[connectionId] ?? []);

	const canCreateDatabase = $derived(driver === 'mysql' || driver === 'postgres');
	const canCreateTable = $derived(driver !== 'redis');

	$effect(() => {
		if (!connection) return;
		if (useDatabaseTree && currentDb === null) {
			loadDatabases();
		} else {
			loadObjects(useDatabaseTree ? currentDb ?? undefined : undefined);
		}
	});

	$effect(() => {
		if (createDbOpen && createDbInputEl) {
			createDbInputEl.focus();
		}
	});

	async function loadObjects(database?: string): Promise<void> {
		loading = true;
		error = null;
		try {
			await dbClientStore.refreshSchema(connectionId, { database });
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			debug.error('db-client', 'schema load failed:', e);
		} finally {
			loading = false;
		}
	}

	async function loadDatabases(): Promise<void> {
		loading = true;
		error = null;
		try {
			databases = await dbClientStore.listDatabases(connectionId);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			debug.error('db-client', 'list databases failed:', e);
		} finally {
			loading = false;
		}
	}

	function refresh(): void {
		if (useDatabaseTree && currentDb === null) {
			loadDatabases();
		} else {
			loadObjects(useDatabaseTree ? currentDb ?? undefined : undefined);
		}
	}

	function openDatabase(name: string): void {
		currentDb = name;
		dbClientStore.setActiveObject(connectionId, null);
	}

	function backToDatabases(): void {
		currentDb = null;
		dbClientStore.setActiveObject(connectionId, null);
	}

	function onObjectClick(node: DbClientSchemaNode, database?: string): void {
		if (node.type === 'table' || node.type === 'collection' || node.type === 'view' || node.type === 'key') {
			dbClientStore.setActiveObject(connectionId, {
				name: node.name,
				type: node.type,
				database
			});
			dbClientStore.setView(connectionId, 'data');
		}
	}

	function isActiveNode(name: string, database?: string): boolean {
		const view = dbClientStore.views[connectionId];
		const obj = view?.activeObject;
		if (!obj) return false;
		return obj.name === name && (obj.database ?? undefined) === (database ?? undefined);
	}

	function nodeIcon(node: DbClientSchemaNode): IconName {
		switch (node.type) {
			case 'database': return 'lucide:database';
			case 'schema': return 'lucide:folder';
			case 'view': return 'lucide:eye';
			case 'collection': return 'lucide:table';
			case 'index': return 'lucide:list-tree';
			case 'key': return 'lucide:table';
			default: return 'lucide:table';
		}
	}

	function openCreateDb(): void {
		createDbName = '';
		createDbError = null;
		createDbOpen = true;
	}

	function cancelCreateDb(): void {
		createDbOpen = false;
		createDbName = '';
		createDbError = null;
	}

	async function submitCreateDb(): Promise<void> {
		const name = createDbName.trim();
		if (!name) return;
		createDbSaving = true;
		createDbError = null;
		try {
			await dbClientStore.createDatabase(connectionId, name);
			createDbOpen = false;
			createDbName = '';
			await loadDatabases();
		} catch (e) {
			createDbError = e instanceof Error ? e.message : String(e);
		} finally {
			createDbSaving = false;
		}
	}

	const showingDatabases = $derived(useDatabaseTree && currentDb === null);
</script>

<div class="flex flex-col h-full min-h-0">
	<div class="flex items-center gap-2 px-3 py-2.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
		{#if useDatabaseTree && currentDb !== null}
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 transition-colors shrink-0"
				onclick={backToDatabases}
				aria-label="Back to databases"
				title="Back to databases"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
			</button>
		{:else if onBackToConnections}
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 transition-colors shrink-0"
				onclick={onBackToConnections}
				aria-label="Back to connections"
				title="Back to connections"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
			</button>
		{/if}
		{#if connection}
			<DriverIcon driver={connection.driver} class="w-4 h-4 shrink-0" />
			<span class="min-w-0 flex-1 text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
				{#if useDatabaseTree && currentDb !== null}
					{connection.name}<span class="ml-1.5">/ {currentDb}</span>
				{:else}
					{connection.name}
				{/if}
			</span>
		{/if}
		<div class="flex items-center gap-1.5 shrink-0">
			{#if showingDatabases && canCreateDatabase}
				<button
					type="button"
					class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 hover:bg-violet-500/10 hover:text-violet-600 transition-colors"
					onclick={openCreateDb}
					aria-label="New database"
					title="New database"
				>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</button>
			{:else if !showingDatabases && canCreateTable && onCreateTable}
				<button
					type="button"
					class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 hover:bg-violet-500/10 hover:text-violet-600 transition-colors"
					onclick={() => onCreateTable(currentDb ?? undefined)}
					aria-label="New table"
					title="New table"
				>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</button>
			{/if}
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 hover:bg-violet-500/10 hover:text-violet-600 transition-colors disabled:opacity-50"
				onclick={refresh}
				disabled={loading}
				aria-label="Refresh"
				title="Refresh"
			>
				<Icon name={loading ? 'lucide:loader' : 'lucide:refresh-cw'} class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" />
			</button>
		</div>
	</div>

	{#if createDbOpen}
		<div class="px-3 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 shrink-0">
			<div class="text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">New database</div>
			<div class="flex items-center gap-1.5">
				<input
					bind:this={createDbInputEl}
					type="text"
					bind:value={createDbName}
					placeholder="database_name"
					class="flex-1 min-w-0 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-violet-500 dark:focus:border-violet-500"
					onkeydown={(e) => {
						if (e.key === 'Enter') { e.preventDefault(); submitCreateDb(); }
						else if (e.key === 'Escape') { e.preventDefault(); cancelCreateDb(); }
					}}
				/>
				<button
					type="button"
					class="flex items-center justify-center w-8 h-8 rounded-md bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 transition-colors shrink-0"
					onclick={submitCreateDb}
					disabled={!createDbName.trim() || createDbSaving}
					title="Create"
				>
					{#if createDbSaving}
						<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin" />
					{:else}
						<Icon name="lucide:check" class="w-3.5 h-3.5" />
					{/if}
				</button>
				<button
					type="button"
					class="flex items-center justify-center w-8 h-8 rounded-md text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors shrink-0"
					onclick={cancelCreateDb}
					title="Cancel"
				>
					<Icon name="lucide:x" class="w-3.5 h-3.5" />
				</button>
			</div>
			{#if createDbError}
				<div class="mt-1.5 text-xs text-red-600 dark:text-red-400">{createDbError}</div>
			{/if}
		</div>
	{/if}

	<div class="flex-1 min-h-0 overflow-y-auto p-1">
		{#if error}
			<div class="px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</div>
		{:else if showingDatabases}
			{#each databases as db (db.name)}
				<button
					type="button"
					class="flex items-center gap-2 w-full px-2.5 py-1.5 rounded text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300"
					onclick={() => openDatabase(db.name)}
					oncontextmenu={(e) => { e.preventDefault(); onContextMenu?.(e, db); }}
				>
					<Icon name="lucide:database" class="w-4 h-4 text-slate-400 shrink-0" />
					<span class="truncate">{db.name}</span>
				</button>
			{:else}
				{#if !loading}
					<div class="px-3 py-2 text-sm text-slate-400">No databases</div>
				{/if}
			{/each}
		{:else}
			{#each objects as node (node.name)}
				<button
					type="button"
					class="flex items-center gap-2 w-full px-2.5 py-1.5 rounded text-left text-sm {isActiveNode(node.name, currentDb ?? undefined)
						? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
						: 'hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'}"
					onclick={() => onObjectClick(node, currentDb ?? undefined)}
					oncontextmenu={(e) => { e.preventDefault(); onContextMenu?.(e, currentDb ? { ...node, meta: { ...node.meta, database: currentDb } } : node); }}
				>
					<Icon name={nodeIcon(node)} class="w-4 h-4 text-slate-400 shrink-0" />
					<span class="truncate">{node.name}</span>
				</button>
			{:else}
				{#if !loading}
					<div class="px-3 py-2 text-sm text-slate-400">No objects</div>
				{/if}
			{/each}
		{/if}
	</div>
</div>
