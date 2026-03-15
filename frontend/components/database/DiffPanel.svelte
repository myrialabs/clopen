<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import LoadingSpinner from '$frontend/components/common/feedback/LoadingSpinner.svelte';
	import type { DBConnectionConfig } from '$shared/types/db-manager';
	import type { DiffStatus } from '$shared/types/db-diff';
	import {
		dbDiffState,
		runDiffCompare,
		generateMigration,
		resetDiff
	} from '$frontend/stores/features/db-diff.svelte';
	import DiffMigrationModal from './DiffMigrationModal.svelte';
	import { STATUS_CONFIG } from './diff-utils';

	interface Props {
		connections: DBConnectionConfig[];
	}

	const { connections }: Props = $props();

	let expandedTables = $state(new Set<string>());
	let sourceId = $state(dbDiffState.sourceConnectionId ?? '');
	let targetId = $state(dbDiffState.targetConnectionId ?? '');

	const filteredTables = $derived(
		dbDiffState.filterStatus === 'all'
			? (dbDiffState.diff?.tables ?? [])
			: (dbDiffState.diff?.tables ?? []).filter((t) => t.status !== 'unchanged')
	);

	const changesCount = $derived(
		(dbDiffState.diff?.tables ?? []).filter((t) => t.status !== 'unchanged').length
	);

	function toggleTable(name: string): void {
		const next = new Set(expandedTables);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		expandedTables = next;
	}

	const statusColor = (s: DiffStatus) => STATUS_CONFIG[s].color;
	const statusBg = (s: DiffStatus) => STATUS_CONFIG[s].bg;
	const statusRowBg = (s: DiffStatus) => STATUS_CONFIG[s].rowBg;
	const statusLabel = (s: DiffStatus) => STATUS_CONFIG[s].label;
	const statusBadge = (s: DiffStatus) => STATUS_CONFIG[s].badge;

	function handleCompare(): void {
		expandedTables = new Set();
		runDiffCompare();
	}

	$effect(() => {
		if (dbDiffState.diff) {
			const changed = (dbDiffState.diff.tables ?? [])
				.filter((t) => t.status !== 'unchanged')
				.map((t) => t.tableName);
			expandedTables = new Set(changed);
		}
	});
</script>

