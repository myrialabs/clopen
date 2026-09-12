<script lang="ts">
	/**
	 * The Deployments surface.
	 *
	 * Lives in More Tools rather than as a dock panel, following the Issues
	 * surface: a sixth panel touches `PanelId`, the split tree, every layout
	 * preset and both navigators, and a second place to look at the same builds
	 * would drift from this one within a release. Many doors, one room.
	 *
	 * More Tools is GLOBAL, so this has its own project selector and does not
	 * follow the workspace. Watching another project's build should not cost you
	 * the session you are in — only opening a build in the preview browser
	 * relocates you, because the preview dock belongs to the workspace.
	 *
	 * Nothing below names a provider. Builds, logs and what is live are the three
	 * things this surface knows, and which service answers is something the
	 * binding bar and the footer report rather than something the layout is
	 * built around.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import MenuSurface from '$frontend/components/common/overlay/MenuSurface.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import RefreshButton from '$frontend/components/common/display/RefreshButton.svelte';
	import DeployBindingBar from './DeployBindingBar.svelte';
	import DeploymentList from './DeploymentList.svelte';
	import DeploymentDetailPane from './DeploymentDetailPane.svelte';
	import DeployModal from './DeployModal.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import { deploymentsStore } from '$frontend/stores/features/deployments.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { openIntegrationConnect, openSettingsModal } from '$frontend/stores/ui/settings-modal.svelte';
	import type { DeploymentEnvironmentFilter } from '$shared/types/deployments';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	let projectMenuOpen = $state(false);
	let projectFilter = $state('');
	let deployOpen = $state(false);
	let deployTab = $state<'build' | 'new-project'>('build');
	let branchInput = $state('');
	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);

	const isMobile = $derived(windowWidth < 768);
	const sources = $derived(deploymentsStore.sources);
	const source = $derived(deploymentsStore.source);
	const project = $derived(deploymentsStore.project);
	const rateLimit = $derived(deploymentsStore.rateLimit);

	const visibleProjects = $derived(
		projectState.projects.filter((entry) =>
			entry.name.toLowerCase().includes(projectFilter.trim().toLowerCase())
		)
	);

	// `custom` is here because the model has always had it — Vercel custom
	// environments and Netlify branch deploys are neither production nor
	// preview, and leaving the chip out made them unreachable rather than absent.
	const FILTERS: { id: DeploymentEnvironmentFilter; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'production', label: 'Production' },
		{ id: 'preview', label: 'Preview' },
		{ id: 'custom', label: 'Custom' }
	];

	const canDeploy = $derived(source?.capabilities.createDeployment === true && source.binding !== null);
	const canCreateProject = $derived(source?.capabilities.createProject === true);
	const isPaused = $derived(deploymentsStore.projectStatus?.paused === true);
	const aliasRequest = $derived(deploymentsStore.pendingAliasRequest);
	const autoRefresh = $derived(source?.binding?.config.autoRefresh ?? true);

	function toggleAutoRefresh() {
		const binding = source?.binding;
		if (!binding) return;
		void deploymentsStore.setConfig({ ...binding.config, autoRefresh: !binding.config.autoRefresh });
	}

	// The modal's visibility is owned by the quick-panels store, which is what
	// the navigators bind to. The store is told about it rather than deciding it,
	// so an action that closes the surface closes the ONE thing on screen.
	$effect(() => {
		if (isOpen) deploymentsStore.activate();
		else deploymentsStore.deactivate();
	});

	// Detail is a column on desktop and a layer on mobile — at 360px a
	// side-by-side list and build view are both unusable.
	const showDetailLayer = $derived(isMobile && deploymentsStore.selectedId !== null);

	function handleResize() {
		windowWidth = window.innerWidth;
	}

	function onListScroll(event: Event) {
		const el = event.currentTarget as HTMLElement;
		if (el.scrollHeight - el.scrollTop - el.clientHeight > 200) return;
		void deploymentsStore.loadMore();
	}

	/**
	 * Vercel is named here rather than derived, because this is the empty state:
	 * there is no connected source to ask, and Vercel is the one provider that
	 * exists. When a second one lands this becomes a choice, not a guess.
	 */
	function connectVercel() {
		onClose();
		openIntegrationConnect('vercel');
	}
