<script lang="ts">
	/**
	 * Agents — the AI agents Clopen drives (Claude Code, OpenCode, Codex…). Each
	 * card goes Install → Sign in → Ready in place; "All tools" lists every
	 * installable tool, Git and Chrome included.
	 */
	import AIEnginesSettings from '../engines/AIEnginesSettings.svelte';
	import StackSettings from '../stack/StackSettings.svelte';
	import { settingsModalState, type AgentsTab } from '$frontend/stores/ui/settings-modal.svelte';

	const tabs: Array<{ id: AgentsTab; label: string }> = [
		{ id: 'accounts', label: 'Agents' },
		{ id: 'install', label: 'All tools' }
	];
</script>

<div class="space-y-5">
	<div>
		<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Agents</h3>
		<p class="text-sm text-slate-600 dark:text-slate-500">OpenCode is free. Others: install, then sign in.</p>
	</div>
	<div class="flex gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 w-fit" role="tablist">
		{#each tabs as tab (tab.id)}
			<button
				type="button"
				role="tab"
				aria-selected={settingsModalState.agentsTab === tab.id}
				class="px-3.5 py-1.5 rounded-md text-sm font-medium border-none cursor-pointer {settingsModalState.agentsTab === tab.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'bg-transparent text-slate-500'}"
				onclick={() => (settingsModalState.agentsTab = tab.id)}
			>{tab.label}</button>
		{/each}
	</div>
	{#if settingsModalState.agentsTab === 'accounts'}
		<AIEnginesSettings showHeader={false} />
	{:else}
		<StackSettings showHeader={false} />
	{/if}
</div>
