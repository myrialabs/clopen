<!--
	Containers — the networks on this host.

	The networks a compose project creates outlive `compose down` and accumulate
	quietly, so the useful signal is the same one the volume list carries: which
	of these is nothing attached to. The runtime's own networks are shown and
	never offered for removal — `network rm bridge` fails on every host, and an
	action that can only fail should not be on screen.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { containersStore } from '$frontend/stores/features/containers.svelte';
	import type { ContainerNetworkEntry } from '$shared/types/containers';

	interface Props {
		canManage: boolean;
		onRemove: (network: ContainerNetworkEntry) => void;
	}

	const { canManage, onRemove }: Props = $props();

	const networks = $derived(containersStore.networks);
	const total = $derived(containersStore.result?.networks.length ?? 0);
	const unused = $derived(
		networks.filter((network) => !network.predefined && network.usedBy.length === 0).length
	);
</script>

<div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1 p-3">
	{#if total === 0}
		<p class="m-0 px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-500">
			This host has no networks.
		</p>
	{:else if networks.length === 0}
		<p class="m-0 px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-500">
			No network matches that search.
		</p>
	{:else}
		<p class="m-0 px-1 pb-1 text-[11px] text-slate-400 dark:text-slate-600">
			{networks.length} shown · {unused} with nothing attached
		</p>
	{/if}

	{#each networks as network (network.key)}
		<div
			class="group flex items-center gap-3 px-3 py-2 rounded-lg border bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800"
		>
			<Icon
				name="lucide:network"
				class="w-4 h-4 shrink-0 {network.usedBy.length > 0
					? 'text-violet-600 dark:text-violet-400'
					: 'text-slate-300 dark:text-slate-700'}"
			/>

			<div class="flex flex-col min-w-0 flex-1">
				<span class="flex items-center gap-1.5 min-w-0">
					<span class="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
						{network.name}
					</span>
					{#if network.predefined}
						<span
							class="shrink-0 px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
							title="Created by the runtime itself and part of how it works"
						>
							built-in
						</span>
					{/if}
					{#if network.internal}
						<span
							class="hidden sm:inline shrink-0 px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
							title="No route out of this network"
						>
							internal
						</span>
					{/if}
				</span>
				<span class="truncate text-xs text-slate-500 dark:text-slate-500">
					{#if network.usedBy.length > 0}
						{network.usedBy.slice(0, 3).join(', ')}{network.usedBy.length > 3
							? ` +${network.usedBy.length - 3}`
							: ''}
					{:else}
						Nothing is attached to this network
					{/if}
				</span>
			</div>

			<span class="hidden md:block shrink-0 text-[11px] text-slate-400 dark:text-slate-600">
				{network.driver}
			</span>

			{#if canManage && !network.predefined}
				<button
					type="button"
					class="shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-slate-400 cursor-pointer transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-wait"
					onclick={() => onRemove(network)}
					disabled={containersStore.actingId === network.id}
					title="Remove this network"
					aria-label="Remove network {network.name}"
				>
					<Icon
						name={containersStore.actingId === network.id ? 'lucide:loader-circle' : 'lucide:trash-2'}
						class="w-3.5 h-3.5 {containersStore.actingId === network.id ? 'animate-spin' : ''}"
					/>
				</button>
			{/if}
		</div>
	{/each}
</div>
