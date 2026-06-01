<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { debug } from '$shared/utils/logger';
	import type { DbClientQueryResult, DbDriver } from '$shared/types/db-client';

	interface Props {
		isOpen: boolean;
		connectionId: string;
		driver: DbDriver;
		refTable: string;
		refColumn: string;
		database?: string;
		schema?: string;
		onPick: (value: unknown) => void;
		onClose: () => void;
	}

	let {
		isOpen = $bindable(),
		connectionId,
		driver,
		refTable,
		refColumn,
		database,
		schema,
		onPick,
		onClose
	}: Props = $props();

	const LIMIT = 200;

	let result = $state<DbClientQueryResult | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let filter = $state('');

	function quoteIdent(name: string): string {
		switch (driver) {
			case 'mysql': return '`' + name.replace(/`/g, '``') + '`';
			case 'postgres':
			case 'sqlite': return '"' + name.replace(/"/g, '""') + '"';
			default: return name;
		}
	}

	async function load(): Promise<void> {
		loading = true;
		error = null;
		try {
			const qualified = schema ? `${quoteIdent(schema)}.${quoteIdent(refTable)}` : quoteIdent(refTable);
			result = await dbClientStore.executeRead(
				connectionId,
				`SELECT * FROM ${qualified} LIMIT ${LIMIT}`,
				{ database }
			);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			debug.error('db-client', 'fk lookup load failed:', e);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (isOpen) {
			filter = '';
			result = null;
			void load();
		}
	});

	function fmt(v: unknown): string {
		if (v === null || v === undefined) return '';
		if (typeof v === 'object') return JSON.stringify(v);
		return String(v);
	}

	const rows = $derived(result?.rows ?? []);
	const filtered = $derived(
		filter.trim()
			? rows.filter((r) => Object.values(r).some((v) => fmt(v).toLowerCase().includes(filter.trim().toLowerCase())))
			: rows
	);

	function pick(value: unknown): void {
		onPick(value);
		onClose();
	}
</script>

<Modal bind:isOpen {onClose} title={`Pick ${refTable}.${refColumn}`} size="lg">
	{#snippet children()}
		<div class="space-y-2">
			<div class="flex items-center gap-2">
				<div class="relative flex-1">
					<Icon name="lucide:search" class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
					<input
						type="text"
						placeholder="Filter rows…"
						class="w-full pl-8 pr-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-violet-500"
						bind:value={filter}
					/>
				</div>
				<button
					type="button"
					class="flex items-center justify-center w-8 h-8 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
					onclick={load}
					disabled={loading}
					title="Refresh"
					aria-label="Refresh"
				>
					<Icon name={loading ? 'lucide:loader' : 'lucide:refresh-cw'} class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" />
				</button>
			</div>

			{#if error}
				<pre class="p-2 text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap">{error}</pre>
			{:else if loading && !result}
				<div class="p-4 text-sm text-slate-400">Loading…</div>
			{:else if result && filtered.length > 0}
				<div class="max-h-[55vh] overflow-auto border border-slate-200 dark:border-slate-800 rounded-lg">
					<table class="min-w-full text-sm border-collapse">
						<thead class="sticky top-0 bg-slate-100 dark:bg-slate-800 z-10">
							<tr>
								<th class="px-2 py-1.5 w-8 border-b border-slate-200 dark:border-slate-800"></th>
								{#each result.columns as col (col.name)}
									<th class="px-3 py-1.5 text-left font-semibold whitespace-nowrap border-b border-slate-200 dark:border-slate-800 {col.name === refColumn ? 'text-violet-700 dark:text-violet-300' : 'text-slate-700 dark:text-slate-200'}">{col.name}</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each filtered as row, i (i)}
								<tr class="hover:bg-violet-500/5 cursor-pointer" onclick={() => pick(row[refColumn])}>
									<td class="px-2 py-1.5 border-b border-slate-100 dark:border-slate-800 text-center">
										<Icon name="lucide:corner-down-left" class="w-3.5 h-3.5 text-slate-400" />
									</td>
									{#each result.columns as col (col.name)}
										<td class="px-3 py-1.5 border-b border-slate-100 dark:border-slate-800 text-slate-700 dark:text-slate-300 {col.name === refColumn ? 'font-medium text-violet-700 dark:text-violet-300' : ''}">
											<span class="block max-w-[280px] truncate">{fmt(row[col.name])}</span>
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<div class="text-[11px] text-slate-400">
					Showing {filtered.length}{rows.length === LIMIT ? ` of first ${LIMIT}` : ''} row{filtered.length === 1 ? '' : 's'} — click one to use its <span class="font-medium">{refColumn}</span>.
				</div>
			{:else if result}
				<div class="p-4 text-sm text-slate-400">No matching rows.</div>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="outline" size="sm" onclick={onClose}>Cancel</Button>
	{/snippet}
</Modal>
