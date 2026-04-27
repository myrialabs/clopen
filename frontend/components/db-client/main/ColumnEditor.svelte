<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Checkbox from '../shared/Checkbox.svelte';
	import type { DbClientObjectColumn, DbDriver } from '$shared/types/db-client';

	interface Props {
		isOpen: boolean;
		driver: DbDriver;
		column: DbClientObjectColumn | null;
		onSubmit: (payload: {
			originalName: string;
			newName: string;
			type: string;
			nullable: boolean;
			default: string;
			primary: boolean;
			unique: boolean;
			autoIncrement: boolean;
		}) => Promise<void>;
		onClose: () => void;
	}

	let {
		isOpen = $bindable(),
		driver,
		column,
		onSubmit,
		onClose
	}: Props = $props();

	let name = $state('');
	let type = $state('');
	let nullable = $state(true);
	let defaultVal = $state('');
	let primary = $state(false);
	let unique = $state(false);
	let autoIncrement = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (isOpen && column) {
			name = column.name;
			type = column.type;
			nullable = column.nullable;
			defaultVal = column.default ?? '';
			primary = column.isPrimary;
			unique = column.isUnique;
			autoIncrement = false;
			error = null;
		}
	});

	const sqliteWarn = $derived(driver === 'sqlite' && column !== null && (
		column.type !== type || column.nullable !== nullable || (column.default ?? '') !== defaultVal ||
		column.isPrimary !== primary || column.isUnique !== unique
	));

	async function submit(): Promise<void> {
		if (!column) return;
		saving = true;
		error = null;
		try {
			await onSubmit({
				originalName: column.name,
				newName: name,
				type,
				nullable,
				default: defaultVal,
				primary,
				unique,
				autoIncrement
			});
			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:isOpen {onClose} title="Edit column" size="md">
	{#snippet children()}
		<div class="space-y-3">
			<div class="grid grid-cols-2 gap-2">
				<div>
					<label for="ce-name" class="text-xs font-medium text-slate-700 dark:text-slate-300">Name</label>
					<input
						id="ce-name"
						type="text"
						class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
						bind:value={name}
					/>
				</div>
				<div>
					<label for="ce-type" class="text-xs font-medium text-slate-700 dark:text-slate-300">Type</label>
					<input
						id="ce-type"
						type="text"
						class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
						bind:value={type}
					/>
				</div>
			</div>
			<div>
				<label for="ce-default" class="text-xs font-medium text-slate-700 dark:text-slate-300">Default</label>
				<input
					id="ce-default"
					type="text"
					class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
					bind:value={defaultVal}
					placeholder="e.g. NULL, 0, 'text'"
				/>
			</div>
			<div class="flex flex-wrap gap-3 text-sm">
				<label class="inline-flex items-center gap-1.5 cursor-pointer">
					<Checkbox bind:checked={nullable} ariaLabel="Nullable" /> Nullable
				</label>
				<label class="inline-flex items-center gap-1.5 cursor-pointer">
					<Checkbox bind:checked={primary} ariaLabel="Primary key" /> Primary key
				</label>
				<label class="inline-flex items-center gap-1.5 cursor-pointer">
					<Checkbox bind:checked={unique} ariaLabel="Unique" /> Unique
				</label>
				{#if driver === 'mysql' || driver === 'sqlite'}
					<label class="inline-flex items-center gap-1.5 cursor-pointer">
						<Checkbox bind:checked={autoIncrement} ariaLabel="Auto-increment" /> Auto-increment
					</label>
				{/if}
			</div>
			{#if sqliteWarn}
				<div class="text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 px-2 py-1.5 rounded">
					SQLite does not support MODIFY COLUMN — only rename will be applied. To change type/constraints, recreate the table.
				</div>
			{/if}
			{#if error}
				<div class="text-sm text-red-600 dark:text-red-400">{error}</div>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="outline" size="sm" onclick={onClose}>Cancel</Button>
		<Button variant="primary" size="sm" onclick={submit} loading={saving} disabled={saving || !name || !type}>
			{saving ? 'Saving…' : 'Save'}
		</Button>
	{/snippet}
</Modal>
