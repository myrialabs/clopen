<script lang="ts">
	import { SIZE, SPACING } from './config';
	import { getInterpolatedPosition } from './animation';
	import type { VersionGroup, AnimationState } from './types';

	const {
		group,
		animationState
	}: {
		group: VersionGroup;
		animationState: AnimationState;
	} = $props();

	// Calculate bracket positions based on first and last node
	const firstNodePos = $derived(getInterpolatedPosition(group.nodes[0], animationState));
	const lastNodePos = $derived(getInterpolatedPosition(group.nodes[group.nodes.length - 1], animationState));

	// Bracket positioning calculations
	const bracketX = $derived(firstNodePos.x + SIZE.node + SIZE.labelWidth + SPACING.bracketGap);
	const quarterHeight = $derived(SIZE.labelHeight / 4);
	const topY = $derived(firstNodePos.y - quarterHeight);
	const bottomY = $derived(lastNodePos.y + quarterHeight);
	const bracketEndX = $derived(bracketX + SPACING.bracketLength);
</script>

<g class="version-group-bracket">
	<!-- Top horizontal line -->
	<line
		x1={bracketX}
		y1={topY}
		x2={bracketEndX}
		y2={topY}
		stroke="#a78bfa"
		stroke-width="1.5"
		opacity="0.6"
	/>

	<!-- Vertical line -->
	<line
		x1={bracketEndX}
		y1={topY}
		x2={bracketEndX}
		y2={bottomY}
		stroke="#a78bfa"
		stroke-width="4"
		opacity="0.6"
	/>

	<!-- Bottom horizontal line -->
	<line
		x1={bracketX}
		y1={bottomY}
		x2={bracketEndX}
		y2={bottomY}
		stroke="#a78bfa"
		stroke-width="1.5"
		opacity="0.6"
	/>
</g>
