<!--
	Containers — the whole view, for whichever host it is pointed at.

	This is the feature. The Containers panel renders it for `local` and the SSH
	Client renders it for a saved host, and neither knows anything the other does
	not: same store, same lists, same detail pane, same logs and same shell. That
	is what keeps the two surfaces from drifting into two features.

	The pane has three faces — the lists, one container's logs, one container's
	shell — because a terminal squeezed into a 320px detail panel is unusable and
	a log squeezed in beside it is worse. Logs and the shell take the whole pane
	and hand it back.

	Every removal on this screen goes through a dialog that says what cannot be
	undone. The runtime refuses to remove anything in use and that refusal is
	shown as it came, so the destructive paths fail safe by default rather than
	by our own bookkeeping.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ContainerTable from './main/ContainerTable.svelte';
	import ImageList from './main/ImageList.svelte';
	import VolumeList from './main/VolumeList.svelte';
	import NetworkList from './main/NetworkList.svelte';
	import ContainerLogsPane from './main/ContainerLogsPane.svelte';
	import ContainerShellPane from './main/ContainerShellPane.svelte';
	import ContainerDetailLayer from './ContainerDetailLayer.svelte';
	import ContainerActionDialog from './ContainerActionDialog.svelte';
	import ResourceRemoveDialog, { type PendingRemoval } from './ResourceRemoveDialog.svelte';
	import CleanupDialog from './CleanupDialog.svelte';
	import { containersStore, type ContainerTab } from '$frontend/stores/features/containers.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import type { ContainerAction, ContainerEntry } from '$shared/types/containers';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		hostId: string;
	}

	const { hostId }: Props = $props();

	let pending = $state<{ entry: ContainerEntry; action: ContainerAction } | null>(null);
	let pendingRemoval = $state<PendingRemoval | null>(null);
	let cleanupOpen = $state(false);

	const result = $derived(containersStore.result);
	const selected = $derived(containersStore.selected);
	const view = $derived(containersStore.view);
	const shellContainer = $derived(containersStore.shellContainer);
	/** Reading is open to every member; starting, stopping and shells are not. */
	const canManage = $derived(authStore.isAdmin);

	const TABS: Array<{ id: ContainerTab; label: string; icon: IconName }> = [
		{ id: 'containers', label: 'Containers', icon: 'lucide:container' },
		{ id: 'images', label: 'Images', icon: 'lucide:layers' },
		{ id: 'volumes', label: 'Volumes', icon: 'lucide:hard-drive' },
		{ id: 'networks', label: 'Networks', icon: 'lucide:network' }
	];

	const counts = $derived({
		containers: result?.entries.length ?? 0,
		images: result?.images.length ?? 0,
		volumes: result?.volumes.length ?? 0,
		networks: result?.networks.length ?? 0
	});

	$effect(() => {
		const id = hostId;
		// `untrack` because starting a watch writes the store state it also reads
		// — tracked, that is an effect that invalidates itself, and each re-run
		// costs another round of watch/unwatch on the host.
		untrack(() => void containersStore.watch(id));
		// Leaving the panel must stop the polling behind it, not just hide it.
		return () => {
			void containersStore.unwatch(id);
			void containersStore.stopLogs();
		};
	});

	/**
	 * Anything that takes something away asks first. Starting, pausing and
	 * resuming do not: each is reversible by the button next to it.
	 */
	function requestAction(entry: ContainerEntry, action: ContainerAction): void {
		if (action === 'start' || action === 'pause' || action === 'unpause') {
			void containersStore.act(entry, action);
			return;
		}
		pending = { entry, action };
	}
</script>

