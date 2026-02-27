/**
 * Timeline Graph Builder (Rewritten)
 *
 * Builds visual tree from checkpoint nodes with parent-child relationships.
 * Uses activeChildId to determine which child continues straight (main line)
 * and which children become branches (indented).
 */

import { SPACING, SIZE, LAYOUT } from './config';
import type { TimelineResponse, GraphNode, GraphEdge, VersionGroup, CheckpointNode } from './types';
import { debug } from '$shared/utils/logger';

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	versionGroups: VersionGroup[];
	svgWidth: number;
	svgHeight: number;
}

interface TreeNode {
	checkpoint: CheckpointNode;
	children: TreeNode[];
	activeChild: TreeNode | null; // the child that continues straight
	branchChildren: TreeNode[]; // children that are branches (indented)
}

/**
 * Build a tree structure from flat checkpoint nodes
 */
function buildTree(nodes: CheckpointNode[]): TreeNode[] {
	const nodeMap = new Map<string, TreeNode>();

	// Create TreeNode for each checkpoint
	for (const cp of nodes) {
		nodeMap.set(cp.id, {
			checkpoint: cp,
			children: [],
			activeChild: null,
			branchChildren: []
		});
	}

	// Build parent-child relationships
	const roots: TreeNode[] = [];
	for (const cp of nodes) {
		const treeNode = nodeMap.get(cp.id)!;

		if (cp.parentId && nodeMap.has(cp.parentId)) {
			const parent = nodeMap.get(cp.parentId)!;
			parent.children.push(treeNode);
		} else {
			roots.push(treeNode);
		}
	}

	// Determine active child vs branch children for each node
	for (const cp of nodes) {
		const treeNode = nodeMap.get(cp.id)!;
		if (treeNode.children.length === 0) continue;

		if (treeNode.children.length === 1) {
			// Only one child - it's the active/straight continuation
			treeNode.activeChild = treeNode.children[0];
			treeNode.branchChildren = [];
		} else {
			// Multiple children - use activeChildId to determine which goes straight
			const activeChildNode = cp.activeChildId
				? treeNode.children.find(c => c.checkpoint.id === cp.activeChildId)
				: null;

			if (activeChildNode) {
				treeNode.activeChild = activeChildNode;
				treeNode.branchChildren = treeNode.children.filter(c => c !== activeChildNode);
			} else {
				// No activeChildId set or not found.
				// Use the child on the active path, or fallback to the first child
				const activePathChild = treeNode.children.find(c => c.checkpoint.isOnActivePath);
				if (activePathChild) {
					treeNode.activeChild = activePathChild;
					treeNode.branchChildren = treeNode.children.filter(c => c !== activePathChild);
				} else {
					// Fallback: first child by timestamp goes straight
					const sorted = [...treeNode.children].sort(
						(a, b) => a.checkpoint.timestamp.localeCompare(b.checkpoint.timestamp)
					);
					treeNode.activeChild = sorted[sorted.length - 1]; // last created goes straight
					treeNode.branchChildren = sorted.slice(0, sorted.length - 1);
				}
			}

			// Sort branch children: reverse creation order (newest first)
			treeNode.branchChildren.sort(
				(a, b) => b.checkpoint.timestamp.localeCompare(a.checkpoint.timestamp)
			);
		}
	}

	return roots;
}

/**
 * Calculate the total height of a subtree (for spacing)
 */
function calculateSubtreeHeight(node: TreeNode, depth: number): number {
	let height = SPACING.nodeGap;

	// Add height for branch children
	for (const branch of node.branchChildren) {
		height += calculateBranchHeight(branch, depth + 1);
		height += SPACING.branchGap;
	}

	// Add height for active child's subtree
	if (node.activeChild) {
		height += calculateSubtreeHeight(node.activeChild, depth);
	}

	return height;
}

/**
 * Calculate the height of a branch (including its own subtree)
 */
function calculateBranchHeight(node: TreeNode, depth: number): number {
	let height = SPACING.nodeGap; // This node itself

	// Add height for this branch's sub-branches
	for (const branch of node.branchChildren) {
		height += calculateBranchHeight(branch, depth + 1);
		height += SPACING.branchGap;
	}

	// Add height for active child continuation
	if (node.activeChild) {
		height += calculateBranchHeight(node.activeChild, depth);
	}

	return height;
}

/**
 * Build graph visualization from timeline data
 */
