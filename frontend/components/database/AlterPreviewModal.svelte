<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { dbAlterState, closePreview, applyChanges } from '$frontend/stores/features/db-alter.svelte';

	interface Props {
		onApplied?: () => void;
	}

	let { onApplied }: Props = $props();

	const preview = $derived(dbAlterState.preview);
	const errors = $derived(preview?.warnings.filter((w) => w.severity === 'error') ?? []);
	const warnings = $derived(preview?.warnings.filter((w) => w.severity === 'warning') ?? []);

	function handleApply() {
		applyChanges(onApplied);
	}
</script>

<Modal
	isOpen={dbAlterState.previewOpen}
	onClose={closePreview}
	size="lg"
	closable={!dbAlterState.isApplying}
>
	{#snippet header()}
		<div class="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
			<div class="flex items-center justify-center w-8 h-8 rounded-lg bg-violet-500/10">
				<Icon name="lucide:eye" class="w-4 h-4 text-violet-500" />
			</div>
			<div>
				<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">SQL Preview</h2>
				<p class="text-xs text-slate-500 dark:text-slate-400">{dbAlterState.tableName}</p>
			</div>
		</div>
	{/snippet}

	{#if preview}
		<div class="space-y-4">
			<!-- Summary badges -->
			<div class="flex items-center gap-2 flex-wrap">
				<span class="text-xs text-slate-500 dark:text-slate-400">
					{preview.statements.length} statement{preview.statements.length !== 1 ? 's' : ''}
				</span>
				{#if errors.length > 0}
					<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
						<Icon name="lucide:circle-x" class="w-3 h-3" />
						{errors.length} error{errors.length !== 1 ? 's' : ''}
					</span>
				{/if}
				{#if warnings.length > 0}
					<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
						<Icon name="lucide:triangle-alert" class="w-3 h-3" />
						{warnings.length} warning{warnings.length !== 1 ? 's' : ''}
					</span>
				{/if}
				{#if preview.requiresRecreate}
					<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
						<Icon name="lucide:refresh-cw" class="w-3 h-3" />
						Table recreation
					</span>
				{/if}
			</div>

			<!-- Warnings & Errors -->
			{#if preview.warnings.length > 0}
				<div class="space-y-1.5">
					{#each errors as w}
						<div class="flex items-start gap-2 p-2.5 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
							<Icon name="lucide:circle-x" class="w-4 h-4 shrink-0 text-red-600 dark:text-red-400 mt-0.5" />
							<span class="text-xs text-red-700 dark:text-red-300">{w.message}</span>
						</div>
					{/each}
					{#each warnings as w}
						<div class="flex items-start gap-2 p-2.5 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
							<Icon name="lucide:triangle-alert" class="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
							<span class="text-xs text-amber-700 dark:text-amber-300">{w.message}</span>
						</div>
					{/each}
				</div>
			{/if}

			<!-- SQLite recreation note -->
			{#if preview.requiresRecreate}
				<div class="flex items-start gap-2 p-3 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50">
					<Icon name="lucide:info" class="w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400 mt-0.5" />
					<div class="text-xs text-blue-700 dark:text-blue-300">
						<span class="font-medium">SQLite table recreation:</span> SQLite cannot modify existing columns directly.
						The table will be recreated with the new schema and all data will be migrated.
						This operation runs inside a transaction.
					</div>
				</div>
			{/if}

			<!-- SQL Statements -->
			<div>
				<p class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Generated SQL</p>
				<div class="bg-slate-900 dark:bg-slate-950 rounded-lg p-3 overflow-auto max-h-64">
					<pre class="text-xs text-slate-200 font-mono whitespace-pre-wrap leading-relaxed">{preview.statements.join(';\n\n')}{preview.statements.length ? ';' : ''}</pre>
				</div>
			</div>
		</div>
	{:else}
		<div class="flex items-center justify-center py-8 text-slate-400 text-sm">
			No preview available
		</div>
	{/if}

	{#snippet footer()}
		<button
			type="button"
			onclick={closePreview}
			disabled={dbAlterState.isApplying}
			class="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-lg transition-colors disabled:opacity-50"
		>
			<Icon name="lucide:arrow-left" class="w-3.5 h-3.5 inline mr-1" />
			Back
		</button>
		<button
			type="button"
			onclick={handleApply}
			disabled={!preview || preview.hasErrors || dbAlterState.isApplying}
			class="px-4 py-2 text-sm font-medium text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center gap-2"
		>
			{#if dbAlterState.isApplying}
				<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
				</svg>
				Applying...
			{:else}
				<Icon name="lucide:check" class="w-3.5 h-3.5" />
				Apply Changes
			{/if}
		</button>
	{/snippet}
</Modal>
