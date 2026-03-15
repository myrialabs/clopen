<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { dbSchemaVersionState, closeDiff } from '$frontend/stores/features/db-schema-versioning.svelte';
	import type { ColumnDiffStatus } from '$shared/types/schema-versioning';
	import { STATUS_CONFIG } from './diff-utils';

	const statusColor = (s: ColumnDiffStatus) => STATUS_CONFIG[s].color;
	const statusRowBg = (s: ColumnDiffStatus) => STATUS_CONFIG[s].rowBg;
	const statusLabel = (s: ColumnDiffStatus) => STATUS_CONFIG[s].label;

	const changedColumns = $derived(
		(dbSchemaVersionState.diffModal.diff?.columns ?? []).filter((c) => c.status !== 'unchanged')
	);
	const unchangedColumns = $derived(
		(dbSchemaVersionState.diffModal.diff?.columns ?? []).filter((c) => c.status === 'unchanged')
	);

	let showUnchanged = $state(false);

	const visibleColumns = $derived(
		showUnchanged
			? (dbSchemaVersionState.diffModal.diff?.columns ?? [])
			: changedColumns
	);
</script>

{#if dbSchemaVersionState.diffModal.isOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
		onclick={(e) => e.target === e.currentTarget && closeDiff()}
		onkeydown={(e) => e.key === 'Escape' && closeDiff()}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div class="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col max-h-[80vh]">
			<!-- Header -->
			<div class="flex items-center gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<div class="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
					<Icon name="lucide:git-compare" class="w-4 h-4 text-violet-500" />
				</div>
				<div class="flex-1 min-w-0">
					<h2 class="text-sm font-semibold text-slate-800 dark:text-slate-200">Schema Version Diff</h2>
					{#if dbSchemaVersionState.diffModal.diff}
						<p class="text-xs text-slate-400 truncate">
							{dbSchemaVersionState.diffModal.diff.labelA}
							<span class="mx-1">→</span>
							{dbSchemaVersionState.diffModal.diff.labelB}
						</p>
					{/if}
				</div>
				<button
					type="button"
					class="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
					onclick={closeDiff}
				>
					<Icon name="lucide:x" class="w-4 h-4 text-slate-500" />
				</button>
			</div>

			<!-- Body -->
			<div class="flex-1 min-h-0 overflow-y-auto">
				{#if dbSchemaVersionState.diffModal.isLoading}
					<div class="flex items-center justify-center h-40 gap-2 text-slate-400 text-sm">
						<svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Computing diff…
					</div>
				{:else if !dbSchemaVersionState.diffModal.diff}
					<div class="flex flex-col items-center justify-center h-40 gap-2 text-slate-400">
						<Icon name="lucide:triangle-alert" class="w-6 h-6" />
						<span class="text-sm">Failed to load diff</span>
					</div>
				{:else if !dbSchemaVersionState.diffModal.diff.hasChanges}
					<div class="flex flex-col items-center justify-center h-40 gap-2 p-6 text-center">
						<div class="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center">
							<Icon name="lucide:check-line" class="w-6 h-6 text-emerald-500" />
						</div>
						<p class="text-sm font-medium text-slate-700 dark:text-slate-300">No differences found</p>
						<p class="text-xs text-slate-400">These two versions have identical column structures.</p>
					</div>
				{:else}
					<!-- Summary pills -->
					<div class="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
						{#if changedColumns.filter((c) => c.status === 'added').length}
							<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-3xs font-medium bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400">
								+{changedColumns.filter((c) => c.status === 'added').length} added
							</span>
						{/if}
						{#if changedColumns.filter((c) => c.status === 'removed').length}
							<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-3xs font-medium bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400">
								−{changedColumns.filter((c) => c.status === 'removed').length} removed
							</span>
						{/if}
						{#if changedColumns.filter((c) => c.status === 'modified').length}
							<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-3xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400">
								~{changedColumns.filter((c) => c.status === 'modified').length} modified
							</span>
						{/if}
						<div class="flex-1"></div>
						{#if unchangedColumns.length > 0}
							<button
								type="button"
								class="text-3xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
								onclick={() => (showUnchanged = !showUnchanged)}
							>
								{showUnchanged ? 'Hide' : 'Show'} {unchangedColumns.length} unchanged
							</button>
						{/if}
					</div>

					<!-- Diff table -->
					<div class="overflow-x-auto">
						<table class="w-full text-3xs">
							<thead>
								<tr class="bg-slate-50 dark:bg-slate-800/40 border-b border-slate-100 dark:border-slate-800">
									<th class="text-left px-4 py-2 text-slate-500 font-medium w-8"></th>
									<th class="text-left px-2 py-2 text-slate-500 font-medium">Column</th>
									<th class="text-left px-2 py-2 text-slate-500 font-medium">Before (type)</th>
									<th class="text-left px-2 py-2 text-slate-500 font-medium">After (type)</th>
									<th class="text-left px-2 py-2 text-slate-500 font-medium">Nullable</th>
									<th class="text-left px-2 py-2 text-slate-500 font-medium">Default</th>
								</tr>
							</thead>
							<tbody>
								{#each visibleColumns as col (col.name)}
									<tr class="border-b border-slate-100 dark:border-slate-800/40 {statusRowBg(col.status)}">
										<td class="px-4 py-1.5 font-bold font-mono {statusColor(col.status)}">
											{statusLabel(col.status)}
										</td>
										<td class="px-2 py-1.5 font-medium text-slate-700 dark:text-slate-300">
											{col.name}
											{#if col.before?.primaryKey || col.after?.primaryKey}
												<span class="ml-1 text-violet-500 font-mono text-3xs">PK</span>
											{/if}
										</td>
										<td class="px-2 py-1.5 font-mono text-slate-500 dark:text-slate-400">
											{#if col.before?.type}
												<span class="{col.status === 'modified' && col.before.type !== col.after?.type ? 'line-through text-red-400' : ''}">{col.before.type}</span>
											{:else}
												<span class="text-slate-300 dark:text-slate-600">—</span>
											{/if}
										</td>
										<td class="px-2 py-1.5 font-mono
											{col.status === 'modified' && col.before?.type !== col.after?.type ? statusColor(col.status) : 'text-slate-500 dark:text-slate-400'}">
											{#if col.after?.type}
												{col.after.type}
											{:else}
												<span class="text-slate-300 dark:text-slate-600">—</span>
											{/if}
										</td>
										<td class="px-2 py-1.5 text-slate-400">
											{#if col.before && col.after && col.before.nullable !== col.after.nullable}
												<span class="line-through text-red-400">{col.before.nullable ? 'YES' : 'NO'}</span>
												<span class="ml-1 {statusColor('modified')}">{col.after.nullable ? 'YES' : 'NO'}</span>
											{:else if col.before || col.after}
												{(col.after ?? col.before)!.nullable ? 'YES' : 'NO'}
											{:else}—{/if}
										</td>
										<td class="px-2 py-1.5 font-mono text-slate-400 max-w-[80px] truncate">
											{(col.after ?? col.before)?.defaultValue ?? '—'}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>

			<!-- Footer -->
			<div class="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800 shrink-0">
				<button
					type="button"
					class="px-4 py-1.5 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
					onclick={closeDiff}
				>
					Close
				</button>
			</div>
		</div>
	</div>
{/if}
