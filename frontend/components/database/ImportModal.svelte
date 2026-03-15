<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbExportState,
		closeImport,
		previewImportFile,
		startImport
	} from '$frontend/stores/features/db-export.svelte';
	import type { DBColumn } from '$shared/types/db-manager';

	interface Props {
		connectionId: string;
		tableName: string;
		schema?: string;
		tableColumns: DBColumn[];
	}

	const { connectionId, tableName, schema, tableColumns }: Props = $props();

	const columnNames = $derived(tableColumns.map((c) => c.name));

	let selectedFile = $state<File | null>(null);
	let step = $state<'select' | 'mapping' | 'progress'>('select');
	let errorMsg = $state<string | null>(null);
	let isSqlFile = $state(false);

	const isBusy = $derived(dbExportState.isImporting);
	const progress = $derived(dbExportState.importProgress);
	const preview = $derived(dbExportState.importPreview);
	const mappings = $derived(dbExportState.columnMappings);

	async function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		selectedFile = file;
		errorMsg = null;

		try {
			const result = await previewImportFile(file, columnNames);
			if (result === 'sql-file') {
				isSqlFile = true;
				step = 'mapping'; // Show the SQL-direct confirm screen
			} else {
				isSqlFile = false;
				step = 'mapping';
			}
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Failed to parse file';
		}
	}

	async function handleImport() {
		if (!selectedFile) return;
		step = 'progress';
		await startImport(selectedFile, connectionId, tableName, schema);
		if (!dbExportState.isImportOpen) {
			// Modal was closed (success case) — reset
			step = 'select';
			selectedFile = null;
		} else {
			// Stay on progress with error stats
		}
	}

	function handleClose() {
		if (isBusy) return;
		step = 'select';
		selectedFile = null;
		errorMsg = null;
		closeImport();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !isBusy) handleClose();
	}

	function resetFile() {
		step = 'select';
		selectedFile = null;
		errorMsg = null;
		isSqlFile = false;
	}

	// Derived mapping stats
	const mappedCount = $derived(mappings.filter((m) => m.targetColumn !== null).length);
	const skippedCount = $derived(mappings.filter((m) => m.targetColumn === null).length);
</script>

<svelte:window onkeydown={handleKeydown} />

