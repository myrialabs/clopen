<script lang="ts">
	/**
	 * Which account, and which repository — inline, on the modal's one header row.
	 *
	 * It used to be a strip of its own under the title. Two stacked rows of
	 * chrome above a list is a lot of vertical space spent on something that is
	 * usually already correct: the repository was read off the git remote and
	 * never touched again. So it reads as one line, and the editor is a popover
	 * rather than a row that pushes the content down.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import MenuSurface from './MenuSurface.svelte';

	const sources = $derived(workStore.sources);
	const source = $derived(workStore.source);
	const binding = $derived(source?.binding ?? null);

	let editing = $state(false);
	let draft = $state('');

	// An unbound source has nothing to show but the editor, so it opens itself.
	$effect(() => {
		if (source && !source.binding) editing = true;
	});

	function beginEdit() {
		draft = binding?.locator ?? source?.suggestedLocators[0] ?? '';
		editing = true;
	}

	let applying = $state('');

	async function apply(locator: string) {
		if (!locator.trim() || applying) return;
		applying = locator;
		try {
			await workStore.setBinding(locator);
			editing = false;
		} finally {
			applying = '';
		}
	}

	function dismiss() {
		// A source with no binding has nowhere to dismiss to — the popover IS the
		// only way forward, so clicking away must not strand the user.
		if (binding) editing = false;
	}
</script>

<div class="flex items-center gap-2 min-w-0 w-full">
	<!--
		Which ACCOUNT, only when there is a choice to make. Naming the provider
		here as well would say the same thing twice — the footer already carries
		the brand mark and the signed-in user, and identification does not need
		two places in a header this tight.
	-->
	{#if sources.length > 1}
		<div class="flex items-center gap-0.5 shrink-0">
			{#each sources as entry (entry.accountId)}
				<button
					type="button"
					class="flex items-center h-7 px-2 text-xs font-medium rounded-md border transition-colors duration-150 cursor-pointer
						{entry.accountId === source?.accountId
						? 'bg-violet-500/10 border-violet-500/40 text-slate-900 dark:text-slate-100'
						: 'bg-transparent border-transparent text-slate-600 dark:text-slate-400 hover:bg-violet-500/10'}"
					disabled={!!applying}
					onclick={() => workStore.selectSource(entry.accountId)}
					title={entry.label}
				>
					{entry.label}
				</button>
			{/each}
		</div>
	{/if}

	<div class="relative flex items-center min-w-0 flex-1" use:clickOutside={dismiss}>
		<button
			type="button"
			class="flex items-center gap-1.5 h-7 min-w-0 px-2 text-xs font-mono bg-transparent border border-transparent rounded-md text-slate-800 dark:text-slate-200 cursor-pointer hover:bg-violet-500/10 hover:border-violet-500/30"
			onclick={beginEdit}
			title={binding ? 'Point this project at a different repository' : 'Pick a repository'}
		>
			<Icon name="lucide:book-marked" class="w-3.5 h-3.5 shrink-0 text-slate-500" />
			<span class="truncate">{binding?.displayName ?? 'Pick a repository'}</span>
			<Icon name="lucide:chevron-down" class="w-3 h-3 shrink-0 text-slate-400" />
		</button>

		{#if editing}
			<MenuSurface prefer="start" width="w-72" class="flex flex-col gap-2 p-3">
				<div class="flex items-center gap-1.5">
					<input
						type="text"
						class="flex-1 min-w-0 h-8 px-2.5 text-xs font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
						value={draft}
						oninput={(event) => (draft = event.currentTarget.value)}
						onkeydown={(event) => {
							if (event.key === 'Enter') apply(draft);
							if (event.key === 'Escape') dismiss();
						}}
						placeholder="owner/repository"
					/>
					<button
						type="button"
						class="flex items-center justify-center gap-1.5 h-8 px-3 text-xs font-semibold bg-violet-600 hover:bg-violet-700 border-none rounded-md text-white cursor-pointer transition-colors duration-150 disabled:opacity-60 disabled:cursor-not-allowed"
						disabled={!!applying || !draft.trim()}
						onclick={() => apply(draft)}
					>
						{#if applying === draft}
							<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
						{/if}
						Use
					</button>
				</div>

				{#if (source?.suggestedLocators.length ?? 0) > 0}
					<div class="flex flex-col gap-1">
						<span class="text-[0.7rem] text-slate-500 dark:text-slate-500">From your git remotes</span>
						<div class="flex items-center gap-1 flex-wrap">
							{#each source?.suggestedLocators ?? [] as locator (locator)}
								<button
									type="button"
									class="flex items-center gap-1 h-7 px-2 text-xs font-mono bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-700 dark:text-slate-300 cursor-pointer hover:border-violet-500/40 disabled:opacity-60 disabled:cursor-not-allowed"
									disabled={!!applying}
									onclick={() => apply(locator)}
								>
									{#if applying === locator}
										<Icon name="lucide:loader-circle" class="w-3 h-3 animate-spin" />
									{/if}
									{locator}
								</button>
							{/each}
						</div>
					</div>
				{/if}
			</MenuSurface>
		{/if}
	</div>

	{#if binding?.detected}
		<span class="hidden lg:inline shrink-0 text-xs text-slate-500 dark:text-slate-500">
			from your git remote
		</span>
	{/if}
</div>
