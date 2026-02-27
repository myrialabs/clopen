<script lang="ts">
	import { SIZE, SPACING } from './config';
	import { formatTime } from './utils';
	import type { GraphNode, AnimationState } from './types';
	import { getInterpolatedPosition, getInterpolatedNodeClass } from './animation';
	import Icon from '$frontend/lib/components/common/Icon.svelte';

	const {
		node,
		animationState,
		isDisabled,
		readonly,
		onNodeClick
	}: {
		node: GraphNode;
		animationState: AnimationState;
		isDisabled: boolean;
		readonly: boolean;
		onNodeClick: (node: GraphNode) => void;
	} = $props();

	const pos = $derived(getInterpolatedPosition(node, animationState));
	const nodeClass = $derived(getInterpolatedNodeClass(node));
</script>

<!-- Node group -->
<g
	class="cursor-pointer group {isDisabled ? 'opacity-40' : ''} {readonly || isDisabled || animationState.isAnimating ? '!pointer-events-none' : 'pointer-events-auto'}"
	onclick={() => onNodeClick(node)}
	onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onNodeClick(node); }}
	role="button"
	tabindex="0"
	aria-label={`${node.type === 'main' ? 'Checkpoint' : 'Version'} - ${node.checkpoint.messageText}`}
>
	<title>{node.checkpoint.messageText}</title>
	<!-- Node circle -->
	<circle
		cx={pos.x}
		cy={pos.y}
		r={SIZE.node}
		class={nodeClass}
		stroke-width="1.5"
		opacity={node.isOrphaned ? '0.6' : '1'}
		filter="url(#nodeShadow)"
	/>

	<!-- Current indicator ring -->
	{#if node.isCurrent}
		<circle
			cx={pos.x}
			cy={pos.y}
			r={SIZE.node + SIZE.nodeRing}
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			class="text-green-400 animate-pulse"
		/>
	{/if}

	<!-- Node inner dot -->
	<circle
		cx={pos.x}
		cy={pos.y}
		r={SIZE.nodeDot}
		class="fill-white pointer-events-none"
	/>

	<!-- Label container -->
	<rect
		x={pos.x + SIZE.node + SPACING.labelGap}
		y={pos.y - (SIZE.labelHeight / 2)}
		width={SIZE.labelWidth - 15}
		height={SIZE.labelHeight}
		rx="6"
		class="fill-white dark:fill-slate-800 stroke-slate-200 dark:stroke-slate-700 group-hover:fill-slate-50 dark:group-hover:fill-slate-700 group-hover:stroke-slate-300 dark:group-hover:stroke-slate-600 transition-colors"
		stroke-width="1"
	/>

	<!-- Text content using foreignObject for CSS truncation -->
	<foreignObject
		x={pos.x + SIZE.node + 20}
		y={pos.y - SIZE.labelHeight / 2 + 4}
		width={SIZE.labelWidth - 35}
		height={SIZE.labelHeight - 8}
	>
		<div class="flex flex-col h-full justify-center pointer-events-none">
			<!-- Timestamp and file stats in one line -->
			<div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 leading-tight">
				<span>{formatTime(node.checkpoint.timestamp)}</span>
				<span class="w-px h-3 bg-slate-300 dark:bg-slate-600"></span>
				<span class="flex items-center gap-0.5">
					<Icon name="lucide:file-text" class="w-2.5 h-2.5" />
					{node.checkpoint.filesChanged ?? 0}
				</span>
				<span class="text-green-600 dark:text-green-400">
					+{node.checkpoint.insertions ?? 0}
				</span>
				<span class="text-red-600 dark:text-red-400">
					-{node.checkpoint.deletions ?? 0}
				</span>
			</div>
			<!-- Message text below timestamp with auto truncation -->
			<div class="text-sm text-slate-900 dark:text-slate-100 leading-tight truncate mt-0.5">
				{node.checkpoint.messageText}
			</div>
		</div>
	</foreignObject>
</g>
