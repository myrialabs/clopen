<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbExportState,
		closeExport,
		startExport
	} from '$frontend/stores/features/db-export.svelte';
	import type { ExportFormat } from '$shared/types/db-export';

	interface Props {
		connectionId: string;
		tableName: string;
		schema?: string;
	}

	const { connectionId, tableName, schema }: Props = $props();

	const formats: { value: ExportFormat; label: string; icon: string; desc: string }[] = [
		{ value: 'csv', label: 'CSV', icon: 'lucide:file-spreadsheet', desc: 'Comma-separated values, compatible with Excel and Google Sheets' },
		{ value: 'json', label: 'JSON', icon: 'lucide:braces', desc: 'Array of JSON objects, suitable for APIs and JavaScript applications' },
		{ value: 'sql', label: 'SQL Dump', icon: 'lucide:database', desc: 'CREATE TABLE + INSERT statements, for database migration and backup' }
	];

	const progressPct = $derived(dbExportState.exportProgress);
	const isBusy = $derived(dbExportState.isExporting);

	async function handleExport() {
		await startExport(connectionId, tableName, schema, dbExportState.exportFormat);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !isBusy) closeExport();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if dbExportState.isExportOpen}
	<div
		class="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-label="Export Data"
		tabindex="-1"
		onclick={(e) => { if (e.target === e.currentTarget && !isBusy) closeExport(); }}
		onkeydown={handleKeydown}
		in:fade={{ duration: 150, easing: cubicOut }}
		out:fade={{ duration: 100, easing: cubicOut }}
	>
		<div
			class="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl overflow-hidden"
			in:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
				<div class="flex items-center gap-2.5">
					<div class="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center">
						<Icon name="lucide:download" class="w-4 h-4 text-violet-600" />
					</div>
					<div>
						<h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Export Data</h2>
						<p class="text-xs text-slate-400 dark:text-slate-500">{tableName}</p>
					</div>
				</div>
				{#if !isBusy}
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
						onclick={closeExport}
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				{/if}
			</div>

			<div class="p-5 space-y-5">
				<!-- Format selector -->
				<div>
					<label class="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">Format</label>
					<div class="grid grid-cols-3 gap-2">
						{#each formats as fmt}
							<button
								type="button"
								disabled={isBusy}
								class="flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all duration-100
									{dbExportState.exportFormat === fmt.value
										? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10'
										: 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}"
								onclick={() => (dbExportState.exportFormat = fmt.value)}
								title={fmt.desc}
							>
								<Icon
									name={fmt.icon as any}
									class="w-5 h-5 {dbExportState.exportFormat === fmt.value
										? 'text-violet-600 dark:text-violet-400'
										: 'text-slate-400'}"
								/>
								<span class="text-xs font-semibold {dbExportState.exportFormat === fmt.value
									? 'text-violet-700 dark:text-violet-300'
									: 'text-slate-600 dark:text-slate-400'}">{fmt.label}</span>
							</button>
						{/each}
					</div>
					<p class="mt-2 text-xs text-slate-400 dark:text-slate-500">
						{formats.find((f) => f.value === dbExportState.exportFormat)?.desc}
					</p>
				</div>

				<!-- Format-specific options -->
				<div class="space-y-2">
					{#if dbExportState.exportFormat === 'csv'}
						<label class="flex items-center gap-2.5 cursor-pointer group">
							<input
								type="checkbox"
								class="rounded border-slate-300 dark:border-slate-600 text-violet-600 w-4 h-4"
								bind:checked={dbExportState.exportOptions.includeHeaders}
								disabled={isBusy}
							/>
							<span class="text-xs text-slate-700 dark:text-slate-300">Include header row</span>
						</label>
					{:else if dbExportState.exportFormat === 'json'}
						<label class="flex items-center gap-2.5 cursor-pointer">
							<input
								type="checkbox"
								class="rounded border-slate-300 dark:border-slate-600 text-violet-600 w-4 h-4"
								bind:checked={dbExportState.exportOptions.prettyPrint}
								disabled={isBusy}
							/>
							<span class="text-xs text-slate-700 dark:text-slate-300">Pretty-print JSON</span>
						</label>
					{:else if dbExportState.exportFormat === 'sql'}
						<label class="flex items-center gap-2.5 cursor-pointer">
							<input
								type="checkbox"
								class="rounded border-slate-300 dark:border-slate-600 text-violet-600 w-4 h-4"
								bind:checked={dbExportState.exportOptions.includeCreateTable}
								disabled={isBusy}
							/>
							<span class="text-xs text-slate-700 dark:text-slate-300">Include CREATE TABLE statement</span>
						</label>
					{/if}

					<!-- Batch size -->
					<div class="flex items-center gap-3">
						<label class="text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">Batch size</label>
						<select
							class="flex-1 text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300"
							bind:value={dbExportState.exportOptions.batchSize}
							disabled={isBusy}
						>
							{#each [500, 1000, 2000, 5000] as size}
								<option value={size}>{size.toLocaleString()} rows/batch</option>
							{/each}
						</select>
					</div>
				</div>

				<!-- Progress -->
				{#if isBusy}
					<div class="space-y-2">
						<div class="flex items-center justify-between text-xs">
							<span class="text-slate-600 dark:text-slate-400">Exporting…</span>
							<span class="text-slate-500 dark:text-slate-500">
								{dbExportState.exportFetched.toLocaleString()} / {dbExportState.exportTotal.toLocaleString()} rows
							</span>
						</div>
						<div class="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
							<div
								class="h-full bg-violet-500 rounded-full transition-all duration-300"
								style="width: {progressPct}%"
							></div>
						</div>
						<p class="text-xs text-center text-slate-400">{progressPct}%</p>
					</div>
				{/if}
			</div>

			<!-- Footer -->
			<div class="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
				<button
					type="button"
					class="px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors"
					onclick={closeExport}
					disabled={isBusy}
				>
					Cancel
				</button>
				<button
					type="button"
					class="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-all disabled:opacity-60 disabled:cursor-not-allowed"
					onclick={handleExport}
					disabled={isBusy}
				>
					{#if isBusy}
						<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Exporting…
					{:else}
						<Icon name="lucide:download" class="w-3.5 h-3.5" />
						Export {dbExportState.exportFormat.toUpperCase()}
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}
