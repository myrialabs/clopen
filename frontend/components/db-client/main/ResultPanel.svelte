<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import NullValue from '../shared/NullValue.svelte';
	import { downloadFile, toCsv } from './export-utils';
	import type {
		DbClientQueryResult,
		DbClientStatementResult,
		DbClientStatementStatus
	} from '$shared/types/db-client';

	interface Props {
		result: DbClientQueryResult | null;
		error: string | null;
		running: boolean;
	}

	const { result, error, running }: Props = $props();

	interface ResultTab {
		label: string;
		queryClass: string | null;
		status: DbClientStatementStatus;
		result: DbClientQueryResult | null;
		error: string | null;
	}

	function extractTableName(query: string): string | null {
		const trimmed = query.trim();
		if (!trimmed) return null;

		// Match SELECT ... FROM table
		const selectMatch = /\bFROM\s+([A-Za-z0-9_"`[\].]+)/i.exec(trimmed);
		if (selectMatch && selectMatch[1]) {
			return cleanTableName(selectMatch[1]);
		}

		// Match INSERT INTO table, UPDATE table, DELETE FROM table
		const dmlMatch = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z0-9_"`[\].]+)/i.exec(trimmed);
		if (dmlMatch && dmlMatch[1]) {
			return cleanTableName(dmlMatch[1]);
		}

		return null;
	}

	function cleanTableName(raw: string): string {
		let name = raw.replace(/[[\]"`]/g, '');
		if (name.includes('.')) {
			const parts = name.split('.');
			name = parts[parts.length - 1];
		}
		return name;
	}

	// A multi-statement (batch) execution carries a per-statement report; a
	// plain execution is shown as a single tab.
	const batch = $derived(result?.batch ?? null);

	const tabs = $derived<ResultTab[]>(
		batch && batch.statements.length > 0
			? batch.statements.map((s: DbClientStatementResult) => {
				const tableName = extractTableName(s.query);
				const defaultLabel = batch.statements.length > 1 ? `Result ${s.index + 1}` : 'Result 1';
				return {
					label: tableName ? tableName : defaultLabel,
					queryClass: s.queryClass,
					status: s.status,
					result: s.result,
					error: s.error
				};
			})
			: result
				? [{ label: 'Result 1', queryClass: null, status: 'success', result, error: null }]
				: []
	);

	let activeResultIdx = $state(0);

	$effect(() => {
		// Reset active tab when the result changes.
		void result;
		activeResultIdx = 0;
	});

	const activeTab = $derived(tabs[activeResultIdx] ?? null);
	const activeResult = $derived(activeTab?.result ?? null);

	// Client-side pagination — never render more than PAGE_SIZE rows at once.
	const PAGE_SIZE = 100;
	let page = $state(0);

	$effect(() => {
		// Reset to the first page when the active result set changes.
		void activeResultIdx;
		void result;
		page = 0;
	});

	const totalRows = $derived(activeResult?.rows.length ?? 0);
	const pageCount = $derived(Math.max(1, Math.ceil(totalRows / PAGE_SIZE)));
	const pagedRows = $derived(
		activeResult ? activeResult.rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE) : []
	);

	function statusIcon(
		status: DbClientStatementStatus
	): 'lucide:circle-x' | 'lucide:circle-slash' | 'lucide:circle-check' {
		if (status === 'error') return 'lucide:circle-x';
		if (status === 'skipped') return 'lucide:circle-slash';
		return 'lucide:circle-check';
	}

	function isNullish(v: unknown): boolean {
		return v === null || v === undefined;
	}

	function fmt(value: unknown): string {
		if (isNullish(value)) return 'NULL';
		if (typeof value === 'object') return JSON.stringify(value);
		return String(value);
	}

	function display(value: unknown): string {
		if (isNullish(value)) return '';
		if (typeof value === 'object') return JSON.stringify(value);
		return String(value);
	}

	function exportCsv(): void {
		if (!activeResult) return;
		const cols = activeResult.columns.map((c) => c.name);
		const rows = activeResult.rows.map((r) => cols.map((c) => r[c]));
		downloadFile(toCsv(cols, rows), 'query-result.csv', 'text/csv');
	}

	function exportJson(): void {
		if (!activeResult) return;
		downloadFile(JSON.stringify(activeResult.rows, null, 2), 'query-result.json', 'application/json');
	}

	function exportMarkdown(): void {
		if (!activeResult) return;
		const cols = activeResult.columns.map((c) => c.name);
		const header = `| ${cols.join(' | ')} |`;
		const sep = `| ${cols.map(() => '---').join(' | ')} |`;
		const lines = activeResult.rows.map((r) => `| ${cols.map((c) => fmt(r[c]).replace(/\|/g, '\\|')).join(' | ')} |`);
		downloadFile([header, sep, ...lines].join('\n'), 'query-result.md', 'text/markdown');
	}

	async function copyCell(value: unknown): Promise<void> {
		await navigator.clipboard.writeText(fmt(value));
	}
</script>

<div class="flex-1 min-h-0 flex flex-col bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
	<div class="flex items-center justify-between px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 text-sm shrink-0">
		<div class="flex items-center gap-3 text-slate-600 dark:text-slate-400 font-sans">
			{#if running}
				<span class="flex items-center gap-1">
					<Icon name="lucide:loader" class="w-3 h-3 animate-spin" /> running…
				</span>
			{:else if error}
				<span class="text-red-600 dark:text-red-400">error</span>
			{:else if activeTab && activeTab.status === 'error'}
				<span class="text-red-600 dark:text-red-400">error</span>
			{:else if activeTab && activeTab.status === 'skipped'}
				<span class="text-slate-400">skipped</span>
			{:else if activeResult}
				<span>{activeResult.rowCount} rows</span>
				{#if activeResult.affectedRows !== null}
					<span>· {activeResult.affectedRows} affected</span>
				{/if}
				<span>· {result?.durationMs} ms total</span>
			{:else}
				<span class="text-slate-400">No result yet</span>
			{/if}
			{#if batch && batch.statements.length > 1}
				<span class="flex items-center gap-1 text-xs">
					<span class="text-slate-300 dark:text-slate-600">·</span>
					{#if batch.transaction}
						<span class="text-emerald-600 dark:text-emerald-400" title="Ran atomically in a transaction">transaction</span>
					{:else}
						<span class="text-amber-600 dark:text-amber-400" title="Statements ran sequentially, not atomically">no transaction</span>
					{/if}
					{#if !batch.ok}
						<span class="text-red-600 dark:text-red-400">· {batch.transaction ? 'rolled back' : 'failed'}</span>
					{/if}
				</span>
			{/if}
		</div>
		<div class="flex items-center gap-1 font-sans">
			<button
				type="button"
				class="px-2 py-0.5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
				onclick={exportCsv}
				disabled={!activeResult || activeResult.rows.length === 0}
				title="Export CSV"
			>CSV</button>
			<button
				type="button"
				class="px-2 py-0.5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
				onclick={exportJson}
				disabled={!activeResult || activeResult.rows.length === 0}
				title="Export JSON"
			>JSON</button>
			<button
				type="button"
				class="px-2 py-0.5 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
				onclick={exportMarkdown}
				disabled={!activeResult || activeResult.rows.length === 0}
				title="Export Markdown"
			>MD</button>
		</div>
	</div>

	<!-- Result tabs — always shown when there is a result (one tab per statement) -->
	{#if tabs.length >= 1}
		<div class="flex items-center gap-0.5 px-2 pt-1.5 border-b border-slate-200 dark:border-slate-800 shrink-0 overflow-x-auto select-none bg-slate-50 dark:bg-slate-900 font-sans">
			{#each tabs as tab, i (i)}
				<button
					type="button"
					class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-t border transition-colors shrink-0 cursor-pointer {activeResultIdx === i
						? 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 border-b-white dark:border-b-slate-900 text-violet-600 dark:text-violet-400'
						: 'bg-slate-100 dark:bg-slate-800 border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
					onclick={() => activeResultIdx = i}
					title={tab.queryClass ? `${tab.queryClass.toUpperCase()} · ${tab.status}` : tab.status}
				>
					<Icon
						name={statusIcon(tab.status)}
						class="w-3 h-3 {tab.status === 'error'
							? 'text-red-500'
							: tab.status === 'skipped'
								? 'text-slate-400'
								: 'text-emerald-500'}"
					/>
					{tab.label}
					{#if tab.status === 'success' && tab.result}
						<span class="text-[10px] opacity-70">
							({tab.result.rows.length > 0
								? `${tab.result.rowCount} rows`
								: `${tab.result.affectedRows ?? 0} affected`})
						</span>
					{/if}
				</button>
			{/each}
		</div>
	{/if}

	<div class="flex-1 min-h-0 overflow-auto">
		{#if error}
			<pre class="p-3 text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap">{error}</pre>
		{:else if activeTab && activeTab.status === 'error'}
			<pre class="p-3 text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap">{activeTab.error}</pre>
		{:else if activeTab && activeTab.status === 'skipped'}
			<div class="p-4 text-sm text-slate-400">Not executed — a previous statement failed and the batch was rolled back.</div>
		{:else if activeResult && activeResult.rows.length > 0}
			<table class="w-full text-sm border-collapse bg-slate-50 dark:bg-slate-800/50">
				<thead class="sticky top-0 bg-slate-200 dark:bg-slate-800 z-10 font-sans">
					<tr>
						<th class="px-2 py-1 text-left font-semibold text-slate-500 border-b border-slate-200 dark:border-slate-800 w-10">#</th>
						{#each activeResult.columns as col (col.name)}
							<th class="px-2 py-1 text-left font-semibold text-slate-700 dark:text-slate-200 border-b border-slate-200 dark:border-slate-800">
								<div class="flex flex-col">
									<span>{col.name}</span>
									{#if col.type}
										<span class="text-[10px] text-slate-400">{col.type}</span>
									{/if}
								</div>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each pagedRows as row, i (i)}
						<tr class="hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors duration-100">
							<td class="px-2.5 py-1.5 text-slate-400 border-b border-slate-200/50 dark:border-slate-800/40 select-none font-mono text-[10px]">{page * PAGE_SIZE + i + 1}</td>
							{#each activeResult.columns as col (col.name)}
								<td
									class="px-2.5 py-1.5 border-b border-slate-200/50 dark:border-slate-800/40 text-slate-700 dark:text-slate-300 cursor-pointer max-w-[400px] truncate hover:bg-slate-200/30 dark:hover:bg-slate-800/50 transition-colors duration-100"
									title={fmt(row[col.name])}
									ondblclick={() => copyCell(row[col.name])}
								>
									{#if isNullish(row[col.name])}
										<NullValue />
									{:else}
										{display(row[col.name])}
									{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		{:else if activeResult}
			<div class="p-4 text-sm text-slate-400">Empty result set.</div>
		{/if}
	</div>

	<!-- Pagination — only when the result set exceeds one page -->
	{#if activeResult && totalRows > PAGE_SIZE}
		<div class="flex items-center justify-between gap-2 px-3 py-1.5 border-t border-slate-200 dark:border-slate-800 shrink-0 text-xs text-slate-500 dark:text-slate-400 font-sans">
			<span>
				Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalRows)} of {totalRows}
			</span>
			<div class="flex items-center gap-1">
				<button
					type="button"
					class="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
					onclick={() => (page = Math.max(0, page - 1))}
					disabled={page === 0}
				>
					<Icon name="lucide:chevron-left" class="w-3.5 h-3.5" /> Prev
				</button>
				<span class="tabular-nums">{page + 1} / {pageCount}</span>
				<button
					type="button"
					class="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
					onclick={() => (page = Math.min(pageCount - 1, page + 1))}
					disabled={page >= pageCount - 1}
				>
					Next <Icon name="lucide:chevron-right" class="w-3.5 h-3.5" />
				</button>
			</div>
		</div>
	{/if}
</div>
