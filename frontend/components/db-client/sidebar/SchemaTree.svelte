<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import DriverIcon from '../shared/DriverIcon.svelte';
	import { focusAndSelect } from '$frontend/utils/focus-and-select';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { debug } from '$shared/utils/logger';
	import type { DbClientSchemaNode } from '$shared/types/db-client';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		connectionId: string;
		onContextMenu?: (e: MouseEvent, node: DbClientSchemaNode) => void;
		onScopeMenu?: (e: MouseEvent) => void;
		onBackToConnections?: () => void;
		onCreateTable?: (database?: string) => void;
		onCreateView?: (database?: string) => void;
		onCreateFunction?: (database?: string) => void;
		onCreateProcedure?: (database?: string) => void;
	}

	const {
		connectionId,
		onContextMenu,
		onScopeMenu,
		onBackToConnections,
		onCreateTable,
		onCreateView,
		onCreateFunction,
		onCreateProcedure
	}: Props = $props();

	let loading = $state(false);
	let error = $state<string | null>(null);
	let databases = $state<DbClientSchemaNode[]>([]);
	const currentDb = $derived(dbClientStore.openedDatabase[connectionId] ?? null);

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
		!!connection && !connection.database && (driver === 'mysql' || driver === 'postgres' || driver === 'mongodb' || driver === 'mssql')
	);

	const objects = $derived<DbClientSchemaNode[]>(dbClientStore.schema[connectionId] ?? []);

	const canCreateDatabase = $derived(driver === 'mysql' || driver === 'postgres' || driver === 'mssql');
	const canCreateTable = $derived(driver !== 'redis');

	$effect(() => {
		dbClientStore.schemaNonce;
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
		dbClientStore.setOpenedDatabase(connectionId, name);
		dbClientStore.setActiveObject(connectionId, null);
	}

	function backToDatabases(): void {
		dbClientStore.setOpenedDatabase(connectionId, null);
		dbClientStore.setActiveObject(connectionId, null);
	}

	function onObjectClick(node: DbClientSchemaNode, database?: string): void {
		if (
			node.type === 'table' ||
			node.type === 'collection' ||
			node.type === 'view' ||
			node.type === 'key' ||
			node.type === 'function' ||
			node.type === 'procedure'
		) {
			const isRoutine = node.type === 'function' || node.type === 'procedure';
			dbClientStore.openTable(
				connectionId,
				{
					name: node.name,
					type: node.type,
					database
				},
				isRoutine ? 'structure' : 'data',
				{ remember: true }
			);
		}
	}

	function isActiveNode(name: string, database?: string): boolean {
		const v = dbClientStore.views[connectionId];
		const obj = v?.activeObject;
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
			case 'function': return 'lucide:code';
			case 'procedure': return 'lucide:terminal';
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

	let searchQuery = $state('');
	let isObjectSearchOpen = $state(false);

	const filteredDatabases = $derived(
		searchQuery.trim()
			? databases.filter((db) => db.name.toLowerCase().includes(searchQuery.toLowerCase().trim()))
			: databases
	);

	const filteredObjects = $derived(
		searchQuery.trim()
			? objects.filter((node) => node.name.toLowerCase().includes(searchQuery.toLowerCase().trim()))
			: objects
	);

	let expandedFolders = $state<Record<string, boolean>>({
		tables: true,
		views: true,
		functions: true,
		procedures: true
	});

	// Per-folder search (used when DB has multiple object categories)
	let folderSearchQueries = $state<Record<string, string>>({
		tables: '',
		views: '',
		functions: '',
		procedures: ''
	});
	let isFolderSearchOpen = $state<Record<string, boolean>>({
		tables: false,
		views: false,
		functions: false,
		procedures: false
	});

	// Raw (unfiltered) lists by type. The store dedupes (type, name) pairs so
	// keyed {#each} blocks below never see duplicate names.
	const rawTables = $derived(objects.filter((n) => n.type === 'table' || n.type === 'collection'));
	const rawViews = $derived(objects.filter((n) => n.type === 'view'));
	const rawFunctions = $derived(objects.filter((n) => n.type === 'function'));
	const rawProcedures = $derived(objects.filter((n) => n.type === 'procedure'));

	// True when schema has more than just tables (views, functions, or procedures exist)
	const hasMultipleFolders = $derived(
		rawViews.length > 0 || rawFunctions.length > 0 || rawProcedures.length > 0
	);

	// When hasMultipleFolders: filter per-folder using folder search queries
	// When flat: filter everything with the shared searchQuery
	const tablesList = $derived(
		hasMultipleFolders
			? (folderSearchQueries.tables.trim()
				? rawTables.filter((n) => n.name.toLowerCase().includes(folderSearchQueries.tables.toLowerCase().trim()))
				: rawTables)
			: filteredObjects.filter((n) => n.type === 'table' || n.type === 'collection')
	);
	const viewsList = $derived(
		hasMultipleFolders
			? (folderSearchQueries.views.trim()
				? rawViews.filter((n) => n.name.toLowerCase().includes(folderSearchQueries.views.toLowerCase().trim()))
				: rawViews)
			: filteredObjects.filter((n) => n.type === 'view')
	);
	const functionsList = $derived(
		hasMultipleFolders
			? (folderSearchQueries.functions.trim()
				? rawFunctions.filter((n) => n.name.toLowerCase().includes(folderSearchQueries.functions.toLowerCase().trim()))
				: rawFunctions)
			: filteredObjects.filter((n) => n.type === 'function')
	);
	const proceduresList = $derived(
		hasMultipleFolders
			? (folderSearchQueries.procedures.trim()
				? rawProcedures.filter((n) => n.name.toLowerCase().includes(folderSearchQueries.procedures.toLowerCase().trim()))
				: rawProcedures)
			: filteredObjects.filter((n) => n.type === 'procedure')
	);

	$effect(() => {
		void connectionId;
		void currentDb;
		searchQuery = '';
		folderSearchQueries = { tables: '', views: '', functions: '', procedures: '' };
		isFolderSearchOpen = { tables: false, views: false, functions: false, procedures: false };
	});

	const view = $derived(dbClientStore.getView(connectionId));
	const activeView = $derived(view?.activeView ?? null);

	// ── Schema state ──────────────────────────────────────────────────
	let isObjectsExpanded = $state(true);
	let isDatabasesExpanded = $state(true);
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
			{#if !showingDatabases && onScopeMenu}
				<button
					type="button"
					class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 hover:bg-violet-500/10 hover:text-violet-600 transition-colors"
					onclick={(e) => onScopeMenu?.(e)}
					aria-label="Database actions"
					title="Database actions"
				>
					<Icon name="lucide:ellipsis-vertical" class="w-4 h-4" />
				</button>
			{/if}
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
		{/if}

		<!-- Database Objects / Databases section -->
		{#if showingDatabases}
			<div class="flex items-center justify-between px-2.5 py-1.5 text-2xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider select-none border-b border-slate-100 dark:border-slate-800/60 mb-1">
				<button
					type="button"
					class="flex items-center gap-1 hover:text-slate-600 dark:hover:text-slate-350 cursor-pointer select-none font-bold uppercase tracking-wider text-2xs text-slate-400 dark:text-slate-500"
					onclick={() => isDatabasesExpanded = !isDatabasesExpanded}
				>
					<Icon name={isDatabasesExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3 h-3 text-slate-400" />
					<span>Databases</span>
				</button>
				<button
					type="button"
					class="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer"
					onclick={() => {
						isObjectSearchOpen = !isObjectSearchOpen;
						if (!isObjectSearchOpen) searchQuery = '';
					}}
					title="Search databases"
				>
					<Icon name="lucide:search" class="w-3.5 h-3.5" />
				</button>
			</div>
			{#if isDatabasesExpanded}
				{#if isObjectSearchOpen}
					<div class="px-2 py-1 mb-1.5 shrink-0">
						<div class="flex items-center gap-2 px-2.5 py-1 bg-slate-100/80 dark:bg-slate-800/60 rounded-md">
							<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
							<input
								type="text"
								bind:value={searchQuery}
								placeholder="Search databases..."
								class="py-1 flex-1 bg-transparent border-none outline-none text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 min-w-0"
								use:focusAndSelect
							/>
							{#if searchQuery}
								<button
									type="button"
									class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer shrink-0"
									onclick={() => searchQuery = ''}
									aria-label="Clear search"
								>
									<Icon name="lucide:x" class="w-3.5 h-3.5" />
								</button>
							{/if}
						</div>
					</div>
				{/if}
				{#each filteredDatabases as db (db.name)}
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
			{/if}
		{:else if !error}
			<!-- Schema Objects Section -->
			<!-- With multiple folders (tables/views/functions/procedures) the folders
			     are themselves accordions, so we skip the outer wrapper to avoid an
			     accordion-in-accordion and render the folders directly. -->
			{#if !hasMultipleFolders}
				<div class="flex items-center justify-between px-2.5 py-1.5 text-2xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider select-none border-b border-slate-100 dark:border-slate-800/60 mb-1">
					<button
						type="button"
						class="flex items-center gap-1 hover:text-slate-600 dark:hover:text-slate-350 cursor-pointer select-none font-bold uppercase tracking-wider text-2xs text-slate-400 dark:text-slate-500"
						onclick={() => isObjectsExpanded = !isObjectsExpanded}
					>
						<Icon name={isObjectsExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3 h-3 text-slate-400" />
						<span>
							{#if driver === 'mongodb'}
								Collections ({rawTables.length})
							{:else if driver === 'redis'}
								Keys ({rawTables.length})
							{:else}
								Tables ({rawTables.length})
							{/if}
						</span>
					</button>
					<div class="flex items-center gap-1">
						<button
							type="button"
							class="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer"
							onclick={() => {
								isObjectSearchOpen = !isObjectSearchOpen;
								if (!isObjectSearchOpen) searchQuery = '';
							}}
							title="Search objects"
						>
							<Icon name="lucide:search" class="w-3.5 h-3.5" />
						</button>
						{#if !showingDatabases && canCreateTable && onCreateTable}
							<button
								type="button"
								class="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors cursor-pointer"
								onclick={() => onCreateTable(currentDb ?? undefined)}
								aria-label="New table"
								title="New table"
							>
								<Icon name="lucide:plus" class="w-3.5 h-3.5" />
							</button>
						{/if}
					</div>
				</div>
			{/if}

			{#if hasMultipleFolders || isObjectsExpanded}
				{#if isObjectSearchOpen}
					<div class="px-2 py-1 mb-1.5 shrink-0">
						<div class="flex items-center gap-2 px-2.5 py-1 bg-slate-100/80 dark:bg-slate-800/60 rounded-md">
							<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
							<input
								type="text"
								bind:value={searchQuery}
								placeholder="Search objects..."
								class="py-1 flex-1 bg-transparent border-none outline-none text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 min-w-0"
								use:focusAndSelect
							/>
							{#if searchQuery}
								<button
									type="button"
									class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer shrink-0"
									onclick={() => searchQuery = ''}
									aria-label="Clear search"
								>
									<Icon name="lucide:x" class="w-3.5 h-3.5" />
								</button>
							{/if}
						</div>
					</div>
				{/if}

				{#if filteredObjects.length === 0}
					{#if !loading}
						<div class="px-3 py-2 text-sm text-slate-400">No objects</div>
					{/if}
				{:else}
					<div class="space-y-1">
						<!-- Folder: Tables -->
						{#if rawTables.length > 0}
							{#if hasMultipleFolders}
								<div>
									<div class="flex items-center justify-between pr-2.5">
										<button
											type="button"
											class="flex items-center gap-1 pl-2.5 pr-1 pt-2 pb-0.5 flex-1 text-left font-bold text-2xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors uppercase tracking-wider select-none"
											onclick={() => expandedFolders.tables = !expandedFolders.tables}
										>
											<Icon name={expandedFolders.tables ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3 h-3 text-slate-400 shrink-0" />
											<span>Tables ({rawTables.length})</span>
										</button>
										<div class="flex items-center gap-1 mt-1.5">
											<button
												type="button"
												class="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors shrink-0"
												onclick={() => {
													isFolderSearchOpen.tables = !isFolderSearchOpen.tables;
													if (!isFolderSearchOpen.tables) folderSearchQueries.tables = '';
												}}
												title="Search tables"
											>
												<Icon name="lucide:search" class="w-3.5 h-3.5" />
											</button>
											{#if !showingDatabases && canCreateTable && onCreateTable}
												<button
													type="button"
													class="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors shrink-0"
													onclick={() => onCreateTable(currentDb ?? undefined)}
													aria-label="New table"
													title="New table"
												>
													<Icon name="lucide:plus" class="w-3.5 h-3.5" />
												</button>
											{/if}
										</div>
									</div>
									{#if expandedFolders.tables}
										{#if isFolderSearchOpen.tables}
											<div class="px-2 py-1 shrink-0">
												<div class="flex items-center gap-2 px-2.5 py-1 bg-slate-100/80 dark:bg-slate-800/60 rounded-md">
													<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
													<input
														type="text"
														bind:value={folderSearchQueries.tables}
														placeholder="Search tables..."
														class="py-1 flex-1 bg-transparent border-none outline-none text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 min-w-0"
														use:focusAndSelect
													/>
													{#if folderSearchQueries.tables}
														<button
															type="button"
															class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer shrink-0"
															onclick={() => folderSearchQueries.tables = ''}
															aria-label="Clear search"
														>
															<Icon name="lucide:x" class="w-3.5 h-3.5" />
														</button>
													{/if}
												</div>
											</div>
										{/if}
										<div class="mt-0.5 space-y-0">
											{#each tablesList as node (node.name)}
												<button
													type="button"
													class="flex items-center gap-2 w-full pl-5 pr-2.5 py-1.5 rounded text-left text-sm {isActiveNode(node.name, currentDb ?? undefined)
														? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
														: 'hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'}"
													onclick={() => onObjectClick(node, currentDb ?? undefined)}
													oncontextmenu={(e) => { e.preventDefault(); onContextMenu?.(e, currentDb ? { ...node, meta: { ...node.meta, database: currentDb } } : node); }}
												>
													<Icon name={nodeIcon(node)} class="w-4 h-4 text-slate-400 shrink-0" />
													<span class="truncate">{node.name}</span>
												</button>
											{:else}
												{#if folderSearchQueries.tables}
													<div class="pl-5 pr-2.5 py-1.5 text-xs text-slate-400">No results</div>
												{/if}
											{/each}
										</div>
									{/if}
								</div>
							{:else}
								<div class="mt-0.5 space-y-0">
									{#each tablesList as node (node.name)}
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
									{/each}
								</div>
							{/if}
						{/if}

						<!-- Folder: Views -->
						{#if rawViews.length > 0}
							<div>
								<div class="flex items-center justify-between pr-2.5">
									<button
										type="button"
										class="flex items-center gap-1 pl-2.5 pr-1 py-1 flex-1 text-left font-bold text-2xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors uppercase tracking-wider select-none"
										onclick={() => expandedFolders.views = !expandedFolders.views}
									>
										<Icon name={expandedFolders.views ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3 h-3 text-slate-400 shrink-0" />
										<span>Views ({rawViews.length})</span>
									</button>
									<div class="flex items-center gap-1 mt-1.5">
										<button
											type="button"
											class="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors shrink-0"
											onclick={() => {
												isFolderSearchOpen.views = !isFolderSearchOpen.views;
												if (!isFolderSearchOpen.views) folderSearchQueries.views = '';
											}}
											title="Search views"
										>
											<Icon name="lucide:search" class="w-3.5 h-3.5" />
										</button>
										{#if !showingDatabases && onCreateView}
											<button
												type="button"
												class="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors shrink-0"
												onclick={() => onCreateView(currentDb ?? undefined)}
												aria-label="New view"
												title="New view"
											>
												<Icon name="lucide:plus" class="w-3.5 h-3.5" />
											</button>
										{/if}
									</div>
								</div>
								{#if expandedFolders.views}
									{#if isFolderSearchOpen.views}
										<div class="px-2 py-1 shrink-0">
											<div class="flex items-center gap-2 px-2.5 py-1 bg-slate-100/80 dark:bg-slate-800/60 rounded-md">
												<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
												<input
													type="text"
													bind:value={folderSearchQueries.views}
													placeholder="Search views..."
													class="py-1 flex-1 bg-transparent border-none outline-none text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 min-w-0"
													use:focusAndSelect
												/>
												{#if folderSearchQueries.views}
													<button
														type="button"
														class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer shrink-0"
														onclick={() => folderSearchQueries.views = ''}
														aria-label="Clear search"
													>
														<Icon name="lucide:x" class="w-3.5 h-3.5" />
													</button>
												{/if}
											</div>
										</div>
									{/if}
									<div class="mt-0.5 space-y-0">
										{#each viewsList as node (node.name)}
											<button
												type="button"
												class="flex items-center gap-2 w-full pl-5 pr-2.5 py-1.5 rounded text-left text-sm {isActiveNode(node.name, currentDb ?? undefined)
													? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
													: 'hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'}"
												onclick={() => onObjectClick(node, currentDb ?? undefined)}
												oncontextmenu={(e) => { e.preventDefault(); onContextMenu?.(e, currentDb ? { ...node, meta: { ...node.meta, database: currentDb } } : node); }}
											>
												<Icon name={nodeIcon(node)} class="w-4 h-4 text-slate-400 shrink-0" />
												<span class="truncate">{node.name}</span>
											</button>
										{:else}
											{#if folderSearchQueries.views}
												<div class="pl-5 pr-2.5 py-1.5 text-xs text-slate-400">No results</div>
											{/if}
										{/each}
									</div>
								{/if}
							</div>
						{/if}

						<!-- Folder: Functions -->
						{#if rawFunctions.length > 0}
							<div>
								<div class="flex items-center justify-between pr-2.5">
									<button
										type="button"
										class="flex items-center gap-1 pl-2.5 pr-1 py-1 flex-1 text-left font-bold text-2xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors uppercase tracking-wider select-none"
										onclick={() => expandedFolders.functions = !expandedFolders.functions}
									>
										<Icon name={expandedFolders.functions ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3 h-3 text-slate-400 shrink-0" />
										<span>Functions ({rawFunctions.length})</span>
									</button>
									<div class="flex items-center gap-1 mt-1.5">
										<button
											type="button"
											class="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors shrink-0"
											onclick={() => {
												isFolderSearchOpen.functions = !isFolderSearchOpen.functions;
												if (!isFolderSearchOpen.functions) folderSearchQueries.functions = '';
											}}
											title="Search functions"
										>
											<Icon name="lucide:search" class="w-3.5 h-3.5" />
										</button>
										{#if !showingDatabases && onCreateFunction}
											<button
												type="button"
												class="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors shrink-0"
												onclick={() => onCreateFunction(currentDb ?? undefined)}
												aria-label="New function"
												title="New function"
											>
												<Icon name="lucide:plus" class="w-3.5 h-3.5" />
											</button>
										{/if}
									</div>
								</div>
								{#if expandedFolders.functions}
									{#if isFolderSearchOpen.functions}
										<div class="px-2 py-1 shrink-0">
											<div class="flex items-center gap-2 px-2.5 py-1 bg-slate-100/80 dark:bg-slate-800/60 rounded-md">
												<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
												<input
													type="text"
													bind:value={folderSearchQueries.functions}
													placeholder="Search functions..."
													class="py-1 flex-1 bg-transparent border-none outline-none text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 min-w-0"
													use:focusAndSelect
												/>
												{#if folderSearchQueries.functions}
													<button
														type="button"
														class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer shrink-0"
														onclick={() => folderSearchQueries.functions = ''}
														aria-label="Clear search"
													>
														<Icon name="lucide:x" class="w-3.5 h-3.5" />
													</button>
												{/if}
											</div>
										</div>
									{/if}
									<div class="mt-0.5 space-y-0">
										{#each functionsList as node (node.name)}
											<button
												type="button"
												class="flex items-center gap-2 w-full pl-5 pr-2.5 py-1.5 rounded text-left text-sm {isActiveNode(node.name, currentDb ?? undefined)
													? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
													: 'hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'}"
												onclick={() => onObjectClick(node, currentDb ?? undefined)}
												oncontextmenu={(e) => { e.preventDefault(); onContextMenu?.(e, currentDb ? { ...node, meta: { ...node.meta, database: currentDb } } : node); }}
											>
												<Icon name={nodeIcon(node)} class="w-4 h-4 text-slate-400 shrink-0" />
												<span class="truncate">{node.name}</span>
											</button>
										{:else}
											{#if folderSearchQueries.functions}
												<div class="pl-5 pr-2.5 py-1.5 text-xs text-slate-400">No results</div>
											{/if}
										{/each}
									</div>
								{/if}
							</div>
						{/if}

						<!-- Folder: Procedures -->
						{#if rawProcedures.length > 0}
							<div>
								<div class="flex items-center justify-between pr-2.5">
									<button
										type="button"
										class="flex items-center gap-1 pl-2.5 pr-1 py-1 flex-1 text-left font-bold text-2xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors uppercase tracking-wider select-none"
										onclick={() => expandedFolders.procedures = !expandedFolders.procedures}
									>
										<Icon name={expandedFolders.procedures ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3 h-3 text-slate-400 shrink-0" />
										<span>Procedures ({rawProcedures.length})</span>
									</button>
									<div class="flex items-center gap-1 mt-1.5">
										<button
											type="button"
											class="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors shrink-0"
											onclick={() => {
												isFolderSearchOpen.procedures = !isFolderSearchOpen.procedures;
												if (!isFolderSearchOpen.procedures) folderSearchQueries.procedures = '';
											}}
											title="Search procedures"
										>
											<Icon name="lucide:search" class="w-3.5 h-3.5" />
										</button>
										{#if !showingDatabases && onCreateProcedure}
											<button
												type="button"
												class="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors shrink-0"
												onclick={() => onCreateProcedure(currentDb ?? undefined)}
												aria-label="New procedure"
												title="New procedure"
											>
												<Icon name="lucide:plus" class="w-3.5 h-3.5" />
											</button>
												{/if}
									</div>
								</div>
								{#if expandedFolders.procedures}
									{#if isFolderSearchOpen.procedures}
										<div class="px-2 py-1 shrink-0">
											<div class="flex items-center gap-2 px-2.5 py-1 bg-slate-100/80 dark:bg-slate-800/60 rounded-md">
												<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
												<input
													type="text"
													bind:value={folderSearchQueries.procedures}
													placeholder="Search procedures..."
													class="py-1 flex-1 bg-transparent border-none outline-none text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 min-w-0"
													use:focusAndSelect
												/>
												{#if folderSearchQueries.procedures}
													<button
														type="button"
														class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer shrink-0"
														onclick={() => folderSearchQueries.procedures = ''}
														aria-label="Clear search"
													>
														<Icon name="lucide:x" class="w-3.5 h-3.5" />
													</button>
												{/if}
											</div>
										</div>
									{/if}
									<div class="mt-0.5 space-y-0">
										{#each proceduresList as node (node.name)}
											<button
												type="button"
												class="flex items-center gap-2 w-full pl-5 pr-2.5 py-1.5 rounded text-left text-sm {isActiveNode(node.name, currentDb ?? undefined)
													? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
													: 'hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'}"
												onclick={() => onObjectClick(node, currentDb ?? undefined)}
												oncontextmenu={(e) => { e.preventDefault(); onContextMenu?.(e, currentDb ? { ...node, meta: { ...node.meta, database: currentDb } } : node); }}
											>
												<Icon name={nodeIcon(node)} class="w-4 h-4 text-slate-400 shrink-0" />
												<span class="truncate">{node.name}</span>
											</button>
										{:else}
											{#if folderSearchQueries.procedures}
												<div class="pl-5 pr-2.5 py-1.5 text-xs text-slate-400">No results</div>
											{/if}
										{/each}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			{/if}
		{/if}
	</div>
</div>


