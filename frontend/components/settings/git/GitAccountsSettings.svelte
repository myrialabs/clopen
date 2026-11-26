<script lang="ts">
	/**
	 * Settings → Git Accounts.
	 *
	 * One page for "who am I to git", in two tabs rather than one long scroll:
	 *   Services   — GitHub, GitLab, Gitea, Bitbucket sign-ins. They publish,
	 *                push over HTTPS and bring issues and pull requests in.
	 *   Identities — the name and email commits carry, and an SSH key or token
	 *                for servers no service account covers.
	 * They used to be two Settings sections whose names said the same thing.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import GitServicesTab from './GitServicesTab.svelte';
	import GitIdentitiesSettings from './GitIdentitiesSettings.svelte';
	import { settingsModalState } from '$frontend/stores/ui/settings-modal.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	type Tab = 'services' | 'identities';

	let tab = $state<Tab>('services');

	// A deep link (the identity picker's "Manage…") can ask for the second tab.
	$effect(() => {
		const wanted = settingsModalState.gitAccountsTab;
		if (!wanted) return;
		tab = wanted;
		settingsModalState.gitAccountsTab = null;
	});

	const TABS: { id: Tab; label: string; icon: IconName }[] = [
		{ id: 'services', label: 'Services', icon: 'lucide:cloud' },
		{ id: 'identities', label: 'Commit identities', icon: 'lucide:user-round-pen' }
	];
</script>

<div class="space-y-4">
	<div>
		<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 m-0">Git Accounts</h3>
	</div>

	<div class="flex gap-1 border-b border-slate-200 dark:border-slate-800" role="tablist">
		{#each TABS as entry (entry.id)}
			<button
				type="button"
				role="tab"
				aria-selected={tab === entry.id}
				class="relative flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-transparent border-none cursor-pointer transition-colors
					{tab === entry.id ? 'text-violet-600 dark:text-violet-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}"
				onclick={() => (tab = entry.id)}
			>
				<Icon name={entry.icon} class="w-4 h-4" />
				{entry.label}
				{#if tab === entry.id}
					<span class="absolute bottom-0 inset-x-0 h-0.5 rounded-full bg-violet-600 dark:bg-violet-400"></span>
				{/if}
			</button>
		{/each}
	</div>

	{#if tab === 'services'}
		<GitServicesTab />
	{:else}
		<GitIdentitiesSettings showHeader={false} />
	{/if}
</div>
