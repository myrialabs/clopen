<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { dbSqlEditorState } from '$frontend/stores/features/db-sql-editor.svelte';
	import { dbManagerState } from '$frontend/stores/features/db-manager.svelte';
	import ResultsTable from './ResultsTable.svelte';
	import QueryProfilerDiagram from './QueryProfilerDiagram.svelte';

	// View mode: 'visual' shows the interactive diagram, 'text' shows raw output
	let viewMode: 'visual' | 'text' = $state('visual');

	// Detect DB type from result columns
	const explainType = $derived(() => {
		const result = dbManagerState.explainResult;
		if (!result || !result.columns.length) return null;
		// SQLite: EXPLAIN QUERY PLAN → columns: id, parent, notused, detail
		if (result.columns.includes('detail') && result.columns.includes('parent')) return 'sqlite';
		// PostgreSQL: single column "QUERY PLAN"
		if (result.columns.length === 1 && result.columns[0] === 'QUERY PLAN') return 'postgresql';
		// MySQL/MariaDB: columns like select_type, type, key etc.
		return 'mysql';
	});

	// Build SQLite tree rows with depth-based indentation
	const sqliteTreeRows = $derived(() => {
		const result = dbManagerState.explainResult;
		if (!result || explainType() !== 'sqlite') return [];

		// Build parent map
		const rows = result.rows as Array<{ id: number; parent: number; detail: string }>;

		function getDepth(id: number): number {
			const row = rows.find((r) => r.id === id);
			if (!row || row.parent === 0) return 0;
			return 1 + getDepth(row.parent);
		}

		return rows.map((row) => ({
			depth: getDepth(row.id),
			detail: String(row.detail ?? '')
		}));
	});

	// PostgreSQL plain text
	const postgresText = $derived(() => {
		const result = dbManagerState.explainResult;
		if (!result || explainType() !== 'postgresql') return '';
		return result.rows.map((r) => String(r['QUERY PLAN'] ?? '')).join('\n');
	});

	// Whether the visual profiler can render this result type
	const canVisualise = $derived(
		() => explainType() === 'postgresql' || explainType() === 'sqlite' || explainType() === 'mysql'
	);
</script>

<div class="flex flex-col h-full min-h-0 overflow-hidden">
	{#if dbSqlEditorState.isLoadingExplain}
		<div class="flex items-center justify-center h-full gap-2 text-slate-400 text-sm">
			<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
				></circle>
				<path
					class="opacity-75"
					fill="currentColor"
					d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
				></path>
			</svg>
			Analyzing...
		</div>
	{:else if !dbManagerState.explainResult}
		<div class="flex flex-col items-center justify-center h-full gap-2 text-slate-400 text-xs">
			<Icon name="lucide:zap" class="w-6 h-6 opacity-40" />
			<span>Click Explain to analyze query performance</span>
		</div>
	{:else if dbManagerState.explainResult.error}
		<div class="flex flex-col items-center justify-center h-full gap-2 text-red-400 text-xs p-4">
			<Icon name="lucide:circle-x" class="w-5 h-5" />
			<span class="text-center">{dbManagerState.explainResult.error}</span>
		</div>
	{:else}
		<!-- View mode toggle -->
		<div
			class="flex items-center gap-1 px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-slate-50 dark:bg-slate-900/30"
		>
			<span class="text-xs text-slate-400 dark:text-slate-500 mr-1">View:</span>
			<button
				type="button"
				class="flex items-center gap-1 px-2 py-0.5 text-xs rounded-md transition-all
					{viewMode === 'visual'
					? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 font-medium'
					: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}"
				onclick={() => (viewMode = 'visual')}
				disabled={!canVisualise()}
			>
				<Icon name="lucide:workflow" class="w-3 h-3" />
				Visual
			</button>
			<button
				type="button"
				class="flex items-center gap-1 px-2 py-0.5 text-xs rounded-md transition-all
					{viewMode === 'text'
					? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 font-medium'
					: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}"
				onclick={() => (viewMode = 'text')}
			>
				<Icon name="lucide:file-text" class="w-3 h-3" />
				Text
			</button>
		</div>

		<!-- Content -->
		<div class="flex-1 min-h-0 overflow-hidden">
			{#if viewMode === 'visual' && canVisualise()}
				<!-- Interactive query profiler diagram -->
				<QueryProfilerDiagram
					result={dbManagerState.explainResult}
					dbType={explainType() as 'postgresql' | 'sqlite' | 'mysql'}
				/>
			{:else if explainType() === 'sqlite'}
				<!-- SQLite: tree view -->
				<div class="flex-1 min-h-0 h-full overflow-y-auto p-3 font-mono text-xs">
					{#each sqliteTreeRows() as row}
						<div
							class="flex items-start gap-1 py-0.5 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded px-1"
						>
							<span class="text-slate-400 shrink-0" style="padding-left: {row.depth * 16}px">
								{row.depth > 0 ? '└─' : ''}
							</span>
							<span class="leading-relaxed">{row.detail}</span>
						</div>
					{/each}
				</div>
			{:else if explainType() === 'postgresql'}
				<!-- PostgreSQL: preformatted text -->
				<div class="h-full overflow-auto p-3">
					<pre
						class="text-xs font-mono text-slate-700 dark:text-slate-300 whitespace-pre leading-relaxed"
					>{postgresText()}</pre>
				</div>
			{:else}
				<!-- MySQL/MariaDB: table view -->
				<div class="h-full overflow-hidden">
					<ResultsTable result={dbManagerState.explainResult} readonly={true} />
				</div>
			{/if}
		</div>
	{/if}
</div>
