<script lang="ts">
	/**
	 * Which remote project this Clopen project deploys to.
	 *
	 * Says where the answer came from. A binding that was detected reads "from
	 * your linked project" rather than presenting a guess as a decision — the
	 * same honesty the Issues binding bar owes, and more necessary here: a
	 * monorepo deploying three apps from one repository will be detected wrong,
	 * and the user has to be able to see that it was detected at all.
	 *
	 * The locator itself is never shown. It is an opaque provider id, which is
	 * why the display name is cached on the binding in the first place.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MenuSurface from '$frontend/components/common/overlay/MenuSurface.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import { deploymentsStore } from '$frontend/stores/features/deployments.svelte';
	import type { DeployTarget } from '$shared/types/deployments';

	let menuOpen = $state(false);
	let filter = $state('');

	const source = $derived(deploymentsStore.source);
	const binding = $derived(source?.binding ?? null);

	// The suggestions travel with the source before anything is bound; the full
	// list is fetched only when the picker is opened, because listing every
	// project in every team is several requests.
	const candidates = $derived(
		deploymentsStore.targets.length > 0 ? deploymentsStore.targets : source?.suggestedTargets ?? []
	);

	const visible = $derived(
		candidates.filter((target) =>
			`${target.name} ${target.teamName ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())
		)
	);

	function openMenu() {
		menuOpen = !menuOpen;
		if (menuOpen && deploymentsStore.targets.length === 0) void deploymentsStore.loadTargets();
	}

	function pick(target: DeployTarget) {
		menuOpen = false;
		void deploymentsStore.setBinding(target);
	}
</script>

{#if source}
	<div class="relative min-w-0" use:clickOutside={() => (menuOpen = false)}>
		<button
			type="button"
			class="flex items-center gap-1.5 h-8 w-full max-w-[16rem] px-2 text-xs font-medium bg-transparent border border-transparent rounded-md text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10 hover:border-violet-500/30"
			onclick={openMenu}
			title={binding?.detected
				? 'Detected automatically — click to point this project somewhere else'
				: 'Which project this deploys to'}
		>
			<ProviderMark provider={source.provider} size="w-3.5 h-3.5" fallback="lucide:rocket" />
			<span class="truncate">{binding?.displayName ?? 'Pick a project'}</span>
			{#if binding?.detected}
				<Icon name="lucide:sparkles" class="w-3 h-3 shrink-0 text-violet-400" />
			{/if}
			<Icon name="lucide:chevron-down" class="w-3 h-3 shrink-0 text-slate-400" />
		</button>

		{#if menuOpen}
			<MenuSurface prefer="start" width="w-72" class="flex flex-col max-h-80">
				<div class="p-2 shrink-0 border-b border-slate-200 dark:border-slate-700">
					<input
						type="search"
						class="w-full h-8 px-2.5 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
						placeholder="Filter projects…"
						value={filter}
						oninput={(event) => (filter = event.currentTarget.value)}
					/>
				</div>

				{#if binding?.detected}
					<p class="px-3 py-2 m-0 shrink-0 text-[11px] text-slate-500 dark:text-slate-500 border-b border-slate-200 dark:border-slate-700">
						Detected from this project. Change it if it picked the wrong one.
					</p>
				{/if}

				<div class="flex flex-col min-h-0 overflow-y-auto py-1">
					{#if deploymentsStore.isLoadingTargets && visible.length === 0}
						<div class="flex items-center justify-center py-4">
							<Icon name="lucide:loader-circle" class="w-4 h-4 text-slate-400 animate-spin" />
						</div>
					{:else if visible.length === 0}
						<p class="px-3 py-3 m-0 text-xs text-slate-500 dark:text-slate-500 text-center">
							No project matches.
						</p>
					{:else}
						{#each visible as target (target.id)}
							<button
								type="button"
								class="flex items-center gap-2 w-full shrink-0 px-3 h-9 bg-transparent border-none text-left text-xs cursor-pointer hover:bg-violet-500/10
									{target.id === binding?.locator
									? 'text-slate-900 dark:text-slate-100 font-medium'
									: 'text-slate-600 dark:text-slate-400'}"
								onclick={() => pick(target)}
							>
								<Icon
									name={target.id === binding?.locator ? 'lucide:check' : 'lucide:box'}
									class="w-3.5 h-3.5 shrink-0 {target.id === binding?.locator ? 'text-violet-500' : 'text-slate-400'}"
								/>
								<span class="flex flex-col min-w-0">
									<span class="truncate">{target.name}</span>
									{#if target.teamName || target.gitRepo}
										<span class="truncate text-[10px] text-slate-400 dark:text-slate-600">
											{[target.teamName, target.gitRepo].filter(Boolean).join(' · ')}
										</span>
									{/if}
								</span>
							</button>
						{/each}
					{/if}
				</div>
			</MenuSurface>
		{/if}
	</div>
{/if}
