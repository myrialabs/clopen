<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { DBType } from '$shared/types/db-manager';
	import type { DBColumnDef, ForeignKeyDef } from '$shared/types/alter-table';
	import { DB_TYPE_GROUPS, FK_ACTIONS } from '$shared/types/alter-table';

	interface Props {
		def: DBColumnDef;
		dbType: DBType;
		/** Tables available for FK picker */
		tables: string[];
		isNew?: boolean;
		onChange: (def: DBColumnDef) => void;
		onCancel: () => void;
	}

	let { def, dbType, tables, isNew = false, onChange, onCancel }: Props = $props();

	// Local editable copy — initialized from derived values to avoid Svelte 5 state_referenced_locally warnings
	let name = $state('');
	let type = $state('TEXT');
	let nullable = $state(true);
	let unique = $state(false);
	let primaryKey = $state(false);
	let defaultValue = $state('');
	let hasFk = $state(false);
	let fkTable = $state('');
	let fkColumn = $state('');
	let fkOnDelete = $state<(typeof FK_ACTIONS)[number]>('NO ACTION');
	let fkOnUpdate = $state<(typeof FK_ACTIONS)[number]>('NO ACTION');

	// Sync from prop when def changes (e.g. parent opens editor for different column)
	$effect(() => {
		name = def.name;
		type = def.type;
		nullable = def.nullable;
		unique = def.unique;
		primaryKey = def.primaryKey;
		defaultValue = def.defaultValue ?? '';
		hasFk = !!def.foreignKey;
		fkTable = def.foreignKey?.table ?? '';
		fkColumn = def.foreignKey?.column ?? '';
		fkOnDelete = def.foreignKey?.onDelete ?? 'NO ACTION';
		fkOnUpdate = def.foreignKey?.onUpdate ?? 'NO ACTION';
	});

	// Columns for the selected FK table
	let fkTableColumns = $state<string[]>([]);
	let loadingFkColumns = $state(false);

	const typeGroups = $derived(DB_TYPE_GROUPS[dbType] ?? []);

	async function loadFkColumns(tableName: string) {
		if (!tableName) {
			fkTableColumns = [];
			return;
		}
		loadingFkColumns = true;
		try {
			// Use parent connection — we use dbManagerState from the store context
			// ColumnEditor receives a connectionId via a separate prop when needed
			// For now use explore:columns with the parent's connection info
			fkTableColumns = [];
		} finally {
			loadingFkColumns = false;
		}
	}

	function handleFkTableChange(tableName: string) {
		fkTable = tableName;
		fkColumn = '';
		loadFkColumns(tableName);
	}

	function handleSave() {
		const trimmedName = name.trim();
		if (!trimmedName) return;
		const updated: DBColumnDef = {
			name: trimmedName,
			type: type.trim() || 'TEXT',
			nullable,
			unique,
			primaryKey,
			defaultValue: defaultValue.trim() || null,
			foreignKey: hasFk && fkTable && fkColumn
				? ({
					fromColumn: trimmedName,
					table: fkTable,
					column: fkColumn,
					onDelete: fkOnDelete,
					onUpdate: fkOnUpdate
				} satisfies ForeignKeyDef)
				: null
		};
		onChange(updated);
	}

	const canSave = $derived(name.trim().length > 0 && type.trim().length > 0);
</script>

