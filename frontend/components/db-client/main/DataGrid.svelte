<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ConfirmDestructive from '../shared/ConfirmDestructive.svelte';
	import CellViewer from '../shared/CellViewer.svelte';
	import RowForm from '../shared/RowForm.svelte';
	import Checkbox from '../shared/Checkbox.svelte';
	import NullValue from '../shared/NullValue.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { debug } from '$shared/utils/logger';
	import type {
		DbClientObjectColumn,
		DbClientObjectDetails,
		DbClientQueryResult,
		DbDriver
	} from '$shared/types/db-client';

	interface Props {
		connectionId: string;
		driver: DbDriver;
		objectName: string;
		database?: string;
		schema?: string;
		/** Pre-applied filter (foreign-key jump / history replay). */
		filter?: { column: string; op: string; value: string } | null;
	}

	const { connectionId, driver, objectName, database, schema, filter = null }: Props = $props();

	type SortDir = 'asc' | 'desc' | null;

	type Operator =
		| '=' | '!=' | '<' | '<=' | '>' | '>='
		| 'CONTAINS' | 'STARTS WITH' | 'ENDS WITH'
		| 'LIKE' | 'NOT LIKE' | 'ILIKE'
		| 'IN' | 'NOT IN'
		| 'IS NULL' | 'IS NOT NULL';

	interface FilterCondition {
		column: string;
		op: Operator;
		value: string;
	}

	const SQL_OPS_BASE: Operator[] = [
		'=', '!=', '<', '<=', '>', '>=',
		'CONTAINS', 'STARTS WITH', 'ENDS WITH',
		'LIKE', 'NOT LIKE',
		'IN', 'NOT IN',
		'IS NULL', 'IS NOT NULL'
	];
	const SQL_OPS_PG: Operator[] = [
		'=', '!=', '<', '<=', '>', '>=',
		'CONTAINS', 'STARTS WITH', 'ENDS WITH',
		'LIKE', 'NOT LIKE', 'ILIKE',
		'IN', 'NOT IN',
		'IS NULL', 'IS NOT NULL'
	];
	const VALUELESS_OPS = new Set<Operator>(['IS NULL', 'IS NOT NULL']);
	const LIST_OPS = new Set<Operator>(['IN', 'NOT IN']);
	const PRESET_LIKE_OPS = new Set<Operator>(['CONTAINS', 'STARTS WITH', 'ENDS WITH']);

	let result = $state<DbClientQueryResult | null>(null);
	let details = $state<DbClientObjectDetails | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let page = $state(0);
	let totalRows = $state<number | null>(null);
	let countLoading = $state(false);
	const pageSize = 100;

	let editing = $state<{ rowIdx: number; col: string } | null>(null);
	let editValue = $state('');
	let pendingChanges = $state<Map<string, Record<string, unknown>>>(new Map());
	let editInputEl = $state<HTMLTextAreaElement | null>(null);

	let selected = $state<Set<number>>(new Set());
	let confirmDelete = $state(false);
	let insertOpen = $state(false);

	let cellOpen = $state(false);
	let cellColumn = $state('');
	let cellValue = $state<unknown>(null);
	let cellRowIdx = $state(-1);

	const fkMap = $derived(new Map((details?.foreignKeys ?? []).map((fk) => [fk.column, fk])));

	const cellFk = $derived(cellColumn ? fkMap.get(cellColumn) ?? null : null);
	const cellNullable = $derived(
		(details?.columns ?? []).find((c) => c.name === cellColumn)?.nullable ?? false
	);

	function openCell(rowIdx: number, col: string, value: unknown): void {
		cellRowIdx = rowIdx;
		cellColumn = col;
		cellValue = value;
		cellOpen = true;
	}

	// Stage an edit made from the cell viewer the same way an inline edit is
	// staged — it joins pendingChanges and is written on "Save changes".
	function saveCell(value: unknown): void {
		if (cellRowIdx < 0 || !cellColumn) return;
		const key = pkKey(cellRowIdx);
		const map = new Map(pendingChanges);
		const existing = map.get(key) ?? {};
		map.set(key, { ...existing, [cellColumn]: value });
		pendingChanges = map;
	}

	function jumpToFk(col: string, value: unknown): void {
		const fk = fkMap.get(col);
		if (!fk || value === null || value === undefined) return;
		// Carry the filter on the active object so back/forward history replays
		// the same filtered view of the referenced table.
		dbClientStore.setActiveObject(connectionId, {
			name: fk.refTable,
			type: 'table',
			database,
			schema,
			filter: { column: fk.refColumn, op: '=', value: String(value) }
		});
		dbClientStore.setView(connectionId, 'data');
	}

	let showSearch = $state(false);
	let conditions = $state<FilterCondition[]>([]);
	let sortColumn = $state<string | null>(null);
	let sortDir = $state<SortDir>(null);

	const isTabular = $derived(driver === 'mysql' || driver === 'postgres' || driver === 'sqlite');
	const operators = $derived<Operator[]>(driver === 'postgres' ? SQL_OPS_PG : SQL_OPS_BASE);

	const pkColumns = $derived<DbClientObjectColumn[]>(
		(details?.columns ?? []).filter((c) => c.isPrimary)
	);
	const hasPk = $derived(pkColumns.length > 0);

	const rangeStart = $derived(result && (result.rows?.length ?? 0) > 0 ? page * pageSize + 1 : 0);
	const rangeEnd = $derived(result ? page * pageSize + (result.rows?.length ?? 0) : 0);
	const hasNext = $derived(result ? (result.rows?.length ?? 0) === pageSize : false);
	const totalPages = $derived(totalRows !== null ? Math.max(1, Math.ceil(totalRows / pageSize)) : null);

	function quoteIdent(name: string): string {
		switch (driver) {
			case 'mysql': return '`' + name.replace(/`/g, '``') + '`';
			case 'postgres':
			case 'sqlite': return '"' + name.replace(/"/g, '""') + '"';
			default: return name;
		}
	}

	function placeholder(idx: number): string {
		return driver === 'postgres' ? `$${idx + 1}` : '?';
	}

	function escapeLike(value: string): string {
		return value.replace(/[\\%_]/g, (m) => `\\${m}`);
	}

	function buildWhereClause(): { sql: string; params: unknown[] } {
		const params: unknown[] = [];
		const parts: string[] = [];
		for (const c of conditions) {
			if (!c.column || !c.op) continue;
			const col = quoteIdent(c.column);
			if (VALUELESS_OPS.has(c.op)) {
				parts.push(`${col} ${c.op}`);
			} else if (LIST_OPS.has(c.op)) {
				const items = c.value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
				if (items.length === 0) continue;
				const phs: string[] = [];
				for (const it of items) {
					phs.push(placeholder(params.length));
					params.push(it);
				}
				parts.push(`${col} ${c.op} (${phs.join(', ')})`);
			} else if (PRESET_LIKE_OPS.has(c.op)) {
				const escaped = escapeLike(c.value);
				let pattern: string;
				if (c.op === 'CONTAINS') pattern = `%${escaped}%`;
				else if (c.op === 'STARTS WITH') pattern = `${escaped}%`;
				else pattern = `%${escaped}`;
				parts.push(`${col} LIKE ${placeholder(params.length)}`);
				params.push(pattern);
			} else {
				parts.push(`${col} ${c.op} ${placeholder(params.length)}`);
				params.push(c.value);
			}
		}
		return { sql: parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '', params };
	}

	function buildSelectSql(): { sql: string; params: unknown[] } | string {
		if (driver === 'mongodb') {
			return JSON.stringify({
				collection: objectName,
				op: 'find',
				args: [{}, { limit: pageSize, skip: page * pageSize }]
			});
		}
		if (driver === 'redis') {
			return JSON.stringify(['SCAN', String(page * pageSize), 'MATCH', '*', 'COUNT', String(pageSize)]);
		}
		const qualified = schema ? `${quoteIdent(schema)}.${quoteIdent(objectName)}` : quoteIdent(objectName);
		const where = buildWhereClause();
		const orderBy = sortColumn && sortDir
			? ` ORDER BY ${quoteIdent(sortColumn)} ${sortDir.toUpperCase()}`
			: '';
		const offset = page * pageSize;
		const limitClause = ` LIMIT ${pageSize} OFFSET ${offset}`;
		return {
			sql: `SELECT * FROM ${qualified}${where.sql}${orderBy}${limitClause}`,
			params: where.params
		};
	}

	async function load(): Promise<void> {
		loading = true;
		error = null;
		try {
			const opts: { database?: string; schema?: string; name: string; type: 'table' | 'collection' | 'view' | 'key' } = {
				name: objectName,
				type: driver === 'mongodb' ? 'collection' : driver === 'redis' ? 'key' : 'table',
				database,
				schema
			};
			details = await dbClientStore.getObjectDetails(connectionId, opts);
			const built = buildSelectSql();
			if (typeof built === 'string') {
				result = await dbClientStore.executeRead(connectionId, built, { database });
			} else {
				const ws = (await import('$frontend/utils/ws')).default;
				result = (await ws.http('db-client:execute-read', {
					connectionId,
					query: built.sql,
					params: built.params,
					database
				})) as DbClientQueryResult;
			}
			pendingChanges = new Map();
			selected = new Set();
			void loadCount();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			debug.error('db-client', 'data load failed:', e);
		} finally {
			loading = false;
		}
	}

	async function loadCount(): Promise<number | null> {
		if (!isTabular) return null;
		countLoading = true;
		try {
			const qualified = schema ? `${quoteIdent(schema)}.${quoteIdent(objectName)}` : quoteIdent(objectName);
			const where = buildWhereClause();
			const sql = `SELECT COUNT(*) AS c FROM ${qualified}${where.sql}`;
			const ws = (await import('$frontend/utils/ws')).default;
			const res = (await ws.http('db-client:execute-read', {
				connectionId,
				query: sql,
				params: where.params,
				database
			})) as DbClientQueryResult;
			const row = res.rows[0] ?? {};
			const raw = row.c ?? row.C ?? Object.values(row)[0];
			const n = typeof raw === 'number' ? raw : Number(raw);
			if (!Number.isFinite(n)) return null;
			totalRows = n;
			return n;
		} catch (e) {
			debug.warn('db-client', 'count failed:', e);
			return null;
		} finally {
			countLoading = false;
		}
	}

	$effect(() => {
		// Re-evaluate on object change, explicit (re)selection, and history jumps
		// (navObjectTick). The pre-applied filter is read untracked and consumed,
		// so switching tabs (which remounts the grid) or reloading the same object
		// never re-applies a filter the user has navigated past — while back/forward
		// still replays it, because each history jump bumps the tick and re-seeds
		// the filter from its own snapshot copy.
		const tick = dbClientStore.navObjectTick;
		const objKey = `${connectionId}::${objectName}`;
		void objKey;
		if (objectName && connectionId) {
			// Apply the relation filter once per navigation. Claimed untracked so it
			// neither re-triggers this effect nor mutates the object history relies on.
			const applied = untrack(() =>
				filter && dbClientStore.claimFilterApplication(connectionId, tick) ? filter : null
			);
			page = 0;
			sortColumn = null;
			sortDir = null;
			totalRows = null;
			if (applied) {
				conditions = [{ column: applied.column, op: applied.op as Operator, value: applied.value }];
				showSearch = true;
			} else {
				conditions = [];
			}
			load();
		}
	});

	// External reload signal (e.g. after truncate/reset on this object).
	// Tracks only dataNonce; reads object refs untracked so switching tables
	// doesn't double-load via this effect.
	let dataSignalReady = false;
	$effect(() => {
		dbClientStore.dataNonce;
		untrack(() => {
			if (dataSignalReady && objectName && connectionId) {
				totalRows = null;
				load();
			}
			dataSignalReady = true;
		});
	});

	function applyFilter(): void {
		page = 0;
		totalRows = null;
		load();
	}

	function clearFilter(): void {
		conditions = [];
		page = 0;
		totalRows = null;
		load();
	}

	function addCondition(): void {
		const firstCol = details?.columns?.[0]?.name ?? '';
		conditions = [...conditions, { column: firstCol, op: '=', value: '' }];
	}

	function toggleSearch(): void {
		showSearch = !showSearch;
		if (showSearch && conditions.length === 0) addCondition();
	}

	function removeCondition(i: number): void {
		conditions = conditions.filter((_, idx) => idx !== i);
		if (conditions.length === 0) {
			totalRows = null;
			load();
		}
	}

	function toggleSort(colName: string): void {
		if (sortColumn !== colName) {
			sortColumn = colName;
			sortDir = 'asc';
		} else if (sortDir === 'asc') {
			sortDir = 'desc';
		} else {
			sortColumn = null;
			sortDir = null;
		}
		page = 0;
		load();
	}

	function startEdit(rowIdx: number, col: string, current: unknown): void {
		if (!hasPk) return;
		editing = { rowIdx, col };
		editValue = current === null || current === undefined ? '' : typeof current === 'object' ? JSON.stringify(current) : String(current);
	}

	function cancelEdit(): void {
		editing = null;
		editValue = '';
	}

	function pkOf(rowIdx: number): Record<string, unknown> {
		const row = result?.rows[rowIdx] ?? {};
		const pk: Record<string, unknown> = {};
		for (const c of pkColumns) pk[c.name] = row[c.name];
		return pk;
	}

	function pkKey(rowIdx: number): string {
		return JSON.stringify(pkOf(rowIdx));
	}

	function commitEdit(): void {
		if (!editing) return;
		const key = pkKey(editing.rowIdx);
		const map = new Map(pendingChanges);
		const existing = map.get(key) ?? {};
		map.set(key, { ...existing, [editing.col]: editValue });
		pendingChanges = map;
		editing = null;
		editValue = '';
	}

	function commitEditNull(): void {
		if (!editing) return;
		const key = pkKey(editing.rowIdx);
		const map = new Map(pendingChanges);
		const existing = map.get(key) ?? {};
		map.set(key, { ...existing, [editing.col]: null });
		pendingChanges = map;
		editing = null;
		editValue = '';
	}

	function discardChanges(): void {
		pendingChanges = new Map();
	}

	function handleWindowKeydown(e: KeyboardEvent): void {
		if (!editing) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			cancelEdit();
		} else if (e.key === 'Enter' && document.activeElement !== editInputEl) {
			e.preventDefault();
			commitEdit();
		}
	}

	function handleWindowMouseDown(e: MouseEvent): void {
		if (!editing) return;
		const target = e.target as Node | null;
		if (editInputEl && target && editInputEl.contains(target)) return;
		commitEdit();
	}

	async function saveChanges(): Promise<void> {
		if (pendingChanges.size === 0) return;
		loading = true;
		error = null;
		try {
			for (const [key, changes] of pendingChanges) {
				const pk = JSON.parse(key) as Record<string, unknown>;
				await dbClientStore.updateRow(connectionId, objectName, pk, changes, { database, schema });
			}
			pendingChanges = new Map();
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	function toggleSelect(idx: number): void {
		const next = new Set(selected);
		if (next.has(idx)) next.delete(idx);
		else next.add(idx);
		selected = next;
	}

	function toggleAll(): void {
		if (!result) return;
		if (selected.size === result.rows.length) selected = new Set();
		else selected = new Set(result.rows.map((_, i) => i));
	}

	async function doDelete(): Promise<void> {
		if (selected.size === 0) return;
		const pks = Array.from(selected).map((i) => pkOf(i));
		try {
			await dbClientStore.deleteRows(connectionId, objectName, pks, { database, schema });
			totalRows = null;
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function doInsert(row: Record<string, unknown>): Promise<void> {
		await dbClientStore.insertRow(connectionId, objectName, row, { database, schema });
		totalRows = null;
		await load();
	}

	function isNullish(v: unknown): boolean {
		return v === null || v === undefined;
	}

	function fmt(v: unknown): string {
		if (isNullish(v)) return '';
		if (typeof v === 'object') return JSON.stringify(v);
		return String(v);
	}

	function nextPage(): void {
		if (!hasNext) return;
		page++;
		load();
	}
	function prevPage(): void {
		if (page > 0) {
			page--;
			load();
		}
	}
	function firstPage(): void {
		if (page === 0) return;
		page = 0;
		load();
	}
	async function lastPage(): Promise<void> {
		const count = totalRows ?? (await loadCount());
		if (count === null || count === undefined) return;
		const last = Math.max(0, Math.ceil(count / pageSize) - 1);
		if (page === last) return;
		page = last;
		await load();
	}

	function sortIcon(col: string): 'lucide:chevrons-up-down' | 'lucide:chevron-up' | 'lucide:chevron-down' {
		if (sortColumn !== col) return 'lucide:chevrons-up-down';
		return sortDir === 'asc' ? 'lucide:chevron-up' : 'lucide:chevron-down';
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} onmousedown={handleWindowMouseDown} />

<div class="flex flex-col h-full min-h-0">
	<div class="flex items-center gap-1 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0 text-sm flex-wrap">
		<div class="flex items-center gap-1 flex-wrap">
			<button
				type="button"
				class="flex items-center gap-1.5 h-7 px-2 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors"
				onclick={load}
				disabled={loading}
				title="Refresh"
				aria-label="Refresh"
			>
				<Icon name={loading ? 'lucide:loader' : 'lucide:refresh-cw'} class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" />
				<span class="hidden sm:inline">Refresh</span>
			</button>
			{#if isTabular}
				<button
					type="button"
					class="flex items-center gap-1.5 h-7 px-2 rounded-md transition-colors {showSearch || conditions.length > 0 ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}"
					onclick={toggleSearch}
					title="Search"
					aria-label="Search"
				>
					<Icon name="lucide:search" class="w-3.5 h-3.5" />
					<span class="hidden sm:inline">Search{conditions.length > 0 ? ` (${conditions.length})` : ''}</span>
					{#if conditions.length > 0}
						<span class="sm:hidden text-[10px] font-semibold">{conditions.length}</span>
					{/if}
				</button>
			{/if}
			<button
				type="button"
				class="flex items-center gap-1.5 h-7 px-2 rounded-md text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50 transition-colors"
				onclick={() => (insertOpen = true)}
				disabled={!details?.columns}
				title="Add row"
				aria-label="Add row"
			>
				<Icon name="lucide:plus" class="w-3.5 h-3.5" />
				<span class="hidden sm:inline">Add row</span>
			</button>
			<button
				type="button"
				class="flex items-center gap-1.5 h-7 px-2 rounded-md text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
				onclick={() => (confirmDelete = true)}
				disabled={selected.size === 0 || !hasPk}
				title={!hasPk ? 'No primary key — cannot delete by row' : 'Delete selected'}
				aria-label="Delete selected"
			>
				<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
				<span class="hidden sm:inline">Delete{selected.size > 0 ? ` (${selected.size})` : ''}</span>
				{#if selected.size > 0}
					<span class="sm:hidden text-[10px] font-semibold">{selected.size}</span>
				{/if}
			</button>
			{#if pendingChanges.size > 0}
				<button
					type="button"
					class="flex items-center gap-1.5 h-7 px-2 rounded-md text-violet-700 dark:text-violet-300 bg-violet-500/10 hover:bg-violet-500/20 disabled:opacity-50 transition-colors"
					onclick={saveChanges}
					disabled={loading}
					title="Save pending changes"
					aria-label="Save pending changes"
				>
					<Icon name="lucide:save" class="w-3.5 h-3.5" />
					<span class="hidden sm:inline">Save {pendingChanges.size} change{pendingChanges.size === 1 ? '' : 's'}</span>
					<span class="sm:hidden text-[10px] font-semibold">{pendingChanges.size}</span>
				</button>
				<button
					type="button"
					class="flex items-center gap-1.5 h-7 px-2 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors"
					onclick={discardChanges}
					disabled={loading}
					title="Discard pending changes"
					aria-label="Discard pending changes"
				>
					<Icon name="lucide:undo-2" class="w-3.5 h-3.5" />
					<span class="hidden sm:inline">Discard</span>
				</button>
			{/if}
		</div>
		<div class="flex-1 min-w-0"></div>

		<div class="flex items-center gap-0.5 ml-auto">
			<button
				type="button"
				class="hidden sm:flex items-center justify-center w-7 h-7 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
				onclick={firstPage}
				disabled={page === 0 || loading}
				title="First page"
				aria-label="First page"
			>
				<Icon name="lucide:chevrons-left" class="w-3.5 h-3.5" />
			</button>
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
				onclick={prevPage}
				disabled={page === 0 || loading}
				title="Previous page"
				aria-label="Previous page"
			>
				<Icon name="lucide:chevron-left" class="w-3.5 h-3.5" />
			</button>
			<div class="px-2 text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap text-center">
				{#if result}
					{rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}
					<span class="text-slate-400">
						{#if totalRows !== null}
							of {totalRows.toLocaleString()}
						{:else if countLoading}
							of …
						{/if}
					</span>
				{:else}
					—
				{/if}
			</div>
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
				onclick={nextPage}
				disabled={!hasNext || loading}
				title="Next page"
				aria-label="Next page"
			>
				<Icon name="lucide:chevron-right" class="w-3.5 h-3.5" />
			</button>
			<button
				type="button"
				class="hidden sm:flex items-center justify-center w-7 h-7 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
				onclick={lastPage}
				disabled={loading || countLoading || (totalRows !== null && page >= (totalPages ?? 1) - 1)}
				title={totalRows === null ? 'Last page (loads total count)' : 'Last page'}
				aria-label="Last page"
			>
				<Icon name="lucide:chevrons-right" class="w-3.5 h-3.5" />
			</button>
		</div>
	</div>

	{#if showSearch && isTabular}
		<div class="px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 shrink-0 space-y-2">
			<div class="max-w-2xl space-y-1.5">
				{#each conditions as cond, i (i)}
					<div class="flex items-center gap-1.5">
						<select
							class="px-1.5 py-1 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded min-w-[120px] max-w-[180px]"
							bind:value={cond.column}
						>
							{#each details?.columns ?? [] as col (col.name)}
								<option value={col.name}>{col.name}</option>
							{/each}
						</select>
						<select
							class="px-1.5 py-1 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
							bind:value={cond.op}
						>
							{#each operators as op (op)}
								<option value={op}>{op}</option>
							{/each}
						</select>
						<input
							type="text"
							class="flex-1 min-w-0 px-2 py-1 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded disabled:opacity-50"
							placeholder={LIST_OPS.has(cond.op) ? 'comma-separated' : VALUELESS_OPS.has(cond.op) ? '—' : 'value'}
							bind:value={cond.value}
							disabled={VALUELESS_OPS.has(cond.op)}
							onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyFilter(); } }}
						/>
						<button
							type="button"
							class="text-slate-500 hover:text-red-600 hover:bg-red-500/10 rounded p-1 shrink-0"
							onclick={() => removeCondition(i)}
							aria-label="Remove condition"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					</div>
				{/each}
			</div>
			<div class="flex items-center gap-2 max-w-2xl">
				<button
					type="button"
					class="flex items-center gap-1 px-2 py-1 text-xs rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
					onclick={addCondition}
				>
					<Icon name="lucide:plus" class="w-3 h-3" /> Add condition
				</button>
				<button
					type="button"
					class="flex items-center gap-1 px-2 py-1 text-xs rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50"
					onclick={applyFilter}
					disabled={loading}
				>
					<Icon name="lucide:filter" class="w-3 h-3" /> Apply
				</button>
				{#if conditions.length > 0}
					<button
						type="button"
						class="flex items-center gap-1 px-2 py-1 text-xs rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
						onclick={clearFilter}
					>
						<Icon name="lucide:eraser" class="w-3 h-3" /> Clear
					</button>
				{/if}
			</div>
		</div>
	{/if}

	{#if !hasPk && result}
		<div class="px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-500/10 border-b border-amber-500/20" title="No primary key detected — row-level edits and deletes are disabled">
			Read-only: no primary key on this table.
		</div>
	{/if}

	<div class="flex-1 min-h-0 overflow-auto">
		{#if error}
			<pre class="p-3 text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap">{error}</pre>
		{:else if result && (result.rows?.length ?? 0) > 0}
			<table class="w-full text-sm border-collapse bg-slate-50 dark:bg-slate-800/50">
				<thead class="sticky top-0 bg-slate-200 dark:bg-slate-800 z-10">
					<tr>
						<th class="px-3 py-1.5 w-8 border-b border-slate-200 dark:border-slate-800">
							<Checkbox disabled={!hasPk} checked={selected.size > 0 && selected.size === result.rows.length} onchange={toggleAll} />
						</th>
						<th class="px-3 py-1.5 text-left font-semibold text-slate-500 border-b border-slate-200 dark:border-slate-800 w-10">#</th>
						{#each result.columns as col (col.name)}
							<th class="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-200 border-b border-slate-200 dark:border-slate-800">
								<button
									type="button"
									class="flex items-center gap-1 hover:text-violet-600 dark:hover:text-violet-400 disabled:hover:text-slate-700"
									onclick={() => isTabular && toggleSort(col.name)}
									disabled={!isTabular}
									title={isTabular ? 'Sort' : ''}
								>
									<div class="flex flex-col items-start">
										<span>{col.name}</span>
										{#if col.type}
											<span class="text-[10px] text-slate-400 font-normal">{col.type}</span>
										{/if}
									</div>
									{#if isTabular}
										<Icon name={sortIcon(col.name)} class="w-3 h-3 {sortColumn === col.name ? 'text-violet-600 dark:text-violet-400' : 'text-slate-400'}" />
									{/if}
								</button>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each result.rows as row, i (i)}
						<tr class="hover:bg-slate-100 dark:hover:bg-slate-800/60">
							<td class="px-3 py-1.5 border-b border-slate-100 dark:border-slate-800">
								<Checkbox disabled={!hasPk} checked={selected.has(i)} onchange={() => toggleSelect(i)} />
							</td>
							<td class="px-3 py-1.5 text-slate-400 border-b border-slate-100 dark:border-slate-800">{page * pageSize + i + 1}</td>
							{#each result.columns as col (col.name)}
								{@const isEditing = editing?.rowIdx === i && editing.col === col.name}
								{@const pendingVal = pendingChanges.get(pkKey(i))?.[col.name]}
								{@const display = pendingVal !== undefined ? pendingVal : row[col.name]}
								<td
									class="relative group px-3 py-1.5 border-b border-slate-100 dark:border-slate-800 text-slate-700 dark:text-slate-300 max-w-[400px] {pendingVal !== undefined ? 'bg-amber-50 dark:bg-amber-900/20' : ''}"
									ondblclick={() => startEdit(i, col.name, display)}
									title={hasPk ? 'Double-click to edit' : 'Read-only (no PK)'}
								>
									{#if !isEditing}
										<div class="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-0.5">
											{#if fkMap.has(col.name) && !isNullish(display)}
												<button
													type="button"
													class="flex items-center justify-center w-5 h-5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 shadow-sm"
													title={`Go to ${fkMap.get(col.name)?.refTable}`}
													onmousedown={(e) => e.stopPropagation()}
													onclick={(e) => { e.stopPropagation(); jumpToFk(col.name, display); }}
												>
													<Icon name="lucide:arrow-up-right" class="w-3 h-3" />
												</button>
											{/if}
											{#if !isNullish(display)}
												<button
													type="button"
													class="flex items-center justify-center w-5 h-5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 shadow-sm"
													title="View value"
													onmousedown={(e) => e.stopPropagation()}
													onclick={(e) => { e.stopPropagation(); openCell(i, col.name, display); }}
												>
													<Icon name="lucide:maximize-2" class="w-3 h-3" />
												</button>
											{/if}
										</div>
									{/if}
									{#if isEditing}
										{@const colMeta = details?.columns?.find((c) => c.name === col.name)}
										<div class="flex items-start gap-1.5">
											<textarea
												bind:this={editInputEl}
												rows={Math.min(6, Math.max(1, editValue.split('\n').length))}
												class="flex-1 min-w-0 px-1 py-0.5 bg-white dark:bg-slate-800 border border-violet-500 rounded text-sm resize-y"
												bind:value={editValue}
												autofocus
												onkeydown={(e) => {
													if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
													else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
												}}
											></textarea>
											{#if !colMeta || colMeta.nullable}
												<button
													type="button"
													class="shrink-0 px-2 py-0.5 text-[10px] font-medium rounded border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors"
													title="Set NULL"
													onclick={(e) => { e.stopPropagation(); commitEditNull(); }}
													onmousedown={(e) => e.stopPropagation()}
												>NULL</button>
											{/if}
										</div>
									{:else if isNullish(display)}
										<NullValue />
									{:else}
										<span class="truncate block">{fmt(display)}</span>
									{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		{:else if result}
			<div class="p-4 text-sm text-slate-400">No rows.</div>
		{:else if loading}
			<div class="p-4 text-sm text-slate-400">Loading…</div>
		{/if}
	</div>
</div>

{#if details?.columns}
	<RowForm
		bind:isOpen={insertOpen}
		title={`Insert into ${objectName}`}
		columns={details.columns}
		foreignKeys={details.foreignKeys ?? []}
		{connectionId}
		{driver}
		{database}
		{schema}
		onSubmit={doInsert}
		onClose={() => (insertOpen = false)}
	/>
{/if}

<ConfirmDestructive
	bind:isOpen={confirmDelete}
	title="Delete rows?"
	message={`Delete ${selected.size} row${selected.size === 1 ? '' : 's'} from "${objectName}"? This cannot be undone.`}
	confirmText="Delete"
	onConfirm={doDelete}
	onClose={() => (confirmDelete = false)}
/>

<CellViewer
	bind:isOpen={cellOpen}
	column={cellColumn}
	value={cellValue}
	table={objectName}
	editable={hasPk}
	nullable={cellNullable}
	onSave={saveCell}
	fk={cellFk}
	{connectionId}
	{driver}
	{database}
	{schema}
	onClose={() => (cellOpen = false)}
/>
