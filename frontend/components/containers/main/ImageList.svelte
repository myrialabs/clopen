<!--
	Containers — the images on this host.

	The question this answers is "what is this container actually running, and
	what is eating the disk" — so the one action here is removal, of a single
	image or, through Clean up, of everything nothing is using. Pulling and
	building stay where they belong, in a terminal.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { containersStore } from '$frontend/stores/features/containers.svelte';
	import type { ContainerImageEntry } from '$shared/types/containers';

	interface Props {
		canManage: boolean;
		onRemove: (image: ContainerImageEntry) => void;
	}

	const { canManage, onRemove }: Props = $props();

	const images = $derived(containersStore.images);
	const total = $derived(containersStore.result?.images.length ?? 0);
	const unused = $derived(images.filter((image) => image.usedBy.length === 0).length);
</script>

<div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1 p-3">
	{#if total === 0}
		<p class="m-0 px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-500">
			This host has no images.
		</p>
	{:else if images.length === 0}
		<p class="m-0 px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-500">
			No image matches that search.
		</p>
	{:else}
		<p class="m-0 px-1 pb-1 text-[11px] text-slate-400 dark:text-slate-600">
			{images.length} shown · {unused} used by nothing on this host
		</p>
	{/if}

	{#each images as image (image.key)}
		<div
			class="group flex items-center gap-3 px-3 py-2 rounded-lg border bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800"
		>
			<Icon
				name="lucide:layers"
				class="w-4 h-4 shrink-0 {image.dangling
					? 'text-slate-300 dark:text-slate-700'
					: 'text-sky-600 dark:text-sky-400'}"
			/>

			<div class="flex flex-col min-w-0 flex-1">
				<span class="flex items-center gap-1.5 min-w-0">
					<span class="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
						{image.repository}<span class="text-slate-400 dark:text-slate-600">:{image.tag}</span>
					</span>
					{#if image.dangling}
						<span
							class="shrink-0 px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
							title="An untagged layer left behind by a rebuild"
						>
							dangling
						</span>
					{/if}
				</span>
				<span class="truncate text-xs text-slate-500 dark:text-slate-500">
					{#if image.usedBy.length > 0}
						Used by {image.usedBy.slice(0, 3).join(', ')}{image.usedBy.length > 3
							? ` +${image.usedBy.length - 3}`
							: ''}
					{:else}
						Not used by any container here
					{/if}
				</span>
			</div>

			<span class="shrink-0 text-[11px] text-slate-500 dark:text-slate-500 tabular-nums">
				{image.size}
			</span>

			{#if canManage}
				<button
					type="button"
					class="shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-slate-400 cursor-pointer transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-wait"
					onclick={() => onRemove(image)}
					disabled={containersStore.actingId === image.id}
					title={image.usedBy.length > 0
						? 'In use — the runtime will refuse unless it is forced'
						: 'Remove this image'}
					aria-label="Remove image {image.repository}:{image.tag}"
				>
					<Icon
						name={containersStore.actingId === image.id ? 'lucide:loader-circle' : 'lucide:trash-2'}
						class="w-3.5 h-3.5 {containersStore.actingId === image.id ? 'animate-spin' : ''}"
					/>
				</button>
			{/if}
		</div>
	{/each}
</div>
