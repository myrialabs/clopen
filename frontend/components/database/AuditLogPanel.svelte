<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbRbacState,
		loadAuditLog,
		pruneAuditLog,
		rollbackAuditEntry,
		canDo
	} from '$frontend/stores/features/db-rbac.svelte';
	import type { DBAuditLogEntry } from '$shared/types/db-rbac';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	let searchQuery = $state('');
	let filterAction = $state('');
	let showPruneConfirm = $state(false);
	let pruneDays = $state(30);
	let expandedId = $state<string | null>(null);
	let rollbackConfirmId = $state<string | null>(null);
	let isRollingBack = $state(false);
	let rollbackResultSql = $state<string[] | null>(null);

	$effect(() => {
		if (connectionId) loadAuditLog(connectionId);
	});

	const uniqueActions = $derived(
		[...new Set(dbRbacState.auditEntries.map((e) => e.action))].sort()
	);

	const filtered = $derived(
		dbRbacState.auditEntries.filter((entry) => {
			const matchSearch =
				!searchQuery ||
				entry.sql?.toLowerCase().includes(searchQuery.toLowerCase()) ||
				entry.userName.toLowerCase().includes(searchQuery.toLowerCase()) ||
				entry.tableName?.toLowerCase().includes(searchQuery.toLowerCase());
			const matchAction = !filterAction || entry.action === filterAction;
			return matchSearch && matchAction;
		})
	);

	const canRollback = $derived(canDo('data:rollback'));

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString();
	}

	function actionBadgeClass(action: string): string {
		if (action === 'data:rollback') return 'bg-purple-900/60 text-purple-300';
		if (action.includes('drop_db')) return 'bg-red-900/60 text-red-300';
		if (action.includes('ddl') || action.includes('schema')) return 'bg-orange-900/60 text-orange-300';
		if (action.includes('delete') || action.includes('dml')) return 'bg-yellow-900/60 text-yellow-300';
		if (action.includes('insert') || action.includes('update')) return 'bg-blue-900/60 text-blue-300';
		return 'bg-neutral-700 text-neutral-300';
	}

	function hasSnapshot(entry: DBAuditLogEntry): boolean {
		return !!(entry.beforeData || entry.afterData);
	}

	function canRollbackEntry(entry: DBAuditLogEntry): boolean {
		if (!canRollback || !entry.success) return false;
		if (entry.action === 'data:update') return !!(entry.beforeData && entry.pkColumn);
		if (entry.action === 'data:delete') return !!entry.beforeData;
		if (entry.action === 'data:insert') return !!(entry.pkColumn && entry.pkValue);
		return false;
	}

	function parseJson(str: string | null | undefined): unknown {
		if (!str) return null;
		try { return JSON.parse(str); } catch { return null; }
	}

	/** Build a diff array: [{ col, before, after, changed }] for UPDATE display */
	function buildDiff(entry: DBAuditLogEntry): { col: string; before: unknown; after: unknown; changed: boolean }[] {
		const before = parseJson(entry.beforeData) as Record<string, unknown> | null;
		const after = parseJson(entry.afterData) as Record<string, unknown> | null;

		if (entry.action === 'data:update' && before) {
			const allCols = [...new Set([...Object.keys(before), ...Object.keys(after ?? {})])];
			return allCols.map((col) => ({
				col,
				before: before[col],
				after: after ? (col in after ? after[col] : before[col]) : before[col],
				changed: after ? col in after && JSON.stringify(before[col]) !== JSON.stringify(after[col]) : false
			}));
		}
		return [];
	}

	/** Pretty-print a JSON value for display */
	function displayVal(v: unknown): string {
		if (v === null || v === undefined) return 'NULL';
		if (typeof v === 'object') return JSON.stringify(v);
		return String(v);
	}

	async function doRollback(entry: DBAuditLogEntry) {
		rollbackConfirmId = null;
		isRollingBack = true;
		rollbackResultSql = null;
		try {
			const sqls = await rollbackAuditEntry(connectionId, entry.id);
			if (sqls) rollbackResultSql = sqls;
		} finally {
			isRollingBack = false;
		}
	}

	function toggleExpand(id: string) {
		expandedId = expandedId === id ? null : id;
		if (expandedId !== id) rollbackConfirmId = null;
	}
