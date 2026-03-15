<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbManagerState,
		insertRowAction,
		updateRowAction,
		getPkColumn
	} from '$frontend/stores/features/db-manager.svelte';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	const { isOpen, onClose }: Props = $props();

	const isInsert = $derived(dbManagerState.isInsertingRow);
	const columns = $derived(dbManagerState.columns);
	const editingRow = $derived(dbManagerState.editingRow);

	// Form values keyed by column name
	let formValues = $state<Record<string, string>>({});

	$effect(() => {
		if (isOpen) {
			if (isInsert) {
				// Empty form — prefill defaults
				const initial: Record<string, string> = {};
				for (const col of columns) {
					initial[col.name] = col.defaultValue ?? '';
				}
				formValues = initial;
			} else if (editingRow) {
				// Prefill with existing row data
				const prefilled: Record<string, string> = {};
				for (const col of columns) {
					const v = editingRow[col.name];
					prefilled[col.name] = v === null || v === undefined ? '' : String(v);
				}
				formValues = prefilled;
			}
		}
	});

	const pkInfo = $derived(getPkColumn());

	async function handleSave() {
		// Build data object — convert empty string to null for nullable columns
		const data: Record<string, unknown> = {};
		for (const col of columns) {
			const raw = formValues[col.name] ?? '';
			if (raw === '' && col.nullable) {
				data[col.name] = null;
			} else {
				data[col.name] = raw;
			}
		}

		let success: boolean;
		if (isInsert) {
			// Remove PK column if it's auto-increment (empty)
			if (pkInfo && !pkInfo.isFallback && data[pkInfo.column] === null) {
				delete data[pkInfo.column];
			}
			success = await insertRowAction(data);
		} else if (editingRow && pkInfo) {
			const pkValue = editingRow[pkInfo.column];
			success = await updateRowAction(pkInfo.column, pkValue, data);
		} else {
			return;
		}

		if (success) {
			dbManagerState.editingRow = null;
			dbManagerState.isInsertingRow = false;
			onClose();
		}
	}

	function handleClose() {
		dbManagerState.editingRow = null;
		dbManagerState.isInsertingRow = false;
		onClose();
	}

	function getInputType(colType: string): string {
		const t = colType.toLowerCase();
		if (t.includes('int') || t.includes('decimal') || t.includes('float') || t.includes('double') || t.includes('numeric') || t.includes('number')) return 'number';
		if (t.includes('bool')) return 'checkbox';
		if (t.includes('date') && !t.includes('time')) return 'date';
		if (t.includes('datetime') || t.includes('timestamp')) return 'datetime-local';
		return 'text';
	}
</script>

<Modal {isOpen} onClose={handleClose} title={isInsert ? 'Add Row' : 'Edit Row'} size="md">
	{#snippet children()}
		<div class="p-4 flex flex-col gap-3 max-h-[60dvh] overflow-y-auto">
			{#if pkInfo?.isFallback}
				<div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
					<Icon name="lucide:triangle" class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
					<p class="text-xs text-amber-700 dark:text-amber-300">
						No primary key detected. Using <strong>{pkInfo.column}</strong> as row identifier.
					</p>
				</div>
			{/if}

			{#each columns as col (col.name)}
				{@const inputType = getInputType(col.type)}
				<div class="flex flex-col gap-1">
					<label class="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-400">
						{col.name}
						<span class="text-slate-400 dark:text-slate-600 font-normal">{col.type}</span>
						{#if col.primaryKey}
							<span class="px-1 py-0.5 rounded text-[10px] font-medium bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400">PK</span>
						{/if}
						{#if !col.nullable && !col.primaryKey}
							<span class="text-red-400 text-[10px]">required</span>
						{/if}
					</label>

					{#if inputType === 'checkbox'}
						<label class="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								class="w-4 h-4 rounded accent-violet-600"
								checked={formValues[col.name] === '1' || formValues[col.name] === 'true'}
								onchange={(e) => { formValues[col.name] = (e.currentTarget as HTMLInputElement).checked ? '1' : '0'; }}
							/>
							<span class="text-xs text-slate-500 dark:text-slate-400">{formValues[col.name] === '1' || formValues[col.name] === 'true' ? 'true' : 'false'}</span>
						</label>
					{:else}
						<input
							type={inputType}
							class="w-full px-3 py-2 rounded-lg text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 dark:focus:border-violet-500"
							placeholder={col.nullable ? 'NULL' : ''}
							bind:value={formValues[col.name]}
						/>
					{/if}
				</div>
			{/each}
		</div>
	{/snippet}

	{#snippet footer()}
		<div class="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-800">
			<button
				type="button"
				class="px-4 py-2 rounded-lg text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
				onclick={handleClose}
			>
				Cancel
			</button>
			<button
				type="button"
				class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-violet-600 hover:bg-violet-700 disabled:bg-violet-600/50 disabled:cursor-not-allowed text-white transition-colors"
				onclick={handleSave}
				disabled={dbManagerState.isSavingRow}
			>
				{#if dbManagerState.isSavingRow}
					<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
					Saving...
				{:else}
					<Icon name="lucide:check" class="w-3.5 h-3.5" />
					{isInsert ? 'Insert Row' : 'Save Changes'}
				{/if}
			</button>
		</div>
	{/snippet}
</Modal>
