<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';

	interface PreviewItem {
		id: string;
		name: string;
		previewUrl: string;
		size: number;
	}

	interface Props {
		items: PreviewItem[];
		onRemove: (id: string) => void;
	}

	const { items, onRemove }: Props = $props();
</script>

{#if items.length > 0}
	<div class="flex flex-wrap gap-2 p-2 bg-slate-50 dark:bg-slate-800/30 rounded-lg border border-slate-200 dark:border-slate-800">
		{#each items as item (item.id)}
			<div class="relative group">
				<img src={item.previewUrl} alt={item.name} class="w-20 h-20 object-cover rounded-lg border border-slate-200 dark:border-slate-800" />
				<div class="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] px-1 py-0.5 truncate rounded-b">
					{item.name}
				</div>
				<button
					type="button"
					onclick={() => onRemove(item.id)}
					class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-slate-900 text-white flex items-center justify-center hover:bg-red-600 transition-colors"
					aria-label="Remove image"
				>
					<Icon name="lucide:x" class="w-3 h-3" />
				</button>
			</div>
		{/each}
	</div>
{/if}