</script>

<div class="flex h-full flex-col gap-3 overflow-hidden p-3">
	<!-- Toolbar -->
	<div class="flex flex-wrap items-center gap-2">
		<input
			class="min-w-0 flex-1 rounded border border-neutral-600 bg-neutral-800 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-blue-500 focus:outline-none"
			placeholder="Search SQL, user, table…"
			bind:value={searchQuery}
		/>

		<select
			class="rounded border border-neutral-600 bg-neutral-800 px-2 py-1.5 text-sm text-neutral-100 focus:border-blue-500 focus:outline-none"
			bind:value={filterAction}
		>
			<option value="">All actions</option>
			{#each uniqueActions as action}
				<option value={action}>{action}</option>
			{/each}
		</select>

		<button
			class="flex items-center gap-1 rounded border border-neutral-600 bg-neutral-800 px-2 py-1.5 text-sm text-neutral-300 transition hover:bg-neutral-700"
			onclick={() => loadAuditLog(connectionId)}
			title="Refresh"
		>
			<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" />
		</button>

		<button
			class="flex items-center gap-1 rounded border border-red-800 bg-neutral-800 px-2 py-1.5 text-sm text-red-400 transition hover:bg-red-900/30"
			onclick={() => (showPruneConfirm = !showPruneConfirm)}
		>
			<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
			Prune
		</button>
	</div>

	<!-- Prune form -->
	{#if showPruneConfirm}
		<div class="flex items-center gap-2 rounded-lg border border-red-800 bg-red-900/20 px-3 py-2">
			<span class="text-sm text-red-300">Delete entries older than</span>
			<input
				type="number"
				class="w-16 rounded border border-neutral-600 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 focus:border-red-500 focus:outline-none"
				bind:value={pruneDays}
				min="1"
			/>
			<span class="text-sm text-red-300">days</span>
			<button
				class="ml-auto rounded bg-red-700 px-3 py-1 text-xs font-medium text-white transition hover:bg-red-600"
				onclick={async () => {
					await pruneAuditLog(connectionId, pruneDays);
					showPruneConfirm = false;
				}}
			>
				Confirm
			</button>
			<button
				class="rounded border border-neutral-600 px-3 py-1 text-xs text-neutral-400 transition hover:bg-neutral-700"
				onclick={() => (showPruneConfirm = false)}
			>
				Cancel
			</button>
		</div>
	{/if}

	<!-- Rollback result -->
	{#if rollbackResultSql}
		<div class="rounded-lg border border-purple-800 bg-purple-900/20 p-3">
			<div class="mb-1.5 flex items-center justify-between">
				<span class="text-xs font-medium text-purple-300">Rollback executed successfully</span>
				<button
					class="text-xs text-neutral-500 hover:text-neutral-300"
					onclick={() => (rollbackResultSql = null)}
				>
					<Icon name="lucide:x" class="w-3.5 h-3.5" />
				</button>
			</div>
			{#each rollbackResultSql as sql}
				<pre class="rounded bg-neutral-900 px-2 py-1.5 font-mono text-xs text-purple-200">{sql}</pre>
			{/each}
		</div>
	{/if}

	<!-- Stats bar -->
	<div class="flex items-center gap-3 text-xs text-neutral-500">
		<span>{filtered.length} of {dbRbacState.auditEntries.length} entries</span>
		{#if dbRbacState.isLoadingAudit}
			<span class="text-blue-400">Loading…</span>
		{/if}
		{#if isRollingBack}
			<span class="text-purple-400">Rolling back…</span>
		{/if}
	</div>

	<!-- Log table -->
	<div class="min-h-0 flex-1 overflow-auto rounded-lg border border-neutral-700">
		{#if filtered.length === 0}
			<div class="flex h-full items-center justify-center text-sm text-neutral-500">
				{dbRbacState.isLoadingAudit ? 'Loading audit log…' : 'No entries found'}
			</div>
		{:else}
			<table class="w-full text-left text-sm">
				<thead class="sticky top-0 bg-neutral-800 text-xs uppercase tracking-wide text-neutral-400">
					<tr>
						<th class="w-6 px-2 py-2"></th>
						<th class="px-3 py-2">Time</th>
						<th class="px-3 py-2">User</th>
						<th class="px-3 py-2">Action</th>
						<th class="px-3 py-2">Table</th>
						<th class="px-3 py-2">SQL / Details</th>
						<th class="px-3 py-2">Rows</th>
						<th class="px-3 py-2">Status</th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as entry (entry.id)}
						<!-- Main row -->
						<tr
							class="border-t border-neutral-700/50 transition hover:bg-neutral-800/60 cursor-pointer"
							class:opacity-60={!entry.success}
							onclick={() => toggleExpand(entry.id)}
						>
							<td class="px-2 py-1.5">
								{#if hasSnapshot(entry)}
									<Icon
										name={expandedId === entry.id ? 'lucide:chevron-down' : 'lucide:chevron-right'}
										class="w-3.5 h-3.5 text-neutral-500"
									/>
								{/if}
							</td>
							<td class="whitespace-nowrap px-3 py-1.5 text-xs text-neutral-400">
								{formatDate(entry.performedAt)}
							</td>
							<td class="px-3 py-1.5 text-xs font-medium text-neutral-200">
								{entry.userName}
							</td>
							<td class="px-3 py-1.5">
								<span class="rounded px-1.5 py-0.5 text-xs {actionBadgeClass(entry.action)}">
									{entry.action}
								</span>
							</td>
							<td class="px-3 py-1.5 text-xs text-neutral-400">
								{entry.tableName ?? '—'}
							</td>
							<td class="max-w-xs px-3 py-1.5">
								{#if entry.error}
									<span class="text-xs text-red-400">{entry.error}</span>
								{:else if entry.sql}
									<span class="block truncate font-mono text-xs text-neutral-300" title={entry.sql}>
										{entry.sql}
									</span>
								{:else}
									<span class="text-xs text-neutral-600">—</span>
								{/if}
							</td>
							<td class="px-3 py-1.5 text-xs text-neutral-400">
								{entry.rowCount ?? '—'}
							</td>
							<td class="px-3 py-1.5">
								{#if entry.success}
									<span class="text-xs text-emerald-400">OK</span>
								{:else}
									<span class="text-xs text-red-400">Error</span>
								{/if}
							</td>
						</tr>

						<!-- Expanded diff panel -->
						{#if expandedId === entry.id && hasSnapshot(entry)}
							<tr class="border-t border-neutral-700/30 bg-neutral-900/60">
								<td colspan="8" class="px-4 py-3">
									<div class="flex flex-col gap-3">

										<!-- UPDATE diff table -->
										{#if entry.action === 'data:update'}
											{@const diff = buildDiff(entry)}
											<div class="text-xs font-medium text-neutral-400 uppercase tracking-wide">
												Data Diff — before vs after
											</div>
											{#if diff.length}
												<div class="overflow-auto rounded border border-neutral-700">
													<table class="w-full text-xs">
														<thead class="bg-neutral-800 text-neutral-400">
															<tr>
																<th class="px-3 py-1.5 text-left">Column</th>
																<th class="px-3 py-1.5 text-left text-amber-400/80">Before</th>
																<th class="px-3 py-1.5 text-left text-emerald-400/80">After</th>
															</tr>
														</thead>
														<tbody>
															{#each diff as row}
																<tr
																	class={row.changed
																		? 'border-t border-neutral-700/40 bg-amber-900/20'
																		: 'border-t border-neutral-700/40'}
																>
																	<td class="px-3 py-1 font-mono text-neutral-300">
																		{row.col}
																		{#if row.changed}
																			<span class="ml-1 rounded bg-amber-700/40 px-1 py-0.5 text-amber-300 text-[10px]">changed</span>
																		{/if}
																	</td>
																	<td class="px-3 py-1 font-mono text-neutral-400 max-w-xs truncate" title={displayVal(row.before)}>
																		{displayVal(row.before)}
																	</td>
																	<td class="px-3 py-1 font-mono max-w-xs truncate"
																		class:text-emerald-300={row.changed}
																		class:text-neutral-400={!row.changed}
																		title={displayVal(row.after)}>
																		{displayVal(row.after)}
																	</td>
																</tr>
															{/each}
														</tbody>
													</table>
												</div>
											{/if}

										<!-- INSERT — show inserted data -->
										{:else if entry.action === 'data:insert'}
											{@const row = parseJson(entry.afterData) as Record<string, unknown> | null}
											<div class="text-xs font-medium text-neutral-400 uppercase tracking-wide">
												Inserted Row Snapshot
											</div>
											{#if row}
												<div class="overflow-auto rounded border border-neutral-700">
													<table class="w-full text-xs">
														<thead class="bg-neutral-800 text-neutral-400">
															<tr>
																<th class="px-3 py-1.5 text-left">Column</th>
																<th class="px-3 py-1.5 text-left text-emerald-400/80">Inserted Value</th>
															</tr>
														</thead>
														<tbody>
															{#each Object.entries(row) as [col, val]}
																<tr class="border-t border-neutral-700/40">
																	<td class="px-3 py-1 font-mono text-neutral-300">{col}</td>
																	<td class="px-3 py-1 font-mono text-emerald-300 max-w-xs truncate" title={displayVal(val)}>
																		{displayVal(val)}
																	</td>
																</tr>
															{/each}
														</tbody>
													</table>
												</div>
											{/if}

										<!-- DELETE — show deleted rows -->
										{:else if entry.action === 'data:delete'}
											{@const rows = parseJson(entry.beforeData)}
											{@const rowArr = Array.isArray(rows) ? rows : (rows ? [rows] : [])}
											<div class="text-xs font-medium text-neutral-400 uppercase tracking-wide">
												Deleted Row(s) Snapshot
											</div>
											{#if rowArr.length}
												{#each rowArr as row, i}
													{#if i > 0}
														<div class="border-t border-neutral-700/40 pt-2"></div>
													{/if}
													<div class="overflow-auto rounded border border-neutral-700">
														<table class="w-full text-xs">
															{#if i === 0}
																<thead class="bg-neutral-800 text-neutral-400">
																	<tr>
																		<th class="px-3 py-1.5 text-left">Column</th>
																		<th class="px-3 py-1.5 text-left text-red-400/80">Deleted Value</th>
																	</tr>
																</thead>
															{/if}
															<tbody>
																{#each Object.entries(row as Record<string, unknown>) as [col, val]}
																	<tr class="border-t border-neutral-700/40">
																		<td class="px-3 py-1 font-mono text-neutral-300">{col}</td>
																		<td class="px-3 py-1 font-mono text-red-300 max-w-xs truncate" title={displayVal(val)}>
																			{displayVal(val)}
																		</td>
																	</tr>
																{/each}
															</tbody>
														</table>
													</div>
												{/each}
											{/if}
										{/if}

										<!-- Rollback controls -->
										{#if canRollbackEntry(entry)}
											{#if rollbackConfirmId === entry.id}
												<div class="flex items-center gap-2 rounded-lg border border-amber-700 bg-amber-900/20 px-3 py-2">
													<Icon name="lucide:triangle-alert" class="w-4 h-4 text-amber-400 shrink-0" />
													<span class="text-xs text-amber-300">
														This will execute a reverse SQL on the live database. Proceed?
													</span>
													<button
														class="ml-auto rounded bg-amber-700 px-3 py-1 text-xs font-medium text-white transition hover:bg-amber-600 disabled:opacity-50"
														disabled={isRollingBack}
														onclick={() => doRollback(entry)}
													>
														{isRollingBack ? 'Rolling back…' : 'Confirm Rollback'}
													</button>
													<button
														class="rounded border border-neutral-600 px-3 py-1 text-xs text-neutral-400 transition hover:bg-neutral-700"
														onclick={() => (rollbackConfirmId = null)}
													>
														Cancel
													</button>
												</div>
											{:else}
												<div class="flex justify-end">
													<button
														class="flex items-center gap-1.5 rounded border border-amber-700/60 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-300 transition hover:bg-amber-900/40"
														onclick={(e) => { e.stopPropagation(); rollbackConfirmId = entry.id; }}
													>
														<Icon name="lucide:undo-2" class="w-3.5 h-3.5" />
														Rollback this change
													</button>
												</div>
											{/if}
										{/if}

									</div>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>
