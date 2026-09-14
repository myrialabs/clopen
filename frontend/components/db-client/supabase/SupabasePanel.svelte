<script lang="ts">
	/**
	 * The Supabase surface, as ONE entry in DB Client's view strip.
	 *
	 * Six tabs live in here rather than six entries out there. The strip already
	 * shares its row with the open-table tabs, and adding five more top-level
	 * buttons breaks it at dock width — the same reason the Issues modal ended up
	 * with one header row instead of two.
	 *
	 * Each tab knows whether it needs an account, because a `supabase start`
	 * stack has no Management API. Rather than hiding those tabs — which reads as
	 * "Clopen cannot do this" — they render and say what is missing.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import RefreshButton from '$frontend/components/common/display/RefreshButton.svelte';
	import MigrationsTab from './MigrationsTab.svelte';
	import PoliciesTab from './PoliciesTab.svelte';
	import FunctionsTab from './FunctionsTab.svelte';
	import BucketsTab from './BucketsTab.svelte';
	import AuthUsersTab from './AuthUsersTab.svelte';
	import TypesDialog from './TypesDialog.svelte';
	import { dbAccountsStore } from '$frontend/stores/features/db-client-accounts.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	type TabId = 'migrations' | 'policies' | 'functions' | 'buckets' | 'users';

	// Every tab renders with or without an account. The ones that need the
	// Management API say so inside themselves rather than being hidden here —
	// a missing tab reads as "Clopen cannot do this", which is the wrong lesson.
	const TABS: { id: TabId; label: string; icon: IconName }[] = [
		{ id: 'migrations', label: 'Migrations', icon: 'lucide:layers' },
		{ id: 'policies', label: 'Policies', icon: 'lucide:shield' },
		{ id: 'functions', label: 'Functions', icon: 'lucide:zap' },
		{ id: 'buckets', label: 'Storage', icon: 'lucide:folder' },
		{ id: 'users', label: 'Auth users', icon: 'lucide:users' }
	];

	let active = $state<TabId>('migrations');
	let typesOpen = $state(false);
	let refreshing = $state(false);

	const context = $derived(dbAccountsStore.contextFor(connectionId));

	async function refresh(): Promise<void> {
		refreshing = true;
		try {
			// Only the visible tab. Refreshing all five would spend four provider
			// round-trips to update something nobody is looking at.
			if (active === 'migrations') await dbAccountsStore.migrations(connectionId);
			else if (active === 'policies') await dbAccountsStore.rls(connectionId);
			else if (active === 'functions') await dbAccountsStore.functions(connectionId);
			else if (active === 'buckets') await dbAccountsStore.buckets(connectionId);
			else await dbAccountsStore.authUsers(connectionId);
		} finally {
			refreshing = false;
		}
	}
</script>

<div class="flex flex-col h-full min-h-0">
	<!-- Header: which project, and the one action that is not a tab -->
	<div class="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0 min-w-0">
		<ProviderMark provider="supabase" size="w-4 h-4" fallback="lucide:database" />
		<div class="flex items-baseline gap-2 min-w-0">
			<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
				{context?.projectName ?? context?.ref ?? 'Supabase'}
			</span>
			<span class="text-3xs uppercase tracking-wider text-slate-400 shrink-0">
				{context?.isLocal ? 'local stack' : context?.ref ?? ''}
			</span>
		</div>

		<div class="flex items-center gap-1 ml-auto shrink-0">
			<RefreshButton isLoading={refreshing} onRefresh={refresh} label="Refresh" />
			<button
				type="button"
				class="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
				onclick={() => (typesOpen = true)}
				disabled={!context?.hasAccount}
				title={context?.hasAccount
					? 'Generate TypeScript types from this schema'
					: 'Type generation needs a connected Supabase account'}
			>
				<Icon name="lucide:file-code" class="w-3.5 h-3.5" />
				<span class="hidden sm:inline">Generate types</span>
			</button>
		</div>
	</div>

	<!-- Sub-tabs -->
	<div class="flex items-center gap-1 px-2 py-1.5 border-b border-slate-200 dark:border-slate-800 shrink-0 overflow-x-auto no-scrollbar">
		{#each TABS as tab (tab.id)}
			<button
				type="button"
				class="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs font-semibold transition-colors cursor-pointer shrink-0
					{active === tab.id
						? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
						: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:text-slate-100 dark:hover:bg-slate-800'}"
				onclick={() => (active = tab.id)}
			>
				<Icon name={tab.icon} class="w-3.5 h-3.5" />
				<span>{tab.label}</span>
			</button>
		{/each}
	</div>

	<div class="flex-1 min-h-0 overflow-y-auto">
		{#if active === 'migrations'}
			<MigrationsTab {connectionId} />
		{:else if active === 'policies'}
			<PoliciesTab {connectionId} />
		{:else if active === 'functions'}
			<FunctionsTab {connectionId} />
		{:else if active === 'buckets'}
			<BucketsTab {connectionId} />
		{:else}
			<AuthUsersTab {connectionId} />
		{/if}
	</div>
</div>

<TypesDialog bind:isOpen={typesOpen} {connectionId} onClose={() => (typesOpen = false)} />
