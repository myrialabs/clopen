<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbManagerState,
		closeBulkModal,
		executeBulkDelete,
		executeBulkUpdate
	} from '$frontend/stores/features/db-manager.svelte';

	// ─── Derived ──────────────────────────────────────────────────────────────
	const modal = $derived(dbManagerState.bulkModal);
	const tableName = $derived(dbManagerState.activeTableName ?? '');
	const columns = $derived(dbManagerState.columns);
	const isDelete = $derived(modal.operation === 'delete');
	const isRunning = $derived(modal.phase === 'running');
	const isDone = $derived(modal.phase === 'done');
	const succeeded = $derived(isDone && !modal.error);

	const rowLabel = $derived(
		modal.rowCount === 1 ? '1 row' : `${modal.rowCount.toLocaleString()} rows`
	);

	const scopeLabel = $derived(
		modal.isGlobal
			? `all rows matching current filters`
			: `${modal.rowCount.toLocaleString()} selected row${modal.rowCount !== 1 ? 's' : ''}`
	);

	// ─── Handlers ─────────────────────────────────────────────────────────────
	async function handleConfirm() {
		if (isDelete) {
			await executeBulkDelete();
		} else {
			await executeBulkUpdate();
		}
	}

	function handleClose() {
		closeBulkModal();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !isRunning) handleClose();
		if (e.key === 'Enter' && modal.phase === 'confirm' && !isDelete && !modal.updateColumn) return;
		if (e.key === 'Enter' && modal.phase === 'confirm') handleConfirm();
	}
</script>

