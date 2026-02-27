<script lang="ts">
	import type { SplitNode } from '$frontend/lib/stores/ui/workspace.svelte';
	import PanelContainer from '../../PanelContainer.svelte';
	import Container from './Container.svelte';

	interface Props {
		node: SplitNode;
		path?: number[]; // Path in tree for resize updates
	}

	const { node, path = [] }: Props = $props();
</script>

{#if node.type === 'panel'}
	<!-- Panel Leaf: Render panel wrapper -->
	{#if node.panelId}
		<div class="split-pane-panel h-full w-full overflow-hidden">
			<PanelContainer panelId={node.panelId} />
		</div>
	{:else}
		<!-- Empty slot -->
		<div
			class="split-pane-empty flex items-center justify-center h-full w-full bg-slate-100 dark:bg-slate-900/50 border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-lg"
		>
			<span class="text-sm text-slate-400 dark:text-slate-500">Empty Panel</span>
		</div>
	{/if}
{:else if node.type === 'split'}
	<!-- Split Container: Render split with two children -->
	<Container
		direction={node.direction}
		ratio={node.ratio}
		path={path}
		child1={node.children[0]}
		child2={node.children[1]}
	/>
{/if}
