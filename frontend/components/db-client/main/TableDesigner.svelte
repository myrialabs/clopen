<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Checkbox from '../shared/Checkbox.svelte';
	import type { DbDriver } from '$shared/types/db-client';

	interface ColumnInput {
		name: string;
		type: string;
		nullable: boolean;
		default: string;
		primary: boolean;
		unique: boolean;
		autoIncrement: boolean;
	}

	interface Props {
		isOpen: boolean;
		driver: DbDriver;
		mode?: 'create-table' | 'add-column';
		tableName?: string;
		onSubmit: (payload: { name: string; columns: ColumnInput[] }) => Promise<void>;
		onClose: () => void;
	}

	let {
		isOpen = $bindable(),
		driver,
		mode = 'create-table',
		tableName = '',
		onSubmit,
		onClose
	}: Props = $props();

	let name = $state('');
	let columns = $state<ColumnInput[]>([]);
	let saving = $state(false);
	let error = $state<string | null>(null);

	const isDocumentDb = $derived(driver === 'mongodb');
	const isAddColumn = $derived(mode === 'add-column');

	const objectLabel = $derived(driver === 'mongodb' ? 'Collection' : 'Table');
	const modalTitle = $derived(
		isAddColumn ? 'Add column' :
		driver === 'mongodb' ? 'Create collection' :
		'Create table'
	);

	const TYPE_PRESETS: Record<DbDriver, string[]> = {
		mysql:    ['INT', 'BIGINT', 'VARCHAR(255)', 'TEXT', 'DATETIME', 'TIMESTAMP', 'BOOLEAN', 'FLOAT', 'DOUBLE', 'JSON'],
		postgres: ['INTEGER', 'BIGINT', 'TEXT', 'VARCHAR(255)', 'BOOLEAN', 'TIMESTAMP', 'JSONB', 'UUID', 'REAL', 'BYTEA'],
		sqlite:   ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC'],
		mssql:    ['INT', 'BIGINT', 'VARCHAR(255)', 'NVARCHAR(MAX)', 'DATETIME2', 'BIT', 'DECIMAL(18,2)', 'VARBINARY(MAX)'],
		mongodb:  [],
		redis:    []
	};

	function defaultType(d: DbDriver): string {
		const presets = TYPE_PRESETS[d];
		return presets[0] ?? 'TEXT';
	}

	function newColumn(): ColumnInput {
		return { name: '', type: defaultType(driver), nullable: true, default: '', primary: false, unique: false, autoIncrement: false };
	}

	$effect(() => {
		if (isOpen) {
			name = isAddColumn ? tableName : '';
			columns = isDocumentDb ? [] : [newColumn()];
			error = null;
		}
	});

	function addColumn(): void {
		columns = [...columns, newColumn()];
	}

	function removeColumn(i: number): void {
		columns = columns.filter((_, idx) => idx !== i);
	}

	function quote(n: string): string {
		switch (driver) {
			case 'mysql': return '`' + n.replace(/`/g, '``') + '`';
			case 'mssql': return '[' + n.replace(/\]/g, ']]') + ']';
			default: return '"' + n.replace(/"/g, '""') + '"';
		}
	}

	function columnParts(c: ColumnInput): string[] {
		const parts: string[] = [quote(c.name), c.type];
		if (!c.nullable) parts.push('NOT NULL');
		if (c.default) parts.push(`DEFAULT ${c.default}`);
		if (c.unique) parts.push('UNIQUE');
		if (c.primary) parts.push('PRIMARY KEY');
		if (c.autoIncrement) {
			if (driver === 'mysql') parts.push('AUTO_INCREMENT');
			else if (driver === 'sqlite') parts.push('AUTOINCREMENT');
			else if (driver === 'mssql') parts.push('IDENTITY(1,1)');
		}
		return parts;
	}

	const ddlPreview = $derived.by(() => {
		if (isDocumentDb) return '';
		const cols = columns.filter((c) => c.name && c.type);
		if (cols.length === 0) return '';
		if (isAddColumn) {
			return cols
				.map((c) => `ALTER TABLE ${quote(name || '<table>')} ADD COLUMN ${columnParts(c).join(' ')};`)
				.join('\n');
		}
		if (!name) return '';
		const lines = cols.map((c) => '  ' + columnParts(c).join(' '));
		return `CREATE TABLE ${quote(name)} (\n${lines.join(',\n')}\n);`;
	});

	const canSubmit = $derived(
		!saving &&
		!!name.trim() &&
		(isDocumentDb || (columns.length > 0 && columns.every((c) => c.name.trim() && c.type.trim())))
	);

	async function submit(): Promise<void> {
		saving = true;
		error = null;
		try {
			await onSubmit({ name: name.trim(), columns });
			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:isOpen {onClose} title={modalTitle} size={isDocumentDb ? 'sm' : 'xl'}>
	{#snippet children()}
		<div class="space-y-5">
			<!-- Name field -->
			<div class="space-y-1.5">
				<label for="td-name" class="text-sm font-semibold text-slate-700 dark:text-slate-300">
					{isAddColumn ? 'Table' : `${objectLabel} name`}
				</label>
				<input
					id="td-name"
					type="text"
					placeholder={driver === 'mongodb' ? 'my_collection' : 'my_table'}
					class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:border-violet-500 dark:focus:border-violet-500 disabled:opacity-60"
					bind:value={name}
					disabled={isAddColumn}
				/>
			</div>

			{#if !isDocumentDb}
				<!-- Columns -->
				<div class="space-y-2">
					<div class="flex items-center justify-between">
						<span class="text-sm font-semibold text-slate-700 dark:text-slate-300">Columns</span>
						<Button variant="ghost" size="sm" onclick={addColumn}>
							<Icon name="lucide:plus" class="w-3.5 h-3.5 mr-1" /> Add column
						</Button>
					</div>

					<div class="space-y-2">
						{#each columns as col, i (i)}
							<div class="space-y-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700/60">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Column {i + 1}</span>
									{#if columns.length > 1}
										<button
											type="button"
											class="shrink-0 flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors"
											onclick={() => removeColumn(i)}
											aria-label="Remove column"
										>
											<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
										</button>
									{/if}
								</div>
								<div class="grid grid-cols-2 gap-2">
									<div>
										<label for="td-col-name-{i}" class="text-xs font-medium text-slate-700 dark:text-slate-300">Name</label>
										<input
											id="td-col-name-{i}"
											type="text"
											placeholder="column_name"
											class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-violet-500"
											bind:value={col.name}
										/>
									</div>
									<div>
										<label for="td-col-type-{i}" class="text-xs font-medium text-slate-700 dark:text-slate-300">Type</label>
										<input
											id="td-col-type-{i}"
											type="text"
											list="type-presets-{i}"
											placeholder="type"
											class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-violet-500"
											bind:value={col.type}
										/>
										<datalist id="type-presets-{i}">
											{#each TYPE_PRESETS[driver] as t (t)}
												<option value={t}></option>
											{/each}
										</datalist>
									</div>
								</div>
								<div>
									<label for="td-col-default-{i}" class="text-xs font-medium text-slate-700 dark:text-slate-300">Default</label>
									<input
										id="td-col-default-{i}"
										type="text"
										placeholder="e.g. NULL, 0, 'text'"
										class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded focus:outline-none focus:border-violet-500"
										bind:value={col.default}
									/>
								</div>
								<div class="flex flex-wrap gap-3 text-sm">
									<label class="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400 cursor-pointer select-none">
										<Checkbox bind:checked={col.nullable} ariaLabel="Nullable" /> Nullable
									</label>
									<label class="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400 cursor-pointer select-none">
										<Checkbox bind:checked={col.primary} ariaLabel="Primary key" /> Primary key
									</label>
									<label class="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400 cursor-pointer select-none">
										<Checkbox bind:checked={col.unique} ariaLabel="Unique" /> Unique
									</label>
									{#if driver === 'mysql' || driver === 'sqlite' || driver === 'postgres'}
										<label class="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400 cursor-pointer select-none">
											<Checkbox bind:checked={col.autoIncrement} ariaLabel="Auto-increment" /> Auto-increment
										</label>
									{/if}
								</div>
							</div>
						{:else}
							<div class="py-3 text-center text-sm text-slate-400">No columns — click "Add column"</div>
						{/each}
					</div>
				</div>

				<!-- DDL preview -->
				{#if ddlPreview}
					<div class="space-y-1.5">
						<div class="text-xs font-semibold uppercase tracking-wider text-slate-400">DDL preview</div>
						<pre class="p-3 text-xs bg-slate-100 dark:bg-slate-800/80 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 whitespace-pre-wrap font-mono">{ddlPreview}</pre>
					</div>
				{/if}
			{/if}

			{#if error}
				<div class="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-sm text-red-600 dark:text-red-400">{error}</div>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="outline" size="sm" onclick={onClose}>Cancel</Button>
		<Button variant="primary" size="sm" onclick={submit} loading={saving} disabled={!canSubmit}>
			{saving ? 'Saving…' : modalTitle}
		</Button>
	{/snippet}
</Modal>