{#if modal.show}
	<!-- svelte-ignore a11y_interactive_supports_focus -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		onkeydown={handleKeydown}
	>
		<div class="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-[480px] max-w-[95vw] overflow-hidden">

			<!-- ─── Header ─────────────────────────────────────────────────────── -->
			<div class="flex items-center gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
				<div class="p-2 rounded-full shrink-0 {isDelete ? 'bg-red-100 dark:bg-red-900/30' : 'bg-violet-100 dark:bg-violet-900/30'}">
					{#if isRunning}
						<svg class="w-4 h-4 animate-spin {isDelete ? 'text-red-600 dark:text-red-400' : 'text-violet-600 dark:text-violet-400'}" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
					{:else if succeeded}
						<Icon name="lucide:check-line" class="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
					{:else if isDone}
						<Icon name="lucide:circle-x" class="w-4 h-4 text-red-600 dark:text-red-400" />
					{:else if isDelete}
						<Icon name="lucide:trash-2" class="w-4 h-4 text-red-600 dark:text-red-400" />
					{:else}
						<Icon name="lucide:pencil" class="w-4 h-4 text-violet-600 dark:text-violet-400" />
					{/if}
				</div>
				<div>
					<h3 class="text-sm font-semibold text-slate-800 dark:text-slate-200">
						{#if isRunning}
							{isDelete ? 'Deleting rows…' : 'Updating rows…'}
						{:else if succeeded}
							{isDelete ? 'Delete complete' : 'Update complete'}
						{:else if isDone}
							Operation failed
						{:else}
							{isDelete ? 'Bulk Delete Rows' : 'Bulk Update Column'}
						{/if}
					</h3>
					<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
						Table: <span class="font-mono font-medium text-slate-700 dark:text-slate-300">{tableName}</span>
					</p>
				</div>
			</div>

			<!-- ─── Body ───────────────────────────────────────────────────────── -->
			<div class="px-5 py-4">

				{#if modal.phase === 'confirm'}
					<!-- ─ Confirm phase ─ -->

					{#if !isDelete}
						<!-- Update: column + value picker -->
						<div class="space-y-3 mb-4">
							<div>
								<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
									Column to update
								</label>
								<select
									class="w-full px-2.5 py-2 rounded-lg text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-500"
									bind:value={modal.updateColumn}
								>
									{#each columns as col}
										<option value={col.name}>{col.name} ({col.type})</option>
									{/each}
								</select>
							</div>

							<div>
								<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
									New value
								</label>
								<div class="flex items-center gap-2">
									<input
										type="text"
										class="flex-1 px-2.5 py-2 rounded-lg text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
										placeholder={modal.updateIsNull ? 'NULL' : 'Enter new value…'}
										bind:value={modal.updateValue}
										disabled={modal.updateIsNull}
									/>
									<label class="flex items-center gap-1.5 cursor-pointer shrink-0">
										<input
											type="checkbox"
											class="w-3.5 h-3.5 rounded accent-violet-600"
											bind:checked={modal.updateIsNull}
										/>
										<span class="text-xs text-slate-600 dark:text-slate-400">NULL</span>
									</label>
								</div>
							</div>
						</div>
					{/if}

					<!-- Scope summary -->
					<div class="flex items-start gap-2.5 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 mb-4">
						<Icon name="lucide:info" class="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
						<div class="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
							This will
							{#if isDelete}
								permanently <span class="font-semibold text-red-600 dark:text-red-400">delete</span>
							{:else}
								<span class="font-semibold text-violet-600 dark:text-violet-400">update</span>
							{/if}
							<span class="font-semibold text-slate-800 dark:text-slate-200">{rowLabel}</span>
							from <span class="font-mono font-medium">{tableName}</span>
							({scopeLabel}).
							{#if isDelete}
								<span class="block mt-1 text-slate-500 dark:text-slate-500">This action cannot be undone.</span>
							{/if}
						</div>
					</div>

					<!-- Transaction notice -->
					<div class="flex items-start gap-2 text-xs text-emerald-700 dark:text-emerald-400 mb-1">
						<Icon name="lucide:shield-check" class="w-3.5 h-3.5 shrink-0 mt-0.5" />
						<span>Wrapped in a SQL transaction — if any error occurs, no data will be changed.</span>
					</div>

				{:else if modal.phase === 'running'}
					<!-- ─ Running phase ─ -->
					<div class="py-4 space-y-4">
						<p class="text-sm text-slate-600 dark:text-slate-400 text-center">
							{#if isDelete}
								Deleting <span class="font-semibold text-slate-800 dark:text-slate-200">{rowLabel}</span> from <span class="font-mono font-medium">{tableName}</span>…
							{:else}
								Updating <span class="font-semibold text-slate-800 dark:text-slate-200">{rowLabel}</span> in <span class="font-mono font-medium">{tableName}</span>…
							{/if}
						</p>

						<!-- Indeterminate progress bar -->
						<div class="relative h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
							<div
								class="absolute inset-y-0 w-2/5 rounded-full {isDelete ? 'bg-red-500' : 'bg-violet-500'}"
								style="animation: bulk-slide 1.4s ease-in-out infinite;"
							></div>
						</div>

						<p class="text-xs text-center text-slate-400 dark:text-slate-500">
							Do not close this window while the operation is in progress.
						</p>
					</div>

				{:else if modal.phase === 'done'}
					<!-- ─ Done phase ─ -->
					{#if succeeded}
						<div class="py-4 space-y-3">
							<div class="flex flex-col items-center gap-2 text-center">
								<div class="w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
									<Icon name="lucide:check-line" class="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
								</div>
								<p class="text-sm font-medium text-slate-800 dark:text-slate-200">
									{#if isDelete}
										{modal.processed.toLocaleString()} row{modal.processed !== 1 ? 's' : ''} deleted successfully
									{:else}
										{modal.processed.toLocaleString()} row{modal.processed !== 1 ? 's' : ''} updated successfully
									{/if}
								</p>
								<p class="text-xs text-slate-500 dark:text-slate-400">The table will be refreshed when you close this dialog.</p>
							</div>
							<!-- Full progress bar (success) -->
							<div class="h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
								<div class="h-full w-full bg-emerald-500 rounded-full transition-all duration-500"></div>
							</div>
						</div>
					{:else}
						<div class="py-4 space-y-3">
							<div class="flex items-start gap-2.5 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
								<Icon name="lucide:circle-x" class="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
								<div>
									<p class="text-xs font-medium text-red-700 dark:text-red-300">Operation failed</p>
									<p class="text-xs text-red-600 dark:text-red-400 mt-0.5">{modal.error}</p>
								</div>
							</div>
							<p class="text-xs text-slate-500 dark:text-slate-400">
								No data was changed — the transaction was rolled back automatically.
							</p>
						</div>
					{/if}
				{/if}
			</div>

			<!-- ─── Footer ─────────────────────────────────────────────────────── -->
			<div class="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
				{#if modal.phase === 'confirm'}
					<button
						type="button"
						class="px-3.5 py-2 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
						onclick={handleClose}
					>
						Cancel
					</button>
					<button
						type="button"
						class="px-3.5 py-2 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed
							{isDelete
								? 'bg-red-600 hover:bg-red-700'
								: 'bg-violet-600 hover:bg-violet-700'}"
						onclick={handleConfirm}
						disabled={!isDelete && !modal.updateColumn}
					>
						{#if isDelete}
							Delete {rowLabel}
						{:else}
							Update {rowLabel}
						{/if}
					</button>
				{:else if modal.phase === 'done'}
					<button
						type="button"
						class="px-3.5 py-2 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
						onclick={handleClose}
					>
						Close
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	@keyframes bulk-slide {
		0% { transform: translateX(-100%); }
		50% { transform: translateX(250%); }
		100% { transform: translateX(250%); }
	}
</style>
