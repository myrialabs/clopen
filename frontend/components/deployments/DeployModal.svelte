<script lang="ts">
	/**
	 * One dialog for getting something deployed.
	 *
	 * It used to be two, reachable from two header buttons — "Deploy" and a bare
	 * "+" — and both were about deploying, so the user had to choose before
	 * knowing what either did. They are two steps of one job: build what is
	 * already set up, or set it up first. So they are tabs, and the header has
	 * one button.
	 *
	 * The tab strip only appears when there is a choice. On a provider that
	 * cannot create projects there is nothing to switch between, and a strip
	 * with one tab is chrome that explains nothing.
	 */
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import DeployPanel from './DeployPanel.svelte';
	import NewProjectPanel from './NewProjectPanel.svelte';
	import { deploymentsStore } from '$frontend/stores/features/deployments.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		/** Which tab to land on. The empty states point straight at one. */
		initialTab?: Tab;
	}

	type Tab = 'build' | 'new-project';

	let { isOpen = $bindable(), onClose, initialTab = 'build' }: Props = $props();

	let tab = $state<Tab>('build');

	const source = $derived(deploymentsStore.source);
	const canBuild = $derived(source?.capabilities.createDeployment === true && source.binding !== null);
	const canCreate = $derived(source?.capabilities.createProject === true);

	const TABS: { id: Tab; label: string; icon: IconName }[] = [
		{ id: 'build', label: 'Deploy', icon: 'lucide:rocket' },
		{ id: 'new-project', label: 'New project', icon: 'lucide:plus' }
	];

	const visibleTabs = $derived(
		TABS.filter((entry) => (entry.id === 'build' ? canBuild : canCreate))
	);

	$effect(() => {
		if (!isOpen) return;
		// Land on the asked-for tab when it is available, and on whatever is
		// left when it is not — a project with nothing bound cannot "Deploy".
		tab = visibleTabs.some((entry) => entry.id === initialTab)
			? initialTab
			: (visibleTabs[0]?.id ?? 'build');
	});
</script>

<Modal bind:isOpen {onClose} title="Deploy" size="md">
	{#snippet children()}
		<div class="flex flex-col gap-4">
			{#if visibleTabs.length > 1}
				<div class="flex items-center gap-1 p-0.5 bg-slate-100 dark:bg-slate-800/60 rounded-lg">
					{#each visibleTabs as entry (entry.id)}
						<button
							type="button"
							class="flex items-center justify-center gap-1.5 flex-1 h-8 px-3 text-xs font-medium border-none rounded-md cursor-pointer transition-colors duration-150
								{tab === entry.id
								? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
								: 'bg-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}"
							onclick={() => (tab = entry.id)}
						>
							<Icon name={entry.icon} class="w-3.5 h-3.5" />
							{entry.label}
						</button>
					{/each}
				</div>
			{/if}

			{#if tab === 'build'}
				<DeployPanel isActive={isOpen && tab === 'build'} {onClose} />
			{:else}
				<NewProjectPanel isActive={isOpen && tab === 'new-project'} {onClose} />
			{/if}
		</div>
	{/snippet}
</Modal>
