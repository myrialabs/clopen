<script lang="ts">
	/**
	 * The Issues & PRs surface.
	 *
	 * Lives in More Tools rather than as a sixth dock panel, and every entry
	 * point — this menu, the Git panel's "Open pull request" — opens THIS. Many
	 * doors, one room: a second place to look at the same work items would drift
	 * from this one within a release.
	 *
	 * More Tools is GLOBAL, so this surface has its own project selector and
	 * does not follow the workspace. Reading another project's issues should not
	 * cost you the session you are in; only starting work relocates you, because
	 * that is what starting work means.
	 *
	 * Chrome is kept to two rows: identification along the top, and the tabs
	 * inside the list column where they belong — a full-width tab strip spent a
	 * whole row of the modal to label a column that is a third of its width.
	 *
	 * Nothing below names a provider. Issues, pull requests and CI are the three
	 * shapes of work this surface knows, and which service answers is a detail
	 * the binding bar and the footer report rather than something the layout is
	 * built around.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import BindingBar from './BindingBar.svelte';
	import WorkSettings from './WorkSettings.svelte';
	import ProviderMark from './ProviderMark.svelte';
	import WorkItemList from './WorkItemList.svelte';
	import WorkItemDetailPane from './WorkItemDetailPane.svelte';
	import ListToolbar from './ListToolbar.svelte';
	import MenuSurface from './MenuSurface.svelte';
	import PullRequestComposer from './PullRequestComposer.svelte';
	import NewIssueModal from './NewIssueModal.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import { workStore, type WorkTab } from '$frontend/stores/features/work.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { openIntegrationConnect, openSettingsModal } from '$frontend/stores/ui/settings-modal.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		/** Open straight into the pull-request composer. */
		composePullRequest?: boolean;
	}

	let { isOpen = $bindable(), onClose, composePullRequest = false }: Props = $props();

	let settingsOpen = $state(false);
	let composerOpen = $state(false);
	let newIssueOpen = $state(false);
	let projectMenuOpen = $state(false);
	let projectFilter = $state('');
	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);

	const isMobile = $derived(windowWidth < 768);
	const sources = $derived(workStore.sources);
	const source = $derived(workStore.source);
	const rateLimit = $derived(workStore.rateLimit);
	const project = $derived(workStore.project);
	const canCreatePr = $derived(source?.capabilities.createPullRequest === true && source.binding !== null);
	const canCreateIssue = $derived(source?.capabilities.createIssue === true && source.binding !== null);

	const visibleProjects = $derived(
		projectState.projects.filter((entry) =>
			entry.name.toLowerCase().includes(projectFilter.trim().toLowerCase()))
	);

	/**
	 * Load the next page when the list nears its end.
	 *
	 * 200px of runway rather than the exact bottom, so the next page is usually
	 * already there by the time the user reaches it.
	 */
	function onListScroll(event: Event) {
		const el = event.currentTarget as HTMLElement;
		if (el.scrollHeight - el.scrollTop - el.clientHeight > 200) return;
		void workStore.loadMore();
	}

	const TABS: { id: WorkTab; label: string; icon: IconName }[] = [
		{ id: 'issue', label: 'Issues', icon: 'lucide:circle-dot' },
		{ id: 'pull-request', label: 'Pull requests', icon: 'lucide:git-pull-request' }
	];

	// The modal's visibility is owned by the quick-panels store, which is what
	// the navigators bind to. The store is told about it rather than deciding
	// it, so an action that closes the surface (start work, send logs to chat)
	// closes the ONE thing that is actually on screen.
	$effect(() => {
		if (isOpen) {
			workStore.activate();
			if (composePullRequest) composerOpen = true;
		} else {
			workStore.deactivate();
		}
	});

	// Detail is a column on desktop and a layer on mobile — at 360px a
	// side-by-side list and body are both unusable.
	const showDetailLayer = $derived(isMobile && workStore.selectedId !== null);

	function handleResize() {
		windowWidth = window.innerWidth;
	}

	/**
	 * GitHub is named here rather than derived, because this is the empty state:
	 * there is no connected source to ask, and GitHub is the one provider
	 * that exists. When a second one lands this becomes a choice, not a guess.
	 */
	function connectGithub() {
		onClose();
		openIntegrationConnect('github');
	}

