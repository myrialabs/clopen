<script lang="ts">
	import type { SplitNode, PanelId } from '$frontend/lib/stores/ui/workspace.svelte';

	interface Props {
		layout: SplitNode;
		size?: 'small' | 'medium';
	}

	const { layout, size = 'small' }: Props = $props();

	const height = size === 'small' ? 'h-8' : 'h-12';

	// Panel colors - softer colors that blend with theme
	const panelColors: Record<PanelId, string> = {
		chat: 'bg-violet-200/60 dark:bg-violet-700/40',
		files: 'bg-blue-200/60 dark:bg-blue-700/40',
		preview: 'bg-emerald-200/60 dark:bg-emerald-700/40',
		terminal: 'bg-amber-200/60 dark:bg-amber-700/40',
		git: 'bg-orange-200/60 dark:bg-orange-700/40'
	};

	// Panel labels (optional, for larger previews)
	const panelLabels: Record<PanelId, string> = {
		chat: 'C',
		files: 'F',
		preview: 'P',
		terminal: 'T',
		git: 'G'
	};

	function renderNode(node: SplitNode, depth: number = 0): any {
		if (node.type === 'panel') {
			const color = node.panelId ? panelColors[node.panelId] : 'bg-slate-300 dark:bg-slate-700';
			const label = node.panelId ? panelLabels[node.panelId] : '';

			return {
				type: 'panel',
				color,
				label,
				isEmpty: !node.panelId
			};
		}

		return {
			type: 'split',
			direction: node.direction,
			ratio: node.ratio,
			children: [renderNode(node.children[0], depth + 1), renderNode(node.children[1], depth + 1)]
		};
	}

	const previewData = $derived(renderNode(layout));
</script>

{#snippet renderPreview(data: any, isRoot = false)}
	{#if data.type === 'panel'}
		<div
			class="rounded {data.color} {isRoot ? height : 'h-full'} transition-colors duration-150 {data.isEmpty ? 'opacity-30' : ''}"
		></div>
	{:else}
		<div
			class="flex gap-0.5 {isRoot ? height : 'h-full'} {data.direction === 'horizontal' ? 'flex-col' : 'flex-row'}"
		>
			<div style="flex: {data.ratio}">
				{@render renderPreview(data.children[0])}
			</div>
			<div style="flex: {100 - data.ratio}">
				{@render renderPreview(data.children[1])}
			</div>
		</div>
	{/if}
{/snippet}

<div class="w-full">
	{@render renderPreview(previewData, true)}
</div>
