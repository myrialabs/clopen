<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import DiffBlock from '$frontend/components/chat/tools/variants/classic/components/DiffBlock.svelte';
	import type { RestoreConflict, ConflictResolution } from '$frontend/services/snapshot/snapshot.service';

	let {
		isOpen = $bindable(false),
		conflicts,
		onConfirm,
		onClose
	}: {
		isOpen: boolean;
		conflicts: RestoreConflict[];
		onConfirm: (resolutions: ConflictResolution) => void;
		onClose: () => void;
	} = $props();

	// Internal state
	let conflictResolutions = $state<ConflictResolution>({});
	let expandedDiffs = $state<Set<string>>(new Set());

	// Reset internal state when conflicts change (modal opened with new data)
	$effect(() => {
		if (conflicts.length > 0) {
			const resolutions: ConflictResolution = {};
			for (const conflict of conflicts) {
				resolutions[conflict.filepath] = 'keep';
			}
			conflictResolutions = resolutions;
			expandedDiffs = new Set();
		}
	});

	function handleClose() {
		isOpen = false;
		onClose();
	}

	function handleConfirm() {
		isOpen = false;
		onConfirm(conflictResolutions);
	}

	function toggleDiff(filepath: string) {
		const next = new Set(expandedDiffs);
		if (next.has(filepath)) {
			next.delete(filepath);
		} else {
			next.add(filepath);
		}
		expandedDiffs = next;
	}

	function formatFilePath(filepath: string): string {
		const parts = filepath.split('/');
		if (parts.length <= 2) return filepath;
		return '.../' + parts.slice(-2).join('/');
	}

	function formatTimestamp(iso: string): string {
		try {
			const date = new Date(iso);
			return date.toLocaleString(undefined, {
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			});
		} catch {
			return iso;
		}
	}
</script>

<Modal
	bind:isOpen
	size="md"
	onClose={handleClose}
>
	{#snippet header()}
		<div class="flex items-start gap-4 px-4 py-3 md:px-6 md:py-4">
			<div class="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-xl p-3">
				<Icon name="lucide:triangle-alert" class="w-6 h-6 text-amber-600 dark:text-amber-400" />
			</div>
			<div class="flex-1">
				<h3 id="modal-title" class="text-lg font-semibold text-slate-900 dark:text-slate-100">
					Restore Conflict Detected
				</h3>
				<p class="text-sm text-slate-500 dark:text-slate-400 mt-1">
					The following files have changes that conflict with this restore. Choose how to handle each file:
				</p>
			</div>
		</div>
	{/snippet}

	{#snippet children()}
		<div class="space-y-3">
			{#each conflicts as conflict}
				<div class="border border-slate-200 dark:border-slate-700 rounded-lg p-3">
					<div class="flex items-center justify-between gap-2 mb-2">
						<div class="flex items-center gap-2 min-w-0">
							<Icon name="lucide:file-warning" class="w-4 h-4 text-amber-500 shrink-0" />
							<span class="text-sm font-medium text-slate-800 dark:text-slate-200 truncate" title={conflict.filepath}>
								{formatFilePath(conflict.filepath)}
							</span>
						</div>
						{#if conflict.restoreContent && conflict.currentContent}
							<button
								class="shrink-0 flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md transition-colors
									{expandedDiffs.has(conflict.filepath)
										? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-600'
										: 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700'
									}"
								onclick={() => toggleDiff(conflict.filepath)}
							>
								<Icon name="lucide:git-compare" class="w-3 h-3" />
								{expandedDiffs.has(conflict.filepath) ? 'Hide Diff' : 'View Diff'}
							</button>
						{/if}
					</div>
					<p class="text-xs text-slate-500 dark:text-slate-400 mb-2">
						{#if conflict.reason === 'local'}
							You have local edits to this file that aren't part of any checkpoint — restoring will overwrite them.
						{:else}
							Modified by another session on {formatTimestamp(conflict.modifiedAt)}
						{/if}
					</p>

					<!-- Diff View -->
					{#if expandedDiffs.has(conflict.filepath) && conflict.restoreContent && conflict.currentContent}
						<div class="mb-3">
							<div class="flex items-center gap-3 mb-1.5 text-3xs text-slate-500 dark:text-slate-400">
								<span class="flex items-center gap-1">
									<span class="inline-block w-2 h-2 rounded-sm bg-red-400"></span>
									Restore version
								</span>
								<span class="flex items-center gap-1">
									<span class="inline-block w-2 h-2 rounded-sm bg-green-400"></span>
									Current version
								</span>
							</div>
							<DiffBlock
								oldString={conflict.restoreContent}
								newString={conflict.currentContent}
							/>
						</div>
					{/if}

					<div class="flex gap-2">
						<button
							class="relative px-3 py-1.5 text-xs font-medium rounded-md transition-colors bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
							onclick={() => { conflictResolutions[conflict.filepath] = 'restore'; }}
						>
							{#if conflictResolutions[conflict.filepath] === 'restore'}
								<span class="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full bg-green-500 dark:bg-green-600 border-2 border-white dark:border-slate-900">
									<Icon name="lucide:check" class="w-3 h-3 text-white" />
								</span>
							{/if}
							Restore
						</button>
						<button
							class="relative px-3 py-1.5 text-xs font-medium rounded-md transition-colors bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
							onclick={() => { conflictResolutions[conflict.filepath] = 'keep'; }}
						>
							{#if conflictResolutions[conflict.filepath] === 'keep'}
								<span class="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full bg-green-500 dark:bg-green-600 border-2 border-white dark:border-slate-900">
									<Icon name="lucide:check" class="w-3 h-3 text-white" />
								</span>
							{/if}
							Keep Current
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/snippet}

	{#snippet footer()}
		<button
			onclick={handleClose}
			class="px-6 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200 font-semibold"
		>
			Cancel
		</button>
		<button
			onclick={handleConfirm}
			class="px-6 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition-all duration-200 font-semibold"
		>
			Proceed with Restore
		</button>
	{/snippet}
</Modal>
