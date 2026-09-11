<script lang="ts">
	/**
	 * Merging a pull request.
	 *
	 * The most outward-facing action this surface has: it changes what is on the
	 * default branch for everyone watching the repository. So it is a modal with
	 * an explicit method choice and an explicit confirm, never a button that
	 * merges on click.
	 *
	 * Only the methods the REPOSITORY allows are offered. A repo can disable
	 * squash or rebase, and offering a disabled one produces a 405 at the exact
	 * moment the user has committed to the action.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';
	import { MERGE_METHOD_LABELS } from '$shared/types/work';
	import type { MergeMethod, WorkItemDetail } from '$shared/types/work';

	interface Props {
		isOpen: boolean;
		item: WorkItemDetail;
		onClose: () => void;
	}

	let { isOpen = $bindable(), item, onClose }: Props = $props();

	const mergeability = $derived(item.mergeability ?? null);
	const methods = $derived<MergeMethod[]>(mergeability?.allowedMethods ?? ['merge']);

	let method = $state<MergeMethod>('merge');
	let title = $state('');

	$effect(() => {
		if (!isOpen) return;
		// Squash is the common house style, so it is preselected when the
		// repository allows it — but only as a default the user can see and change.
		method = methods.includes('squash') ? 'squash' : methods[0];
		title = `${item.title} (#${item.identifier})`;
	});

	async function merge() {
		if (await workStore.mergePullRequest(method, title)) onClose();
	}
</script>

<Modal bind:isOpen {onClose} title="Merge pull request" size="lg">
	{#snippet children()}
		<div class="flex flex-col gap-4">
			<p class="text-sm text-slate-700 dark:text-slate-300 m-0">
				#{item.identifier} — {item.title}
			</p>

			{#if mergeability?.mergeable === false}
				<div class="flex items-start gap-2 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10">
					<Icon name="lucide:triangle-alert" class="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
					<p class="text-xs text-amber-800 dark:text-amber-300 m-0">
						The provider reports this branch as <strong class="font-semibold">{mergeability.state}</strong>
						and will refuse the merge. Resolve that first — usually a conflict, a failing required
						check, or a missing review.
					</p>
				</div>
			{:else if mergeability?.mergeable === null}
				<div class="flex items-start gap-2 p-3 rounded-lg border border-slate-300 dark:border-slate-700">
					<Icon name="lucide:loader-circle" class="w-4 h-4 mt-0.5 shrink-0 text-slate-400 animate-spin" />
					<p class="text-xs text-slate-600 dark:text-slate-400 m-0">
						Mergeability is still being computed. You can try anyway — it is worked out on
						demand, and the merge itself will say if it cannot proceed.
					</p>
				</div>
			{/if}

			<fieldset class="flex flex-col gap-1.5 m-0 p-0 border-none">
				<legend class="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1 p-0">Method</legend>
				{#each methods as option (option)}
					<label class="flex items-center gap-2.5 px-3 h-10 rounded-lg border cursor-pointer transition-colors duration-150
						{method === option
							? 'border-violet-500/50 bg-violet-500/10'
							: 'border-slate-200 dark:border-slate-800 hover:bg-violet-500/5'}">
						<input
							type="radio"
							class="w-4 h-4 accent-violet-600 cursor-pointer"
							checked={method === option}
							onchange={() => (method = option)}
						/>
						<span class="text-sm text-slate-800 dark:text-slate-200">{MERGE_METHOD_LABELS[option]}</span>
					</label>
				{/each}
			</fieldset>

			{#if method !== 'rebase'}
				<label class="flex flex-col gap-1.5">
					<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Commit title</span>
					<input
						type="text"
						class="w-full h-9 px-3 text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
						value={title}
						oninput={(event) => (title = event.currentTarget.value)}
					/>
				</label>
			{:else}
				<p class="text-xs text-slate-500 dark:text-slate-400 m-0">
					A rebase replays the branch's own commits, so there is no merge commit to title.
				</p>
			{/if}
		</div>
	{/snippet}

	{#snippet footer()}
		<div class="flex items-center justify-end gap-2">
			<button
				type="button"
				class="h-9 px-3.5 text-sm font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-lg text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10"
				onclick={onClose}
			>
				Cancel
			</button>
			<button
				type="button"
				class="flex items-center gap-1.5 h-9 px-3.5 text-sm font-semibold bg-violet-600 hover:bg-violet-700 border-none rounded-lg text-white cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
				disabled={workStore.isMerging}
				onclick={merge}
			>
				{#if workStore.isMerging}
					<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin" />
				{:else}
					<Icon name="lucide:git-merge" class="w-4 h-4" />
				{/if}
				{MERGE_METHOD_LABELS[method]}
			</button>
		</div>
	{/snippet}
</Modal>
