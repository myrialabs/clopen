<script lang="ts">
	/**
	 * Open a new issue.
	 *
	 * Outward-facing, so it is a form with an explicit Create rather than an
	 * inline row — but it is deliberately lighter than the pull-request
	 * composer: an issue harms nobody if it is imperfect, while a pull request
	 * publishes a branch.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import MarkdownComposer from './MarkdownComposer.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	let title = $state('');
	let body = $state('');
	let labelsInput = $state('');
	let creating = $state(false);

	$effect(() => {
		if (!isOpen) return;
		title = '';
		body = '';
		labelsInput = '';
	});

	async function create() {
		if (!title.trim()) return;
		creating = true;
		try {
			const item = await workStore.createIssue({
				title,
				body,
				assignees: [],
				labels: labelsInput
					.split(',')
					.map((entry) => entry.trim())
					.filter(Boolean)
			});
			if (item) onClose();
		} finally {
			creating = false;
		}
	}
</script>

<Modal bind:isOpen {onClose} title="New issue" size="xl">
	{#snippet children()}
		<div class="flex flex-col gap-3">
			<label class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Title</span>
				<input
					type="text"
					class="w-full h-9 px-3 text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
					placeholder="What is wrong, or what should exist"
					value={title}
					oninput={(event) => (title = event.currentTarget.value)}
				/>
			</label>

			<div class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Description</span>
				<MarkdownComposer
					value={body}
					minRows={8}
					placeholder="Markdown. Steps to reproduce, what you expected, what happened."
					onInput={(next) => (body = next)}
					onSubmit={create}
				/>
			</div>

			<label class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Labels</span>
				<input
					type="text"
					class="w-full h-9 px-3 text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
					placeholder="bug, needs-triage"
					value={labelsInput}
					oninput={(event) => (labelsInput = event.currentTarget.value)}
				/>
				<span class="text-xs text-slate-500 dark:text-slate-500">
					Comma-separated. A label the repository does not have is rejected by the provider.
				</span>
			</label>
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
				disabled={creating || !title.trim()}
				onclick={create}
			>
				{#if creating}
					<Icon name="lucide:loader-circle" class="w-4 h-4 animate-spin" />
				{/if}
				Create issue
			</button>
		</div>
	{/snippet}
</Modal>