<div class="flex flex-col flex-1 min-h-0">
	{#if view === 'logs'}
		<ContainerLogsPane onBack={() => containersStore.closeView()} />
	{:else if view === 'shell' && shellContainer}
		<ContainerShellPane
			{hostId}
			entry={shellContainer}
			onBack={() => containersStore.showList()}
			onClose={() => containersStore.closeShell()}
		/>
	{:else}
		<div
			class="flex items-center gap-2 px-2.5 sm:px-3 py-2 shrink-0 border-b border-slate-200 dark:border-slate-800"
		>
			<div
				class="flex items-center gap-0.5 shrink-0 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800"
			>
				{#each TABS as tab (tab.id)}
					<button
						type="button"
						title={tab.label}
						class="flex items-center gap-1.5 px-2 h-7 rounded-md text-xs font-semibold transition-colors cursor-pointer
							{containersStore.tab === tab.id
							? 'bg-white dark:bg-slate-800 text-violet-700 dark:text-violet-300'
							: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
						onclick={() => (containersStore.tab = tab.id)}
					>
						<Icon name={tab.icon} class="w-3.5 h-3.5" />
						<span class="hidden md:inline">{tab.label}</span>
						{#if counts[tab.id] > 0}
							<span class="text-[10px] text-slate-400 dark:text-slate-600">{counts[tab.id]}</span>
						{/if}
					</button>
				{/each}
			</div>

			<div
				class="flex items-center gap-2 flex-1 min-w-0 px-2.5 h-8 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
			>
				<Icon name="lucide:search" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
				<input
					type="text"
					class="flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400"
					placeholder="Search name, image, port…"
					bind:value={containersStore.search}
				/>
			</div>

			{#if canManage}
				<!-- Sits beside the search rather than in a row's menu: cleaning up is
				     a question about the host, not about any one thing on it. -->
				<button
					type="button"
					class="flex items-center gap-1.5 shrink-0 px-2 h-8 rounded-lg bg-transparent border-none text-slate-500 dark:text-slate-400 text-xs cursor-pointer hover:bg-violet-500/10 hover:text-violet-700 dark:hover:text-violet-300"
					onclick={() => (cleanupOpen = true)}
					title="Reclaim disk from what nothing is using"
				>
					<Icon name="lucide:brush-cleaning" class="w-3.5 h-3.5" />
					<span class="hidden lg:inline">Clean up</span>
				</button>
			{/if}

			{#if containersStore.shellId && view === 'list'}
				<!-- A shell left running is easy to forget about; this is the way back
				     to it, and it disappears with the session. -->
				<button
					type="button"
					class="hidden sm:flex items-center gap-1.5 shrink-0 px-2 h-8 rounded-lg bg-transparent border-none text-violet-600 dark:text-violet-400 text-xs cursor-pointer hover:bg-violet-500/10"
					onclick={() => containersStore.reopenShell()}
				>
					<Icon name="lucide:terminal" class="w-3.5 h-3.5" />
					Shell
				</button>
			{/if}
		</div>

		{#if containersStore.isLoading && !result}
			<div class="flex-1 flex items-center justify-center">
				<Icon name="lucide:loader-circle" class="w-5 h-5 animate-spin text-slate-400" />
			</div>
		{:else}
			<div class="flex flex-1 min-h-0 relative">
				{#if containersStore.tab === 'containers'}
					<ContainerTable {canManage} onToggle={(entry) =>
						requestAction(entry, entry.state === 'running' || entry.state === 'paused' ? 'stop' : 'start')} />
				{:else if containersStore.tab === 'images'}
					<ImageList
						{canManage}
						onRemove={(image) =>
							(pendingRemoval = {
								kind: 'image',
								id: image.id,
								label: `${image.repository}:${image.tag}`,
								usedBy: image.usedBy
							})}
					/>
				{:else if containersStore.tab === 'volumes'}
					<VolumeList
						{canManage}
						onRemove={(volume) =>
							(pendingRemoval = {
								kind: 'volume',
								id: volume.name,
								label: volume.name,
								usedBy: volume.usedBy
							})}
					/>
				{:else}
					<NetworkList
						{canManage}
						onRemove={(network) =>
							(pendingRemoval = {
								kind: 'network',
								id: network.name,
								label: network.name,
								usedBy: network.usedBy
							})}
					/>
				{/if}

				{#if selected && containersStore.tab === 'containers'}
					<ContainerDetailLayer
						entry={selected}
						{canManage}
						onClose={() => containersStore.select(null)}
						onAction={requestAction}
					/>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<ContainerActionDialog bind:pending />
<ResourceRemoveDialog bind:pending={pendingRemoval} />
<CleanupDialog bind:isOpen={cleanupOpen} onClose={() => (cleanupOpen = false)} />
