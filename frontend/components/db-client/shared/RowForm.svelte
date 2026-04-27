<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Checkbox from './Checkbox.svelte';
	import type { DbClientObjectColumn } from '$shared/types/db-client';

	interface Props {
		isOpen: boolean;
		title?: string;
		columns: DbClientObjectColumn[];
		initial?: Record<string, unknown>;
		onSubmit: (row: Record<string, unknown>) => Promise<void> | void;
		onClose: () => void;
	}

	let {
		isOpen = $bindable(),
		title = 'Insert row',
		columns,
		initial = {},
		onSubmit,
		onClose
	}: Props = $props();

	let row = $state<Record<string, string>>({});
	let nullFlags = $state<Record<string, boolean>>({});
	let saving = $state(false);
	let error = $state<string | null>(null);

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
		<div class="space-y-2">
			{#each columns as col (col.name)}
				<div class="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700/60 space-y-1.5">
					<label for={`row-${col.name}`} class="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-300">
						{col.name}
						<span class="text-xs font-normal text-slate-400 dark:text-slate-500">{col.type}</span>
						{#if col.isPrimary}<span class="text-[10px] px-1 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">PK</span>{/if}
						{#if !col.nullable}<span class="text-[10px] text-red-500">required</span>{/if}
					</label>
					<div class="flex items-center gap-2">
						<input
							id={`row-${col.name}`}
							type="text"
							class="flex-1 px-2.5 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500 dark:focus:border-violet-500 disabled:opacity-50"
							bind:value={row[col.name]}
							disabled={nullFlags[col.name]}
						/>
						{#if col.nullable}
							<label class="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none shrink-0">
								<Checkbox
									checked={!!nullFlags[col.name]}
									onchange={(c) => (nullFlags = { ...nullFlags, [col.name]: c })}
									ariaLabel={`Set ${col.name} to NULL`}
								/>
								<span class="italic">NULL</span>
							</label>
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