</script>

<svelte:window on:resize={handleResize} />

<Modal
	bind:isOpen
	{onClose}
	bare
	mobileFullscreen
	ariaLabelledBy="work-title"
	className="flex flex-col w-full max-w-[90vw] h-[90dvh] max-h-[960px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		<header class="flex items-center gap-2 px-3 py-2 bg-white dark:bg-slate-900/70 border-b border-slate-200 dark:border-slate-800 shrink-0">
			<h2 id="work-title" class="flex items-center gap-2 shrink-0 text-sm font-semibold text-slate-900 dark:text-slate-100 m-0">
				<Icon name="lucide:circle-dot" class="w-4 h-4 text-violet-500" />
				<!-- The glyph carries the identity when the row runs out of room. -->
				<span class="hidden sm:inline">Issues &amp; PRs</span>
			</h2>

			<!--
				Project and repository share one shrinkable group. They were two
				`shrink-0` items, so a long owner/repository name could not give
				any width back and pushed the actions off the right edge instead.
			-->
			<div class="flex items-center gap-2 flex-1 min-w-0">

				<!--
					The project this surface is looking at, which need NOT be the one
					the workspace has open. More Tools is global, and being forced to
					abandon a running session to glance at another repo's issues is the
					thing that makes a global tool feel like a panel.
				-->
				<div class="relative min-w-0" use:clickOutside={() => (projectMenuOpen = false)}>
					<button
						type="button"
						class="flex items-center gap-1.5 h-8 w-full max-w-[14rem] px-2 text-xs font-medium bg-transparent border border-transparent rounded-md text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10 hover:border-violet-500/30"
						onclick={() => (projectMenuOpen = !projectMenuOpen)}
						title="Look at another project"
					>
						<Icon name="lucide:folder-git-2" class="w-3.5 h-3.5 shrink-0 text-slate-500" />
						<span class="truncate">{project?.name ?? 'Pick a project'}</span>
						<Icon name="lucide:chevron-down" class="w-3 h-3 shrink-0 text-slate-400" />
					</button>

					{#if projectMenuOpen}
						<MenuSurface prefer="start" width="w-64" class="flex flex-col max-h-72">
							<!-- A picker over a long project list is a search box, not a scroll. -->
							<div class="p-2 shrink-0 border-b border-slate-200 dark:border-slate-700">
								<input
									type="search"
									class="w-full h-8 px-2.5 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
									placeholder="Filter projects…"
									value={projectFilter}
									oninput={(event) => (projectFilter = event.currentTarget.value)}
								/>
							</div>
							<div class="flex flex-col min-h-0 overflow-y-auto py-1">
							{#each visibleProjects as entry (entry.id)}
								<button
									type="button"
									class="flex items-center gap-2 w-full shrink-0 px-3 h-8 bg-transparent border-none text-left text-xs cursor-pointer hover:bg-violet-500/10
										{entry.id === workStore.projectId
										? 'text-slate-900 dark:text-slate-100 font-medium'
										: 'text-slate-600 dark:text-slate-400'}"
									onclick={() => {
										projectMenuOpen = false;
										workStore.selectProject(entry.id);
									}}
								>
									<Icon
										name={entry.id === workStore.projectId ? 'lucide:check' : 'lucide:folder'}
										class="w-3.5 h-3.5 shrink-0 {entry.id === workStore.projectId ? 'text-violet-500' : 'text-slate-400'}"
									/>
									<span class="truncate">{entry.name}</span>
								</button>
							{/each}
							{#if visibleProjects.length === 0}
								<p class="px-3 py-3 m-0 text-xs text-slate-500 dark:text-slate-500 text-center">
									No project matches.
								</p>
							{/if}
							</div>
						</MenuSurface>
					{/if}
				</div>

				{#if sources.length > 0}
					<div class="-ml-2 min-w-0">
						<BindingBar />
					</div>
				{/if}
			</div>

			{#if canCreateIssue}
				<button
					type="button"
					class="flex items-center gap-1.5 h-8 shrink-0 px-2 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer transition-colors duration-150 hover:border-violet-500/50 hover:text-violet-600 dark:hover:text-violet-400"
					onclick={() => (newIssueOpen = true)}
				>
					<Icon name="lucide:plus" class="w-3.5 h-3.5" />
					{isMobile ? '' : 'New issue'}
				</button>
			{/if}

			{#if canCreatePr}
				<button
					type="button"
					class="flex items-center gap-1.5 h-8 shrink-0 px-2 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer transition-colors duration-150 hover:border-violet-500/50 hover:text-violet-600 dark:hover:text-violet-400"
					onclick={() => (composerOpen = true)}
				>
					<Icon name="lucide:git-pull-request" class="w-3.5 h-3.5" />
					{isMobile ? '' : 'New PR'}
				</button>
			{/if}

			{#if sources.length > 0}
				<button
					type="button"
					class="flex items-center justify-center w-8 h-8 shrink-0 bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-colors duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => (settingsOpen = true)}
					aria-label="Behaviour settings"
					title="Branch naming and state transitions"
				>
					<Icon name="lucide:settings-2" class="w-4 h-4" />
				</button>
			{/if}

			<button
				type="button"
				class="flex items-center justify-center w-8 h-8 shrink-0 bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-colors duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
				onclick={onClose}
				aria-label="Close"
			>
				<Icon name="lucide:x" class="w-4.5 h-4.5" />
			</button>
		</header>

		{#if workStore.isLoadingSources && sources.length === 0}
			<div class="flex items-center justify-center flex-1">
				<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
			</div>
		{:else if sources.length === 0}
			<div class="flex flex-col items-center justify-center gap-3 flex-1 px-8 text-center">
				<Icon name="lucide:plug" class="w-9 h-9 text-slate-300 dark:text-slate-700" />
				<p class="text-sm text-slate-700 dark:text-slate-300 m-0">No provider is connected</p>
				<p class="text-xs text-slate-500 dark:text-slate-500 max-w-sm m-0">
					Connect an account that offers issues and pull requests, and this project's work appears here.
				</p>
				{#if authStore.isAdmin}
					<!--
						Straight to the Connect dialog for the provider this surface
						needs, not to a list. Sending someone to Integrations and
						leaving them to find Add → GitHub is three clicks of hunting
						for something we already knew they wanted.
					-->
					<Button size="sm" onclick={connectGithub}>Connect GitHub</Button>
					<button
						type="button"
						class="text-xs text-slate-500 dark:text-slate-500 bg-transparent border-none cursor-pointer underline underline-offset-2 hover:text-slate-700 dark:hover:text-slate-300"
						onclick={() => {
							onClose();
							openSettingsModal('integrations');
						}}
					>
						Or see every integration
					</button>
				{:else}
					<p class="text-xs text-slate-500 dark:text-slate-500 m-0">
						Ask an administrator to connect one in Settings → Integrations.
					</p>
				{/if}
			</div>
		{:else if workStore.needsBinding}
			<div class="flex flex-col items-center justify-center gap-2 flex-1 px-8 text-center">
				<Icon name="lucide:book-marked" class="w-8 h-8 text-slate-300 dark:text-slate-700" />
				<p class="text-sm text-slate-700 dark:text-slate-300 m-0">
					Pick the repository this project belongs to
				</p>
				<p class="text-xs text-slate-500 dark:text-slate-500 max-w-sm m-0">
					Nothing matching was found among this project's git remotes. Use the repository picker
					in the header to enter one.
				</p>
			</div>
		{:else}
			<div class="flex flex-1 min-h-0">
				<div
					class="flex flex-col min-h-0 bg-white dark:bg-slate-900/40 {isMobile
						? 'flex-1'
						: 'w-[19rem] shrink-0 border-r border-slate-200 dark:border-slate-800'}"
				>
					<!-- Tabs scope the LIST, so they live over the list. -->
					<div class="flex items-center gap-0.5 px-2 pt-1.5 shrink-0">
						{#each TABS as entry (entry.id)}
							<button
								type="button"
								class="flex items-center gap-1.5 h-8 px-2 text-xs font-medium rounded-t-md border-b-2 bg-transparent cursor-pointer transition-colors duration-150
									{workStore.tab === entry.id
									? 'border-violet-500 text-slate-900 dark:text-slate-100'
									: 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}"
								onclick={() => workStore.setTab(entry.id)}
								title={entry.label}
							>
								<Icon name={entry.icon} class="w-3.5 h-3.5" />
								<span class="truncate">{entry.label}</span>
							</button>
						{/each}
					</div>

					<ListToolbar />

					<div class="flex-1 min-h-0 overflow-y-auto" onscroll={onListScroll}>
						{#if workStore.isLoadingItems}
							<div class="flex items-center justify-center h-full">
								<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
							</div>
						{:else if workStore.error}
							<div class="flex flex-col items-center gap-2 px-6 py-10 text-center">
								<Icon name="lucide:triangle-alert" class="w-7 h-7 text-amber-500" />
								<p class="text-sm text-slate-700 dark:text-slate-300 m-0">{workStore.error}</p>
							</div>
						{:else}
							<WorkItemList />
							{#if workStore.isLoadingMore}
								<div class="flex items-center justify-center gap-2 py-3 text-xs text-slate-500">
									<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
									Loading more…
								</div>
							{:else if workStore.hasMore}
								<button
									type="button"
									class="w-full py-3 text-xs bg-transparent border-none text-slate-500 dark:text-slate-400 cursor-pointer hover:bg-violet-500/5"
									onclick={() => workStore.loadMore()}
								>
									Load more
								</button>
							{/if}
						{/if}
					</div>
				</div>

				{#if !isMobile}
					<div class="flex-1 min-w-0 bg-white dark:bg-slate-900/40">
						<WorkItemDetailPane />
					</div>
				{/if}
			</div>

			<!--
				Identification, not navigation: which account answered and what is
				left of its budget. It sat in the header until the header ran out of
				room, and this is where the same question is asked about every other
				connection in Clopen.
			-->
			<footer class="flex items-center gap-2 px-3 py-1.5 text-[0.7rem] text-slate-500 dark:text-slate-500 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 shrink-0">
				{#if source}
					<span class="flex items-center gap-1.5 shrink-0">
						<ProviderMark provider={source.provider} size="w-3.5 h-3.5" />
						{source.providerName}
						{#if source.viewer}
							<span class="text-slate-400 dark:text-slate-600">· {source.viewer}</span>
						{/if}
					</span>
				{/if}

				<span class="flex-1"></span>

				{#if rateLimit}
					<span class="flex items-center gap-1.5 shrink-0">
						<Icon name="lucide:gauge" class="w-3 h-3" />
						{rateLimit.remaining} of {rateLimit.limit} API requests left
						{#if rateLimit.resetAt}
							· resets {new Date(rateLimit.resetAt).toLocaleTimeString()}
						{/if}
					</span>
				{/if}
			</footer>
		{/if}

		{#if showDetailLayer}
			<!-- Mobile detail: a full layer over the list, dismissed with the arrow. -->
			<div class="absolute inset-0 z-20 flex flex-col bg-white dark:bg-slate-900">
				<button
					type="button"
					class="flex items-center gap-2 px-4 py-3 bg-transparent border-none border-b border-slate-200 dark:border-slate-800 text-sm text-slate-600 dark:text-slate-400 cursor-pointer text-left"
					onclick={() => workStore.select(null)}
				>
					<Icon name="lucide:arrow-left" class="w-4 h-4" />
					Back to the list
				</button>
				<div class="flex-1 min-h-0">
					<WorkItemDetailPane />
				</div>
			</div>
		{/if}
	{/snippet}
</Modal>

<WorkSettings bind:isOpen={settingsOpen} onClose={() => (settingsOpen = false)} />

<NewIssueModal bind:isOpen={newIssueOpen} onClose={() => (newIssueOpen = false)} />

<PullRequestComposer
	bind:isOpen={composerOpen}
	accountId={source?.accountId ?? null}
	onClose={() => (composerOpen = false)}
/>
