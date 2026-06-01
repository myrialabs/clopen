<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ConfirmDestructive from '../shared/ConfirmDestructive.svelte';
	import TableDesigner from './TableDesigner.svelte';
	import ColumnEditor from './ColumnEditor.svelte';
	import IndexForm from './IndexForm.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { debug } from '$shared/utils/logger';
	import type {
		DbClientObjectColumn,
		DbClientObjectDetails,
		DbDriver
	} from '$shared/types/db-client';

	interface Props {
		connectionId: string;
		driver: DbDriver;
		objectName: string;
		database?: string;
		schema?: string;
	}

	const { connectionId, driver, objectName, database, schema }: Props = $props();

	let details = $state<DbClientObjectDetails | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);

	let renameOpen = $state(false);
	let renameValue = $state('');
	let confirmDrop = $state(false);
	let confirmTruncate = $state(false);
	let dropColumn = $state<string | null>(null);
	let dropIndex = $state<string | null>(null);
	let addColumnOpen = $state(false);
	let addIndexOpen = $state(false);
	let editColumnOpen = $state(false);
	let editingColumn = $state<DbClientObjectColumn | null>(null);

	async function load(): Promise<void> {
		loading = true;
		error = null;
		try {
			details = await dbClientStore.getObjectDetails(connectionId, {
				name: objectName,
				type: driver === 'mongodb' ? 'collection' : 'table',
				database,
				schema
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			debug.error('db-client', 'structure load failed:', e);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (objectName) load();
	});

	async function doRename(): Promise<void> {
		if (!renameValue || renameValue === objectName) return;
		try {
			await dbClientStore.renameTable(connectionId, objectName, renameValue, { database, schema });
			// Point the active object at the new name (this re-drives load via the
			// effect) and refresh the sidebar so the rename is reflected there too.
			dbClientStore.setActiveObject(connectionId, {
				name: renameValue,
				type: driver === 'mongodb' ? 'collection' : 'table',
				database,
				schema
			});
			dbClientStore.requestSchemaReload();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function doTruncate(): Promise<void> {
		try {
			await dbClientStore.truncateTable(connectionId, objectName, { database, schema });
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function doDrop(): Promise<void> {
		try {
			await dbClientStore.dropTable(connectionId, objectName, { database, schema });
			// Clear the now-gone object and refresh the sidebar so the dropped
			// table disappears from the navigation list immediately.
			dbClientStore.setActiveObject(connectionId, null);
			dbClientStore.requestSchemaReload();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function doDropColumn(): Promise<void> {
		if (!dropColumn) return;
		try {
			await dbClientStore.alterTable(connectionId, objectName, [{ kind: 'drop-column', name: dropColumn }], { database, schema });
			dropColumn = null;
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function doDropIndex(): Promise<void> {
		if (!dropIndex) return;
		try {
			await dbClientStore.dropIndex(connectionId, objectName, dropIndex, { database, schema });
			dropIndex = null;
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function doAddColumn(payload: { name: string; columns: { name: string; type: string; nullable: boolean; default: string; primary: boolean; unique: boolean; autoIncrement: boolean }[] }): Promise<void> {
		const c = payload.columns[0];
		await dbClientStore.alterTable(connectionId, objectName, [{
			kind: 'add-column',
			column: {
				name: c.name,
				type: c.type,
				nullable: c.nullable,
				default: c.default || null,
				primary: c.primary,
				unique: c.unique,
				autoIncrement: c.autoIncrement
			}
		}], { database, schema });
		await load();
	}

	async function doAddIndex(def: { name: string; columns: string[]; unique: boolean }): Promise<void> {
		await dbClientStore.createIndex(connectionId, objectName, def, { database, schema });
		await load();
	}

	function openEditColumn(col: DbClientObjectColumn): void {
		editingColumn = col;
		editColumnOpen = true;
	}

	async function doEditColumn(payload: {
		originalName: string;
		newName: string;
		type: string;
		nullable: boolean;
		default: string;
		primary: boolean;
		unique: boolean;
		autoIncrement: boolean;
	}): Promise<void> {
		const ops: Parameters<typeof dbClientStore.alterTable>[2] = [];
		if (payload.originalName !== payload.newName) {
			ops.push({ kind: 'rename-column', name: payload.originalName, newName: payload.newName });
		}
		if (driver !== 'sqlite') {
			ops.push({
				kind: 'modify-column',
				column: {
					name: payload.newName,
					type: payload.type,
					nullable: payload.nullable,
					default: payload.default || null,
					primary: payload.primary,
					unique: payload.unique,
					autoIncrement: payload.autoIncrement
				}
			});
		}
		if (ops.length === 0) return;
		await dbClientStore.alterTable(connectionId, objectName, ops, { database, schema });
		await load();
	}
</script>

<div class="flex flex-col h-full min-h-0 overflow-y-auto">
	<div class="flex items-center gap-1 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0 text-sm">
		<button
			type="button"
			class="flex items-center gap-1 px-2 py-1 rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
			onclick={load}
			disabled={loading}
			title="Refresh"
		>
			<Icon name={loading ? 'lucide:loader' : 'lucide:refresh-cw'} class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" /> Refresh
		</button>
		<button
			type="button"
			class="flex items-center gap-1 px-2 py-1 rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
			onclick={() => { renameValue = objectName; renameOpen = true; }}
		>
			<Icon name="lucide:pencil" class="w-3.5 h-3.5" /> Rename
		</button>
		<button
			type="button"
			class="flex items-center gap-1 px-2 py-1 rounded text-amber-600 hover:bg-amber-500/10"
			onclick={() => (confirmTruncate = true)}
		>
			<Icon name="lucide:eraser" class="w-3.5 h-3.5" /> Truncate
		</button>
		<button
			type="button"
			class="flex items-center gap-1 px-2 py-1 rounded text-red-600 hover:bg-red-500/10"
			onclick={() => (confirmDrop = true)}
		>
			<Icon name="lucide:trash-2" class="w-3.5 h-3.5" /> Drop
		</button>
	</div>

	{#if driver === 'sqlite'}
		<div class="px-4 py-2 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-500/10 border-b border-amber-500/20">
			SQLite: <code>MODIFY COLUMN</code> is not supported; <code>DROP COLUMN</code> requires SQLite 3.35+. Edits will only apply rename.
		</div>
	{/if}

	{#if error}
		<div class="px-4 py-2 text-xs text-red-600 dark:text-red-400">{error}</div>
	{/if}

	<div class="flex-1 p-4 space-y-6">
		<section>
			<div class="flex items-center justify-between mb-2">
				<h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200">Columns</h3>
				<button
					type="button"
					class="flex items-center gap-1 text-xs px-2 py-1 rounded bg-violet-500/10 text-violet-600 hover:bg-violet-500/20"
					onclick={() => (addColumnOpen = true)}
				>
					<Icon name="lucide:plus" class="w-3 h-3" /> Add column
				</button>
			</div>
			<div class="border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
				<table class="w-full text-sm bg-slate-50 dark:bg-slate-800/50">
					<thead class="bg-slate-200 dark:bg-slate-800">
						<tr>
							<th class="px-3 py-1.5 text-left font-semibold">Name</th>
							<th class="px-3 py-1.5 text-left font-semibold">Type</th>
							<th class="px-3 py-1.5 text-left font-semibold">Nullable</th>
							<th class="px-3 py-1.5 text-left font-semibold">Default</th>
							<th class="px-3 py-1.5 text-left font-semibold">Flags</th>
							<th class="px-3 py-1.5 w-20"></th>
						</tr>
					</thead>
					<tbody>
						{#each details?.columns ?? [] as col (col.name)}
							<tr class="border-t border-slate-100 dark:border-slate-800">
								<td class="px-3 py-1.5">{col.name}</td>
								<td class="px-3 py-1.5 text-slate-500">{col.type}</td>
								<td class="px-3 py-1.5">{col.nullable ? 'YES' : 'NO'}</td>
								<td class="px-3 py-1.5 text-slate-500">{col.default ?? ''}</td>
								<td class="px-3 py-1.5">
									{#if col.isPrimary}<span class="mr-1 text-[10px] px-1 rounded bg-violet-500/10 text-violet-600">PK</span>{/if}
									{#if col.isUnique}<span class="text-[10px] px-1 rounded bg-emerald-500/10 text-emerald-600">UQ</span>{/if}
								</td>
								<td class="px-3 py-1.5">
									<div class="flex items-center gap-0.5">
										<button
											type="button"
											class="text-slate-500 hover:text-violet-600 hover:bg-violet-500/10 rounded p-1"
											onclick={() => openEditColumn(col)}
											aria-label="Edit column"
											title="Edit"
										>
											<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
										</button>
										<button
											type="button"
											class="text-red-500 hover:bg-red-500/10 rounded p-1"
											onclick={() => (dropColumn = col.name)}
											aria-label="Drop column"
											title="Drop"
										>
											<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
										</button>
									</div>
								</td>
							</tr>
						{:else}
							<tr><td class="p-3 text-slate-400 text-center" colspan="6">No columns</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<section>
			<div class="flex items-center justify-between mb-2">
				<h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200">Indexes</h3>
				<button
					type="button"
					class="flex items-center gap-1 text-xs px-2 py-1 rounded bg-violet-500/10 text-violet-600 hover:bg-violet-500/20"
					onclick={() => (addIndexOpen = true)}
				>
					<Icon name="lucide:plus" class="w-3 h-3" /> Add index
				</button>
			</div>
			<div class="border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
				<table class="w-full text-sm bg-slate-50 dark:bg-slate-800/50">
					<thead class="bg-slate-200 dark:bg-slate-800">
						<tr>
							<th class="px-3 py-1.5 text-left font-semibold">Name</th>
							<th class="px-3 py-1.5 text-left font-semibold">Columns</th>
							<th class="px-3 py-1.5 text-left font-semibold">Unique</th>
							<th class="px-3 py-1.5 w-10"></th>
						</tr>
					</thead>
					<tbody>
						{#each details?.indexes ?? [] as ix (ix.name)}
							<tr class="border-t border-slate-100 dark:border-slate-800">
								<td class="px-3 py-1.5">{ix.name}</td>
								<td class="px-3 py-1.5 text-slate-500">{ix.columns.join(', ')}</td>
								<td class="px-3 py-1.5">{ix.unique ? 'YES' : ''}</td>
								<td class="px-3 py-1.5">
									<button
										type="button"
										class="text-red-500 hover:bg-red-500/10 rounded p-1"
										onclick={() => (dropIndex = ix.name)}
										aria-label="Drop index"
									>
										<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
									</button>
								</td>
							</tr>
						{:else}
							<tr><td class="p-3 text-slate-400 text-center" colspan="4">No indexes</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		{#if details?.foreignKeys && details.foreignKeys.length > 0}
			<section>
				<h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Foreign keys</h3>
				<div class="border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
					<table class="w-full text-sm bg-slate-50 dark:bg-slate-800/50">
						<thead class="bg-slate-200 dark:bg-slate-800">
							<tr>
								<th class="px-3 py-1.5 text-left font-semibold">Column</th>
								<th class="px-3 py-1.5 text-left font-semibold">References</th>
							</tr>
						</thead>
						<tbody>
							{#each details.foreignKeys as fk (fk.column + fk.refTable)}
								<tr class="border-t border-slate-100 dark:border-slate-800">
									<td class="px-3 py-1.5">{fk.column}</td>
									<td class="px-3 py-1.5 text-slate-500">{fk.refTable}.{fk.refColumn}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}
	</div>
</div>

<Dialog
	bind:isOpen={renameOpen}
	onClose={() => (renameOpen = false)}
	title="Rename table"
	type="info"
	bind:inputValue={renameValue}
	confirmText="Rename"
	onConfirm={doRename}
/>

<ConfirmDestructive
	bind:isOpen={confirmTruncate}
	title="Truncate table?"
	message={`Remove all rows from "${objectName}"? This cannot be undone.`}
	confirmText="Truncate"
	onConfirm={doTruncate}
	onClose={() => (confirmTruncate = false)}
/>

<ConfirmDestructive
	bind:isOpen={confirmDrop}
	title="Drop table?"
	message={`Permanently drop "${objectName}" and all its data? This cannot be undone.`}
	confirmText="Drop"
	onConfirm={doDrop}
	onClose={() => (confirmDrop = false)}
/>

<ConfirmDestructive
	isOpen={dropColumn !== null}
	title="Drop column?"
	message={`Drop column "${dropColumn}" from "${objectName}"? This cannot be undone.`}
	confirmText="Drop"
	onConfirm={doDropColumn}
	onClose={() => (dropColumn = null)}
/>

<ConfirmDestructive
	isOpen={dropIndex !== null}
	title="Drop index?"
	message={`Drop index "${dropIndex}" from "${objectName}"? This cannot be undone.`}
	confirmText="Drop"
	onConfirm={doDropIndex}
	onClose={() => (dropIndex = null)}
/>

<TableDesigner
	bind:isOpen={addColumnOpen}
	{driver}
	mode="add-column"
	tableName={objectName}
	onSubmit={doAddColumn}
	onClose={() => (addColumnOpen = false)}
/>

<ColumnEditor
	bind:isOpen={editColumnOpen}
	{driver}
	column={editingColumn}
	onSubmit={doEditColumn}
	onClose={() => { editColumnOpen = false; editingColumn = null; }}
/>

{#if details?.columns}
	<IndexForm
		bind:isOpen={addIndexOpen}
		columns={details.columns}
		onSubmit={doAddIndex}
		onClose={() => (addIndexOpen = false)}
	/>
{/if}
