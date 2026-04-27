<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Checkbox from '../shared/Checkbox.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';
	import type { DbDriver, DbClientSchemaNode } from '$shared/types/db-client';

	interface Props {
		isOpen: boolean;
		connectionId: string;
		driver: DbDriver;
		database?: string;
		schema?: string;
		onClose: () => void;
	}

	type ExportFormat = 'sql' | 'csv' | 'json' | 'jsonl' | 'redis';

	let {
		isOpen = $bindable(),
		connectionId,
		driver,
		database,
		schema,
		onClose
	}: Props = $props();

	let loading = $state(false);
	let error = $state<string | null>(null);
	let objects = $state<DbClientSchemaNode[]>([]);
	let selected = $state<Set<string>>(new Set());
	let format = $state<ExportFormat>('sql');
	let withData = $state(true);
	let schemaOnly = $state(false);
	let busy = $state(false);

	const formats = $derived<ExportFormat[]>(
		driver === 'mongodb' ? ['json', 'jsonl']
			: driver === 'redis' ? ['json', 'redis']
			: ['sql', 'csv', 'json']
	);

	const singleOnly = $derived(format === 'csv' || format === 'jsonl');
	const isMongo = $derived(driver === 'mongodb');
	const isRedis = $derived(driver === 'redis');
	const itemLabel = $derived(isMongo ? 'collection' : isRedis ? 'key' : 'table');

	$effect(() => {
		if (isOpen) {
			void load();
			selected = new Set();
			error = null;
		}
	});

	$effect(() => {
		if (!formats.includes(format)) format = formats[0];
	});

	async function load(): Promise<void> {
		loading = true;
		error = null;
		try {
			objects = await dbClientStore.listObjects(connectionId, { database, schema });
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			debug.error('db-client', 'export: list objects failed:', e);
		} finally {
			loading = false;
		}
	}

	function toggle(name: string): void {
		const next = new Set(selected);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		selected = next;
	}

	function selectAll(): void {
		selected = new Set(objects.map((o) => o.name));
	}

	function clearAll(): void {
		selected = new Set();
	}

	async function submit(): Promise<void> {
		if (selected.size === 0) {
			error = `Pick at least one ${itemLabel}`;
			return;
		}
		if (singleOnly && selected.size > 1) {
			error = `${format.toUpperCase()} export supports a single ${itemLabel} only`;
			return;
		}
		busy = true;
		error = null;
		try {
			const result = await ws.http('db-client:data:export', {
				connectionId,
				database,
				schema,
				tables: Array.from(selected),
				format,
				withData,
				schemaOnly
			}) as { filename: string; content: string; mimeType: string };

			const blob = new Blob([result.content], { type: result.mimeType });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = result.filename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);

			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			debug.error('db-client', 'export failed:', e);
		} finally {
			busy = false;
		}
	}
</script>

<Modal bind:isOpen {onClose} title="Export" size="md">
	{#snippet children()}
		<div class="space-y-3">
			<div>
				<div class="flex items-center justify-between mb-1">
					<label class="text-xs font-medium text-slate-700 dark:text-slate-300" for="exp-tables">
						{itemLabel.charAt(0).toUpperCase() + itemLabel.slice(1)}s
						{#if selected.size > 0}<span class="text-slate-400 ml-1">({selected.size} selected)</span>{/if}
					</label>
					<div class="flex items-center gap-1.5 text-xs">
						<button type="button" class="text-violet-600 hover:underline" onclick={selectAll}>All</button>
						<span class="text-slate-300">|</span>
						<button type="button" class="text-violet-600 hover:underline" onclick={clearAll}>None</button>
					</div>
				</div>
				<div id="exp-tables" class="max-h-48 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900">
					{#if loading}
						<div class="px-3 py-2 text-xs text-slate-400">Loading…</div>
					{:else if objects.length === 0}
						<div class="px-3 py-2 text-xs text-slate-400">No {itemLabel}s</div>
					{:else}
						{#each objects as obj (obj.name)}
							<label class="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer">
								<Checkbox
									checked={selected.has(obj.name)}
									onchange={() => toggle(obj.name)}
									ariaLabel={`Select ${obj.name}`}
								/>
								<span class="truncate text-slate-700 dark:text-slate-300">{obj.name}</span>
							</label>
						{/each}
					{/if}
				</div>
			</div>

			<div>
				<label for="exp-format" class="text-xs font-medium text-slate-700 dark:text-slate-300">Format</label>
				<select
					id="exp-format"
					class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
					bind:value={format}
				>
					{#each formats as f (f)}
						<option value={f}>{f.toUpperCase()}</option>
					{/each}
				</select>
				{#if singleOnly}
					<div class="text-[11px] text-slate-500 mt-1">{format.toUpperCase()} format requires exactly one {itemLabel}.</div>
				{/if}
			</div>

			{#if !isRedis}
				<div class="flex flex-wrap gap-3 text-sm">
					<label class="inline-flex items-center gap-1.5 cursor-pointer">
						<Checkbox bind:checked={withData} disabled={schemaOnly} ariaLabel="Include data" /> Include data
					</label>
					{#if !isMongo}
						<label class="inline-flex items-center gap-1.5 cursor-pointer">
							<Checkbox bind:checked={schemaOnly} ariaLabel="Schema only" /> Schema only
						</label>
					{/if}
				</div>
			{/if}

			{#if error}
				<div class="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-500/10 px-2 py-1.5 rounded">
					<Icon name="lucide:circle-alert" class="w-4 h-4 mt-0.5 shrink-0" />
					<span>{error}</span>
				</div>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="outline" size="sm" onclick={onClose}>Cancel</Button>
		<Button variant="primary" size="sm" onclick={submit} loading={busy} disabled={busy || selected.size === 0}>
			{busy ? 'Exporting…' : 'Export'}
		</Button>
	{/snippet}
</Modal>
