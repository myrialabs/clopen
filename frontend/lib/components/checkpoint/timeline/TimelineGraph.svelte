<script lang="ts">
	import { getSortedNodes } from './utils';
	import TimelineNode from './TimelineNode.svelte';
	import TimelineEdge from './TimelineEdge.svelte';
	import TimelineVersionGroup from './TimelineVersionGroup.svelte';
	import type { GraphNode, GraphEdge, VersionGroup, AnimationState } from './types';

	const {
		graphNodes,
		graphEdges,
		versionGroups,
		svgWidth,
		svgHeight,
		animationState,
		isDisabled,
		readonly,
		onNodeClick
	}: {
		graphNodes: GraphNode[];
		graphEdges: GraphEdge[];
		versionGroups: VersionGroup[];
		svgWidth: number;
		svgHeight: number;
		animationState: AnimationState;
		isDisabled: boolean;
		readonly: boolean;
		onNodeClick: (node: GraphNode) => void;
	} = $props();

	const sortedNodes = $derived(getSortedNodes(graphNodes, animationState.isAnimating, animationState.restoringNodeId));
</script>

<div>
	<svg
		width={svgWidth}
		height={svgHeight}
	>
		<!-- Define gradients and filters -->
		<defs>
			<linearGradient id="mainLineGradient" x1="0%" y1="0%" x2="0%" y2="100%">
				<stop offset="0%" style="stop-color:#94a3b8" />
				<stop offset="100%" style="stop-color:#94a3b8" />
			</linearGradient>
			<linearGradient id="branchLineGradient" x1="0%" y1="0%" x2="100%" y2="0%">
				<stop offset="0%" style="stop-color:#a78bfa" />
				<stop offset="100%" style="stop-color:#a78bfa" />
			</linearGradient>
			<filter id="nodeShadow">
				<feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity="0.1"/>
			</filter>
		</defs>

		<!-- Draw version group brackets (right side) -->
		<!-- <g id="version-groups">
			{#each versionGroups as group (`group-${group.branchName}`)}
				<TimelineVersionGroup
					{group}
					{animationState}
				/>
			{/each}
		</g> -->

		<!-- Draw edges (lines) -->
		<g id="edges">
			{#each graphEdges as edge (`edge-${edge.from}-${edge.to}`)}
				<TimelineEdge
					{edge}
					{graphNodes}
					{animationState}
				/>
			{/each}
		</g>

		<!-- Draw nodes on top -->
		<g id="nodes">
			{#each sortedNodes as node (node.id)}
				<TimelineNode
					{node}
					{animationState}
					{isDisabled}
					{readonly}
					{onNodeClick}
				/>
			{/each}
		</g>
	</svg>
</div>