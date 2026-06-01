<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Checkbox from './Checkbox.svelte';
	import FkPicker from './FkPicker.svelte';
	import type { DbClientObjectColumn, DbClientObjectForeignKey, DbDriver } from '$shared/types/db-client';

	interface Props {
		isOpen: boolean;
		title?: string;
		columns: DbClientObjectColumn[];
		initial?: Record<string, unknown>;
		onSubmit: (row: Record<string, unknown>) => Promise<void> | void;
		onClose: () => void;
		// Optional foreign-key context — enables a lookup helper on relation columns.
		foreignKeys?: DbClientObjectForeignKey[];
		connectionId?: string;
		driver?: DbDriver;
		database?: string;
		schema?: string;
	}

	let {
		isOpen = $bindable(),
		title = 'Insert row',
		columns,
		initial = {},
		onSubmit,
		onClose,
		foreignKeys = [],
		connectionId,
		driver,
		database,
		schema
	}: Props = $props();

	let row = $state<Record<string, string>>({});
	let nullFlags = $state<Record<string, boolean>>({});
	let saving = $state(false);
	let error = $state<string | null>(null);

	const fkMap = $derived(new Map(foreignKeys.map((fk) => [fk.column, fk])));
	const canLookup = $derived(!!connectionId && !!driver);

	let pickerOpen = $state(false);
	let pickerColumn = $state('');
	let pickerFk = $state<DbClientObjectForeignKey | null>(null);

	function openPicker(colName: string): void {
		const fk = fkMap.get(colName);
		if (!fk) return;
		pickerColumn = colName;
		pickerFk = fk;
		pickerOpen = true;
	}

	function onPicked(value: unknown): void {
		row = { ...row, [pickerColumn]: value === null || value === undefined ? '' : String(value) };
		nullFlags = { ...nullFlags, [pickerColumn]: false };
	}

	function reset(): void {
		const next: Record<string, string> = {};
		const nulls: Record<string, boolean> = {};
		for (const col of columns) {
			const v = initial[col.name];
			if (v === null || v === undefined) {
				next[col.name] = '';
				nulls[col.name] = v === null;
			} else if (typeof v === 'object') {
				next[col.name] = JSON.stringify(v);
				nulls[col.name] = false;
			} else {
				next[col.name] = String(v);
				nulls[col.name] = false;
			}
		}
		row = next;
		nullFlags = nulls;
		error = null;
	}

	$effect(() => {
		if (isOpen) reset();
	});

	function build(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const col of columns) {
			if (nullFlags[col.name]) {
				out[col.name] = null;
			} else if (row[col.name] === '' && col.nullable) {
				out[col.name] = null;
			} else {
				out[col.name] = row[col.name];
			}
		}
		return out;
	}

	async function submit(): Promise<void> {
		saving = true;
		error = null;
		try {
			await onSubmit(build());
			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	async function submitAndNext(): Promise<void> {
		saving = true;
		error = null;
		try {
			await onSubmit(build());
			reset();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:isOpen {onClose} {title} size="md">
	{#snippet children()}
		<div class="space-y-2.5">
			{#each columns as col (col.name)}
				<div class="rounded-lg border border-slate-200 dark:border-slate-700/60 bg-slate-50/60 dark:bg-slate-800/30 px-3 py-2.5">
					<div class="flex items-center justify-between gap-2 mb-1.5">
						<label for={`row-${col.name}`} class="flex items-center gap-1.5 min-w-0">
							<span class="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">{col.name}</span>
							<span class="text-[11px] font-normal text-slate-400 dark:text-slate-500 shrink-0">{col.type}</span>
							{#if col.isPrimary}<span class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 shrink-0">PK</span>{/if}
							{#if fkMap.has(col.name)}<span class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 shrink-0" title={`→ ${fkMap.get(col.name)?.refTable}.${fkMap.get(col.name)?.refColumn}`}>FK</span>{/if}
							{#if !col.nullable}<span class="text-[10px] font-medium text-red-500 shrink-0">required</span>{/if}
						</label>
						{#if col.nullable}
							<label class="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer select-none shrink-0">
								<Checkbox
									checked={!!nullFlags[col.name]}
									onchange={(c) => (nullFlags = { ...nullFlags, [col.name]: c })}
									ariaLabel={`Set ${col.name} to NULL`}
								/>
								<span class="italic">NULL</span>
							</label>
						{/if}
					</div>
					<div class="flex items-center gap-2">
						<input
							id={`row-${col.name}`}
							type="text"
							placeholder={nullFlags[col.name] ? 'NULL' : ''}
							class="flex-1 min-w-0 px-2.5 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:border-violet-500 dark:focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-shadow"
							bind:value={row[col.name]}
							disabled={nullFlags[col.name]}
						/>
						{#if fkMap.has(col.name) && canLookup}
							<button
								type="button"
								class="flex items-center justify-center w-8 h-8 shrink-0 rounded-md border border-slate-200 dark:border-slate-700 text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 hover:border-sky-400 dark:hover:border-sky-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
								onclick={() => openPicker(col.name)}
								disabled={nullFlags[col.name]}
								title={`Look up ${fkMap.get(col.name)?.refTable}`}
								aria-label={`Look up ${col.name}`}
							>
								<Icon name="lucide:search" class="w-3.5 h-3.5" />
							</button>
						{/if}
					</div>
				</div>
			{/each}
			{#if error}
				<div class="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-sm text-red-600 dark:text-red-400">{error}</div>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="outline" size="sm" onclick={onClose}>Cancel</Button>
		<Button variant="outline" size="sm" onclick={submitAndNext} loading={saving} disabled={saving}>
			{saving ? 'Saving…' : 'Save & next'}
		</Button>
		<Button variant="primary" size="sm" onclick={submit} loading={saving} disabled={saving}>
			{saving ? 'Saving…' : 'Save'}
		</Button>
	{/snippet}
</Modal>

{#if pickerFk && connectionId && driver}
	<FkPicker
		bind:isOpen={pickerOpen}
		{connectionId}
		{driver}
		refTable={pickerFk.refTable}
		refColumn={pickerFk.refColumn}
		{database}
		{schema}
		onPick={onPicked}
		onClose={() => (pickerOpen = false)}
	/>
{/if}
