<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ColumnEditor from './ColumnEditor.svelte';
	import AlterPreviewModal from './AlterPreviewModal.svelte';
	import {
		dbAlterState,
		closeArchitect,
		addChange,
		updateChange,
		removeChange,
		resetChanges,
		previewSQL
	} from '$frontend/stores/features/db-alter.svelte';
	import { loadTablesForActive } from '$frontend/stores/features/db-manager.svelte';
	import type { DBColumnDef, AlterChange } from '$shared/types/alter-table';

	interface Props {
		onApplied?: () => void;
	}

	let { onApplied }: Props = $props();

	type EditorMode = 'add' | 'modify' | 'rename' | null;

	let editorMode = $state<EditorMode>(null);
	let editingChangeId = $state<string | null>(null);
	let editorDef = $state<DBColumnDef | null>(null);

	// Map: columnName → change type for display
	const changeMap = $derived(() => {
		const m = new Map<string, AlterChange>();
		for (const c of dbAlterState.changes) {
			m.set(c.columnName, c);
		}
		return m;
	});

	// Columns that will be added (from changes)
	const addedColumns = $derived(
		dbAlterState.changes
			.filter((c) => c.type === 'add' && c.newDef)
			.map((c) => c.newDef!)
	);

	// Table names for FK picker (strip schema-grouped tables)
	const tableNames = $derived(
		// We don't have table list here; use the db-manager tables list
		// Import dbManagerState lazily to avoid circular deps
		[] as string[]
	);

	function startAdd() {
		editorMode = 'add';
		editingChangeId = null;
		editorDef = {
			name: '',
			type: 'TEXT',
			nullable: true,
			primaryKey: false,
			unique: false,
			defaultValue: null,
			foreignKey: null
		};
	}

	function startEdit(col: DBColumnDef) {
		// Check if there's already a modify change for this column
		const existing = dbAlterState.changes.find(
			(c) => c.columnName === col.name && (c.type === 'modify' || c.type === 'rename')
		);
		editorMode = 'modify';
		editingChangeId = existing?.id ?? null;
		editorDef = { ...(existing?.newDef ?? col) };
	}

	function handleEditorChange(def: DBColumnDef) {
		if (editorMode === 'add') {
			addChange({ type: 'add', columnName: def.name, newDef: def });
		} else if (editorMode === 'modify' && editorDef) {
			const originalName = editorDef.name !== def.name ? editorDef.name : def.name;
			if (editingChangeId) {
				updateChange(editingChangeId, { newName: def.name !== originalName ? def.name : undefined, newDef: def });
			} else {
				addChange({ type: 'modify', columnName: originalName, newDef: def });
			}
		}
		editorMode = null;
		editorDef = null;
		editingChangeId = null;
	}

	function handleEditorCancel() {
		editorMode = null;
		editorDef = null;
		editingChangeId = null;
	}

	function handleDrop(col: DBColumnDef) {
		// Remove any existing modify change for this column first
		const existing = dbAlterState.changes.find((c) => c.columnName === col.name);
		if (existing) removeChange(existing.id);
		addChange({ type: 'drop', columnName: col.name });
	}

	function undropColumn(col: DBColumnDef) {
		const c = dbAlterState.changes.find((c) => c.columnName === col.name && c.type === 'drop');
		if (c) removeChange(c.id);
	}

	function removeAddedColumn(def: DBColumnDef) {
		const c = dbAlterState.changes.find((c) => c.type === 'add' && c.newDef?.name === def.name);
		if (c) removeChange(c.id);
	}

	function getColumnClass(col: DBColumnDef): string {
		const change = changeMap().get(col.name);
		if (!change) return '';
		if (change.type === 'drop') return 'opacity-50 line-through';
		if (change.type === 'modify' || change.type === 'rename') return 'text-amber-600 dark:text-amber-400';
		return '';
	}

	function getChangeLabel(col: DBColumnDef): string | null {
		const change = changeMap().get(col.name);
		if (!change) return null;
		if (change.type === 'drop') return 'DROP';
		if (change.type === 'modify') return 'MOD';
		if (change.type === 'rename') return 'RENAME';
		return null;
	}

	function getChangeLabelClass(col: DBColumnDef): string {
		const change = changeMap().get(col.name);
		if (!change) return '';
		if (change.type === 'drop') return 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400';
		return 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400';
	}

	function handleApplied() {
		loadTablesForActive();
		onApplied?.();
	}

	const totalChanges = $derived(dbAlterState.changes.length);
</script>

<Modal
	isOpen={dbAlterState.isOpen}
	onClose={closeArchitect}
	size="xl"
	closable={!dbAlterState.isApplying}