export function buildGraph(timelineData: TimelineResponse | null): GraphData {
	if (!timelineData || timelineData.nodes.length === 0) {
		return {
			nodes: [],
			edges: [],
			versionGroups: [],
			svgWidth: 800,
			svgHeight: 100
		};
	}

	debug.log('snapshot', `Graph builder: ${timelineData.nodes.length} nodes`);

	// Build tree structure
	const roots = buildTree(timelineData.nodes);

	if (roots.length === 0) {
		return { nodes: [], edges: [], versionGroups: [], svgWidth: 800, svgHeight: 100 };
	}

	const graphNodes: GraphNode[] = [];
	const graphEdges: GraphEdge[] = [];

	/**
	 * Recursively layout the tree.
	 * Returns the Y position after this subtree.
	 */
	function layoutNode(
		treeNode: TreeNode,
		x: number,
		startY: number,
		parentId: string | null,
		isMainLine: boolean,
		isBranchEdge: boolean
	): number {
		const nodeY = startY;

		// Create graph node
		const graphNode: GraphNode = {
			id: treeNode.checkpoint.id,
			checkpoint: treeNode.checkpoint,
			x,
			y: nodeY,
			type: isMainLine ? 'main' : 'branch',
			isCurrent: treeNode.checkpoint.isCurrent,
			isOrphaned: treeNode.checkpoint.isOrphaned
		};
		graphNodes.push(graphNode);

		// Create edge from parent
		if (parentId) {
			graphEdges.push({
				from: parentId,
				to: treeNode.checkpoint.id,
				type: isBranchEdge ? 'branch' : 'straight',
				path: '' // Will be calculated later
			});
		}

		let currentY = nodeY;

		// Layout branch children first (they go between this node and the active child)
		for (let i = 0; i < treeNode.branchChildren.length; i++) {
			const branch = treeNode.branchChildren[i];
			const branchX = x + SPACING.branchIndent;
			const branchStartY = currentY + SPACING.checkpointToBranch;

			const branchEndY = layoutNode(
				branch,
				branchX,
				branchStartY,
				treeNode.checkpoint.id,
				false, // not main line
				true  // is a branch edge
			);

			currentY = branchEndY;

			// Add gap after branch
			if (i < treeNode.branchChildren.length - 1) {
				currentY += SPACING.branchGap;
			}
		}

		// Layout active child (straight continuation)
		if (treeNode.activeChild) {
			// If we had branches, add transition spacing
			if (treeNode.branchChildren.length > 0) {
				currentY += SPACING.branchToCheckpoint;
			} else {
				currentY += SPACING.nodeGap;
			}

			currentY = layoutNode(
				treeNode.activeChild,
				x, // same X (straight continuation)
				currentY,
				treeNode.checkpoint.id,
				isMainLine, // inherit main line status
				false // straight edge
			);
		}

		return currentY;
	}

	// Layout from root
	let currentY = LAYOUT.startY;
	for (let i = 0; i < roots.length; i++) {
		currentY = layoutNode(
			roots[i],
			LAYOUT.startX,
			currentY,
			null,
			true, // root is main line
			false
		);

		if (i < roots.length - 1) {
			currentY += SPACING.nodeGap;
		}
	}

	// Calculate SVG paths for edges
	for (const edge of graphEdges) {
		const fromNode = graphNodes.find(n => n.id === edge.from);
		const toNode = graphNodes.find(n => n.id === edge.to);

		if (fromNode && toNode) {
			if (edge.type === 'straight') {
				// Vertical line
				edge.path = `M ${fromNode.x} ${fromNode.y + SIZE.node} L ${toNode.x} ${toNode.y - SIZE.node}`;
			} else if (edge.type === 'branch') {
				// Horizontal line from main line to branch node
				const startX = fromNode.x + 1;
				const endX = toNode.x - SIZE.node;
				const lineY = toNode.y;
				edge.path = `M ${startX} ${lineY} L ${endX} ${lineY}`;
			}
		}
	}

	// Calculate SVG dimensions
	const maxX = graphNodes.length > 0
		? Math.max(...graphNodes.map(n => n.x)) + SIZE.labelWidth + 30
		: 800;
	const maxY = graphNodes.length > 0
		? Math.max(...graphNodes.map(n => n.y)) + 50
		: 100;

	debug.log('snapshot', `Graph: ${graphNodes.length} nodes, ${graphEdges.length} edges, ${maxX}x${maxY}`);

	return {
		nodes: graphNodes,
		edges: graphEdges,
		versionGroups: [], // No longer using version groups
		svgWidth: maxX,
		svgHeight: maxY
	};
}
