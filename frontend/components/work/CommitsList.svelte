<script lang="ts">
	/**
	 * Commits on a pull request's branch, newest first — and what each one did.
	 *
	 * This was a list of subjects beside a pane of nothing: the whole right half
	 * of the tab was empty, and reading a commit meant leaving for the browser.
	 * It is now shaped like Git → History, which answers the same question a few
	 * feet away: the list is navigation, and the selected commit shows its
	 * message, its stats and its diff. The newest is opened on arrival, because
	 * a pane that says "pick something" when there is an obvious something to
	 * pick is asking for a click it could have made itself.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import DiffBrowser from './DiffBrowser.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';
	import { copyText } from '$frontend/utils/clipboard';
	import { showInfo } from '$frontend/stores/ui/notification.svelte';

	const commits = $derived(workStore.commits);
	const selected = $derived(workStore.selectedCommit);
	const detail = $derived(workStore.commitDetail);
	const isLoading = $derived(workStore.isLoadingCommit);

	let bodyExpanded = $state(false);

	// A long message is opt-in, and the choice belongs to the commit that was
	// open when it was made.
	$effect(() => {
		selected;
		bodyExpanded = false;
	});

	async function copyHash(hash: string) {
		const ok = await copyText(hash);
		showInfo(ok ? 'Copied' : 'Could not copy', ok ? hash : 'The clipboard refused the request.');
	}
</script>

{#if commits.length === 0}
	<p class="text-sm text-slate-500 dark:text-slate-500 m-0 px-1 py-6 text-center">
		No commits on this branch.
	</p>
{:else}
	<div class="flex h-full min-h-0">
		<aside class="hidden md:flex flex-col w-64 lg:w-72 shrink-0 border-r border-slate-200 dark:border-slate-800">
			<div class="px-3 py-1.5 shrink-0 text-[0.7rem] text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
				{commits.length} commit{commits.length === 1 ? '' : 's'}
			</div>
			<ul class="flex flex-col list-none flex-1 min-h-0 overflow-y-auto m-0 p-0">
				{#each commits as commit (commit.hash)}
					<li>
						<button
							type="button"
							class="flex items-start gap-2 w-full px-3 py-2 text-left bg-transparent border-none border-b border-slate-100 dark:border-slate-800/70 cursor-pointer transition-colors duration-150
								{commit.hash === selected
								? 'bg-violet-500/10'
								: 'hover:bg-violet-500/5'}"
							onclick={() => workStore.openCommit(commit.hash)}
						>
							<Icon name="lucide:git-commit-horizontal" class="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" />
							<span class="flex flex-col min-w-0 flex-1">
								<span class="text-sm text-slate-900 dark:text-slate-100 truncate">{commit.subject}</span>
								<span class="text-xs text-slate-500 dark:text-slate-500 truncate">
									{commit.author ?? 'unknown'}{commit.date
										? ` · ${new Date(commit.date).toLocaleDateString()}`
										: ''}
								</span>
							</span>
							<span class="shrink-0 px-1.5 h-5 flex items-center font-mono text-[0.65rem] rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
								{commit.hash}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</aside>

		<div class="flex flex-col flex-1 min-w-0 min-h-0">
			<!-- The list, for screens with no room for the list. -->
			<div class="flex md:hidden items-center gap-2 px-3 py-1.5 shrink-0 border-b border-slate-200 dark:border-slate-800">
				<Icon name="lucide:git-commit-horizontal" class="w-3.5 h-3.5 shrink-0 text-slate-500" />
				<select
					class="flex-1 min-w-0 h-8 px-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
					value={selected ?? ''}
					onchange={(event) => workStore.openCommit(event.currentTarget.value)}
					aria-label="Pick a commit"
				>
					{#each commits as commit (commit.hash)}
						<option value={commit.hash}>{commit.hash} · {commit.subject}</option>
					{/each}
				</select>
			</div>

			{#if isLoading}
				<div class="flex items-center justify-center flex-1">
					<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
				</div>
			{:else if !detail}
				<div class="flex flex-col items-center justify-center gap-2 flex-1 px-6 text-center">
					<Icon name="lucide:git-commit-horizontal" class="w-8 h-8 text-slate-300 dark:text-slate-700" />
					<p class="text-sm text-slate-500 dark:text-slate-500 m-0">Pick a commit</p>
				</div>
			{:else}
				<header class="flex flex-col gap-1.5 px-4 py-2.5 shrink-0 border-b border-slate-200 dark:border-slate-800">
					<div class="flex items-start gap-2">
						<h3 class="flex-1 m-0 text-sm font-semibold text-slate-900 dark:text-slate-100 leading-snug">
							{detail.commit.subject}
						</h3>
						<button
							type="button"
							class="shrink-0 px-1.5 h-6 flex items-center gap-1 font-mono text-xs rounded bg-slate-100 dark:bg-slate-800 border-none text-slate-600 dark:text-slate-400 cursor-pointer hover:text-violet-600 dark:hover:text-violet-400"
							onclick={() => copyHash(detail.commit.hash)}
							title="Copy the hash"
						>
							<Icon name="lucide:copy" class="w-3 h-3" />
							{detail.commit.hash}
						</button>
						<a
							href={detail.commit.url}
							target="_blank"
							rel="noreferrer noopener"
							class="flex items-center justify-center w-6 h-6 shrink-0 rounded text-slate-500 no-underline hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
							title="Open the commit on the web"
						>
							<Icon name="lucide:external-link" class="w-3 h-3" />
						</a>
					</div>

					<div class="flex items-center gap-2 flex-wrap text-xs text-slate-500 dark:text-slate-500">
						<span>{detail.commit.author ?? 'unknown'}</span>
						{#if detail.commit.date}
							<span>· {new Date(detail.commit.date).toLocaleString()}</span>
						{/if}
						<span class="text-green-600 dark:text-green-400">+{detail.additions}</span>
						<span class="text-red-600 dark:text-red-400">−{detail.deletions}</span>
						<span>
							{detail.files.length} file{detail.files.length === 1 ? '' : 's'}
						</span>
					</div>

					{#if detail.body}
						<button
							type="button"
							class="flex items-center gap-1 self-start h-6 px-0 text-xs bg-transparent border-none text-slate-500 dark:text-slate-400 cursor-pointer hover:text-slate-800 dark:hover:text-slate-200"
							onclick={() => (bodyExpanded = !bodyExpanded)}
						>
							<Icon
								name={bodyExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'}
								class="w-3 h-3"
							/>
							{bodyExpanded ? 'Hide message' : 'Show full message'}
						</button>
						{#if bodyExpanded}
							<pre class="m-0 max-h-40 overflow-y-auto whitespace-pre-wrap wrap-anywhere text-xs leading-5 font-mono text-slate-700 dark:text-slate-300">{detail.body}</pre>
						{/if}
					{/if}
				</header>

				<div class="flex-1 min-h-0">
					<DiffBrowser files={detail.files} emptyLabel="This commit touched no files." />
				</div>
			{/if}
		</div>
	</div>
{/if}
