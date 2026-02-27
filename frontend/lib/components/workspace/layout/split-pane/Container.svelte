<script lang="ts">
	import type { SplitDirection, SplitNode } from '$frontend/lib/stores/ui/workspace.svelte';
	import Layout from './Layout.svelte';
	import Handle from './Handle.svelte';

	interface Props {
		direction: SplitDirection;
		ratio: number;
		path: number[];
		child1: SplitNode;
		child2: SplitNode;
	}

	const { direction, ratio, path, child1, child2 }: Props = $props();

	// Calculate sizes for flex basis
	const child1Size = $derived(`${ratio}%`);
	const child2Size = $derived(`${100 - ratio}%`);

	// Calculate sizes for container
	const size = 'calc(100% - (var(--spacing) * 3))';
	const width = $derived(direction === 'horizontal' ? '100%' : size);
	const height = $derived(direction === 'horizontal' ? size : '100%');

	// Flex direction based on split direction
	const flexDirection = $derived(direction === 'horizontal' ? 'flex-col' : 'flex-row');
</script>

<div class="split-pane-container flex {flexDirection} gap-0" style="width: {width}; height: {height};">
	<!-- Child 1 -->
	<div class="split-pane-child overflow-hidden min-w-0" style="flex: 0 0 {child1Size};">
		<Layout node={child1} path={[...path, 0]} />
	</div>

	<!-- Resize Handle -->
	<Handle {direction} {path} currentRatio={ratio} />

	<!-- Child 2 -->
	<div class="split-pane-child overflow-hidden min-w-0" style="flex: 0 0 {child2Size};">
		<Layout node={child2} path={[...path, 1]} />
	</div>
</div>
