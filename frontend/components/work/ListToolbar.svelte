<script lang="ts">
	/**
	 * Search, and everything the list can be narrowed by.
	 *
	 * Only the two controls people reach for constantly — text and open/closed —
	 * sit on the toolbar. Author, labels and dates live behind one button with a
	 * count on it, because a narrow column cannot hold six controls and a
	 * permanently-expanded filter panel would cost more rows than the list it is
	 * filtering.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import RefreshButton from '$frontend/components/common/display/RefreshButton.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import MenuSurface from '$frontend/components/common/overlay/MenuSurface.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';
	import type { WorkItemState } from '$shared/types/work';
	import type { Snippet } from 'svelte';

	interface Props {
		/** Controls before the state picker — the hosting view puts its PR/issue switch here. */
		leading?: Snippet;
		/** Controls after refresh — new item, settings. */
		trailing?: Snippet;
	}

	const { leading, trailing }: Props = $props();

	const filters = $derived(workStore.filters);
	const activeCount = $derived(workStore.activeFilterCount);

	let panelOpen = $state(false);
	let labelFilter = $state('');

	const STATES: { id: WorkItemState; label: string }[] = [
		{ id: 'open', label: 'Open' },
		{ id: 'closed', label: 'Closed' },
		{ id: 'all', label: 'All' }
	];

	const visibleLabels = $derived(
		workStore.labels.filter((label) =>
			label.toLowerCase().includes(labelFilter.trim().toLowerCase()))
	);

	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	function onSearchInput(value: string) {
		workStore.search = value;
		if (searchTimer) clearTimeout(searchTimer);
		// Debounced because each keystroke would otherwise be a provider request.
		// Out-of-order answers are handled in the store's generation counter, not
		// here — a debounce alone does not prevent them.
		searchTimer = setTimeout(() => void workStore.loadItems(), 250);
	}

	async function openPanel() {
		panelOpen = !panelOpen;
		if (panelOpen) await workStore.loadLabels();
	}

	function toggleLabel(label: string) {
		const next = filters.labels.includes(label)
			? filters.labels.filter((entry) => entry !== label)
			: [...filters.labels, label];
		void workStore.setFilters({ labels: next });
	}
</script>

<!-- A container: the controls compact by the column's width, not the window's. -->
<div class="@container flex flex-col gap-1.5 px-2 py-1.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
	<div class="flex items-center gap-1 min-w-0">
		{@render leading?.()}
		<!-- A select, not three buttons: the column is narrow, and which slice
			you are looking at is one choice, not three controls. -->
		<select
			class="h-7 min-w-0 shrink pl-1.5 pr-5 text-xs bg-transparent border border-slate-200 dark:border-slate-700 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer focus:outline-none focus:border-violet-500"
			value={filters.state}
			onchange={(event) => workStore.setFilters({ state: event.currentTarget.value as WorkItemState })}
			aria-label="Which items"
		>
			{#each STATES as entry (entry.id)}
				<option value={entry.id}>{entry.label}</option>
			{/each}
		</select>

		<span class="flex-1"></span>

		<div class="relative" use:clickOutside={() => (panelOpen = false)}>
			<button
				type="button"
				class="flex items-center justify-center gap-1 h-7 min-w-7 px-1 text-xs rounded-md border transition-colors duration-150 cursor-pointer
					{activeCount > 0
					? 'bg-violet-500/10 border-violet-500/40 text-slate-900 dark:text-slate-100'
					: 'bg-transparent border-transparent text-slate-500 dark:text-slate-400 hover:bg-violet-500/10'}"
				onclick={openPanel}
				title="More filters"
			>
				<Icon name="lucide:list-filter" class="w-3.5 h-3.5" />
				{#if activeCount > 0}{activeCount}{/if}
			</button>

			{#if panelOpen}
				<!--
					`start`: the panel opens rightwards from the button's left edge.
					It sits at the right of a 19rem column with the whole detail
					pane beside it, so there is always room that way and never any
					to the left. MenuSurface still flips if a window proves that
					wrong.
				-->
				<MenuSurface prefer="start" width="w-72" class="flex flex-col gap-3 p-3">
					<label class="flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							class="w-4 h-4 accent-violet-600 cursor-pointer"
							checked={filters.mineOnly}
							onchange={(event) => workStore.setFilters({ mineOnly: event.currentTarget.checked })}
						/>
						<!-- The provider's own wording. "Mine" is not a term GitHub uses. -->
						<span class="text-xs text-slate-700 dark:text-slate-300">Assigned to me</span>
					</label>

					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Author</span>
						<input
							type="text"
							class="w-full h-8 px-2.5 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
							placeholder="username"
							value={filters.author}
							onchange={(event) => workStore.setFilters({ author: event.currentTarget.value })}
						/>
					</label>

					<div class="flex flex-col gap-1">
						<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Labels</span>
						{#if workStore.labels.length === 0}
							<span class="text-xs text-slate-500 dark:text-slate-500">
								This repository defines no labels.
							</span>
						{:else}
							<input
								type="search"
								class="w-full h-8 px-2.5 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
								placeholder="Filter labels…"
								value={labelFilter}
								oninput={(event) => (labelFilter = event.currentTarget.value)}
							/>
							<div class="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
								{#each visibleLabels as label (label)}
									<button
										type="button"
										class="h-6 px-1.5 text-[0.7rem] rounded border transition-colors duration-150 cursor-pointer
											{filters.labels.includes(label)
											? 'bg-violet-500/10 border-violet-500/40 text-slate-900 dark:text-slate-100'
											: 'bg-slate-100 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-violet-500/40'}"
										onclick={() => toggleLabel(label)}
									>
										{label}
									</button>
								{/each}
							</div>
						{/if}
					</div>

					<div class="flex items-end gap-2">
						<label class="flex flex-col gap-1 flex-1 min-w-0">
							<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Updated from</span>
							<input
								type="date"
								class="w-full h-8 px-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
								value={filters.since}
								onchange={(event) => workStore.setFilters({ since: event.currentTarget.value })}
							/>
						</label>
						<label class="flex flex-col gap-1 flex-1 min-w-0">
							<span class="text-xs font-medium text-slate-700 dark:text-slate-300">to</span>
							<input
								type="date"
								class="w-full h-8 px-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
								value={filters.until}
								onchange={(event) => workStore.setFilters({ until: event.currentTarget.value })}
							/>
						</label>
					</div>

					<button
						type="button"
						class="h-8 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10 disabled:opacity-50"
						disabled={activeCount === 0 && !workStore.search}
						onclick={() => workStore.clearFilters()}
					>
						Clear all
					</button>
				</MenuSurface>
			{/if}
		</div>

		<RefreshButton
			isLoading={workStore.isLoadingItems}
			onRefresh={() => workStore.loadItems()}
			label={workStore.rateLimit
				? `Refresh · ${workStore.rateLimit.remaining} of ${workStore.rateLimit.limit} API requests left`
				: 'Refresh the list'}
		/>
		{@render trailing?.()}
	</div>

	<input
		type="search"
		class="w-full h-7 px-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
		placeholder="Search…"
		value={workStore.search}
		oninput={(event) => onSearchInput(event.currentTarget.value)}
	/>
</div>
