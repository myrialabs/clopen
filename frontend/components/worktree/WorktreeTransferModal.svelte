<script lang="ts">
	/**
	 * Moving work between a worktree and the main project.
	 *
	 * Two phases so nothing lands unseen: the preview lists every file that would
	 * change, and any file both sides touched has to be resolved before the
	 * transfer runs. Where a clean line-level merge exists it is offered as the
	 * default, so the all-or-nothing choice is the exception rather than the rule.
	 */
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import DiffBlock from '$frontend/components/chat/tools/variants/classic/components/DiffBlock.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import {
		previewTransfer,
		runTransfer,
		worktreeState,
		type MergeResolution,
		type TransferDirection,
		type TransferPreview,
		type WorktreeSummary
	} from '$frontend/stores/features/worktrees.svelte';
	import { debug } from '$shared/utils/logger';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		isOpen: boolean;
		worktree: WorktreeSummary | null;
		direction: TransferDirection;
		onClose: () => void;
	}

	let { isOpen = $bindable(false), worktree, direction, onClose }: Props = $props();

	let preview = $state<TransferPreview | null>(null);
	let isLoading = $state(false);
	let resolutions = $state<Record<string, MergeResolution>>({});
	let expandedPaths = $state<Set<string>>(new Set());

	const sourceLabel = $derived(direction === 'apply' ? worktree?.name ?? 'worktree' : 'Main');
	const targetLabel = $derived(direction === 'apply' ? 'Main' : worktree?.name ?? 'worktree');
	const title = $derived(direction === 'apply' ? 'Apply to Main' : 'Sync from Main');

	const cleanChanges = $derived(preview?.changes.filter((change) => !change.conflict) ?? []);
	const conflicts = $derived(preview?.conflicts ?? []);
	const hasChanges = $derived((preview?.changes.length ?? 0) > 0);

	async function loadPreview() {
		if (!worktree) return;

		isLoading = true;
		preview = null;
		resolutions = {};

		try {
			const result = await previewTransfer(worktree.id, direction);
			preview = result;

			// Default every conflict to the safest outcome that keeps both sides'
			// work: a clean merge where one exists, otherwise leave the target alone.
			const defaults: Record<string, MergeResolution> = {};
			for (const conflict of result.conflicts) {
				defaults[conflict.path] = conflict.autoMergeable ? 'merge' : 'target';
			}
			resolutions = defaults;
			expandedPaths = new Set();
		} catch (error) {
			debug.error('worktree', 'Preview failed:', error);
			addNotification({
				type: 'error',
				title: 'Could not read changes',
				message: error instanceof Error ? error.message : String(error),
				duration: 5000
			});
		} finally {
			isLoading = false;
		}
	}

	function handleClose() {
		if (worktreeState.isTransferring) return;
		isOpen = false;
		preview = null;
		onClose();
	}

	async function confirm() {
		if (!worktree || !preview) return;

		try {
			const result = await runTransfer(worktree.id, direction, resolutions);
			isOpen = false;
			preview = null;
			onClose();

			const kept = result.skipped > 0 ? `, ${result.skipped} kept as-is` : '';
			addNotification({
				type: result.failed.length > 0 ? 'warning' : 'success',
				title: title,
				message: `${result.written} written, ${result.deleted} removed${kept}${
					result.failed.length > 0 ? ` — ${result.failed.length} failed` : ''
				}.`,
				duration: 5000
			});
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Transfer failed',
				message: error instanceof Error ? error.message : String(error),
				duration: 5000
			});
		}
	}

	function toggleDiff(filePath: string) {
		const next = new Set(expandedPaths);
		if (next.has(filePath)) next.delete(filePath);
		else next.add(filePath);
		expandedPaths = next;
	}

	function statusIcon(status: string): IconName {
		if (status === 'added') return 'lucide:file-plus';
		if (status === 'deleted') return 'lucide:file-minus';
		return 'lucide:file-pen';
	}

	function statusColor(status: string): string {
		if (status === 'added') return 'text-green-600 dark:text-green-400';
		if (status === 'deleted') return 'text-red-600 dark:text-red-400';
		return 'text-amber-600 dark:text-amber-400';
	}
</script>

