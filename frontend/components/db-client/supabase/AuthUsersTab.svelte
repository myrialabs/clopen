<script lang="ts">
	/**
	 * Auth users, read from `auth.users`.
	 *
	 * Read-only. The admin API that could ban, delete or reset a user needs the
	 * service-role key, and this tab is not worth storing one for — the question
	 * it answers is "did that sign-up actually land", which SQL answers with the
	 * credential the connection already has.
	 *
	 * Paged server-side. A project with fifty thousand users is ordinary, and a
	 * client-side filter over all of them is not.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import InlineError from '$frontend/components/common/display/InlineError.svelte';
	import { dbAccountsStore } from '$frontend/stores/features/db-client-accounts.svelte';
	import { shortRelativeTime } from '$frontend/utils/relative-time';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	const PAGE_SIZE = 50;

	let search = $state('');
	let offset = $state(0);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	const cell = $derived(dbAccountsStore.authUsersFor(connectionId));
	const page = $derived(cell.data);
	const users = $derived(page?.users ?? []);

	$effect(() => {
		dbAccountsStore.ensureAuthUsers(connectionId);
	});

	function load(nextOffset: number): void {
		offset = nextOffset;
		dbAccountsStore.authUsers(connectionId, {
			search: search.trim() || undefined,
			limit: PAGE_SIZE,
			offset: nextOffset
		});
	}

	// Debounced, and always back to the first page: a filter applied while on
	// page four would otherwise show an empty result that looks like "no matches".
	function onSearch(value: string): void {
		search = value;
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => load(0), 250);
	}

	const hasPrev = $derived(offset > 0);
	const hasNext = $derived(page !== null && offset + users.length < page.total);
</script>

<div class="flex flex-col gap-3 p-3">
	<div class="flex items-center gap-2">
		<div class="flex-1 flex items-center gap-2 px-2.5 py-1 bg-slate-100/80 dark:bg-slate-800/60 rounded-md min-w-0">
			<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
			<input
				type="text"
				value={search}
				oninput={(e) => onSearch(e.currentTarget.value)}
				placeholder="Search email or phone…"
				class="py-1 flex-1 bg-transparent border-none outline-none text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 min-w-0"
			/>
		</div>
		{#if page}
			<span class="text-xs text-slate-500 dark:text-slate-400 shrink-0">
				{page.total} {page.total === 1 ? 'user' : 'users'}
			</span>
		{/if}
	</div>

	{#if cell.loading && users.length === 0}
		<div class="flex flex-col gap-1.5">
			{#each [0, 1, 2, 3, 4] as row (row)}
				<div class="h-10 rounded-lg bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
			{/each}
		</div>
	{:else if cell.error}
		<InlineError message={cell.error} />
	{:else if users.length === 0}
		<div class="flex flex-col items-center gap-2 py-10 text-center">
			<Icon name="lucide:users" class="w-8 h-8 text-slate-300 dark:text-slate-600" />
			<p class="text-sm text-slate-500 dark:text-slate-400">
				{search.trim() ? 'No users match that search.' : 'No users have signed up yet.'}
			</p>
		</div>
	{:else}
		<div class="flex flex-col gap-1">
			{#each users as user (user.id)}
				<div class="flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 min-w-0">
					<Icon name="lucide:user" class="w-4 h-4 text-slate-400 shrink-0" />
					<div class="flex flex-col min-w-0 flex-1">
						<span class="text-sm text-slate-800 dark:text-slate-200 truncate">
							{user.email ?? user.phone ?? user.id}
						</span>
						<span class="text-xs text-slate-500 dark:text-slate-400 truncate">
							{#if user.providers.length > 0}{user.providers.join(', ')} · {/if}
							{#if user.createdAt}joined {shortRelativeTime(user.createdAt)}{/if}
							{#if user.lastSignInAt}· last seen {shortRelativeTime(user.lastSignInAt)}{/if}
						</span>
					</div>
					{#if user.isBanned}
						<span class="text-3xs px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider shrink-0 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
							Banned
						</span>
					{:else if !user.confirmedAt}
						<span class="text-3xs px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider shrink-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
							Unconfirmed
						</span>
					{/if}
				</div>
			{/each}
		</div>

		{#if hasPrev || hasNext}
			<div class="flex items-center justify-between gap-2">
				<button
					type="button"
					class="px-2.5 h-7 rounded-md text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
					disabled={!hasPrev || cell.loading}
					onclick={() => load(Math.max(0, offset - PAGE_SIZE))}
				>
					Previous
				</button>
				<span class="text-xs text-slate-400">
					{offset + 1}–{offset + users.length}
				</span>
				<button
					type="button"
					class="px-2.5 h-7 rounded-md text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
					disabled={!hasNext || cell.loading}
					onclick={() => load(offset + PAGE_SIZE)}
				>
					Next
				</button>
			</div>
		{/if}
	{/if}
</div>
