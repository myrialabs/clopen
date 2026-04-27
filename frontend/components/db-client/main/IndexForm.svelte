<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Checkbox from '../shared/Checkbox.svelte';
	import type { DbClientObjectColumn } from '$shared/types/db-client';

	interface Props {
		isOpen: boolean;
		columns: DbClientObjectColumn[];
		onSubmit: (def: { name: string; columns: string[]; unique: boolean }) => Promise<void>;
		onClose: () => void;
	}

	let {
		isOpen = $bindable(),
		columns,
		onSubmit,
		onClose
	}: Props = $props();

	let name = $state('');
	let selected = $state<string[]>([]);
	let unique = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (isOpen) {
			name = '';
			selected = [];
			unique = false;
			error = null;
		}
	});

	function toggleColumn(c: string): void {
		selected = selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c];
	}

	async function submit(): Promise<void> {
		saving = true;
		error = null;
		try {
			await onSubmit({ name, columns: selected, unique });
			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:isOpen {onClose} title="Create index" size="md">
	{#snippet children()}
		<div class="space-y-3">
			<div>
				<label for="ix-name" class="text-sm font-medium text-slate-700 dark:text-slate-300">Index name</label>
				<input
					id="ix-name"
					type="text"
					class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
					bind:value={name}
				/>
			</div>
			<div>
				<div class="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Columns (in order)</div>
				<div class="space-y-1 max-h-48 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded p-2">
					{#each columns as col (col.name)}
						<label class="flex items-center gap-2 text-sm cursor-pointer">
							<Checkbox
								checked={selected.includes(col.name)}
								onchange={() => toggleColumn(col.name)}
								ariaLabel={`Select ${col.name}`}
							/>
							<span>{col.name}</span>
							<span class="text-slate-400 text-xs">— {col.type}</span>
						</label>
					{/each}
				</div>
			</div>
			<label class="flex items-center gap-2 text-sm cursor-pointer">
				<Checkbox bind:checked={unique} ariaLabel="Unique index" /> Unique index
			</label>
			{#if error}
				<div class="text-sm text-red-600 dark:text-red-400">{error}</div>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="outline" size="sm" onclick={onClose}>Cancel</Button>
		<Button variant="primary" size="sm" onclick={submit} loading={saving} disabled={saving || !name || selected.length === 0}>
			{saving ? 'Saving…' : 'Create index'}
		</Button>
	{/snippet}
</Modal>
