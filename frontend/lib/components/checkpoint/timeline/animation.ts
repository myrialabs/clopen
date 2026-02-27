/**
 * Timeline animation utilities
 * Handles FLIP animation technique and interpolation
 */

import { ANIMATION, SIZE } from './config';
import type { GraphNode, GraphEdge, VersionGroup, AnimationState } from './types';

/**
 * Cubic bezier easing function (ease-in-out)
 */
export function cubicBezier(t: number): number {
	// ease-in-out: cubic-bezier(0.42, 0, 0.58, 1)
	const x1 = 0.42, x2 = 0.58;

	const c = 3 * x1;
	const b = 3 * (x2 - x1) - c;
	const a = 1 - c - b;

	const t2 = t * t;
	const t3 = t2 * t;

	return a * t3 + b * t2 + c * t;
}

/**
 * Get interpolated position for a node
 */
export function getInterpolatedPosition(
	node: GraphNode,
	animationState: AnimationState
): { x: number, y: number } {
	if (!animationState.isAnimating) {
		return { x: node.x, y: node.y };
	}

	const oldPos = animationState.oldNodePositions.get(node.id);
	if (!oldPos) {
		// Node is new, just use current position
		return { x: node.x, y: node.y };
	}

	// Interpolate between old and new position
	const x = oldPos.x + (node.x - oldPos.x) * animationState.progress;
	const y = oldPos.y + (node.y - oldPos.y) * animationState.progress;

	return { x, y };
}

/**
 * Get interpolated color for a node
 */
export function getInterpolatedNodeClass(node: GraphNode): string {
	if (node.isCurrent) {
		return 'fill-green-500 stroke-green-300';
	}

	// Orphaned nodes (descendants of current active checkpoint) are always gray
	if (node.isOrphaned) {
		return 'fill-slate-300 stroke-slate-200 dark:fill-slate-600 dark:stroke-slate-500';
	}

	// All non-orphaned nodes use blue (Active Path)
	return 'fill-blue-500 stroke-blue-300';
}

/**
 * Get interpolated path for an edge
 * Recalculates path using interpolated node positions for smooth transitions
 */
export function getInterpolatedEdgePath(
	edge: GraphEdge,
	graphNodes: GraphNode[],
	animationState: AnimationState
): string {
	if (!animationState.isAnimating) {
		return edge.path;
	}

	// Find the from and to nodes
	const fromNode = graphNodes.find(n => n.id === edge.from);
	const toNode = graphNodes.find(n => n.id === edge.to);

	if (!fromNode || !toNode) {
		return edge.path;
	}

	// Get interpolated positions
	const fromPos = getInterpolatedPosition(fromNode, animationState);
	const toPos = getInterpolatedPosition(toNode, animationState);

	// Recalculate path with interpolated positions
	if (edge.type === 'straight') {
		// Straight vertical line
		return `M ${fromPos.x} ${fromPos.y + SIZE.node} L ${toPos.x} ${toPos.y - SIZE.node}`;
	} else if (edge.type === 'branch') {
		// Horizontal line from main vertical line to branch
		const startX = fromPos.x + 1;
		const endX = toPos.x - SIZE.node;
		const lineY = toPos.y;
		return `M ${startX} ${lineY} L ${endX} ${lineY}`;
	}

	return edge.path;
}

/**
 * Get interpolated bracket position for version group
 */
export function getInterpolatedBracket(
	group: VersionGroup,
	animationState: AnimationState
): { minY: number, maxY: number, height: number } {
	if (!animationState.isAnimating) {
		return {
			minY: group.minY,
			maxY: group.maxY,
			height: group.height
		};
	}

	// Find old group with same branch name
	const oldGroup = animationState.oldVersionGroups.find(g => g.branchName === group.branchName);
	if (!oldGroup) {
		// New group, just use current values
		return {
			minY: group.minY,
			maxY: group.maxY,
			height: group.height
		};
	}

	// Interpolate bracket position
	const minY = oldGroup.minY + (group.minY - oldGroup.minY) * animationState.progress;
	const maxY = oldGroup.maxY + (group.maxY - oldGroup.maxY) * animationState.progress;
	const height = oldGroup.height + (group.height - oldGroup.height) * animationState.progress;

	return { minY, maxY, height };
}

/**
 * Start animation loop
 */
export function startAnimation(
	targetNodeId: string,
	onProgressUpdate: (progress: number) => void,
	onComplete: () => void
): void {
	const startTime = performance.now();

	function animate(currentTime: number) {
		const elapsed = currentTime - startTime;
		const rawProgress = Math.min(elapsed / ANIMATION.duration, 1);

		// Apply easing
		const easedProgress = cubicBezier(rawProgress);
		onProgressUpdate(easedProgress);

		if (rawProgress < 1) {
			requestAnimationFrame(animate);
		} else {
			// Animation complete
			onComplete();
		}
	}

	requestAnimationFrame(animate);
}