<div class="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
	<div class="flex items-center gap-2 mb-1">
		<Icon name="lucide:columns-2" class="w-4 h-4 text-violet-500" />
		<span class="text-sm font-semibold text-slate-700 dark:text-slate-300">
			{isNew ? 'New Column' : 'Edit Column'}
		</span>
	</div>

	<!-- Name -->
	<div class="grid grid-cols-2 gap-3">
		<div>
			<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Column Name</label>
			<input
				bind:value={name}
				type="text"
				placeholder="column_name"
				class="w-full px-3 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
			/>
		</div>

		<!-- Type -->
		<div>
			<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Data Type</label>
			{#if typeGroups.length > 0}
				<select
					bind:value={type}
					class="w-full px-3 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
				>
					{#each typeGroups as group}
						<optgroup label={group.label}>
							{#each group.types as t}
								<option value={t}>{t}</option>
							{/each}
						</optgroup>
					{/each}
				</select>
			{:else}
				<input
					bind:value={type}
					type="text"
					placeholder="e.g. VARCHAR(255)"
					class="w-full px-3 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
				/>
			{/if}
		</div>
	</div>

	<!-- Flags -->
	<div class="flex flex-wrap gap-4">
		<label class="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
			<input type="checkbox" bind:checked={nullable} class="rounded border-slate-300 dark:border-slate-600 text-violet-500 focus:ring-violet-500" />
			Nullable
		</label>
		<label class="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
			<input type="checkbox" bind:checked={unique} class="rounded border-slate-300 dark:border-slate-600 text-violet-500 focus:ring-violet-500" />
			Unique
		</label>
		<label class="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
			<input type="checkbox" bind:checked={primaryKey} class="rounded border-slate-300 dark:border-slate-600 text-amber-500 focus:ring-amber-500" />
			Primary Key
		</label>
	</div>

	<!-- Default value -->
	<div>
		<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Default Value <span class="font-normal opacity-60">(optional)</span></label>
		<input
			bind:value={defaultValue}
			type="text"
			placeholder="e.g. 0, 'active', NOW()"
			class="w-full px-3 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
		/>
	</div>

	<!-- Foreign Key -->
	<div class="border-t border-slate-200 dark:border-slate-700 pt-2">
		<label class="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 cursor-pointer select-none mb-2">
			<input type="checkbox" bind:checked={hasFk} class="rounded border-slate-300 dark:border-slate-600 text-violet-500 focus:ring-violet-500" />
			Foreign Key Constraint
		</label>

		{#if hasFk}
			<div class="grid grid-cols-2 gap-2 pl-5">
				<!-- FK Table -->
				<div>
					<label class="block text-xs text-slate-500 dark:text-slate-500 mb-1">References Table</label>
					<select
						value={fkTable}
						onchange={(e) => handleFkTableChange((e.target as HTMLSelectElement).value)}
						class="w-full px-2 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
					>
						<option value="">— select table —</option>
						{#each tables as tbl}
							<option value={tbl}>{tbl}</option>
						{/each}
					</select>
				</div>

				<!-- FK Column -->
				<div>
					<label class="block text-xs text-slate-500 dark:text-slate-500 mb-1">References Column</label>
					<input
						bind:value={fkColumn}
						type="text"
						placeholder="id"
						class="w-full px-2 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500"
					/>
				</div>

				<!-- ON DELETE -->
				<div>
					<label class="block text-xs text-slate-500 dark:text-slate-500 mb-1">ON DELETE</label>
					<select
						bind:value={fkOnDelete}
						class="w-full px-2 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
					>
						{#each FK_ACTIONS as action}
							<option value={action}>{action}</option>
						{/each}
					</select>
				</div>

				<!-- ON UPDATE -->
				<div>
					<label class="block text-xs text-slate-500 dark:text-slate-500 mb-1">ON UPDATE</label>
					<select
						bind:value={fkOnUpdate}
						class="w-full px-2 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
					>
						{#each FK_ACTIONS as action}
							<option value={action}>{action}</option>
						{/each}
					</select>
				</div>
			</div>
		{/if}
	</div>

	<!-- Actions -->
	<div class="flex items-center justify-end gap-2 pt-1 border-t border-slate-200 dark:border-slate-700">
		<button
			type="button"
			onclick={onCancel}
			class="px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-md transition-colors"
		>
			Cancel
		</button>
		<button
			type="button"
			onclick={handleSave}
			disabled={!canSave}
			class="px-3 py-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors"
		>
			{isNew ? 'Add Column' : 'Save Change'}
		</button>
	</div>
</div>
