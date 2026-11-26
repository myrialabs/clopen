<script lang="ts">
	/**
	 * The Git panel's hosting view — named after the service the repository's
	 * remote lives on (GitHub, GitLab, …).
	 *
	 * Two rows of chrome and then the list, because this is a column the width
	 * of the Git panel:
	 *   1. PRs / Issues, which slice, filters, refresh, new, settings.
	 *   2. Search.
	 * Above the list, at most one line about the current branch, and only when
	 * it has something to say — its pull request, or that one could be opened.
	 * The default branch has nothing to say and gets nothing.
	 *
	 * Everything that is not "here is the work" — no account, no Issues & PRs
	 * for this service, a remote that matched nothing — is one empty state with
	 * the one action that fixes it.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import WorkItemList from '$frontend/components/work/WorkItemList.svelte';
	import ListToolbar from '$frontend/components/work/ListToolbar.svelte';
	import NewIssueModal from '$frontend/components/work/NewIssueModal.svelte';
	import RepoHostingSettingsModal from './RepoHostingSettingsModal.svelte';
	import { workStore, type WorkTab } from '$frontend/stores/features/work.svelte';
	import { hostingStore } from '$frontend/stores/features/hosting.svelte';
	import { integrationsStore } from '$frontend/stores/features/integrations.svelte';
	import { openHostConnect } from '$frontend/stores/ui/host-connect.svelte';
	import type { WorkItem } from '$shared/types/work';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		currentBranch: string | null;
		/** True when the current branch exists on the remote. */
		branchPushed: boolean;
		onCreatePullRequest: () => void;
		onPublish: () => void;
		/** Called after an item is opened, so a one-column panel can show it. */
		onItemOpened: () => void;
	}

	const { currentBranch, branchPushed, onCreatePullRequest, onPublish, onItemOpened }: Props = $props();

	let newIssueOpen = $state(false);
	let settingsOpen = $state(false);
	let enablingWork = $state(false);

	const remote = $derived(hostingStore.primaryRemote);
	const account = $derived(hostingStore.primaryAccount);
	const provider = $derived(hostingStore.primaryProvider);
	const providerName = $derived(hostingStore.providerName ?? 'Git host');
	const noun = $derived(hostingStore.prNoun);
	const source = $derived(workStore.source);
	const branchPr = $derived(currentBranch ? hostingStore.branchPrs[currentBranch] ?? null : null);
	const onDefaultBranch = $derived(!!currentBranch && currentBranch === remote?.defaultBranch);
	const forYou = $derived([...workStore.forYou.pulls, ...workStore.forYou.issues]);

	const checkState = $derived.by(() => {
		const current = hostingStore.currentChecks;
		if (!current || current.branch !== currentBranch || current.runs.length === 0) return null;
		// The newest run per name: a re-run that passed must not still read as failing.
		const latest = new Map<string, (typeof current.runs)[number]>();
		for (const run of current.runs) if (!latest.has(run.name)) latest.set(run.name, run);
		const runs = [...latest.values()];
		if (runs.some((run) => run.status === 'failure')) return { icon: 'lucide:circle-x' as IconName, class: 'text-rose-500', label: 'Checks failing' };
		if (runs.some((run) => run.status === 'running' || run.status === 'queued')) return { icon: 'lucide:circle-dot-dashed' as IconName, class: 'text-amber-500', label: 'Checks running' };
		return { icon: 'lucide:circle-check' as IconName, class: 'text-emerald-500', label: 'Checks passed' };
	});

	const KINDS: { id: WorkTab; icon: IconName }[] = [
		{ id: 'pull-request', icon: 'lucide:git-pull-request' },
		{ id: 'issue', icon: 'lucide:circle-dot' }
	];

	/** Which empty state, if any, stands in for the view. */
	const blocker = $derived.by(() => {
		if (!remote) return 'no-remote' as const;
		if (!account) return 'no-account' as const;
		if (account.status === 'needs_auth') return 'needs-auth' as const;
		if (!account.offersWork) return 'no-work' as const;
		if (workStore.isLoadingSources && !source) return 'loading' as const;
		if (source && !source.binding) return 'unbound' as const;
		return null;
	});

	// The remote decides which account this view reads from.
	$effect(() => {
		const id = account?.offersWork ? account.accountId : null;
		if (!id) return;
		workStore.activate(id);
		return () => workStore.deactivate();
	});

	/** Whether this service has an Issues & PRs adapter at all, or only needs the capability on. */
	const workAvailable = $derived(provider === 'github' || provider === 'gitlab');

	async function enableWork() {
		if (!account) return;
		const info = integrationsStore.accounts.find((entry) => entry.id === account.accountId);
		if (!info) return;
		enablingWork = true;
		try {
			await integrationsStore.update({ id: info.id, capabilities: [...new Set([...info.capabilities, 'work' as const])] });
			await hostingStore.load({ force: true });
		} finally {
			enablingWork = false;
		}
	}

	function open(item: WorkItem) {
		void workStore.select(item);
		onItemOpened();
	}

	function stateIcon(item: WorkItem): { icon: IconName; class: string } {
		if (item.stateCategory === 'merged') return { icon: 'lucide:git-merge', class: 'text-violet-500' };
		if (item.stateCategory === 'draft') return { icon: 'lucide:git-pull-request-draft', class: 'text-slate-500' };
		if (item.stateCategory === 'closed') return { icon: item.kind === 'pull-request' ? 'lucide:git-pull-request-closed' : 'lucide:circle-check', class: 'text-slate-500' };
		return { icon: item.kind === 'pull-request' ? 'lucide:git-pull-request' : 'lucide:circle-dot', class: 'text-green-600 dark:text-green-400' };
	}

	function onListScroll(event: Event) {
		const el = event.currentTarget as HTMLElement;
		if (el.scrollHeight - el.scrollTop - el.clientHeight > 200) return;
		void workStore.loadMore();
	}

	const iconButton = 'flex items-center justify-center w-7 h-7 shrink-0 rounded-md bg-transparent border-none text-slate-500 dark:text-slate-400 cursor-pointer hover:bg-violet-500/10 hover:text-slate-800 dark:hover:text-slate-200';
