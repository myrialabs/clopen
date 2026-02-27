/**
 * Timeline data structures and type definitions
 */

export interface CheckpointNode {
	id: string;
	messageId: string;
	parentId: string | null; // parent checkpoint ID in the tree
	activeChildId: string | null; // which child continues straight
	timestamp: string;
	messageText: string;
	isOnActivePath: boolean;
	isOrphaned: boolean;
	isCurrent: boolean;
	hasSnapshot: boolean;
	senderName?: string | null;
	// File change statistics (git-like)
	filesChanged?: number;
	insertions?: number;
	deletions?: number;
}

export interface TimelineResponse {
	nodes: CheckpointNode[];
	currentHeadId: string | null;
}

// Graph visualization interfaces
export interface GraphNode {
	id: string;
	checkpoint: CheckpointNode;
	x: number;
	y: number;
	type: 'main' | 'branch';
	isCurrent: boolean;
	isOrphaned: boolean;
}

export interface GraphEdge {
	from: string;
	to: string;
	type: 'straight' | 'branch';
	path: string;
}

export interface VersionGroup {
	branchName: string;
	versionNumber: number;
	nodes: GraphNode[];
	x: number;
	minY: number;
	maxY: number;
	width: number;
	height: number;
}

// Animation state
export interface AnimationState {
	isAnimating: boolean;
	restoringNodeId: string | null;
	progress: number;
	oldNodePositions: Map<string, {x: number, y: number}>;
	oldNodeStyles: Map<string, {type: string}>;
	oldVersionGroups: VersionGroup[];
}