>
	{#snippet header()}
		<div class="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
			<div class="flex items-center justify-center w-8 h-8 rounded-lg bg-violet-500/10">
				<Icon name="lucide:table-properties" class="w-4 h-4 text-violet-500" />
			</div>
			<div>
				<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">Table Architect</h2>
				<p class="text-xs text-slate-500 dark:text-slate-400 font-mono">{dbAlterState.tableName}</p>
			</div>
			{#if totalChanges > 0}
				<span class="ml-2 px-2 py-0.5 rounded-full text-xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400">
					{totalChanges} pending
				</span>
			{/if}
		</div>
	{/snippet}

	{#if dbAlterState.isLoading}
		<div class="flex items-center justify-center py-12 gap-2 text-slate-400 text-sm">
			<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
			</svg>
			Loading schema...
		</div>
	{:else}
		<div class="flex gap-4 min-h-0">
			<!-- Left: Column list -->
			<div class="flex-1 min-w-0">
				<p class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
					Current Columns ({dbAlterState.originalColumns.length})
				</p>

				<div class="space-y-1">
					{#each dbAlterState.originalColumns as col}
						{@const change = changeMap().get(col.name)}
						{@const isDropped = change?.type === 'drop'}
						{@const isModified = change?.type === 'modify' || change?.type === 'rename'}
						{@const label = getChangeLabel(col)}
						{@const labelClass = getChangeLabelClass(col)}
						<div class="flex items-center gap-2 px-3 py-2 rounded-md border
							{isDropped
								? 'border-red-200 dark:border-red-800/50 bg-red-50/50 dark:bg-red-900/10'
								: isModified
									? 'border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-900/10'
									: 'border-transparent bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800'}"
						>
							<!-- PK icon -->
							{#if col.primaryKey}
								<Icon name="lucide:key" class="w-3.5 h-3.5 shrink-0 text-amber-500" />
							{:else if col.foreignKey}
								<Icon name="lucide:link" class="w-3.5 h-3.5 shrink-0 text-blue-400" />
							{:else}
								<Icon name="lucide:circle-dot" class="w-3.5 h-3.5 shrink-0 text-slate-300 dark:text-slate-600" />
							{/if}

							<!-- Name & type -->
							<span class="flex-1 min-w-0 text-xs font-medium truncate
								{isDropped ? 'line-through text-slate-400 dark:text-slate-500' : 'text-slate-800 dark:text-slate-200'}">
								{isModified && change?.newDef?.name ? change.newDef.name : col.name}
							</span>
							<span class="text-3xs font-mono text-slate-400 dark:text-slate-500 shrink-0">
								{isModified && change?.newDef?.type ? change.newDef.type : col.type}
							</span>

							<!-- Change badge -->
							{#if label}
								<span class="text-3xs font-bold px-1.5 py-0.5 rounded {labelClass}">{label}</span>
							{/if}

							<!-- Actions -->
							{#if isDropped}
								<button
									type="button"
									onclick={() => undropColumn(col)}
									class="shrink-0 p-1 rounded text-xs text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
									title="Undo drop"
								>
									<Icon name="lucide:undo-2" class="w-3 h-3" />
								</button>
							{:else}
								<button
									type="button"
									onclick={() => startEdit(col)}
									class="shrink-0 p-1 rounded text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors"
									title="Edit column"
								>
									<Icon name="lucide:pencil" class="w-3 h-3" />
								</button>
								{#if !col.primaryKey}
									<button
										type="button"
										onclick={() => handleDrop(col)}
										class="shrink-0 p-1 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
										title="Drop column"
									>
										<Icon name="lucide:trash-2" class="w-3 h-3" />
									</button>
								{/if}
							{/if}
						</div>
					{/each}

					<!-- Added columns (new, not yet in DB) -->
					{#each addedColumns as col}
						<div class="flex items-center gap-2 px-3 py-2 rounded-md border border-green-200 dark:border-green-800/50 bg-green-50/50 dark:bg-green-900/10">
							<Icon name="lucide:plus" class="w-3.5 h-3.5 shrink-0 text-green-500" />
							<span class="flex-1 min-w-0 text-xs font-medium truncate text-green-700 dark:text-green-400">{col.name}</span>
							<span class="text-3xs font-mono text-green-500/70 shrink-0">{col.type}</span>
							<span class="text-3xs font-bold px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">ADD</span>
							<button
								type="button"
								onclick={() => removeAddedColumn(col)}
								class="shrink-0 p-1 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
								title="Remove"
							>
								<Icon name="lucide:x" class="w-3 h-3" />
							</button>
						</div>
					{/each}
				</div>

				<!-- Add Column button -->
				<button
					type="button"
					onclick={startAdd}
					class="mt-3 flex items-center gap-2 w-full px-3 py-2 rounded-md border-2 border-dashed border-violet-300 dark:border-violet-700 text-xs font-medium text-violet-500 dark:text-violet-400 hover:border-violet-500 dark:hover:border-violet-500 hover:bg-violet-50 dark:hover:bg-violet-900/10 transition-all"
				>
					<Icon name="lucide:plus" class="w-3.5 h-3.5" />
					Add Column
				</button>
			</div>

			<!-- Right: Column Editor (shown when editing or adding) -->
			{#if editorMode && editorDef}
				<div class="w-72 shrink-0">
					<p class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
						{editorMode === 'add' ? 'New Column' : 'Edit Column'}
					</p>
					<ColumnEditor
						def={editorDef}
						dbType={dbAlterState.dbType}
						tables={tableNames}
						isNew={editorMode === 'add'}
						onChange={handleEditorChange}
						onCancel={handleEditorCancel}
					/>
				</div>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<div class="flex items-center gap-2 w-full">
			{#if totalChanges > 0}
				<button
					type="button"
					onclick={resetChanges}
					class="px-3 py-2 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
				>
					<Icon name="lucide:rotate-ccw" class="w-3.5 h-3.5 inline mr-1" />
					Reset
				</button>
			{/if}
			<div class="flex-1"></div>
			<button
				type="button"
				onclick={closeArchitect}
				class="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-lg transition-colors"
			>
				Close
			</button>
			<button
				type="button"
				onclick={previewSQL}
				disabled={totalChanges === 0 || dbAlterState.isGenerating}
				class="px-4 py-2 text-sm font-medium text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center gap-2"
			>
				{#if dbAlterState.isGenerating}
					<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
					Generating...
				{:else}
					<Icon name="lucide:code" class="w-3.5 h-3.5" />
					Preview SQL
				{/if}
			</button>
		</div>
	{/snippet}
</Modal>

<!-- Preview modal (stacked on top) -->
<AlterPreviewModal onApplied={handleApplied} />