</script>

{#snippet emptyState(title: string, body: string, action?: { label: string; onclick: () => void; busy?: boolean })}
	<div class="flex flex-col items-center justify-center gap-2 flex-1 px-6 py-10 text-center">
		{#if provider}<ProviderMark provider={provider} size="w-7 h-7" />{:else}<Icon name="lucide:cloud-upload" class="w-7 h-7 text-slate-300 dark:text-slate-700" />{/if}
		<p class="m-0 text-sm text-slate-700 dark:text-slate-300">{title}</p>
		<p class="m-0 max-w-64 text-xs text-slate-500">{body}</p>
		{#if action}
			<button
				type="button"
				class="mt-1 inline-flex items-center gap-1.5 h-8 px-3 text-xs font-semibold rounded-lg bg-violet-600 hover:bg-violet-700 text-white border-none cursor-pointer disabled:opacity-60"
				disabled={action.busy}
				onclick={action.onclick}
			>
				{#if action.busy}<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />{/if}
				{action.label}
			</button>
		{/if}
	</div>
{/snippet}

<div class="flex-1 flex flex-col min-h-0">
	{#if blocker === 'no-remote'}
		{@render emptyState('Not on a server yet', 'Publish this repository — it is created and pushed for you.', { label: 'Publish repository', onclick: onPublish })}
	{:else if blocker === 'no-account'}
		{@render emptyState(`Connect ${providerName}`, `See pull requests, issues and CI for ${remote?.locator ?? 'this repository'}.`, {
			label: `Connect ${providerName}`,
			onclick: () => openHostConnect({ provider })
		})}
	{:else if blocker === 'needs-auth'}
		{@render emptyState(`Sign in to ${providerName} again`, 'The stored sign-in no longer works.', {
			label: 'Sign in again',
			onclick: () => openHostConnect({ provider, accountId: account?.accountId })
		})}
	{:else if blocker === 'no-work'}
		{#if workAvailable}
			{@render emptyState('Issues & pull requests are off', `Turn them on for ${account?.label ?? 'this account'} to see them here.`, { label: 'Turn on', onclick: () => void enableWork(), busy: enablingWork })}
		{:else}
			{@render emptyState(
				`${providerName} issues aren't supported yet`,
				'Pushing, publishing and CI work. Open issues and pull requests on the web.',
				remote?.links ? { label: `Open on ${providerName}`, onclick: () => window.open(remote!.links!.repo, '_blank', 'noopener,noreferrer') } : undefined
			)}
		{/if}
	{:else if blocker === 'loading'}
		<div class="flex items-center justify-center flex-1"><Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" /></div>
	{:else if blocker === 'unbound'}
		{@render emptyState('Could not match this repository', `None of the remotes is a repository ${account?.label ?? 'the account'} can see.`, {
			label: 'Choose the repository',
			onclick: () => (settingsOpen = true)
		})}
	{:else}
		<ListToolbar>
			{#snippet leading()}
				<div class="flex shrink-0 p-0.5 rounded-md bg-slate-100 dark:bg-slate-800">
					{#each KINDS as kind (kind.id)}
						<button
							type="button"
							class="flex items-center gap-1 h-6 px-1.5 text-xs rounded border-none cursor-pointer
								{workStore.tab === kind.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'bg-transparent text-slate-500'}"
							onclick={() => void workStore.setTab(kind.id)}
							title={kind.id === 'issue' ? 'Issues' : `${noun.long[0]!.toUpperCase()}${noun.long.slice(1)}s`}
						>
							<Icon name={kind.icon} class="w-3.5 h-3.5" />
							<!-- Names only when the column has room for them and every icon. -->
							<span class="hidden @[22rem]:inline">{kind.id === 'issue' ? 'Issues' : `${noun.short}s`}</span>
						</button>
					{/each}
				</div>
			{/snippet}
			{#snippet trailing()}
				{#if workStore.tab === 'issue' ? source?.capabilities.createIssue : source?.capabilities.createPullRequest}
					<button
						type="button"
						class={iconButton}
						onclick={() => (workStore.tab === 'issue' ? (newIssueOpen = true) : onCreatePullRequest())}
						title={workStore.tab === 'issue' ? 'New issue' : `New ${noun.long}`}
					>
						<Icon name="lucide:plus" class="w-4 h-4" />
					</button>
				{/if}
				<button type="button" class={iconButton} onclick={() => (settingsOpen = true)} title="Repository settings">
					<Icon name="lucide:settings-2" class="w-3.5 h-3.5" />
				</button>
			{/snippet}
		</ListToolbar>

		<div class="flex-1 min-h-0 overflow-y-auto" onscroll={onListScroll}>
			<!-- The current branch, only when it has something to say. -->
			{#if branchPr}
				<button
					type="button"
					class="flex items-center gap-2 w-full px-3 py-1.5 text-left border-none border-b border-slate-100 dark:border-slate-800 bg-green-500/5 hover:bg-green-500/10 cursor-pointer"
					onclick={() => open(branchPr)}
					title={branchPr.title}
				>
					<Icon name="lucide:git-branch" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
					<span class="text-xs font-mono text-slate-600 dark:text-slate-300 truncate max-w-[40%]">{currentBranch}</span>
					<span class="flex-1 min-w-0 text-xs text-slate-700 dark:text-slate-200 truncate"><span class="font-mono text-green-600 dark:text-green-400">#{branchPr.identifier}</span> {branchPr.title}</span>
					{#if checkState}<Icon name={checkState.icon} class="w-3.5 h-3.5 shrink-0 {checkState.class}" />{/if}
				</button>
			{:else if currentBranch && !onDefaultBranch && source?.capabilities.createPullRequest}
				<button
					type="button"
					class="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs border-none border-b border-slate-100 dark:border-slate-800 bg-transparent text-slate-600 dark:text-slate-300 hover:bg-violet-500/5 hover:text-violet-600 cursor-pointer"
					onclick={onCreatePullRequest}
				>
					<Icon name="lucide:git-pull-request-create" class="w-3.5 h-3.5 shrink-0" />
					<span class="flex-1 min-w-0 truncate">
						{branchPushed ? 'Open' : 'Push and open'} a {noun.long} for <span class="font-mono">{currentBranch}</span>
					</span>
					{#if checkState}<Icon name={checkState.icon} class="w-3.5 h-3.5 shrink-0 {checkState.class}" />{/if}
				</button>
			{/if}

			{#if forYou.length > 0 && workStore.filters.state === 'open' && !workStore.search}
				<!-- A shaded block of its own with a heading, and the full list gets a
				     heading too: two lists of the same items read as one without them. -->
				<details class="group bg-violet-500/[0.04] dark:bg-violet-500/[0.06] border-b-4 border-slate-100 dark:border-slate-800/80" open>
					<summary class="flex items-center gap-1 px-3 py-1.5 text-3xs font-semibold uppercase tracking-wide text-violet-600/80 dark:text-violet-400/80 cursor-pointer list-none">
						<Icon name="lucide:chevron-right" class="w-3 h-3 transition-transform group-open:rotate-90" />
						For you · {forYou.length}
					</summary>
					<div class="pb-1">
						{#each forYou as item (`${item.kind}-${item.id}`)}
							{@const style = stateIcon(item)}
							<button
								type="button"
								class="flex items-center gap-2 w-full px-3 py-1 text-left border-none cursor-pointer {workStore.selectedId === item.id ? 'bg-violet-500/10' : 'bg-transparent hover:bg-slate-100 dark:hover:bg-slate-800/60'}"
								onclick={() => open(item)}
								title={item.title}
							>
								<Icon name={style.icon} class="w-3.5 h-3.5 shrink-0 {style.class}" />
								<span class="flex-1 min-w-0 text-xs text-slate-700 dark:text-slate-200 truncate">{item.title}</span>
								<span class="shrink-0 text-3xs font-mono text-slate-400">#{item.identifier}</span>
							</button>
						{/each}
					</div>
				</details>
			{/if}

			{#if workStore.isLoadingItems && workStore.items.length === 0}
				<div class="flex items-center justify-center py-8"><Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" /></div>
			{:else if workStore.error}
				<div class="flex flex-col items-center gap-2 px-6 py-8 text-center">
					<Icon name="lucide:triangle-alert" class="w-6 h-6 text-amber-500" />
					<p class="m-0 text-xs text-slate-600 dark:text-slate-300">{workStore.error}</p>
				</div>
			{:else}
				<!-- A filter or search change keeps the current rows, dimmed, until
				     the answer arrives — emptying them would flicker on every keystroke. -->
				{#if forYou.length > 0 && workStore.filters.state === 'open' && !workStore.search}
					<div class="px-3 pt-2 pb-1 text-3xs font-semibold uppercase tracking-wide text-slate-500">
						All {workStore.tab === 'issue' ? 'issues' : `${noun.short}s`}
					</div>
				{/if}
				<div class="transition-opacity duration-150 {workStore.isLoadingItems ? 'opacity-50 pointer-events-none' : ''}">
					<WorkItemList onOpen={onItemOpened} />
				</div>
				{#if workStore.isLoadingMore}
					<div class="flex items-center justify-center gap-2 py-3 text-xs text-slate-500"><Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />Loading more…</div>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<NewIssueModal bind:isOpen={newIssueOpen} onClose={() => (newIssueOpen = false)} />
<RepoHostingSettingsModal isOpen={settingsOpen} onClose={() => (settingsOpen = false)} />
