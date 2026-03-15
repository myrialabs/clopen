<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import RowEditModal from './RowEditModal.svelte';
	import ExportModal from './ExportModal.svelte';
	import ImportModal from './ImportModal.svelte';
	import DataMaskingModal from './DataMaskingModal.svelte';
	import BulkActionModal from './BulkActionModal.svelte';
	import {
		dbManagerState,
		getPkColumn,
		setFilters,
		goToPage,
		setPageSize,
		deleteRowsAction,
		getActiveConnection,
		openBulkDelete,
		openBulkUpdate
	} from '$frontend/stores/features/db-manager.svelte';
	import { dbExportState, openExport, openImport } from '$frontend/stores/features/db-export.svelte';
	import {
		getActiveMaskRules,
		applyMask,
		openMaskingModal
	} from '$frontend/stores/features/db-data-masking.svelte';
	import type { DBQueryResult, DBRowFilter, DBFilterOperator } from '$shared/types/db-manager';

	const activeConnection = $derived(getActiveConnection());

	interface Props {
		result: DBQueryResult | null;
		readonly?: boolean;
	}

	const { result, readonly = false }: Props = $props();

	// ─── Filter state ─────────────────────────────────────────────────────────
	let pendingFilters = $state<DBRowFilter[]>(
		dbManagerState.browseFilters.map((f) => ({ ...f }))
	);
	let showFilters = $state(false);

	$effect(() => {
		pendingFilters = dbManagerState.browseFilters.map((f) => ({ ...f }));
	});

	const OPERATORS: { value: DBFilterOperator; label: string; hasValue: boolean }[] = [
		{ value: 'eq', label: '=', hasValue: true },
		{ value: 'neq', label: '≠', hasValue: true },
		{ value: 'like', label: 'contains', hasValue: true },
		{ value: 'gt', label: '>', hasValue: true },
		{ value: 'lt', label: '<', hasValue: true },
		{ value: 'null', label: 'is null', hasValue: false },
		{ value: 'notnull', label: 'not null', hasValue: false }
	];

	const PAGE_SIZES = [25, 50, 100, 200];

	// ─── Derived ──────────────────────────────────────────────────────────────
	const pkInfo = $derived(getPkColumn());
	const columns = $derived(result?.columns ?? []);
	const rows = $derived(result?.rows ?? []);

	const totalCount = $derived(dbManagerState.browseTotalCount);
	const page = $derived(dbManagerState.browsePage);
	const pageSize = $derived(dbManagerState.browsePageSize);
	const totalPages = $derived(Math.max(1, Math.ceil(totalCount / pageSize)));
	const startRow = $derived(page * pageSize + 1);
	const endRow = $derived(Math.min((page + 1) * pageSize, totalCount));

	const selectedSet = $derived(new Set(dbManagerState.selectedRowKeys));
	const allSelected = $derived(rows.length > 0 && rows.every((r) => selectedSet.has(rowKey(r))));
	const someSelected = $derived(dbManagerState.selectedRowKeys.length > 0 || dbManagerState.globalSelectionActive);
	const canOfferGlobalSelect = $derived(
		allSelected &&
		!dbManagerState.globalSelectionActive &&
		dbManagerState.browseTotalCount > dbManagerState.browsePageSize
	);

	// ─── Selection ───────────────────────────────────────────────────────────
	function rowKey(row: Record<string, unknown>): string {
		if (!pkInfo) return JSON.stringify(row);
		return String(row[pkInfo.column] ?? '');
	}

	function toggleRow(row: Record<string, unknown>) {
		const key = rowKey(row);
		if (selectedSet.has(key)) {
			dbManagerState.selectedRowKeys = dbManagerState.selectedRowKeys.filter((k) => k !== key);
		} else {
			dbManagerState.selectedRowKeys = [...dbManagerState.selectedRowKeys, key];
		}
	}

	function toggleAll() {
		if (allSelected || dbManagerState.globalSelectionActive) {
			dbManagerState.selectedRowKeys = [];
			dbManagerState.globalSelectionActive = false;
		} else {
			dbManagerState.selectedRowKeys = rows.map(rowKey);
		}
	}

	// ─── CRUD handlers ───────────────────────────────────────────────────────
	let showEditModal = $state(false);

	// Single-row inline delete confirmation state
	let showDeleteConfirm = $state(false);
	let pendingDeleteRow = $state<Record<string, unknown> | null>(null);

	function handleAddRow() {
		dbManagerState.isInsertingRow = true;
		dbManagerState.editingRow = null;
		showEditModal = true;
	}

	function handleEditRow(row: Record<string, unknown>) {
		dbManagerState.isInsertingRow = false;
		dbManagerState.editingRow = { ...row };
		showEditModal = true;
	}

	function handleDeleteSelected() {
		if (!pkInfo || !someSelected) return;
		openBulkDelete();
	}

	function handleDeleteRow(row: Record<string, unknown>) {
		if (!pkInfo) return;
		pendingDeleteRow = { ...row };
		showDeleteConfirm = true;
	}

	function cancelDelete() {
		showDeleteConfirm = false;
		pendingDeleteRow = null;
	}

	async function confirmDelete() {
		if (!pkInfo || !pendingDeleteRow) return;
		showDeleteConfirm = false;
		await deleteRowsAction(pkInfo.column, [pendingDeleteRow[pkInfo.column]]);
		pendingDeleteRow = null;
	}

	// ─── Filter handlers ─────────────────────────────────────────────────────
	function addFilter() {
		const firstCol = dbManagerState.columns[0]?.name ?? (columns[0] ?? '');
		pendingFilters = [...pendingFilters, { column: firstCol, operator: 'like', value: '' }];
	}

	function removeFilter(index: number) {
		pendingFilters = pendingFilters.filter((_, i) => i !== index);
	}

	async function applyFilters() {
		await setFilters(pendingFilters.filter((f) => f.column));
	}

	async function clearFilters() {
		pendingFilters = [];
		await setFilters([]);
	}

	// ─── Sticky header scroll-shadow ─────────────────────────────────────────
	let scrollContainer = $state<HTMLElement | null>(null);
	let isScrolled = $state(false);

	$effect(() => {
		const el = scrollContainer;
		if (!el) return;
		const onScroll = () => { isScrolled = el.scrollTop > 2; };
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	});

	// ─── Value display ────────────────────────────────────────────────────────
	function displayValue(v: unknown): string {
		if (v === null || v === undefined) return '';
		if (typeof v === 'object') return JSON.stringify(v);
		return String(v);
	}

	// ─── Data masking ─────────────────────────────────────────────────────────
	const activeMaskRules = $derived(getActiveMaskRules());
	const maskRuleMap = $derived(
		new Map(activeMaskRules.filter((r) => r.enabled).map((r) => [r.column, r]))
	);
	const activeMaskCount = $derived(maskRuleMap.size);

	function getMaskedValue(col: string, val: unknown): string {
		const display = displayValue(val);
		if (!display) return display;
		const rule = maskRuleMap.get(col);
		if (!rule) return display;
		return applyMask(display, rule.method);
	}
