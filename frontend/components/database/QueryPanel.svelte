<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import SqlEditor from './SqlEditor.svelte';
	import ResultsTable from './ResultsTable.svelte';
	import ExplainPanel from './ExplainPanel.svelte';
	import QueryHistoryPanel from './QueryHistoryPanel.svelte';
	import SnippetsPanel from './SnippetsPanel.svelte';
	import AuditLogPanel from './AuditLogPanel.svelte';
	import AiSqlAssistantPanel from './AiSqlAssistantPanel.svelte';
	import VisualizationPanel from './VisualizationPanel.svelte';
	import {
		dbManagerState,
		executeQuery,
		browseTableData,
		getActiveConnection
	} from '$frontend/stores/features/db-manager.svelte';
	import {
		dbSqlEditorState,
		loadSchemaForCompletion,
		fetchHistory,
		runExplain,
		setResultTab
	} from '$frontend/stores/features/db-sql-editor.svelte';
	import { openDatagen } from '$frontend/stores/features/db-data-generator.svelte';
	import { fetchSnippets } from '$frontend/stores/features/db-sql-snippets.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';

	// Reference to SqlEditor — used to imperatively push snippet SQL and focus Monaco
	let sqlEditorRef: { forceSetValue: (sql: string) => void; focusEditor: () => void } | undefined = $state();

	const activeConnection = $derived(getActiveConnection());

	const editorLanguage = $derived(() => {
		if (!activeConnection) return 'sql';
		if (activeConnection.type === 'mongodb') return 'json';
		if (activeConnection.type === 'redis') return 'plaintext';
		return 'sql';
	});

	const queryHint = $derived(() => {
		if (!activeConnection) return null;
		switch (activeConnection.type) {
			case 'mongodb':
				return 'MongoDB: enter a JSON filter {"field": "value"} or aggregation pipeline [{…}]. Prepend "collection:name" on first line to override active table.';
			case 'redis':
				return 'Redis: enter a Redis command, e.g. GET mykey · HGETALL user:123 · KEYS user:*';
			default:
				return null;
		}
	});

	// Whether Explain is available for this connection type
	const supportsExplain = $derived(
		!!activeConnection &&
			['sqlite', 'postgresql', 'mysql', 'mariadb'].includes(activeConnection.type)
	);

	// Whether AI assistant is available (SQL-based databases only)
	const supportsAi = $derived(!!activeConnection && activeConnection.type !== 'redis');

	const activeResult = $derived(
		dbManagerState.activeTab === 'query' ? dbManagerState.queryResult : dbManagerState.browseResult
	);

	const isLoading = $derived(
		dbManagerState.activeTab === 'query' ? dbManagerState.isLoadingQuery : dbManagerState.isLoadingBrowse
	);

	async function handleRunQuery() {
		await executeQuery();
		// After running, switch result tab to results and refresh history
		setResultTab('results');
		if (activeConnection) {
			await fetchHistory(activeConnection.id);
		}
	}

	async function handleExplain() {
		if (!activeConnection || !dbManagerState.currentSql.trim()) return;
		await runExplain(activeConnection.id, dbManagerState.currentSql);
	}

	async function handleRefreshBrowse() {
		if (dbManagerState.activeTableName) {
			await browseTableData(
				dbManagerState.activeTableName,
				dbManagerState.activeTableSchema ?? undefined
			);
		}
	}

	// Load schema for IntelliSense when connection changes
	$effect(() => {
		const conn = activeConnection;
		if (conn && dbManagerState.activeTab === 'query' && editorLanguage() === 'sql') {
			loadSchemaForCompletion(conn.id);
		}
	});

	// Load history when switching to History tab
	$effect(() => {
		if (dbManagerState.activeResultTab === 'history' && activeConnection) {
			fetchHistory(activeConnection.id);
		}
	});

	// Load snippets when switching to Snippets tab
	$effect(() => {
		if (dbManagerState.activeResultTab === 'snippets') {
			fetchSnippets();
		}
	});

	// History: select entry → load into editor and show results
	function handleHistorySelect(sql: string) {
		dbManagerState.currentSql = sql;
		setResultTab('results');
	}

	/**
	 * Snippet insert — loads SQL into the editor above.
	 * Stays on the Snippets tab so the user can see the editor update.
	 * A notification confirms the action.
	 */
	function handleSnippetInsert(sql: string) {
		dbManagerState.currentSql = sql;
		sqlEditorRef?.forceSetValue(sql);
		addNotification({
			type: 'success',
			title: 'Snippet loaded',
			message: 'SQL inserted into editor — press Ctrl+Enter to run',
			duration: 3000
		});
		// Stay on snippets tab — user can look up at the editor and run manually
	}

	/**
	 * Snippet run — loads SQL into the editor and immediately executes it,
	 * then switches to the Results sub-tab to show output.
	 */
	async function handleSnippetRun(sql: string) {
		if (!activeConnection) {
			addNotification({ type: 'error', title: 'No connection', message: 'Select a database connection first', duration: 3000 });
			return;
		}
		dbManagerState.currentSql = sql;
		sqlEditorRef?.forceSetValue(sql);
		setResultTab('results');
		await executeQuery();
		if (activeConnection) {
			await fetchHistory(activeConnection.id);
		}
	}

	/**
	 * AI assistant: insert generated SQL into editor.
	 */
	function handleAiInsertSql(sql: string) {
		dbManagerState.currentSql = sql;
		sqlEditorRef?.forceSetValue(sql);
	}

	/** Focus the SQL editor — called by DatabaseModal after connection/tab switch. */
	export function focusEditor(): void {
		sqlEditorRef?.focusEditor();
	}

	/** Execute the active query — called by DatabaseModal's global Ctrl+Enter handler. */
	export async function runQuery(): Promise<void> {
		return handleRunQuery();
	}

	/** Explain the active query — called by DatabaseModal's global Ctrl+Shift+Enter handler. */
	export async function explainQuery(): Promise<void> {
		return handleExplain();
	}
