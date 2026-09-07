<script lang="ts">
	/**
	 * The repo's undo journal.
	 *
	 * `git log` only walks what is reachable from a ref, so a bad reset, a deleted
	 * branch or an aborted rebase makes work look permanently gone. The reflog
	 * still holds those commits, which makes this the recovery path for every
	 * destructive action the panel offers.
	 *
	 * Recovery here is deliberately additive: you branch at the commit rather than
	 * resetting onto it, so getting the wrong entry costs a stray branch instead of
	 * the changes you were trying to save.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import type { GitReflogEntry } from '$shared/types/git';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		isOpen: boolean;
		entries: GitReflogEntry[];
		isLoading: boolean;
		onClose: () => void;
		onCreateBranch: (hash: string, name: string) => void;
		onCheckout: (hash: string) => void;
	}

	const { isOpen, entries, isLoading, onClose, onCreateBranch, onCheckout }: Props = $props();

	let query = $state('');
	let branchingHash = $state<string | null>(null);
	let branchName = $state('');

	const filtered = $derived(
		query.trim()
			? entries.filter((entry) => {
					const needle = query.trim().toLowerCase();
					return (
						entry.subject.toLowerCase().includes(needle) ||
						entry.action.toLowerCase().includes(needle) ||
						entry.selector.toLowerCase().includes(needle) ||
						entry.hashShort.includes(needle)
					);
				})
			: entries
	);

	/** A rough icon for the recorded action, so the list scans quickly. */
	function actionIcon(action: string): IconName {
		if (action.startsWith('rebase')) return 'lucide:git-pull-request-arrow';
		if (action.startsWith('merge')) return 'lucide:git-merge';
		if (action.startsWith('commit')) return 'lucide:git-commit-horizontal';
		if (action.startsWith('reset')) return 'lucide:undo-2';
		if (action.startsWith('checkout')) return 'lucide:git-branch';
		if (action.startsWith('clone') || action.startsWith('pull')) return 'lucide:arrow-down-to-line';
		return 'lucide:history';
	}

	function formatDate(iso: string): string {
		const parsed = new Date(iso);
		if (Number.isNaN(parsed.getTime())) return iso;
		return parsed.toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function startBranch(entry: GitReflogEntry) {
		branchingHash = entry.hash;
		branchName = `recover/${entry.hashShort}`;
	}

	function confirmBranch() {
		if (!branchingHash || !branchName.trim()) return;
		onCreateBranch(branchingHash, branchName.trim());
		branchingHash = null;
		branchName = '';
	}
</script>

<Modal
	{isOpen}
	{onClose}
	bare
	closable
	mobileFullscreen
	className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xl w-full max-w-[95vw] md:max-w-[720px] h-[85vh] flex flex-col overflow-hidden"
>
	<div
		class="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 md:px-4 dark:border-slate-800 shrink-0"
	>
		<div class="min-w-0">
			<h2 class="truncate text-sm font-bold text-slate-900 md:text-base dark:text-slate-100">
				Reflog
			</h2>
			<p class="truncate text-3xs text-slate-500 dark:text-slate-400">
				Commits that resets, rebases and deleted branches left behind
			</p>
		</div>
		<button
			type="button"
			class="flex cursor-pointer rounded-lg border-none bg-transparent p-1.5 text-slate-500 transition-colors hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
			onclick={onClose}
			aria-label="Close"
		>
			<Icon name="lucide:x" class="w-4 h-4 md:w-5 md:h-5" />
		</button>
	</div>

	<div class="border-b border-slate-200 px-3 py-2 md:px-4 dark:border-slate-800 shrink-0">
		<input
			type="text"
			bind:value={query}
			placeholder="Filter by message, action or hash…"
			class="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:ring-1 focus:ring-violet-500 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-100"
		/>
	</div>

	{#if isLoading}
		<div class="flex flex-1 items-center justify-center">
			<div
				class="h-7 w-7 animate-spin rounded-full border-2 border-slate-200 border-t-violet-600 dark:border-slate-700"
			></div>
		</div>
	{:else if filtered.length === 0}
		<div class="flex flex-1 flex-col items-center justify-center gap-2 text-slate-500 dark:text-slate-400">
			<Icon name="lucide:history" class="w-10 h-10 opacity-50" />
			<p class="text-sm">{entries.length === 0 ? 'The reflog is empty.' : 'No entries match that filter.'}</p>
		</div>
	{:else}
		<div class="min-h-0 flex-1 overflow-y-auto py-1">
			{#each filtered as entry (entry.selector + entry.hash)}
				<div
					class="flex items-start gap-2.5 border-b border-slate-100 px-3 py-2 md:px-4 dark:border-slate-800/60"
				>
					<Icon
						name={actionIcon(entry.action)}
						class="mt-0.5 w-4 h-4 shrink-0 text-slate-400 dark:text-slate-500"
					/>
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
							<code class="font-mono text-3xs text-violet-600 dark:text-violet-400">{entry.selector}</code>
							<code class="font-mono text-3xs text-slate-500 dark:text-slate-400">{entry.hashShort}</code>
							<span
								class="rounded bg-slate-100 px-1 py-px text-3xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
							>
								{entry.action}
							</span>
							<span class="text-3xs text-slate-400 dark:text-slate-500">{formatDate(entry.date)}</span>
						</div>
						<p class="mt-0.5 truncate text-xs text-slate-700 dark:text-slate-200" title={entry.subject}>
							{entry.subject || '—'}
						</p>

						{#if branchingHash === entry.hash}
							<div class="mt-1.5 flex items-center gap-1.5">
								<input
									type="text"
									bind:value={branchName}
									placeholder="branch name"
									class="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-violet-500 dark:border-slate-700 dark:bg-slate-800"
									onkeydown={(e) => e.key === 'Enter' && confirmBranch()}
								/>
								<button
									type="button"
									class="shrink-0 cursor-pointer rounded-md border-none bg-violet-600 px-2 py-1 text-3xs font-semibold text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
									onclick={confirmBranch}
									disabled={!branchName.trim()}
								>
									Create
								</button>
								<button
									type="button"
									class="shrink-0 cursor-pointer rounded-md border-none bg-transparent px-1.5 py-1 text-3xs text-slate-500 transition-colors hover:text-slate-800 dark:hover:text-slate-200"
									onclick={() => (branchingHash = null)}
								>
									Cancel
								</button>
							</div>
						{/if}
					</div>

					{#if branchingHash !== entry.hash}
						<div class="flex shrink-0 items-center gap-1">
							<button
								type="button"
								class="flex cursor-pointer items-center gap-1 rounded-md border-none bg-violet-500/10 px-2 py-1 text-3xs font-medium text-violet-700 transition-colors hover:bg-violet-500/20 dark:text-violet-300"
								onclick={() => startBranch(entry)}
								title="Create a branch at this commit — the safe way to recover it"
							>
								<Icon name="lucide:git-branch-plus" class="w-3 h-3" />
								Branch
							</button>
							<button
								type="button"
								class="flex cursor-pointer items-center gap-1 rounded-md border-none bg-transparent px-1.5 py-1 text-3xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
								onclick={() => onCheckout(entry.hash)}
								title="Check this commit out to inspect it (detached HEAD)"
							>
								<Icon name="lucide:eye" class="w-3 h-3" />
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</Modal>
