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
		DbClientObjectForeignKey,
		DbDriver
	} from '$shared/types/db-client';
	import type { IconName } from '$shared/types/ui/icons';

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

	const isSqlDriver = $derived(driver === 'mysql' || driver === 'postgres' || driver === 'sqlite');
	const isMongoDriver = $derived(driver === 'mongodb');
	const isRedisDriver = $derived(driver === 'redis');
	const canEditColumns = $derived(isSqlDriver);
	const canAddIndex = $derived(isSqlDriver || isMongoDriver);
	const canTruncate = $derived(!isRedisDriver);

	const columns = $derived(details?.columns ?? []);
	const indexes = $derived(details?.indexes ?? []);
	const foreignKeys = $derived(details?.foreignKeys ?? []);
	const mongoFields = $derived(details?.mongoFieldStats ?? []);
	const indexFormColumns = $derived(
		isMongoDriver && mongoFields.length > 0
			? mongoFields.map((field) => ({
				name: field.field,
				type: field.types.join(' | '),
				nullable: true,
				default: null,
				isPrimary: field.field === '_id',
				isUnique: field.field === '_id'
			}))
			: columns
	);

	const summaryCards = $derived.by<Array<{ label: string; value: string; icon: IconName }>>(() => {
		if (isRedisDriver) {
			return [
				{ label: 'Type', value: details?.redisValueType ?? '-', icon: 'lucide:key-round' },
				{ label: 'TTL', value: formatTtl(details?.redisTtlSeconds), icon: 'lucide:clock' }
			];
		}

		const cards: Array<{ label: string; value: string; icon: IconName }> = [
			{
				label: isMongoDriver ? 'Fields' : 'Columns',
				value: num(isMongoDriver ? mongoFields.length : columns.length),
				icon: isMongoDriver ? 'lucide:braces' : 'lucide:table'
			},
			{ label: 'Indexes', value: num(indexes.length), icon: 'lucide:list-tree' }
		];

		if (isSqlDriver) {
			cards.push({ label: 'Relations', value: num(foreignKeys.length), icon: 'lucide:network' });
		}
		if (typeof details?.rowCount === 'number') {
			cards.push({ label: isMongoDriver ? 'Documents' : 'Rows', value: num(details.rowCount), icon: 'lucide:database' });
		}
		if (typeof details?.sizeBytes === 'number') {
			cards.push({ label: 'Size', value: formatBytes(details.sizeBytes), icon: 'lucide:hard-drive' });
		}

		return cards;
	});

	function objectDetailsType(): 'table' | 'collection' | 'key' {
		if (isMongoDriver) return 'collection';
		if (isRedisDriver) return 'key';
		return 'table';
	}

	async function load(): Promise<void> {
		loading = true;
		error = null;
		try {
			details = await dbClientStore.getObjectDetails(connectionId, {
				name: objectName,
				type: objectDetailsType(),
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
				type: objectDetailsType(),
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
			dbClientStore.requestSchemaReload();
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
			dbClientStore.requestSchemaReload();
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function doAddColumn(payload: { name: string; columns: { name: string; type: string; nullable: boolean; default: string; primary: boolean; unique: boolean; autoIncrement: boolean }[] }): Promise<void> {
		const ops = payload.columns.map((c) => ({
			kind: 'add-column' as const,
			column: {
				name: c.name,
				type: c.type,
				nullable: c.nullable,
				default: c.default || null,
				primary: c.primary,
				unique: c.unique,
				autoIncrement: c.autoIncrement
			}
		}));
		await dbClientStore.alterTable(connectionId, objectName, ops, { database, schema });
		dbClientStore.requestSchemaReload();
		await load();
	}

	async function doAddIndex(def: { name: string; columns: string[]; unique: boolean }): Promise<void> {
		await dbClientStore.createIndex(connectionId, objectName, def, { database, schema });
		dbClientStore.requestSchemaReload();
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
		dbClientStore.requestSchemaReload();
		await load();
	}

	function openReferencedTable(fk: DbClientObjectForeignKey, view: 'data' | 'structure'): void {
		dbClientStore.openTable(connectionId, {
			name: fk.refTable,
			type: 'table',
			database,
			schema
		}, view);
	}

	function num(n: number): string {
		return n.toLocaleString();
	}

	function formatBytes(n: number | null | undefined): string {
		if (n === null || n === undefined || !Number.isFinite(n)) return '-';
		if (n === 0) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
		return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
	}

	function formatTtl(ttl: number | null | undefined): string {
		if (ttl === null) return 'No expiry';
		if (ttl === undefined) return '-';
		if (ttl < 60) return `${ttl}s`;
		if (ttl < 3600) return `${Math.floor(ttl / 60)}m ${ttl % 60}s`;
		const hours = Math.floor(ttl / 3600);
		const minutes = Math.floor((ttl % 3600) / 60);
		return `${hours}h ${minutes}m`;
	}
</script>

<div class="flex flex-col h-full min-h-0 overflow-y-auto">
	<div class="flex items-center gap-1 px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 shrink-0 text-xs">
		<button
			type="button"
			class="flex items-center gap-1.5 h-7 px-2 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors"
			onclick={load}
			disabled={loading}
			title="Refresh"
		>
			<Icon name={loading ? 'lucide:loader' : 'lucide:refresh-cw'} class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" /> Refresh
		</button>
		<button
			type="button"
			class="flex items-center gap-1.5 h-7 px-2 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
			onclick={() => { renameValue = objectName; renameOpen = true; }}
		>
			<Icon name="lucide:pencil" class="w-3.5 h-3.5" /> Rename
		</button>
		<div class="flex-1"></div>
		{#if canTruncate}
			<button
				type="button"
				class="flex items-center gap-1.5 h-7 px-2 rounded-md text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 transition-colors"
				onclick={() => (confirmTruncate = true)}
			>
				<Icon name="lucide:eraser" class="w-3.5 h-3.5" /> Truncate
			</button>
		{/if}
		<button
			type="button"
			class="flex items-center gap-1.5 h-7 px-2 rounded-md text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
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

	<div class="flex-1 p-4 space-y-5">
		{#if loading && !details}
			<div class="min-h-[220px] flex items-center justify-center text-slate-400 dark:text-slate-600">
				<Icon name="lucide:loader" class="w-5 h-5 animate-spin" />
			</div>
		{:else}
			<div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-3">
				{#each summaryCards as card (card.label)}
					<div class="border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 min-w-0">
						<div class="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
							<Icon name={card.icon} class="w-3.5 h-3.5 shrink-0" />
							<span class="truncate">{card.label}</span>
						</div>
						<div class="mt-1 text-base font-semibold text-slate-900 dark:text-slate-100 truncate">{card.value}</div>
					</div>
				{/each}
			</div>

			{#if isRedisDriver}
				<section>
					<h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Key details</h3>
					<div class="border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto">
						<dl class="divide-y divide-slate-200 dark:divide-slate-800 bg-slate-50 dark:bg-slate-800/50 text-sm">
							<div class="flex items-center justify-between gap-4 px-4 py-2.5">
								<dt class="text-slate-500 dark:text-slate-400">Name</dt>
								<dd class="font-medium text-slate-800 dark:text-slate-200 truncate text-right">{objectName}</dd>
							</div>
							<div class="flex items-center justify-between gap-4 px-4 py-2.5">
								<dt class="text-slate-500 dark:text-slate-400">Value type</dt>
								<dd class="font-medium text-slate-800 dark:text-slate-200">{details?.redisValueType ?? '-'}</dd>
							</div>
							<div class="flex items-center justify-between gap-4 px-4 py-2.5">
								<dt class="text-slate-500 dark:text-slate-400">TTL</dt>
								<dd class="font-medium text-slate-800 dark:text-slate-200">{formatTtl(details?.redisTtlSeconds)}</dd>
							</div>
						</dl>
					</div>
				</section>
			{:else}
				{#if isMongoDriver}
					<section>
						<h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Sampled fields</h3>
						<div class="border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto">
							<table class="w-full min-w-[560px] text-sm bg-slate-50 dark:bg-slate-800/50">
								<thead class="bg-slate-200 dark:bg-slate-800">
									<tr>
										<th class="px-3 py-2 text-left font-semibold">Field</th>
										<th class="px-3 py-2 text-left font-semibold">Types</th>
										<th class="px-3 py-2 text-left font-semibold w-32">Samples</th>
									</tr>
								</thead>
								<tbody>
									{#each mongoFields as field (field.field)}
										<tr class="border-t border-slate-100 dark:border-slate-800">
											<td class="px-3 py-2 font-medium text-slate-800 dark:text-slate-200">{field.field}</td>
											<td class="px-3 py-2">
												<div class="flex flex-wrap gap-1">
													{#each field.types as type (type)}
														<span class="px-1.5 py-0.5 rounded text-[11px] font-medium bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200">{type}</span>
													{/each}
												</div>
											</td>
											<td class="px-3 py-2 text-slate-500 dark:text-slate-400">{num(field.sampleCount)}</td>
										</tr>
									{:else}
										<tr><td class="p-3 text-slate-400 text-center" colspan="3">No sampled fields</td></tr>
									{/each}
								</tbody>
							</table>
						</div>
					</section>
				{:else}
					<section>
						<div class="flex items-center justify-between gap-3 mb-2">
							<h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200">Columns</h3>
							{#if canEditColumns}
								<button
									type="button"
									class="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-violet-500/10 text-violet-600 hover:bg-violet-500/20"
									onclick={() => (addColumnOpen = true)}
								>
									<Icon name="lucide:plus" class="w-3 h-3" /> Add column
								</button>
							{/if}
						</div>
						<div class="border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto">
							<table class="w-full min-w-[560px] text-sm bg-slate-50 dark:bg-slate-800/50">
								<thead class="bg-slate-200 dark:bg-slate-800">
									<tr>
										<th class="px-3 py-2 text-left font-semibold">Name</th>
										<th class="px-3 py-2 text-left font-semibold">Type</th>
										<th class="px-3 py-2 text-left font-semibold">Null</th>
										<th class="px-3 py-2 text-left font-semibold">Default</th>
										<th class="px-3 py-2 text-left font-semibold">Key</th>
										<th class="px-3 py-2 w-20"></th>
									</tr>
								</thead>
								<tbody>
									{#each columns as col (col.name)}
										<tr class="border-t border-slate-100 dark:border-slate-800">
											<td class="px-3 py-2 font-medium text-slate-800 dark:text-slate-200">{col.name}</td>
											<td class="px-3 py-2">
												<code class="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs">{col.type}</code>
											</td>
											<td class="px-3 py-2">
												<span class="px-1.5 py-0.5 rounded text-[11px] font-medium {col.nullable ? 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}">{col.nullable ? 'YES' : 'NO'}</span>
											</td>
											<td class="px-3 py-2 text-slate-500 dark:text-slate-400">
												{#if col.default === null || col.default === ''}
													<span class="text-slate-400">NULL</span>
												{:else}
													<code class="text-xs">{col.default}</code>
												{/if}
											</td>
											<td class="px-3 py-2">
												<div class="flex flex-wrap gap-1">
													{#if col.isPrimary}<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-violet-500/10 text-violet-700 dark:text-violet-300">PK</span>{/if}
													{#if col.isUnique}<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">UQ</span>{/if}
													{#if !col.isPrimary && !col.isUnique}<span class="text-slate-400 text-xs">-</span>{/if}
												</div>
											</td>
											<td class="px-3 py-2">
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
				{/if}

				<section>
					<div class="flex items-center justify-between gap-3 mb-2">
						<h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200">Indexes</h3>
						{#if canAddIndex && indexFormColumns.length > 0}
							<button
								type="button"
								class="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-violet-500/10 text-violet-600 hover:bg-violet-500/20"
								onclick={() => (addIndexOpen = true)}
							>
								<Icon name="lucide:plus" class="w-3 h-3" /> Add index
							</button>
						{/if}
					</div>
					<div class="border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto">
						<table class="w-full min-w-[560px] text-sm bg-slate-50 dark:bg-slate-800/50">
							<thead class="bg-slate-200 dark:bg-slate-800">
								<tr>
									<th class="px-3 py-2 text-left font-semibold">Name</th>
									<th class="px-3 py-2 text-left font-semibold">Columns</th>
									<th class="px-3 py-2 text-left font-semibold">Flags</th>
									<th class="px-3 py-2 w-10"></th>
								</tr>
							</thead>
							<tbody>
								{#each indexes as ix (ix.name)}
									<tr class="border-t border-slate-100 dark:border-slate-800">
										<td class="px-3 py-2 font-medium text-slate-800 dark:text-slate-200">{ix.name}</td>
										<td class="px-3 py-2">
											<div class="flex flex-wrap gap-1">
												{#each ix.columns as col (col)}
													<span class="px-1.5 py-0.5 rounded text-[11px] font-medium bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200">{col}</span>
												{:else}
													<span class="text-slate-400 text-xs">-</span>
												{/each}
											</div>
										</td>
										<td class="px-3 py-2">
											<div class="flex flex-wrap gap-1">
												{#if ix.unique}<span class="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">UNIQUE</span>{/if}
												{#if ix.type}<span class="px-1.5 py-0.5 rounded text-[11px] font-medium bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200">{ix.type}</span>{/if}
												{#if !ix.unique && !ix.type}<span class="text-slate-400 text-xs">-</span>{/if}
											</div>
										</td>
										<td class="px-3 py-2">
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

				{#if isSqlDriver}
					<section>
						<h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Relations</h3>
						<div class="border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto">
							<table class="w-full min-w-[560px] text-sm bg-slate-50 dark:bg-slate-800/50">
								<thead class="bg-slate-200 dark:bg-slate-800">
									<tr>
										<th class="px-3 py-2 text-left font-semibold">Column</th>
										<th class="px-3 py-2 text-left font-semibold">References</th>
										<th class="px-3 py-2 text-left font-semibold w-24">Open</th>
									</tr>
								</thead>
								<tbody>
									{#each foreignKeys as fk (fk.column + fk.refTable + fk.refColumn)}
										<tr class="border-t border-slate-100 dark:border-slate-800">
											<td class="px-3 py-2 font-medium text-slate-800 dark:text-slate-200">{fk.column}</td>
											<td class="px-3 py-2 text-slate-500 dark:text-slate-400">
												<span class="text-slate-700 dark:text-slate-200">{fk.refTable}</span>.{fk.refColumn}
											</td>
											<td class="px-3 py-2">
												<div class="flex items-center gap-1">
													<button
														type="button"
														class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 dark:text-slate-400 hover:text-violet-700 hover:bg-violet-500/10 dark:hover:text-violet-300 transition-colors"
														onclick={() => openReferencedTable(fk, 'data')}
														title="Open data"
														aria-label="Open data"
													>
														<Icon name="lucide:table" class="w-3.5 h-3.5" />
													</button>
													<button
														type="button"
														class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 dark:text-slate-400 hover:text-violet-700 hover:bg-violet-500/10 dark:hover:text-violet-300 transition-colors"
														onclick={() => openReferencedTable(fk, 'structure')}
														title="Open structure"
														aria-label="Open structure"
													>
														<Icon name="lucide:layout-list" class="w-3.5 h-3.5" />
													</button>
												</div>
											</td>
										</tr>
									{:else}
										<tr><td class="p-3 text-slate-400 text-center" colspan="3">No outgoing foreign keys</td></tr>
									{/each}
								</tbody>
							</table>
						</div>
					</section>
				{/if}
			{/if}
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

{#if canEditColumns}
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
{/if}

{#if canAddIndex && indexFormColumns.length > 0}
	<IndexForm
		bind:isOpen={addIndexOpen}
		columns={indexFormColumns}
		onSubmit={doAddIndex}
		onClose={() => (addIndexOpen = false)}
	/>
{/if}
