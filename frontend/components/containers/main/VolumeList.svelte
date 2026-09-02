<!--
	Containers — the volumes on this host.

	The useful signal here is which volumes nothing is using: a machine that has
	been developing for a while accumulates hundreds of anonymous ones holding
	tens of gigabytes, and the list says so plainly rather than pretending they
	are all meaningful. Removing one, or all of the unused ones through Clean up,
	is the point of saying it.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { containersStore, isAnonymousVolume } from '$frontend/stores/features/containers.svelte';
	import type { ContainerVolumeEntry } from '$shared/types/containers';

	interface Props {
		canManage: boolean;
		onRemove: (volume: ContainerVolumeEntry) => void;
	}

	const { canManage, onRemove }: Props = $props();

	const volumes = $derived(containersStore.volumes);
	const total = $derived(containersStore.result?.volumes.length ?? 0);
	const unused = $derived(volumes.filter((volume) => volume.usedBy.length === 0).length);
</script>

<div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1 p-3">
	{#if total === 0}
		<p class="m-0 px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-500">
			This host has no volumes.
		</p>
	{:else if volumes.length === 0}
		<p class="m-0 px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-500">
			No volume matches that search.
		</p>
	{:else}
		<p class="m-0 px-1 pb-1 text-[11px] text-slate-400 dark:text-slate-600">
			{volumes.length} shown · {unused} used by nothing on this host
		</p>
	{/if}

	{#each volumes as volume (volume.key)}
		{@const anonymous = isAnonymousVolume(volume)}
		<div
			class="group flex items-center gap-3 px-3 py-2 rounded-lg border bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800"
		>
			<Icon
				name="lucide:hard-drive"
				class="w-4 h-4 shrink-0 {volume.usedBy.length > 0
					? 'text-emerald-600 dark:text-emerald-400'
					: 'text-slate-300 dark:text-slate-700'}"
			/>

			<div class="flex flex-col min-w-0 flex-1">
				<span class="flex items-center gap-1.5 min-w-0">
					<span
						class="truncate text-sm font-medium text-slate-800 dark:text-slate-200 {anonymous
							? 'font-mono text-xs'
							: ''}"
						title={volume.name}
					>
						{anonymous ? `${volume.name.slice(0, 12)}…` : volume.name}
					</span>
					{#if anonymous}
						<span
							class="shrink-0 px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
							title="Created by the runtime rather than named by anyone"
						>
							anonymous
						</span>
					{/if}
				</span>
				<span class="truncate text-xs text-slate-500 dark:text-slate-500">
					{#if volume.usedBy.length > 0}
						Used by {volume.usedBy.slice(0, 3).join(', ')}{volume.usedBy.length > 3
							? ` +${volume.usedBy.length - 3}`
							: ''}
					{:else}
						Not used by any container here
					{/if}
				</span>
			</div>

			<span class="hidden lg:block shrink-0 max-w-64 truncate font-mono text-[11px] text-slate-400 dark:text-slate-600">
				{volume.mountpoint ?? volume.driver}
			</span>

			{#if canManage}
				<button
					type="button"
					class="shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-slate-400 cursor-pointer transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-wait"
					onclick={() => onRemove(volume)}
					disabled={containersStore.actingId === volume.name}
					title={volume.usedBy.length > 0
						? 'In use — the runtime will refuse while a container has it mounted'
						: 'Remove this volume'}
					aria-label="Remove volume {volume.name}"
				>
					<Icon
						name={containersStore.actingId === volume.name
							? 'lucide:loader-circle'
							: 'lucide:trash-2'}
						class="w-3.5 h-3.5 {containersStore.actingId === volume.name ? 'animate-spin' : ''}"
					/>
				</button>
			{/if}
		</div>
	{/each}
</div>