</script>

<div class="flex flex-col h-full min-h-0">
	{#if !readonly}
		<!-- Toolbar -->
		<div class="flex items-center gap-1.5 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0 flex-wrap">
			<button
				type="button"
				class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-violet-600 hover:bg-violet-700 disabled:bg-violet-600/50 text-white transition-colors disabled:cursor-not-allowed"
				onclick={handleAddRow}
				disabled={!dbManagerState.activeTableName || !dbManagerState.columns.length}
				title="Add new row"
			>
				<Icon name="lucide:plus" class="w-3.5 h-3.5" />
				Add Row
			</button>

			{#if someSelected}
				<!-- Bulk delete -->
				<button
					type="button"
					class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-red-600 hover:bg-red-700 text-white transition-colors"
					onclick={handleDeleteSelected}
					disabled={!pkInfo}
					title="Delete selected rows (wrapped in SQL transaction)"
				>
					<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
					{#if dbManagerState.globalSelectionActive}
						Delete all {dbManagerState.browseTotalCount.toLocaleString()} rows
					{:else}
						Delete ({dbManagerState.selectedRowKeys.length})
					{/if}
				</button>

				<!-- Bulk update -->
				<button
					type="button"
					class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
					onclick={openBulkUpdate}
					disabled={!pkInfo || !dbManagerState.columns.length}
					title="Update a column value for selected rows"
				>
					<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
					Update column
				</button>
			{/if}

			<button
				type="button"
				class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors
					{showFilters || dbManagerState.browseFilters.length
						? 'bg-violet-100 dark:bg-violet-900/30 border-violet-400 dark:border-violet-600 text-violet-700 dark:text-violet-300'
						: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600 hover:text-slate-800 dark:hover:text-slate-200'}"
				onclick={() => (showFilters = !showFilters)}
			>
				<Icon name="lucide:filter" class="w-3.5 h-3.5" />
				Filter
				{#if dbManagerState.browseFilters.length}
					<span class="flex items-center justify-center w-4 h-4 rounded-full bg-violet-600 text-white text-[10px] font-bold">
						{dbManagerState.browseFilters.length}
					</span>
				{/if}
			</button>

			<button
				type="button"
				class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed
					{activeMaskCount > 0
						? 'bg-amber-100 dark:bg-amber-900/30 border-amber-400 dark:border-amber-600 text-amber-700 dark:text-amber-300'
						: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600 hover:text-slate-800 dark:hover:text-slate-200'}"
				onclick={openMaskingModal}
				disabled={!dbManagerState.activeTableName || !dbManagerState.columns.length}
				title="Configure data masking for sensitive columns"
			>
				<Icon name="lucide:eye-off" class="w-3.5 h-3.5" />
				Masking
				{#if activeMaskCount > 0}
					<span class="flex items-center justify-center w-4 h-4 rounded-full bg-amber-600 text-white text-[10px] font-bold">
						{activeMaskCount}
					</span>
				{/if}
			</button>

			<div class="flex-1"></div>

			<!-- Import with column mapping -->
			<button
				type="button"
				class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600 hover:text-slate-800 dark:hover:text-slate-200 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
				onclick={openImport}
				disabled={dbExportState.isImporting || !dbManagerState.activeTableName}
				title="Import CSV, JSON, or SQL with column mapping"
			>
				{#if dbExportState.isImporting}
					<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
					Importing…
				{:else}
					<Icon name="lucide:upload" class="w-3.5 h-3.5" />
					Import
				{/if}
			</button>

			<!-- Export (CSV / JSON / SQL Dump) -->
			<button
				type="button"
				class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600 hover:text-slate-800 dark:hover:text-slate-200 transition-colors disabled:opacity-50"
				onclick={openExport}
				disabled={!dbManagerState.activeTableName}
				title="Export as CSV, JSON, or SQL Dump"
			>
				<Icon name="lucide:download" class="w-3.5 h-3.5" />
				Export
			</button>
		</div>

		<!-- Global Selection Banner -->
		{#if canOfferGlobalSelect}
			<div class="flex items-center gap-2 px-3 py-2 border-b border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-900/20 shrink-0 text-xs">
				<Icon name="lucide:info" class="w-3.5 h-3.5 text-violet-500 shrink-0" />
				<span class="text-slate-600 dark:text-slate-400">
					All {dbManagerState.browsePageSize} rows on this page are selected.
				</span>
				<button
					type="button"
					class="font-medium text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 hover:underline transition-colors"
					onclick={() => { dbManagerState.globalSelectionActive = true; }}
				>
					Select all {dbManagerState.browseTotalCount.toLocaleString()} rows
				</button>
			</div>
		{:else if dbManagerState.globalSelectionActive}
			<div class="flex items-center gap-2 px-3 py-2 border-b border-violet-300 dark:border-violet-700 bg-violet-100 dark:bg-violet-900/30 shrink-0 text-xs">
				<Icon name="lucide:check-line" class="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 shrink-0" />
				<span class="font-medium text-violet-700 dark:text-violet-300">
					All {dbManagerState.browseTotalCount.toLocaleString()} rows are selected.
				</span>
				<button
					type="button"
					class="ml-auto text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:underline transition-colors"
					onclick={() => { dbManagerState.globalSelectionActive = false; dbManagerState.selectedRowKeys = []; }}
				>
					Clear selection
				</button>
			</div>
		{/if}

		<!-- Filter Bar -->
		{#if showFilters}
			<div class="flex flex-col gap-2 px-3 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 shrink-0">
				{#if pendingFilters.length === 0}
					<p class="text-xs text-slate-400 dark:text-slate-600 italic">No filters. Click "+ Add Filter" to start.</p>
				{/if}

				{#each pendingFilters as filter, i (i)}
					<div class="flex items-center gap-2">
						<select
							class="px-2 py-1 rounded-md text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-violet-500"
							bind:value={filter.column}
						>
							{#each dbManagerState.columns as col}
								<option value={col.name}>{col.name}</option>
							{/each}
							{#if !dbManagerState.columns.length}
								{#each columns as col}
									<option value={col}>{col}</option>
								{/each}
							{/if}
						</select>

						<select
							class="px-2 py-1 rounded-md text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-violet-500"
							bind:value={filter.operator}
						>
							{#each OPERATORS as op}
								<option value={op.value}>{op.label}</option>
							{/each}
						</select>

						{#if OPERATORS.find((o) => o.value === filter.operator)?.hasValue}
							<input
								type="text"
								class="flex-1 px-2 py-1 rounded-md text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500"
								placeholder="value..."
								bind:value={filter.value}
								onkeydown={(e) => { if (e.key === 'Enter') applyFilters(); }}
							/>
						{:else}
							<div class="flex-1"></div>
						{/if}

						<button
							type="button"
							class="p-1 rounded text-slate-400 hover:text-red-500 transition-colors"
							onclick={() => removeFilter(i)}
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					</div>
				{/each}

				<div class="flex items-center gap-2 pt-1">
					<button
						type="button"
						class="flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300"
						onclick={addFilter}
					>
						<Icon name="lucide:plus" class="w-3 h-3" />
						Add Filter
					</button>
					<div class="flex-1"></div>
					{#if pendingFilters.length > 0 || dbManagerState.browseFilters.length > 0}
						<button
							type="button"
							class="px-2 py-1 rounded-md text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
							onclick={clearFilters}
						>
							Clear All
						</button>
					{/if}
					<button
						type="button"
						class="px-3 py-1 rounded-md text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white transition-colors"
						onclick={applyFilters}
					>
						Apply
					</button>
				</div>
			</div>
		{/if}
	{/if}

	<!-- Error -->
	{#if result?.error}
		<div class="flex items-start gap-2 m-3 px-3 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
			<Icon name="lucide:circle-x" class="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
			<pre class="text-xs text-red-700 dark:text-red-300 whitespace-pre-wrap font-mono">{result.error}</pre>
		</div>
	{/if}

	<!-- Table -->
	{#if result && !result.error && columns.length > 0}
		<div class="flex-1 min-h-0 overflow-auto" bind:this={scrollContainer}>
			<table class="min-w-full text-xs border-separate border-spacing-0">
				<thead class="sticky top-0 z-10">
					<tr>
						{#if !readonly}
							<th class="w-8 px-2 py-2.5 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700
								{isScrolled ? 'shadow-[0_2px_6px_-1px_rgba(0,0,0,0.12)] dark:shadow-[0_2px_8px_-1px_rgba(0,0,0,0.4)]' : ''}
								transition-shadow duration-150">
								<input
									type="checkbox"
									class="w-3.5 h-3.5 rounded accent-violet-600"
									checked={allSelected}
									onchange={toggleAll}
								/>
							</th>
							<th class="w-16 px-2 py-2.5 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700
								{isScrolled ? 'shadow-[0_2px_6px_-1px_rgba(0,0,0,0.12)] dark:shadow-[0_2px_8px_-1px_rgba(0,0,0,0.4)]' : ''}
								transition-shadow duration-150">
							</th>
						{/if}
						{#each columns as col}
							<th class="px-3 py-2.5 text-left font-semibold bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap
								{maskRuleMap.has(col) ? 'text-amber-600 dark:text-amber-400' : 'text-slate-600 dark:text-slate-400'}
								{isScrolled ? 'shadow-[0_2px_6px_-1px_rgba(0,0,0,0.12)] dark:shadow-[0_2px_8px_-1px_rgba(0,0,0,0.4)]' : ''}
								transition-shadow duration-150">
								<div class="flex items-center gap-1">
									{col}
									{#if maskRuleMap.has(col)}
										<Icon name="lucide:eye-off" class="w-3 h-3 text-amber-500 shrink-0" />
									{/if}
								</div>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each rows as row, rowIndex (rowIndex)}
						{@const isSelected = selectedSet.has(rowKey(row))}
						<tr class="group transition-colors {isSelected ? 'bg-violet-50 dark:bg-violet-900/20' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}">
							{#if !readonly}
								<td class="px-2 py-1.5 border-b border-slate-100 dark:border-slate-800">
									<input
										type="checkbox"
										class="w-3.5 h-3.5 rounded accent-violet-600"
										checked={isSelected}
										onchange={() => toggleRow(row)}
									/>
								</td>
								<td class="px-2 py-1.5 border-b border-slate-100 dark:border-slate-800">
									<div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
										<button
											type="button"
											class="p-1 rounded text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
											onclick={() => handleEditRow(row)}
											title="Edit row"
										>
											<Icon name="lucide:pencil" class="w-3 h-3" />
										</button>
										<button
											type="button"
											class="p-1 rounded text-slate-400 hover:text-red-500 transition-colors"
											onclick={() => handleDeleteRow(row)}
											title="Delete row"
										>
											<Icon name="lucide:trash-2" class="w-3 h-3" />
										</button>
									</div>
								</td>
							{/if}
							{#each columns as col}
								{@const val = row[col]}
								{@const isMasked = maskRuleMap.has(col)}
								<td class="px-3 py-1.5 border-b border-slate-100 dark:border-slate-800 max-w-64 truncate
									{val === null || val === undefined
										? 'text-slate-400 dark:text-slate-600 italic'
										: isMasked
											? 'text-amber-600 dark:text-amber-400 font-mono'
											: 'text-slate-800 dark:text-slate-200'}">
									{#if val === null || val === undefined}
										NULL
									{:else}
										{getMaskedValue(col, val)}
									{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Status bar + Pagination -->
		<div class="flex items-center justify-between gap-3 px-3 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 shrink-0 text-xs text-slate-500 dark:text-slate-400">
			<div class="flex items-center gap-3">
				{#if !readonly && totalCount > 0}
					<span>
						{startRow}–{endRow} of {totalCount.toLocaleString()} rows
						{#if dbManagerState.isLoadingCount}
							<span class="opacity-60">(loading…)</span>
						{/if}
					</span>
				{:else}
					<span>{result.rowCount} row{result.rowCount !== 1 ? 's' : ''}</span>
				{/if}
				{#if result.executionTimeMs > 0}
					<span class="text-slate-400 dark:text-slate-600">{result.executionTimeMs}ms</span>
				{/if}
			</div>

			{#if !readonly}
				<div class="flex items-center gap-2">
					<select
						class="px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500"
						value={pageSize}
						onchange={(e) => setPageSize(parseInt((e.currentTarget as HTMLSelectElement).value, 10))}
					>
						{#each PAGE_SIZES as size}
							<option value={size}>{size} / page</option>
						{/each}
					</select>

					<button
						type="button"
						class="p-1 rounded border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
						onclick={() => goToPage(page - 1)}
						disabled={page === 0 || dbManagerState.isLoadingBrowse}
						title="Previous page"
					>
						<Icon name="lucide:chevron-left" class="w-3.5 h-3.5" />
					</button>

					<span>{page + 1} / {totalPages}</span>

					<button
						type="button"
						class="p-1 rounded border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
						onclick={() => goToPage(page + 1)}
						disabled={page >= totalPages - 1 || dbManagerState.isLoadingBrowse}
						title="Next page"
					>
						<Icon name="lucide:chevron-right" class="w-3.5 h-3.5" />
					</button>
				</div>
			{/if}
		</div>
	{:else if result && !result.error && columns.length === 0}
		<div class="flex flex-col items-center justify-center flex-1 gap-2 text-slate-400 text-sm">
			<Icon name="lucide:inbox" class="w-8 h-8 opacity-30" />
			<span>No data</span>
		</div>
	{/if}
</div>


{#if showDeleteConfirm}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
	>
		<div class="bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 p-6 w-80 max-w-[90vw]">
			<div class="flex items-center gap-3 mb-4">
				<div class="p-2 rounded-full bg-red-100 dark:bg-red-900/30 shrink-0">
					<Icon name="lucide:trash-2" class="w-5 h-5 text-red-600 dark:text-red-400" />
				</div>
				<h3 class="text-sm font-semibold text-slate-800 dark:text-slate-200">Delete Row</h3>
			</div>
			<p class="text-sm text-slate-600 dark:text-slate-400 mb-5">
				Are you sure you want to delete this row? This action cannot be undone.
			</p>
			<div class="flex items-center justify-end gap-2">
				<button
					type="button"
					class="px-3 py-1.5 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
					onclick={cancelDelete}
				>
					Cancel
				</button>
				<button
					type="button"
					class="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					onclick={confirmDelete}
					disabled={dbManagerState.isDeletingRows}
				>
					{#if dbManagerState.isDeletingRows}
						<svg class="w-4 h-4 animate-spin inline mr-1" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
						Deleting…
					{:else}
						Delete Row
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}
<RowEditModal
	isOpen={showEditModal}
	onClose={() => { showEditModal = false; }}
/>

<DataMaskingModal />
<BulkActionModal />

{#if dbManagerState.activeConnectionId && dbManagerState.activeTableName}
	<ExportModal
		connectionId={dbManagerState.activeConnectionId}
		tableName={dbManagerState.activeTableName}
		schema={dbManagerState.activeTableSchema ?? undefined}
	/>
	<ImportModal
		connectionId={dbManagerState.activeConnectionId}
		tableName={dbManagerState.activeTableName}
		schema={dbManagerState.activeTableSchema ?? undefined}
		tableColumns={dbManagerState.columns}
	/>
{/if}
