<script lang="ts">
	/**
	 * Who this item is assigned to.
	 *
	 * The candidate list is fetched lazily, on first open: it is a separate
	 * request against a rate limit shared with everything else here, and most
	 * sessions never touch assignment at all.
	 *
	 * Saving replaces the whole set rather than sending adds and removes. The
	 * picker's meaning is "this is the list now", and a diff would race anyone
	 * editing the same item from the web.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import MenuSurface from '$frontend/components/common/overlay/MenuSurface.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';

	interface Props {
		assigned: string[];
	}

	const { assigned }: Props = $props();

	let open = $state(false);
	let filter = $state('');
	let saving = $state(false);
	/** Who is being added or removed, so the row shows it rather than the menu. */
	let pending = $state('');

	const candidates = $derived(workStore.assignees);
	const visible = $derived(
		candidates.filter((login) => login.toLowerCase().includes(filter.trim().toLowerCase()))
	);

	async function toggleOpen() {
		open = !open;
		if (open) await workStore.loadAssignees();
	}

	async function toggle(login: string) {
		if (saving) return;
		saving = true;
		pending = login;
		try {
			const next = assigned.includes(login)
				? assigned.filter((entry) => entry !== login)
				: [...assigned, login];
			await workStore.setAssignees(next);
		} finally {
			saving = false;
			pending = '';
		}
	}
</script>

<div class="relative" use:clickOutside={() => (open = false)}>
	<button
		type="button"
		class="flex items-center gap-1.5 h-8 px-2 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer transition-colors duration-150 hover:border-violet-500/50 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-60 disabled:cursor-not-allowed"
		disabled={saving}
		onclick={toggleOpen}
		title="Assignees"
	>
		{#if saving}
			<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
		{:else}
			<Icon name="lucide:user-plus" class="w-3.5 h-3.5" />
		{/if}
		{#if assigned.length === 0}
			Assign
		{:else}
			{assigned.length === 1 ? assigned[0] : `${assigned.length} assignees`}
		{/if}
	</button>

	{#if open}
		<MenuSurface prefer="start" width="w-64" class="flex flex-col max-h-72">
			<div class="p-2 shrink-0 border-b border-slate-200 dark:border-slate-700">
				<input
					type="search"
					class="w-full h-8 px-2.5 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
					placeholder="Filter people…"
					value={filter}
					oninput={(event) => (filter = event.currentTarget.value)}
				/>
			</div>

			<div class="flex flex-col min-h-0 overflow-y-auto py-1">
				{#if candidates.length === 0}
					<p class="px-3 py-3 m-0 text-xs text-slate-500 dark:text-slate-500 text-center">
						Nobody assignable here — the token may not have write access to this repository.
					</p>
				{:else}
					{#each visible as login (login)}
						<button
							type="button"
							class="flex items-center gap-2 w-full shrink-0 px-3 h-8 bg-transparent border-none text-left text-xs text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-violet-500/10 disabled:opacity-60"
							disabled={saving}
							onclick={() => toggle(login)}
						>
							<Icon
								name={assigned.includes(login) ? 'lucide:check' : 'lucide:user'}
								class="w-3.5 h-3.5 shrink-0 {assigned.includes(login) ? 'text-violet-500' : 'text-slate-400'}"
							/>
							{login}
						</button>
					{/each}
				{/if}
			</div>
		</MenuSurface>
	{/if}
</div>
