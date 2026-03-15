<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { DBTable } from '$shared/types/db-manager';
	import { DB_TYPE_COLORS, DB_SUPPORT } from '$shared/types/db-manager';
	import {
		dbManagerState,
		getActiveConnection,
		selectTable,
		loadTablesForActive
	} from '$frontend/stores/features/db-manager.svelte';
	import { openArchitect } from '$frontend/stores/features/db-alter.svelte';
	import { openVersionHistory } from '$frontend/stores/features/db-schema-versioning.svelte';
	import { ALTER_SUPPORTED_TYPES } from '$shared/types/alter-table';

	const activeConnection = $derived(getActiveConnection());

	// Group tables by schema
	const groupedTables = $derived(() => {
		const groups = new Map<string, DBTable[]>();
		for (const table of dbManagerState.tables) {
			const key = table.schema ?? 'default';
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(table);
		}
		return groups;
	});

	const hasSchemas = $derived(dbManagerState.tables.some((t) => t.schema && t.schema !== 'default'));
	const typeColor = $derived(activeConnection ? DB_TYPE_COLORS[activeConnection.type] : '#7c3aed');
	const hasFullSupport = $derived(
		activeConnection ? DB_SUPPORT[activeConnection.type] === 'full' : false
	);
	const supportsAlter = $derived(
		activeConnection ? ALTER_SUPPORTED_TYPES.includes(activeConnection.type) : false
	);

	let expandedSchemas = $state<Set<string>>(new Set(['public', 'main', 'default']));

	function toggleSchema(schema: string) {
		if (expandedSchemas.has(schema)) {
			expandedSchemas.delete(schema);
		} else {
			expandedSchemas.add(schema);
		}
		expandedSchemas = new Set(expandedSchemas);
	}
</script>

<div class="flex flex-col h-full min-h-0">
	<!-- Explorer header -->
	<div class="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
		<span class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
			Explorer
		</span>
		<div class="flex items-center gap-1">
			{#if supportsAlter && dbManagerState.activeTableName && activeConnection}
				<button
					type="button"
					class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10 transition-all"
					onclick={() => openArchitect(
						activeConnection!.id,
						dbManagerState.activeTableName!,
						dbManagerState.activeTableSchema ?? undefined,
						activeConnection!.type
					)}
					title="Alter Table"
				>
					<Icon name="lucide:table-properties" class="w-3.5 h-3.5" />
				</button>
				<button
					type="button"
					class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10 transition-all"
					onclick={() => openVersionHistory(
						activeConnection!.id,
						dbManagerState.activeTableName!
					)}
					title="Schema Version History"
				>
					<Icon name="lucide:history" class="w-3.5 h-3.5" />
				</button>
			{/if}
			<button
				type="button"
				class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-violet-500/10 transition-all"
				onclick={loadTablesForActive}
				title="Refresh"
			>
				<Icon
					name="lucide:refresh-cw"
					class="w-3.5 h-3.5 {dbManagerState.isLoadingTables ? 'animate-spin' : ''}"
				/>
			</button>
		</div>
	</div>

	<!-- Tables list -->
	<div class="flex-1 overflow-y-auto p-1.5">
		{#if dbManagerState.isLoadingTables}
			<div class="flex items-center justify-center py-8 gap-2 text-slate-400 text-xs">
				<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
				</svg>
				Loading...
			</div>
		{:else if !hasFullSupport && activeConnection}
			<div class="px-3 py-4 text-center">
				<Icon name="lucide:info" class="w-6 h-6 mx-auto mb-2 text-slate-400" />
				<p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
					Schema browsing is not supported for {activeConnection.type}.
					Use the Query tab to interact with this database.
				</p>
			</div>
		{:else if dbManagerState.tables.length === 0}
			<div class="flex flex-col items-center justify-center py-8 gap-2 text-slate-400 text-xs">
				<Icon name="lucide:table-2" class="w-6 h-6 opacity-40" />
				<span>No tables found</span>
			</div>
		{:else if hasSchemas}
			{#each [...groupedTables()] as [schema, tables]}
				<!-- Schema group -->
				<button
					type="button"
					class="flex items-center gap-1.5 w-full px-2 py-1.5 rounded-md text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all text-left"
					onclick={() => toggleSchema(schema)}
				>
					<Icon
						name={expandedSchemas.has(schema) ? 'lucide:chevron-down' : 'lucide:chevron-right'}
						class="w-3.5 h-3.5 shrink-0 transition-transform"
					/>
					<Icon name="lucide:layers" class="w-3.5 h-3.5 shrink-0" />
					<span class="uppercase tracking-wide">{schema}</span>
					<span class="ml-auto text-slate-400 dark:text-slate-600 font-normal">{tables.length}</span>
				</button>

				{#if expandedSchemas.has(schema)}
					{#each tables as table}
						{@const isActive =
							dbManagerState.activeTableName === table.name &&
							(dbManagerState.activeTableSchema ?? 'public') === schema}
						<button
							type="button"
							class="flex items-center gap-2 w-full pl-7 pr-2 py-1.5 rounded-md text-xs cursor-pointer transition-all duration-100 text-left
								{isActive
									? 'bg-violet-500/15 dark:bg-violet-500/20 text-slate-900 dark:text-slate-100 font-medium'
									: 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100'}"
							onclick={() => selectTable(table.name, schema)}
						>
							<Icon
								name={table.type === 'view' ? 'lucide:eye' : 'lucide:table-2'}
								class="w-3.5 h-3.5 shrink-0 {isActive ? '' : 'opacity-60'}"
							/>
							<span class="truncate">{table.name}</span>
						</button>
					{/each}
				{/if}
			{/each}
		{:else}
			{#each dbManagerState.tables as table}
				{@const isActive = dbManagerState.activeTableName === table.name}
				<button
					type="button"
					class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs cursor-pointer transition-all duration-100 text-left
						{isActive
							? 'bg-violet-500/15 dark:bg-violet-500/20 text-slate-900 dark:text-slate-100 font-medium'
							: 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100'}"
					onclick={() => selectTable(table.name)}
				>
					<Icon
						name={table.type === 'view' ? 'lucide:eye' : 'lucide:table-2'}
						class="w-3.5 h-3.5 shrink-0 {isActive ? '' : 'opacity-60'}"
					/>
					<span class="truncate">{table.name}</span>
				</button>
			{/each}
		{/if}
	</div>

	<!-- Column info for selected table -->
	{#if dbManagerState.activeTableName && dbManagerState.columns.length > 0}
		<div class="border-t border-slate-200 dark:border-slate-800 shrink-0">
			<div class="px-3 py-1.5 text-3xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide">
				Columns — {dbManagerState.activeTableName}
			</div>
			<div class="max-h-44 overflow-y-auto px-2 pb-2">
				{#each dbManagerState.columns as col}
					<div class="flex items-center gap-2 px-2 py-1 rounded text-3xs">
						{#if col.primaryKey}
							<Icon name="lucide:key" class="w-3 h-3 shrink-0 text-amber-500" />
						{:else}
							<Icon name="lucide:circle-dot" class="w-3 h-3 shrink-0 text-slate-400 opacity-40" />
						{/if}
						<span class="font-medium text-slate-700 dark:text-slate-300 truncate">{col.name}</span>
						<span class="ml-auto text-slate-400 dark:text-slate-500 font-mono shrink-0">{col.type}</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
