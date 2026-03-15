<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbSchemaVersionState,
		closeRollback,
		executeRollback
	} from '$frontend/stores/features/db-schema-versioning.svelte';

	interface Props {
		onSuccess?: () => void;
	}

	const { onSuccess }: Props = $props();

	const version = $derived(dbSchemaVersionState.rollbackModal.version);
	const isExecuting = $derived(dbSchemaVersionState.rollbackModal.isExecuting);
</script>

{#if dbSchemaVersionState.rollbackModal.isOpen}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
		onclick={(e) => e.target === e.currentTarget && !isExecuting && closeRollback()}
		onkeydown={(e) => e.key === 'Escape' && !isExecuting && closeRollback()}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div class="w-full max-w-lg bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col max-h-[80vh]">
			<!-- Header -->
			<div class="flex items-center gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<div class="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center shrink-0">
					<Icon name="lucide:rotate-ccw" class="w-4 h-4 text-red-500" />
				</div>
				<div class="flex-1 min-w-0">
					<h2 class="text-sm font-semibold text-slate-800 dark:text-slate-200">Rollback Schema Version</h2>
					{#if version}
						<p class="text-xs text-slate-400 truncate">
							v{version.versionNumber} — {version.tableName}
						</p>
					{/if}
				</div>
				{#if !isExecuting}
					<button
						type="button"
						class="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
						onclick={closeRollback}
					>
						<Icon name="lucide:x" class="w-4 h-4 text-slate-500" />
					</button>
				{/if}
			</div>

			<!-- Body -->
			<div class="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
				{#if !version && dbSchemaVersionState.isLoadingDetail}
					<div class="flex items-center justify-center h-24 gap-2 text-slate-400 text-sm">
						<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Loading…
					</div>
				{:else if version}
					<!-- Warning banner -->
					<div class="flex items-start gap-3 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40">
						<Icon name="lucide:triangle-alert" class="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
						<div class="text-xs text-red-700 dark:text-red-300 space-y-1">
							<p class="font-medium">This action will modify your database schema.</p>
							<p>The rollback SQL will be executed against <span class="font-mono font-semibold">{version.connectionName}</span>. Columns that were added will be dropped and data in those columns will be permanently lost.</p>
						</div>
					</div>

					<!-- Version info -->
					<div class="space-y-1">
						<p class="text-3xs font-semibold text-slate-500 uppercase tracking-wide">Rolling back</p>
						<div class="flex items-center gap-2 flex-wrap">
							<span class="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">v{version.versionNumber}</span>
							{#if version.label}
								<span class="text-xs text-slate-600 dark:text-slate-300">{version.label}</span>
							{/if}
							<span class="text-xs text-slate-400">applied {new Date(version.appliedAt).toLocaleString()}</span>
						</div>
					</div>

					<!-- Changes summary -->
					{#if version.changes.length > 0}
						<div class="space-y-1">
							<p class="text-3xs font-semibold text-slate-500 uppercase tracking-wide">Changes that will be undone</p>
							<div class="space-y-0.5">
								{#each version.changes as change}
									<div class="flex items-center gap-1.5 text-xs">
										<span class="font-mono font-bold text-3xs w-12 shrink-0
											{change.type === 'add' ? 'text-emerald-600' :
											 change.type === 'drop' ? 'text-red-500' :
											 'text-amber-600'}">
											{change.type.toUpperCase()}
										</span>
										<span class="font-mono text-slate-600 dark:text-slate-400">{change.columnName}</span>
										{#if change.type === 'rename' && change.newName}
											<Icon name="lucide:arrow-right" class="w-3 h-3 text-slate-400" />
											<span class="font-mono text-slate-600 dark:text-slate-400">{change.newName}</span>
										{/if}
										{#if change.newDef}
											<span class="text-slate-400 text-3xs">{change.newDef.type}</span>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Down SQL preview -->
					{#if version.downStatements.length > 0}
						<div class="space-y-1">
							<p class="text-3xs font-semibold text-slate-500 uppercase tracking-wide">SQL that will be executed</p>
							<pre class="text-3xs font-mono bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800/30 rounded-lg p-3 overflow-x-auto text-red-700 dark:text-red-400 leading-relaxed max-h-40">{version.downStatements.join(';\n')}</pre>
						</div>
					{:else}
						<div class="flex items-center gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40">
							<Icon name="lucide:triangle-alert" class="w-4 h-4 text-amber-500 shrink-0" />
							<p class="text-xs text-amber-700 dark:text-amber-300">No rollback SQL available for this version.</p>
						</div>
					{/if}
				{/if}
			</div>

			<!-- Footer -->
			<div class="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800 shrink-0">
				<button
					type="button"
					class="px-4 py-1.5 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
					disabled={isExecuting}
					onclick={closeRollback}
				>
					Cancel
				</button>
				<button
					type="button"
					class="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
						{isExecuting || !version?.downStatements.length
							? 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed'
							: 'bg-red-600 hover:bg-red-700 text-white'}"
					disabled={isExecuting || !version?.downStatements.length}
					onclick={() => executeRollback(onSuccess)}
				>
					{#if isExecuting}
						<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Executing rollback…
					{:else}
						<Icon name="lucide:rotate-ccw" class="w-3.5 h-3.5" />
						Execute Rollback
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}