{#if dbExportState.isImportOpen}
	<div
		class="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-label="Import Data"
		tabindex="-1"
		onclick={(e) => { if (e.target === e.currentTarget && !isBusy) handleClose(); }}
		onkeydown={handleKeydown}
		in:fade={{ duration: 150, easing: cubicOut }}
		out:fade={{ duration: 100, easing: cubicOut }}
	>
		<div
			class="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl overflow-hidden"
			in:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
				<div class="flex items-center gap-2.5">
					<div class="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center">
						<Icon name="lucide:upload" class="w-4 h-4 text-emerald-600" />
					</div>
					<div>
						<h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Import Data</h2>
						<p class="text-xs text-slate-400 dark:text-slate-500">{tableName}</p>
					</div>
				</div>
				{#if !isBusy}
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
						onclick={handleClose}
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				{/if}
			</div>

			<!-- Step: Select file -->
			{#if step === 'select'}
				<div class="p-5 space-y-4">
					<div
						class="flex flex-col items-center justify-center gap-3 p-8 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl cursor-pointer hover:border-violet-400 dark:hover:border-violet-500 hover:bg-violet-50/50 dark:hover:bg-violet-500/5 transition-all group"
						onclick={() => document.getElementById('import-file-input')?.click()}
						onkeydown={(e) => e.key === 'Enter' && document.getElementById('import-file-input')?.click()}
						role="button"
						tabindex="0"
					>
						<div class="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800 group-hover:bg-violet-100 dark:group-hover:bg-violet-500/15 flex items-center justify-center transition-colors">
							<Icon name="lucide:file-up" class="w-6 h-6 text-slate-400 group-hover:text-violet-500 transition-colors" />
						</div>
						<div class="text-center">
							<p class="text-sm font-medium text-slate-700 dark:text-slate-300">Click to select file</p>
							<p class="text-xs text-slate-400 dark:text-slate-500 mt-1">.csv, .json, or .sql</p>
						</div>
					</div>
					<input
						id="import-file-input"
						type="file"
						accept=".csv,.json,.sql"
						class="hidden"
						onchange={handleFileSelect}
					/>
					{#if errorMsg}
						<div class="flex items-start gap-2 px-3 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
							<Icon name="lucide:circle-alert" class="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
							<p class="text-xs text-red-700 dark:text-red-400">{errorMsg}</p>
						</div>
					{/if}
					<div class="text-xs text-slate-400 dark:text-slate-500 space-y-1">
						<p><strong class="text-slate-600 dark:text-slate-400">CSV / JSON:</strong> Allows column mapping before import</p>
						<p><strong class="text-slate-600 dark:text-slate-400">SQL:</strong> Executed directly against the database</p>
					</div>
				</div>
				<div class="flex justify-end px-5 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
					<button type="button" class="px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200" onclick={handleClose}>Cancel</button>
				</div>

			<!-- Step: Column mapping (or SQL confirm) -->
			{:else if step === 'mapping'}
				<div class="p-5 space-y-4">
					<!-- File info -->
					<div class="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-lg">
						<Icon name="lucide:file" class="w-4 h-4 text-slate-400 shrink-0" />
						<span class="text-xs text-slate-700 dark:text-slate-300 font-medium truncate">{selectedFile?.name}</span>
						<span class="text-xs text-slate-400 ml-auto shrink-0">{((selectedFile?.size ?? 0) / 1024).toFixed(1)} KB</span>
						{#if !isBusy}
							<button type="button" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300" onclick={resetFile}>
								<Icon name="lucide:x" class="w-3.5 h-3.5" />
							</button>
						{/if}
					</div>

					{#if isSqlFile}
						<!-- SQL file — no mapping needed -->
						<div class="flex items-start gap-2 px-3 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
							<Icon name="lucide:info" class="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
							<p class="text-xs text-amber-700 dark:text-amber-300">
								SQL files are executed directly. The file may contain multiple statements.
								<strong>This cannot be undone.</strong>
							</p>
						</div>
					{:else if preview}
						<!-- Column mapping table -->
						<div>
							<div class="flex items-center justify-between mb-2">
								<h3 class="text-xs font-semibold text-slate-700 dark:text-slate-300">Column Mapping</h3>
								<span class="text-xs text-slate-400">{mappedCount} mapped, {skippedCount} skipped</span>
							</div>

							<div class="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
								<!-- Header -->
								<div class="grid grid-cols-[1fr_auto_1fr] items-center px-3 py-2 bg-slate-50 dark:bg-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
									<span>File column</span>
									<span class="px-3">→</span>
									<span>Table column</span>
								</div>
								<div class="max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
									{#each dbExportState.columnMappings as mapping, i}
										<div class="grid grid-cols-[1fr_auto_1fr] items-center px-3 py-2">
											<!-- Source column -->
											<div class="flex flex-col gap-0.5">
												<span class="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">{mapping.sourceColumn}</span>
												{#if preview.sampleRows[0]?.[mapping.sourceColumn] !== undefined}
													<span class="text-3xs text-slate-400 truncate">{preview.sampleRows[0][mapping.sourceColumn]}</span>
												{/if}
											</div>
											<!-- Arrow -->
											<div class="px-2">
												<Icon
													name={mapping.targetColumn ? 'lucide:arrow-right' : 'lucide:x'}
													class="w-3.5 h-3.5 {mapping.targetColumn ? 'text-emerald-500' : 'text-slate-300 dark:text-slate-600'}"
												/>
											</div>
											<!-- Target column selector -->
											<select
												class="text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 w-full"
												value={mapping.targetColumn ?? ''}
												onchange={(e) => {
													const val = (e.target as HTMLSelectElement).value;
													dbExportState.columnMappings = dbExportState.columnMappings.map((m, j) =>
														j === i ? { ...m, targetColumn: val || null } : m
													);
												}}
											>
												<option value="">— skip —</option>
												{#each columnNames as col}
													<option value={col}>{col}</option>
												{/each}
											</select>
										</div>
									{/each}
								</div>
							</div>
						</div>

						<!-- Skip errors option -->
						<label class="flex items-center gap-2.5 cursor-pointer">
							<input
								type="checkbox"
								class="rounded border-slate-300 dark:border-slate-600 text-violet-600 w-4 h-4"
								bind:checked={dbExportState.importSkipErrors}
							/>
							<span class="text-xs text-slate-700 dark:text-slate-300">Skip rows with errors and continue</span>
						</label>
					{/if}
				</div>

				<div class="flex items-center justify-between px-5 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
					<button type="button" class="px-3 py-2 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300" onclick={resetFile}>
						Back
					</button>
					<div class="flex gap-2">
						<button type="button" class="px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200" onclick={handleClose}>
							Cancel
						</button>
						<button
							type="button"
							class="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-all disabled:opacity-60 disabled:cursor-not-allowed"
							onclick={handleImport}
							disabled={!isSqlFile && mappedCount === 0}
						>
							<Icon name="lucide:upload" class="w-3.5 h-3.5" />
							{isSqlFile ? 'Execute SQL' : 'Import'}
						</button>
					</div>
				</div>

			<!-- Step: Progress -->
			{:else if step === 'progress'}
				<div class="p-5 space-y-4">
					{#if isBusy}
						<div class="flex flex-col items-center gap-4 py-4">
							<div class="w-12 h-12 rounded-full bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center">
								<svg class="w-6 h-6 animate-spin text-emerald-600" fill="none" viewBox="0 0 24 24">
									<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
									<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
								</svg>
							</div>
							<div class="text-center">
								<p class="text-sm font-medium text-slate-700 dark:text-slate-300">Importing…</p>
								<p class="text-xs text-slate-400 mt-1">
									{dbExportState.importInserted.toLocaleString()} inserted
									{#if dbExportState.importFailed > 0}
										· {dbExportState.importFailed.toLocaleString()} failed
									{/if}
								</p>
							</div>
							<div class="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
								<div
									class="h-full bg-emerald-500 rounded-full transition-all duration-300"
									style="width: {progress}%"
								></div>
							</div>
							<p class="text-xs text-slate-400">{progress}% of {dbExportState.importTotal.toLocaleString()} rows</p>
						</div>
					{:else}
						<!-- Completed (with errors) -->
						<div class="space-y-3">
							<div class="flex items-start gap-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
								<Icon name="lucide:triangle-alert" class="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
								<div>
									<p class="text-xs font-medium text-red-700 dark:text-red-400">
										{dbExportState.importInserted.toLocaleString()} rows inserted,
										{dbExportState.importFailed.toLocaleString()} failed
									</p>
								</div>
							</div>
							{#if dbExportState.importErrors.length > 0}
								<div class="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
									<div class="px-3 py-2 bg-slate-50 dark:bg-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">Errors</div>
									<div class="max-h-32 overflow-y-auto">
										{#each dbExportState.importErrors as err}
											<div class="px-3 py-1.5 text-xs text-red-600 dark:text-red-400 border-b border-slate-100 dark:border-slate-800 last:border-0">{err}</div>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				{#if !isBusy}
					<div class="flex justify-end px-5 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
						<button
							type="button"
							class="px-4 py-2 text-xs font-medium bg-slate-700 dark:bg-slate-700 hover:bg-slate-800 text-white rounded-lg transition-all"
							onclick={handleClose}
						>
							Close
						</button>
					</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}
