<script lang="ts">
	/**
	 * Pick several from a list — assignees, labels, reviewers.
	 *
	 * The candidates are fetched lazily, on first open: each list is a separate
	 * request against a rate limit shared with everything else here, and most
	 * items are read far more often than they are edited.
	 *
	 * Saving replaces the whole set rather than sending adds and removes. The
	 * picker's meaning is "this is the list now", and a diff would race anyone
	 * editing the same item from the web.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import MenuSurface from '$frontend/components/common/overlay/MenuSurface.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		selected: string[];
		candidates: string[];
		icon: IconName;
		/** Button text when nothing is selected — "Assign", "Labels". */
		placeholder: string;
		/** Plural noun for the count — "assignees", "labels". */
		noun: string;
		filterPlaceholder: string;
		emptyLabel: string;
		load: () => Promise<void>;
		onChange: (next: string[]) => Promise<void>;
	}

	const { selected, candidates, icon, placeholder, noun, filterPlaceholder, emptyLabel, load, onChange }: Props = $props();

	let open = $state(false);
	let filter = $state('');
	let saving = $state(false);

	const visible = $derived(
		candidates.filter((entry) => entry.toLowerCase().includes(filter.trim().toLowerCase()))
	);

	async function toggleOpen() {
		open = !open;
		if (open) await load();
	}

	async function toggle(entry: string) {
		if (saving) return;
		saving = true;
		try {
			await onChange(selected.includes(entry) ? selected.filter((item) => item !== entry) : [...selected, entry]);
		} finally {
			saving = false;
		}
	}
</script>

<div class="relative" use:clickOutside={() => (open = false)}>
	<button
		type="button"
		class="flex items-center gap-1.5 h-7 px-2 max-w-48 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer transition-colors duration-150 hover:border-violet-500/50 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-60 disabled:cursor-not-allowed"
		disabled={saving}
		onclick={toggleOpen}
		title={selected.length > 0 ? selected.join(', ') : placeholder}
	>
		<Icon name={saving ? 'lucide:loader-circle' : icon} class="w-3.5 h-3.5 shrink-0 {saving ? 'animate-spin' : ''}" />
		<span class="truncate">
			{#if selected.length === 0}
				{placeholder}
			{:else}
				{selected.length === 1 ? selected[0] : `${selected.length} ${noun}`}
			{/if}
		</span>
	</button>

	{#if open}
		<MenuSurface prefer="start" width="w-64" class="flex flex-col max-h-72">
			<div class="p-2 shrink-0 border-b border-slate-200 dark:border-slate-700">
				<input
					type="search"
					class="w-full h-8 px-2.5 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
					placeholder={filterPlaceholder}
					value={filter}
					oninput={(event) => (filter = event.currentTarget.value)}
				/>
			</div>

			<div class="flex flex-col min-h-0 overflow-y-auto py-1">
				{#if candidates.length === 0}
					<p class="px-3 py-3 m-0 text-xs text-slate-500 dark:text-slate-500 text-center">{emptyLabel}</p>
				{:else}
					{#each visible as entry (entry)}
						<button
							type="button"
							class="flex items-center gap-2 w-full shrink-0 px-3 h-8 bg-transparent border-none text-left text-xs text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10 disabled:opacity-60"
							disabled={saving}
							onclick={() => toggle(entry)}
						>
							<Icon
								name={selected.includes(entry) ? 'lucide:square-check' : 'lucide:square'}
								class="w-3.5 h-3.5 shrink-0 {selected.includes(entry) ? 'text-violet-500' : 'text-slate-400'}"
							/>
							<span class="truncate">{entry}</span>
						</button>
					{/each}
				{/if}
			</div>
		</MenuSurface>
	{/if}
</div>