<div class="flex flex-col w-full h-full min-h-0 min-w-0">
	<!-- ─── Header / Controls ────────────────────────────────────────────── -->
	<div class="shrink-0 px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/60">
		<div class="flex items-center gap-2 mb-3">
			<Icon name="lucide:diff" class="w-4 h-4 text-violet-500" />
			<span class="text-sm font-semibold text-slate-800 dark:text-slate-200">Schema Diff</span>
			<span class="text-xs text-slate-400 dark:text-slate-500">Compare two database schemas side by side</span>
		</div>

		<!-- Connection selectors -->
		<div class="flex items-center gap-2">
			<!-- Source -->
			<div class="flex-1 min-w-0">
				<label class="block text-3xs font-medium text-slate-500 dark:text-slate-400 mb-1 uppercase tracking-wide">Source (reference)</label>
				<select
					class="w-full text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
					bind:value={sourceId}
					onchange={resetDiff}
				>
					<option value="">Select source…</option>
					{#each connections as conn (conn.id)}
						<option value={conn.id}>{conn.name}</option>
					{/each}
				</select>
			</div>

			<!-- Arrow -->
			<div class="shrink-0 mt-4">
				<Icon name="lucide:arrow-right" class="w-4 h-4 text-slate-400" />
			</div>

			<!-- Target -->
			<div class="flex-1 min-w-0">
				<label class="block text-3xs font-medium text-slate-500 dark:text-slate-400 mb-1 uppercase tracking-wide">Target (to sync)</label>
				<select
					class="w-full text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
					bind:value={targetId}
					onchange={resetDiff}
				>
					<option value="">Select target…</option>
					{#each connections as conn (conn.id)}
						<option value={conn.id}>{conn.name}</option>
					{/each}
				</select>
			</div>

			<!-- Compare button -->
			<div class="shrink-0 mt-4">
				<button
					type="button"
					class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all
						{dbDiffState.isComparing
							? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
							: 'bg-violet-600 hover:bg-violet-700 text-white'}"
					disabled={dbDiffState.isComparing || !dbDiffState.sourceConnectionId || !dbDiffState.targetConnectionId}
					onclick={handleCompare}
				>
					{#if dbDiffState.isComparing}
						<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Comparing…
					{:else}
						<Icon name="lucide:git-compare" class="w-3.5 h-3.5" />
						Compare
					{/if}
				</button>
			</div>
		</div>
	</div>

	<!-- ─── Results Area ─────────────────────────────────────────────────── -->
	{#if !dbDiffState.diff && !dbDiffState.isComparing}
		<!-- Empty state -->
		<div class="flex flex-col items-center justify-center flex-1 gap-3 p-8 text-center">
			<div class="w-14 h-14 rounded-2xl bg-violet-500/10 flex items-center justify-center">
				<Icon name="lucide:git-compare" class="w-7 h-7 text-violet-500/60" />
			</div>
			<div>
				<p class="text-sm font-medium text-slate-700 dark:text-slate-300">Select two connections to compare</p>
				<p class="text-xs text-slate-400 dark:text-slate-500 mt-1">
					Differences in tables, columns, and indexes will be highlighted.
				</p>
			</div>
		</div>

	{:else if dbDiffState.isComparing}
		<div class="flex flex-col items-center justify-center flex-1">
			<LoadingSpinner size="md" color="neutral" text="Comparing schemas…" />
		</div>

	{:else if dbDiffState.diff}
		{@const diff = dbDiffState.diff}

		<!-- Summary bar -->
		<div class="shrink-0 px-4 py-2 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/60 flex items-center gap-3 flex-wrap">
			{#if !diff.hasDifferences}
				<div class="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
					<Icon name="lucide:check-line" class="w-3.5 h-3.5" />
					Schemas are identical
				</div>
			{:else}
				<!-- Summary pills -->
				{#if diff.summary.tablesAdded}
					<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-3xs font-medium bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400">
						+{diff.summary.tablesAdded} table{diff.summary.tablesAdded > 1 ? 's' : ''}
					</span>
				{/if}
				{#if diff.summary.tablesRemoved}
					<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-3xs font-medium bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400">
						−{diff.summary.tablesRemoved} table{diff.summary.tablesRemoved > 1 ? 's' : ''}
					</span>
				{/if}
				{#if diff.summary.tablesModified}
					<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-3xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400">
						~{diff.summary.tablesModified} modified
					</span>
				{/if}
				{#if diff.summary.columnsAdded}
					<span class="text-3xs text-emerald-600 dark:text-emerald-400">+{diff.summary.columnsAdded} col</span>
				{/if}
				{#if diff.summary.columnsRemoved}
					<span class="text-3xs text-red-500 dark:text-red-400">−{diff.summary.columnsRemoved} col</span>
				{/if}
				{#if diff.summary.columnsModified}
					<span class="text-3xs text-amber-600 dark:text-amber-400">~{diff.summary.columnsModified} col</span>
				{/if}

				<div class="flex-1"></div>

				<!-- Filter toggle -->
				<div class="flex items-center gap-0.5 bg-slate-100 dark:bg-slate-800/60 rounded-lg p-0.5">
					<button
						type="button"
						class="px-2 py-0.5 rounded-md text-3xs font-medium transition-all
							{dbDiffState.filterStatus === 'changes'
								? 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 shadow-sm'
								: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
						onclick={() => (dbDiffState.filterStatus = 'changes')}
					>
						Changes ({changesCount})
					</button>
					<button
						type="button"
						class="px-2 py-0.5 rounded-md text-3xs font-medium transition-all
							{dbDiffState.filterStatus === 'all'
								? 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 shadow-sm'
								: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
						onclick={() => (dbDiffState.filterStatus = 'all')}
					>
						All ({diff.tables.length})
					</button>
				</div>

				<!-- Generate migration button -->
				<button
					type="button"
					class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all
						{dbDiffState.isGeneratingMigration
							? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
							: 'bg-violet-600 hover:bg-violet-700 text-white'}"
					disabled={dbDiffState.isGeneratingMigration}
					onclick={generateMigration}
				>
					{#if dbDiffState.isGeneratingMigration}
						<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
					{:else}
						<Icon name="lucide:file-code" class="w-3.5 h-3.5" />
					{/if}
					Migration Script
				</button>
			{/if}
		</div>

		<!-- Table list -->
		<div class="flex-1 overflow-y-auto p-3 space-y-1.5">
			{#if filteredTables.length === 0}
				<div class="flex flex-col items-center justify-center py-10 gap-2 text-slate-400">
					<Icon name="lucide:check-line" class="w-6 h-6 text-emerald-500/60" />
					<span class="text-xs">No differences found</span>
				</div>
			{:else}
				{#each filteredTables as table (table.tableName)}
					{@const isExpanded = expandedTables.has(table.tableName)}
					{@const hasDetails = table.columns.length > 0 || table.indexes.length > 0}

					<div class="border rounded-lg overflow-hidden {statusBg(table.status)}">
						<!-- Table row header -->
						<button
							type="button"
							class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
							onclick={() => toggleTable(table.tableName)}
						>
							{#if table.status !== 'unchanged'}
								<span class="font-mono text-3xs font-bold w-7 shrink-0 {statusColor(table.status)}">
									{statusLabel(table.status)}
								</span>
							{:else}
								<span class="w-7 shrink-0"></span>
							{/if}

							<Icon name="lucide:table-2" class="w-3.5 h-3.5 shrink-0 {statusColor(table.status)}" />
							<span class="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate flex-1">
								{table.schema ? `${table.schema}.` : ''}{table.tableName}
							</span>

							{#if table.status !== 'unchanged'}
								<span class="text-3xs font-medium px-1.5 py-0.5 rounded {statusBadge(table.status)}">
									{table.status}
								</span>
							{/if}

							{#if table.status === 'modified'}
								{@const addedCols = table.columns.filter((c) => c.status === 'added').length}
								{@const removedCols = table.columns.filter((c) => c.status === 'removed').length}
								{@const modifiedCols = table.columns.filter((c) => c.status === 'modified').length}
								<span class="text-3xs text-slate-400">
									{[
										addedCols ? `+${addedCols}` : '',
										removedCols ? `-${removedCols}` : '',
										modifiedCols ? `~${modifiedCols}` : ''
									].filter(Boolean).join(' ')} col
								</span>
							{/if}

							{#if hasDetails}
								<Icon
									name={isExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'}
									class="w-3.5 h-3.5 shrink-0 text-slate-400"
								/>
							{/if}
						</button>

						<!-- Expanded details -->
						{#if isExpanded && hasDetails}
							<div class="border-t border-slate-200/60 dark:border-slate-700/40">
								<!-- Columns table -->
								{#if table.columns.length > 0}
									<div class="overflow-x-auto">
										<table class="w-full text-3xs">
											<thead>
												<tr class="bg-slate-100/60 dark:bg-slate-800/40">
													<th class="text-left px-3 py-1 text-slate-500 font-medium w-6"></th>
													<th class="text-left px-2 py-1 text-slate-500 font-medium">Column</th>
													<th class="text-left px-2 py-1 text-slate-500 font-medium">Source type</th>
													<th class="text-left px-2 py-1 text-slate-500 font-medium">Target type</th>
													<th class="text-left px-2 py-1 text-slate-500 font-medium">Nullable</th>
													<th class="text-left px-2 py-1 text-slate-500 font-medium">Default</th>
												</tr>
											</thead>
											<tbody>
												{#each table.columns as col (col.name)}
													<tr class="border-t border-slate-100 dark:border-slate-800/40 {statusRowBg(col.status)}">
														<td class="px-3 py-1 font-bold font-mono {statusColor(col.status)} leading-none">
															{#if col.status !== 'unchanged'}{statusLabel(col.status)}{/if}
														</td>
														<td class="px-2 py-1 font-medium text-slate-700 dark:text-slate-300">
															{col.name}
															{#if col.source?.primaryKey || col.target?.primaryKey}
																<span class="ml-1 text-violet-500">PK</span>
															{/if}
														</td>
														<td class="px-2 py-1 font-mono text-slate-600 dark:text-slate-400">
															{#if col.source?.type}{col.source.type}{:else}<span class="text-slate-300 dark:text-slate-600">—</span>{/if}
														</td>
														<td class="px-2 py-1 font-mono text-slate-600 dark:text-slate-400
															{col.status === 'modified' && col.source?.type !== col.target?.type ? statusColor(col.status) : ''}">
															{#if col.target?.type}{col.target.type}{:else}<span class="text-slate-300 dark:text-slate-600">—</span>{/if}
														</td>
														<td class="px-2 py-1 text-slate-500">
															{#if col.source}
																{col.source.nullable ? 'YES' : 'NO'}
															{:else}
																—
															{/if}
														</td>
														<td class="px-2 py-1 font-mono text-slate-400 truncate max-w-[80px]">
															{col.source?.defaultValue ?? '—'}
														</td>
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								{/if}

								<!-- Indexes (if any non-unchanged) -->
								{#if table.indexes.some((i) => i.status !== 'unchanged')}
									<div class="border-t border-slate-200/60 dark:border-slate-700/40 px-3 py-1.5">
										<p class="text-3xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Indexes</p>
										<div class="space-y-0.5">
											{#each table.indexes.filter((i) => i.status !== 'unchanged') as idx (idx.name)}
												<div class="flex items-center gap-2 {statusRowBg(idx.status)} rounded px-2 py-1">
													<span class="font-mono text-3xs font-bold w-7 {statusColor(idx.status)}">{statusLabel(idx.status)}</span>
													<span class="font-medium text-slate-700 dark:text-slate-300">{idx.name}</span>
													{#if idx.source?.unique || idx.target?.unique}
														<span class="text-3xs bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 px-1 rounded">UNIQUE</span>
													{/if}
													<span class="text-slate-400 font-mono">
														({(idx.source?.columns ?? idx.target?.columns ?? []).join(', ')})
													</span>
												</div>
											{/each}
										</div>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<!-- Migration modal -->
<DiffMigrationModal />
