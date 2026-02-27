<script lang="ts">
	import { SIZE, STYLE } from './config';
	import type { GraphEdge, GraphNode, AnimationState } from './types';
	import { getInterpolatedEdgePath } from './animation';

	const {
		edge,
		graphNodes,
		animationState
	}: {
		edge: GraphEdge;
		graphNodes: GraphNode[];
		animationState: AnimationState;
	} = $props();

	const interpolatedPath = $derived(getInterpolatedEdgePath(edge, graphNodes, animationState));
</script>

<path
	d={interpolatedPath}
	fill="none"
	stroke={STYLE.lineColor}
	stroke-width={SIZE.line}
	stroke-dasharray={edge.type === 'branch' ? STYLE.lineDash : '0'}
	opacity={STYLE.lineOpacity}
/>