</script>

<svelte:window on:resize={handleResize} />

<Modal
	bind:isOpen
	{onClose}
	bare
	mobileFullscreen
	ariaLabelledBy="deployments-title"
	className="flex flex-col w-full max-w-[72rem] h-[88dvh] max-h-[880px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		<header class="flex items-center gap-2 px-3 py-2 bg-white dark:bg-slate-900/70 border-b border-slate-200 dark:border-slate-800 shrink-0">
			<h2 id="deployments-title" class="flex items-center gap-2 shrink-0 text-sm font-semibold text-slate-900 dark:text-slate-100 m-0">
				<Icon name="lucide:rocket" class="w-4 h-4 text-violet-500" />
				<!-- The glyph carries the identity when the row runs out of room. -->
				<span class="hidden sm:inline">Deployments</span>
			</h2>

			<!--
				Project and deploy target share one shrinkable group, so a long
				project name gives width back instead of pushing the actions off the
				right edge.
			-->
			<div class="flex items-center gap-2 flex-1 min-w-0">
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
											{entry.id === deploymentsStore.projectId
											? 'text-slate-900 dark:text-slate-100 font-medium'
											: 'text-slate-600 dark:text-slate-400'}"
										onclick={() => {
											projectMenuOpen = false;
											deploymentsStore.selectProject(entry.id);
										}}
									>
										<Icon
											name={entry.id === deploymentsStore.projectId ? 'lucide:check' : 'lucide:folder'}
											class="w-3.5 h-3.5 shrink-0 {entry.id === deploymentsStore.projectId ? 'text-violet-500' : 'text-slate-400'}"
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
						<DeployBindingBar />
					</div>
				{/if}
			</div>

			{#if canDeploy || canCreateProject}
				<!--
					ONE button. It used to be two — "Deploy" and a bare "+" — which
					made the user choose between two dialogs about deploying before
					knowing what either did.
				-->
				<button
					type="button"
					class="flex items-center gap-1.5 h-8 shrink-0 px-2 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer transition-colors duration-150 hover:border-violet-500/50 hover:text-violet-600 dark:hover:text-violet-400"
					onclick={() => {
						deployTab = canDeploy ? 'build' : 'new-project';
						deployOpen = true;
					}}
				>
					<Icon name="lucide:rocket" class="w-3.5 h-3.5" />
					{isMobile ? '' : 'Deploy'}
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

		{#if deploymentsStore.isLoadingSources && sources.length === 0}
			<div class="flex items-center justify-center flex-1">
				<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
			</div>
		{:else if sources.length === 0}
			<div class="flex flex-col items-center justify-center gap-3 flex-1 px-8 text-center">
				<Icon name="lucide:plug" class="w-9 h-9 text-slate-300 dark:text-slate-700" />
				<p class="text-sm text-slate-700 dark:text-slate-300 m-0">No deploy target is connected</p>
				<p class="text-xs text-slate-500 dark:text-slate-500 max-w-sm m-0">
					Connect an account that deploys this project, and its builds appear here — with the log of a
					failed one a click away from the chat.
				</p>
				{#if authStore.isAdmin}
					<!--
						Straight to the Connect dialog for the provider this surface
						needs, not to a list. Sending someone to Integrations and
						leaving them to find Add → Vercel is three clicks of hunting
						for something we already knew they wanted.
					-->
					<Button size="sm" onclick={connectVercel}>Connect Vercel</Button>
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
		{:else if deploymentsStore.needsBinding}
			<div class="flex flex-col items-center justify-center gap-2 flex-1 px-8 text-center">
				<Icon name="lucide:box" class="w-8 h-8 text-slate-300 dark:text-slate-700" />
				<p class="text-sm text-slate-700 dark:text-slate-300 m-0">
					Pick the project this one deploys to
				</p>
				<p class="text-xs text-slate-500 dark:text-slate-500 max-w-sm m-0">
					Nothing was detected from this project's link file or its git remotes. Pick one above and it
					is remembered from then on — or create a new one for this project.
				</p>
				{#if canCreateProject}
					<Button
						size="sm"
						onclick={() => {
							deployTab = 'new-project';
							deployOpen = true;
						}}
					>
						Create a deploy project
					</Button>
				{/if}
			</div>
		{:else}
			{#if isPaused}
				<!--
					Read-only. Clopen does not offer to pause: on Vercel it blocks the
					active production deployment — the site goes down, not just future
					builds — which is not an action to reach from an editor. But when
					someone has paused it elsewhere, this is the only thing that
					explains a list that stopped growing and a site that stopped
					answering.
				-->
				<div class="flex items-center gap-2 px-3 py-2 shrink-0 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-800 dark:text-amber-300">
					<Icon name="lucide:pause" class="w-3.5 h-3.5 shrink-0" />
					<span class="flex-1 min-w-0">
						This target is paused at {source?.providerName ?? 'the provider'}. New builds will not run
						and the production deployment is blocked until it is resumed there.
					</span>
				</div>
			{/if}

			{#if aliasRequest}
				<!--
					Rollback and promote return as soon as the provider accepts them
					and move traffic afterwards. Without this the panel would look
					unchanged while production was mid-switch.
				-->
				<div class="flex items-center gap-2 px-3 py-2 shrink-0 bg-violet-500/10 border-b border-violet-500/20 text-xs text-violet-800 dark:text-violet-300">
					<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 shrink-0 animate-spin" />
					<span>
						{aliasRequest.type === 'rollback' ? 'Rolling back' : 'Promoting'} — production traffic moves
						once the provider reassigns the domains.
					</span>
				</div>
			{/if}

			<div class="flex min-h-0 flex-1">
				<!-- List -->
				<div
					class="flex flex-col min-h-0 shrink-0 border-r border-slate-200 dark:border-slate-800
						{isMobile ? 'w-full border-r-0' : 'w-[17rem]'}"
				>
					<div class="flex items-center gap-1 px-2 py-1.5 shrink-0 border-b border-slate-200 dark:border-slate-800">
						{#each FILTERS as filter (filter.id)}
							<button
								type="button"
								class="h-7 px-2 text-xs font-medium bg-transparent border-none rounded-md cursor-pointer transition-colors duration-150
									{deploymentsStore.environment === filter.id
									? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
									: 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
								onclick={() => deploymentsStore.setEnvironment(filter.id)}
							>
								{filter.label}
							</button>
						{/each}
					</div>

					{#if source?.capabilities.branchFilter}
						<!--
							Search and the two controls share this row. They were sitting
							on the chip row above, where a fourth chip ran straight into
							them — and the row they belong on is the one they act upon.
						-->
						<div class="flex items-center gap-1 px-2 py-1.5 shrink-0 border-b border-slate-200 dark:border-slate-800">
							<Icon name="lucide:search" class="w-3.5 h-3.5 shrink-0 ml-1 text-slate-400" />
							<input
								type="search"
								class="flex-1 min-w-0 h-7 px-1.5 text-xs bg-transparent border-none text-slate-900 dark:text-slate-100 focus:outline-none placeholder:text-slate-400 dark:placeholder:text-slate-600"
								placeholder="Filter by branch…"
								value={branchInput}
								oninput={(event) => (branchInput = event.currentTarget.value)}
								onkeydown={(event) => {
									if (event.key === 'Enter') deploymentsStore.setBranch(branchInput);
									if (event.key === 'Escape') {
										branchInput = '';
										deploymentsStore.setBranch('');
									}
								}}
							/>

							{#if deploymentsStore.branch}
								<button
									type="button"
									class="flex items-center justify-center w-6 h-6 shrink-0 bg-transparent border-none rounded text-slate-400 cursor-pointer hover:text-slate-700 dark:hover:text-slate-200"
									onclick={() => {
										branchInput = '';
										deploymentsStore.setBranch('');
									}}
									aria-label="Clear the branch filter"
								>
									<Icon name="lucide:x" class="w-3 h-3" />
								</button>
							{/if}

							<!--
								Auto-refresh was in the binding config from the start with
								no switch, which made it a setting nobody could reach. It
								matters on a metered API: a long build polls for its whole
								duration.
							-->
							<button
								type="button"
								class="flex items-center justify-center w-7 h-7 shrink-0 bg-transparent border-none rounded-md cursor-pointer transition-colors duration-150
									{autoRefresh
									? 'text-violet-600 dark:text-violet-400 hover:bg-violet-500/10'
									: 'text-slate-400 dark:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800'}"
								onclick={toggleAutoRefresh}
								aria-label="Follow running builds automatically"
								title={autoRefresh
									? 'Following running builds — click to stop polling'
									: 'Not following running builds — click to poll while one runs'}
							>
								<Icon name={autoRefresh ? 'lucide:radio' : 'lucide:radio-tower'} class="w-3.5 h-3.5" />
							</button>

							<RefreshButton
								isLoading={deploymentsStore.isLoadingItems}
								onRefresh={() => deploymentsStore.refresh()}
							/>
						</div>
					{/if}

					<div class="flex flex-col min-h-0 flex-1 overflow-y-auto" onscroll={onListScroll}>
						<DeploymentList
							items={deploymentsStore.items}
							selectedId={deploymentsStore.selectedId}
							isLoading={deploymentsStore.isLoadingItems}
							hasMore={deploymentsStore.hasMore}
							isLoadingMore={deploymentsStore.isLoadingMore}
							isFilteredEmpty={deploymentsStore.isFilteredEmpty}
							isNeverDeployed={deploymentsStore.isNeverDeployed}
							{canDeploy}
							onSelect={(id) => deploymentsStore.select(id)}
							onDeploy={() => {
								deployTab = 'build';
								deployOpen = true;
							}}
							onClearFilters={() => {
								branchInput = '';
								deploymentsStore.clearFilters();
							}}
						/>
					</div>
				</div>

				<!-- Detail -->
				{#if !isMobile}
					<div class="flex flex-col min-h-0 flex-1">
						<DeploymentDetailPane />
					</div>
				{/if}
			</div>

			{#if showDetailLayer}
				<!-- On mobile the build takes the whole surface, with a way back. -->
				<div class="absolute inset-0 flex flex-col bg-slate-50 dark:bg-slate-950 z-10">
					<button
						type="button"
						class="flex items-center gap-1.5 h-9 px-3 shrink-0 bg-transparent border-none border-b border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 cursor-pointer"
						onclick={() => deploymentsStore.select(null)}
					>
						<Icon name="lucide:chevron-left" class="w-4 h-4" />
						All deployments
					</button>
					<DeploymentDetailPane />
				</div>
			{/if}

			<footer class="flex items-center gap-2 px-3 py-1.5 shrink-0 bg-white dark:bg-slate-900/70 border-t border-slate-200 dark:border-slate-800 text-[0.7rem] text-slate-500 dark:text-slate-500">
				<!--
					Whose account this is acting on, mirroring the Issues surface.
					The left side used to be empty unless something had gone wrong,
					which wasted the one place a panel can say what it is connected
					to without spending room in the header.
				-->
				{#if source}
					<span class="flex items-center gap-1.5 shrink-0">
						<ProviderMark provider={source.provider} size="w-3.5 h-3.5" fallback="lucide:rocket" />
						{source.providerName}
						{#if source.viewer}
							<span class="text-slate-400 dark:text-slate-600">· {source.viewer}</span>
						{:else}
							<span class="text-slate-400 dark:text-slate-600">· {source.label}</span>
						{/if}
					</span>
				{/if}

				{#if deploymentsStore.error}
					<span class="flex items-center gap-1.5 min-w-0 text-rose-600 dark:text-rose-400">
						<Icon name="lucide:circle-alert" class="w-3.5 h-3.5 shrink-0" />
						<span class="truncate">{deploymentsStore.error}</span>
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
	{/snippet}
</Modal>

<DeployModal bind:isOpen={deployOpen} initialTab={deployTab} onClose={() => (deployOpen = false)} />