</script>

<div class="flex flex-col h-full min-h-0">
	<!-- Tab bar -->
	<div class="flex items-center border-b border-slate-200 dark:border-slate-800 shrink-0 px-2 gap-1 pt-1">
		<button
			type="button"
			class="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-all duration-150
				{dbManagerState.activeTab === 'browse'
					? 'text-violet-600 dark:text-violet-400 border-b-2 border-violet-600 dark:border-violet-400 -mb-px'
					: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
			onclick={() => (dbManagerState.activeTab = 'browse')}
		>
			<Icon name="lucide:table-2" class="w-3.5 h-3.5" />
			Browse
		</button>
		<button
			type="button"
			class="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-all duration-150
				{dbManagerState.activeTab === 'query'
					? 'text-violet-600 dark:text-violet-400 border-b-2 border-violet-600 dark:border-violet-400 -mb-px'
					: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
			onclick={() => (dbManagerState.activeTab = 'query')}
		>
			<Icon name="lucide:terminal" class="w-3.5 h-3.5" />
			Query
		</button>

		<div class="flex-1"></div>

		{#if dbManagerState.activeTab === 'browse' && dbManagerState.activeTableName}
			<button
				type="button"
				class="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 transition-all mr-1"
				onclick={() =>
					openDatagen(
						dbManagerState.activeConnectionId!,
						dbManagerState.activeTableName!,
						dbManagerState.activeTableSchema ?? undefined
					)}
				title="Generate fake data and seed this table"
			>
				<Icon name="lucide:sparkles" class="w-3.5 h-3.5" />
				Seed Data
			</button>
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-violet-500/10 transition-all mr-1"
				onclick={handleRefreshBrowse}
				title="Refresh data"
			>
				<Icon
					name="lucide:refresh-cw"
					class="w-3.5 h-3.5 {dbManagerState.isLoadingBrowse ? 'animate-spin' : ''}"
				/>
			</button>
		{/if}
	</div>

	{#if dbManagerState.activeTab === 'query'}
		<!-- Query editor + results split -->
		<div class="flex flex-col flex-1 min-h-0">
			{#if queryHint()}
				<div class="flex items-start gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800 shrink-0">
					<Icon name="lucide:info" class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
					<p class="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">{queryHint()}</p>
				</div>
			{/if}

			<!-- Editor -->
			<div class="h-44 shrink-0 border-b border-slate-200 dark:border-slate-800">
				<SqlEditor
					bind:this={sqlEditorRef}
					bind:value={dbManagerState.currentSql}
					language={editorLanguage()}
					disabled={!activeConnection}
					isRunning={dbManagerState.isLoadingQuery}
					isExplaining={dbSqlEditorState.isLoadingExplain}
					showExplain={supportsExplain}
					onRun={handleRunQuery}
					onExplain={handleExplain}
				/>
			</div>

			<!-- Result sub-tabs -->
			<div class="flex items-center border-b border-slate-200 dark:border-slate-800 shrink-0 px-2 gap-1 bg-slate-50 dark:bg-slate-900/30 overflow-x-auto">
				{#each (['results', 'plan', 'history', 'snippets', 'audit'] as const) as tab}
					{@const label = tab === 'results' ? 'Results' : tab === 'plan' ? 'Plan' : tab === 'history' ? 'History' : tab === 'snippets' ? 'Snippets' : 'Audit Log'}
					{@const icon = tab === 'results' ? 'lucide:table' : tab === 'plan' ? 'lucide:zap' : tab === 'history' ? 'lucide:clock' : tab === 'snippets' ? 'lucide:bookmark' : 'lucide:shield-check'}
					<button
						type="button"
						class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium transition-all duration-150 shrink-0
							{dbManagerState.activeResultTab === tab
								? 'text-violet-600 dark:text-violet-400 border-b-2 border-violet-600 dark:border-violet-400 -mb-px'
								: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
						onclick={() => setResultTab(tab)}
					>
						<Icon name={icon} class="w-3 h-3" />
						{label}
					</button>
				{/each}
				<!-- Visualize tab — shown when query returned columns -->
				{#if activeResult?.columns?.length}
					<button
						type="button"
						class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium transition-all duration-150 shrink-0
							{dbManagerState.activeResultTab === 'visualize'
								? 'text-violet-600 dark:text-violet-400 border-b-2 border-violet-600 dark:border-violet-400 -mb-px'
								: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
						onclick={() => setResultTab('visualize')}
					>
						<Icon name="lucide:bar-chart-3" class="w-3 h-3" />
						Visualize
					</button>
				{/if}
				{#if supportsAi}
					<button
						type="button"
						class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium transition-all duration-150 shrink-0
							{dbManagerState.activeResultTab === 'ai'
								? 'text-violet-600 dark:text-violet-400 border-b-2 border-violet-600 dark:border-violet-400 -mb-px'
								: 'text-violet-400 dark:text-violet-500 hover:text-violet-600 dark:hover:text-violet-400'}"
						onclick={() => setResultTab('ai')}
					>
						<Icon name="lucide:sparkles" class="w-3 h-3" />
						AI Assistant
					</button>
				{/if}
			</div>

			<!-- Result content -->
			<div class="flex-1 min-h-0 overflow-hidden">
				{#if dbManagerState.activeResultTab === 'results'}
					{#if isLoading}
						<div class="flex items-center justify-center h-full gap-2 text-slate-400 text-sm">
							<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
								<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
								<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
							</svg>
							Executing...
						</div>
					{:else if activeResult}
						<ResultsTable result={activeResult} readonly={true} />
					{:else}
						<div class="flex flex-col items-center justify-center h-full gap-2 text-slate-400 text-xs">
							<Icon name="lucide:database" class="w-6 h-6 opacity-40" />
							<span>Run a query to see results</span>
							<span class="text-slate-300 dark:text-slate-600">Ctrl+Enter to run</span>
						</div>
					{/if}
				{:else if dbManagerState.activeResultTab === 'visualize'}
					<VisualizationPanel result={activeResult} sql={dbManagerState.currentSql} />
				{:else if dbManagerState.activeResultTab === 'plan'}
					<ExplainPanel />
				{:else if dbManagerState.activeResultTab === 'history'}
					<QueryHistoryPanel
						connectionId={activeConnection?.id ?? null}
						onSelectEntry={handleHistorySelect}
					/>
				{:else if dbManagerState.activeResultTab === 'snippets'}
					<SnippetsPanel
						onInsert={handleSnippetInsert}
						onRun={handleSnippetRun}
					/>
				{:else if dbManagerState.activeResultTab === 'ai'}
					<AiSqlAssistantPanel
						connectionId={activeConnection?.id ?? null}
						currentSql={dbManagerState.currentSql}
						onInsertSql={handleAiInsertSql}
					/>
				{:else if activeConnection}
					<AuditLogPanel connectionId={activeConnection.id} />
				{/if}
			</div>
		</div>
	{:else}
		<!-- Browse mode -->
		<div class="flex-1 min-h-0 overflow-hidden">
			{#if !dbManagerState.activeTableName}
				<div class="flex flex-col items-center justify-center h-full gap-2 text-slate-400 text-sm">
					<Icon name="lucide:table-2" class="w-8 h-8 opacity-30" />
					<span>Select a table to browse data</span>
				</div>
			{:else if isLoading && !dbManagerState.browseResult}
				<div class="flex items-center justify-center h-full gap-2 text-slate-400 text-sm">
					<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
					Loading data...
				</div>
			{:else}
				<ResultsTable result={dbManagerState.browseResult} readonly={false} />
			{/if}
		</div>
	{/if}
</div>