<Modal bind:isOpen onClose={handleClose} onOpened={loadPreview} {title} size="lg">
	<div class="space-y-4">
		<p class="text-sm text-slate-600 dark:text-slate-400">
			Changes move from <span class="font-medium text-slate-800 dark:text-slate-200">{sourceLabel}</span>
			into <span class="font-medium text-slate-800 dark:text-slate-200">{targetLabel}</span>.
		</p>

		{#if isLoading}
			<div class="flex items-center gap-2.5 py-10 justify-center text-sm text-slate-500">
				<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin" />
				Comparing both trees…
			</div>
		{:else if !hasChanges}
			<div class="flex flex-col items-center gap-2.5 py-10 text-sm text-slate-500">
				<Icon name="lucide:check-check" class="w-8 h-8 opacity-40" />
				<span>Nothing to transfer — {targetLabel} is already up to date.</span>
			</div>
		{:else}
			{#if conflicts.length > 0}
				<div class="space-y-2">
					<div class="flex items-center gap-2 text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
						<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5" />
						Changed on both sides ({conflicts.length})
					</div>

					<div class="space-y-1.5">
						{#each conflicts as conflict (conflict.path)}
							<div class="p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5">
								<div class="flex items-center gap-2 mb-2">
									<Icon name={statusIcon(conflict.status)} class="w-3.5 h-3.5 shrink-0 {statusColor(conflict.status)}" />
									<span class="text-xs font-mono text-slate-700 dark:text-slate-300 truncate flex-1">{conflict.path}</span>
									{#if conflict.sourceContent !== undefined && conflict.targetContent !== undefined}
										<button
											type="button"
											class="shrink-0 px-1.5 py-0.5 rounded text-3xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-700/70 transition-colors duration-150"
											onclick={() => toggleDiff(conflict.path)}
										>
											{expandedPaths.has(conflict.path) ? 'Hide diff' : 'View diff'}
										</button>
									{/if}
								</div>

								{#if expandedPaths.has(conflict.path)}
									<div class="mb-2 max-h-64 overflow-y-auto">
										<DiffBlock
											oldString={conflict.targetContent ?? ''}
											newString={conflict.sourceContent ?? ''}
											label="{targetLabel} → {sourceLabel}"
										/>
									</div>
								{/if}

								<div class="flex flex-wrap gap-1.5">
									{#if conflict.autoMergeable}
										<button
											type="button"
											class="px-2 py-1 rounded-md text-xs font-medium transition-colors duration-150 {resolutions[conflict.path] === 'merge'
												? 'bg-violet-600 text-white'
												: 'bg-slate-200/70 dark:bg-slate-700/70 text-slate-700 dark:text-slate-300 hover:bg-violet-500/20'}"
											onclick={() => (resolutions = { ...resolutions, [conflict.path]: 'merge' })}
										>
											Merge both
										</button>
									{/if}
									<button
										type="button"
										class="px-2 py-1 rounded-md text-xs font-medium transition-colors duration-150 {resolutions[conflict.path] === 'source'
											? 'bg-violet-600 text-white'
											: 'bg-slate-200/70 dark:bg-slate-700/70 text-slate-700 dark:text-slate-300 hover:bg-violet-500/20'}"
										onclick={() => (resolutions = { ...resolutions, [conflict.path]: 'source' })}
									>
										Take {sourceLabel}
									</button>
									<button
										type="button"
										class="px-2 py-1 rounded-md text-xs font-medium transition-colors duration-150 {resolutions[conflict.path] === 'target'
											? 'bg-violet-600 text-white'
											: 'bg-slate-200/70 dark:bg-slate-700/70 text-slate-700 dark:text-slate-300 hover:bg-violet-500/20'}"
										onclick={() => (resolutions = { ...resolutions, [conflict.path]: 'target' })}
									>
										Keep {targetLabel}
									</button>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if cleanChanges.length > 0}
				<div class="space-y-2">
					<div class="text-xs font-semibold text-slate-600 dark:text-slate-500 uppercase tracking-wider">
						Transfers cleanly ({cleanChanges.length})
					</div>
					<div class="max-h-64 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700">
						{#each cleanChanges as change (change.path)}
							<div class="flex items-center gap-2 px-2.5 py-1.5">
								<Icon name={statusIcon(change.status)} class="w-3.5 h-3.5 shrink-0 {statusColor(change.status)}" />
								<span class="text-xs font-mono text-slate-700 dark:text-slate-300 truncate">{change.path}</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		{/if}
	</div>

	{#snippet footer()}
		<div class="flex justify-end gap-2">
			<Button variant="ghost" onclick={handleClose} disabled={worktreeState.isTransferring}>Cancel</Button>
			<Button
				variant="primary"
				class="gap-2"
				onclick={confirm}
				disabled={!hasChanges || isLoading || worktreeState.isTransferring}
			>
				{#if worktreeState.isTransferring}
					<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin" />
					Transferring…
				{:else}
					{title}
				{/if}
			</Button>
		</div>
	{/snippet}
</Modal>
