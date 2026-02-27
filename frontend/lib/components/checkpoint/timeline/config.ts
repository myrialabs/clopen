/**
 * Timeline visualization configuration
 * Contains all constants for spacing, sizing, layout, style, and animation
 */

// Spacing (distances between elements)
export const SPACING = {
	nodeGap: 52,            // Vertical gap between nodes in same timeline
	branchGap: 0,           // Gap between different branches from same point
	checkpointToBranch: 52, // Gap from checkpoint to first branch
	branchToCheckpoint: 52, // Gap from last branch to next checkpoint
	branchIndent: 32,       // Horizontal indent for branches
	labelGap: 12,           // Gap between node and label
	bracketGap: 10,         // Gap from label to bracket
	bracketLength: 15       // Length of bracket lines
};

// Size (element dimensions)
export const SIZE = {
	node: 6,            // Node radius
	nodeDot: 2,         // Inner dot radius
	nodeRing: 3,        // Current node ring radius
	line: 2,            // Line thickness
	labelWidth: 280,    // Label width
	labelHeight: 44     // Label height
};

// Layout (starting positions)
export const LAYOUT = {
	startX: 10,         // Starting X position
	startY: 30          // Starting Y position
};

// Style (colors & opacity)
export const STYLE = {
	lineColor: '#94a3b8',
	lineOpacity: 0.4,
	lineDash: '0'     // Dash pattern for branch lines
};

// Animation configuration
export const ANIMATION = {
	duration: 300            // ms
};
