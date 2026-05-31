/**
 * Workspace Layout Store
 * Split pane-based workspace layout with visual preset editor
 */

import { debug } from '$shared/utils/logger';
import type { IconName } from '$shared/types/ui/icons';
import { registerDock, requestWorkspaceSave } from '$frontend/stores/ui/project-workspace.svelte';

// ============================================
// TYPE DEFINITIONS
// ============================================

export type PanelId = 'chat' | 'files' | 'terminal' | 'preview' | 'git';

export interface PanelConfig {
	id: PanelId;
	title: string;
	icon: string;
	visible: boolean;
	minimized: boolean;
	order: number;
}

// ============================================
// SPLIT PANE TYPE DEFINITIONS
// ============================================

export type SplitDirection = 'horizontal' | 'vertical';

// Container node (has 2 children)
export interface SplitContainer {
	type: 'split';
	direction: SplitDirection;
	ratio: number; // 0-100, size percentage of first child
	children: [SplitNode, SplitNode];
}

// Leaf node (single panel)
export interface PanelLeaf {
	type: 'panel';
	panelId: PanelId | null; // null = empty slot
}

export type SplitNode = SplitContainer | PanelLeaf;

// Root workspace layout
export type WorkspaceLayout = SplitNode;

export interface LayoutPreset {
	id: string;
	name: string;
	description: string;
	icon: string;
	layout: WorkspaceLayout;
	isCustom: boolean;
}

interface WorkspaceState {
	panels: Record<PanelId, PanelConfig>;
	layout: WorkspaceLayout;
	activePresetId?: string; // Track which preset is currently active
	navigatorCollapsed: boolean;
	navigatorWidth: number;
	activeMobilePanel: PanelId;
}

// ============================================
// SPLIT PANE UTILITY FUNCTIONS
// ============================================

/**
 * Create a simple 2-way split
 */
function createSplit(
	direction: SplitDirection,
	ratio: number,
	child1: SplitNode,
	child2: SplitNode
): SplitContainer {
	return {
		type: 'split',
		direction,
		ratio,
		children: [child1, child2]
	};
}

/**
 * Create a panel leaf node
 */
function createPanel(panelId: PanelId | null): PanelLeaf {
	return {
		type: 'panel',
		panelId
	};
}

/**
 * Get all visible panel IDs from a split tree
 */
export function getVisiblePanels(node: SplitNode): PanelId[] {
	if (node.type === 'panel') {
		return node.panelId ? [node.panelId] : [];
	}

	return [...getVisiblePanels(node.children[0]), ...getVisiblePanels(node.children[1])];
}

/**
 * Update panel visibility in layout tree
 */
export function updatePanelInTree(
	node: SplitNode,
	panelId: PanelId,
	newPanelId: PanelId | null
): SplitNode {
	if (node.type === 'panel') {
		return node.panelId === panelId ? createPanel(newPanelId) : node;
	}

	return {
		...node,
		children: [
			updatePanelInTree(node.children[0], panelId, newPanelId),
			updatePanelInTree(node.children[1], panelId, newPanelId)
		] as [SplitNode, SplitNode]
	};
}

/**
 * Update split ratio
 */
export function updateSplitRatio(node: SplitNode, path: number[], newRatio: number): SplitNode {
	if (path.length === 0) {
		if (node.type === 'split') {
			return { ...node, ratio: newRatio };
		}
		return node;
	}

	if (node.type === 'panel') return node;

	const [nextIndex, ...restPath] = path;
	const newChildren = [...node.children] as [SplitNode, SplitNode];
	newChildren[nextIndex] = updateSplitRatio(newChildren[nextIndex], restPath, newRatio);

	return { ...node, children: newChildren };
}

/**
 * Swap two panels' positions in the tree
 */
function swapPanelsInTree(node: SplitNode, panelA: PanelId, panelB: PanelId): SplitNode {
	if (node.type === 'panel') {
		if (node.panelId === panelA) return createPanel(panelB);
		if (node.panelId === panelB) return createPanel(panelA);
		return node;
	}

	return {
		...node,
		children: [
			swapPanelsInTree(node.children[0], panelA, panelB),
			swapPanelsInTree(node.children[1], panelA, panelB)
		] as [SplitNode, SplitNode]
	};
}

/**
 * Split a panel leaf into a split container with the original panel + new panel
 */
function splitPanelInTree(
	node: SplitNode,
	targetPanelId: PanelId,
	direction: SplitDirection,
	newPanelId: PanelId | null
): SplitNode {
	if (node.type === 'panel') {
		if (node.panelId === targetPanelId) {
			return createSplit(direction, 50, createPanel(targetPanelId), createPanel(newPanelId));
		}
		return node;
	}

	return {
		...node,
		children: [
			splitPanelInTree(node.children[0], targetPanelId, direction, newPanelId),
			splitPanelInTree(node.children[1], targetPanelId, direction, newPanelId)
		] as [SplitNode, SplitNode]
	};
}

/**
 * Remove a panel from the tree and collapse its parent split.
 * Returns null if the node itself is the target panel (root-level).
 */
function removePanelFromTree(node: SplitNode, panelId: PanelId): SplitNode | null {
	if (node.type === 'panel') {
		return node.panelId === panelId ? null : node;
	}

	const [child1, child2] = node.children;

	const newChild1 = removePanelFromTree(child1, panelId);
	if (newChild1 === null) return child2;

	const newChild2 = removePanelFromTree(child2, panelId);
	if (newChild2 === null) return child1;

	if (newChild1 !== child1 || newChild2 !== child2) {
		return { ...node, children: [newChild1, newChild2] as [SplitNode, SplitNode] };
	}

	return node;
}

/**
 * Replace a node at a specific path in the tree
 */
function setNodeAtPath(root: SplitNode, path: number[], replacement: SplitNode): SplitNode {
	if (path.length === 0) return replacement;
	if (root.type === 'panel') return root;

	const [nextIndex, ...restPath] = path;
	const newChildren = [...root.children] as [SplitNode, SplitNode];
	newChildren[nextIndex] = setNodeAtPath(newChildren[nextIndex], restPath, replacement);
	return { ...root, children: newChildren };
}

/**
 * Remove all empty (null) leaf nodes and collapse their parent splits
 */
function cleanupEmptyNodes(node: SplitNode): SplitNode | null {
	if (node.type === 'panel') {
		return node.panelId ? node : null;
	}

	const child1 = cleanupEmptyNodes(node.children[0]);
	const child2 = cleanupEmptyNodes(node.children[1]);

	if (!child1 && !child2) return null;
	if (!child1) return child2;
	if (!child2) return child1;

	if (child1 !== node.children[0] || child2 !== node.children[1]) {
		return { ...node, children: [child1, child2] as [SplitNode, SplitNode] };
	}

	return node;
}

/**
 * Get a node at a specific path in the tree
 */
function getNodeAtPath(root: SplitNode, path: number[]): SplitNode | null {
	if (path.length === 0) return root;
	if (root.type === 'panel') return null;

	const [nextIndex, ...restPath] = path;
	return getNodeAtPath(root.children[nextIndex], restPath);
}

/**
 * Count total leaf nodes in the tree (including empty slots)
 */
function countLeafNodes(node: SplitNode): number {
	if (node.type === 'panel') return 1;
	return countLeafNodes(node.children[0]) + countLeafNodes(node.children[1]);
}

// ============================================
// BUILT-IN PRESETS
// ============================================

export const builtInPresets: LayoutPreset[] = [
	// ============================================
	// A. SINGLE PANEL (1 preset)
	// ============================================
	{
		id: 'focus',
		name: 'Focus',
		description: 'Single full panel',
		icon: 'lucide:maximize-2',
		layout: createPanel('chat'),
		isCustom: false
	},

	// ============================================
	// B. TWO PANELS (3 presets)
	// ============================================
	{
		id: 'side-by-side',
		name: 'Dual Columns',
		description: 'Two equal columns',
		icon: 'lucide:columns-2',
		layout: createSplit('vertical', 50, createPanel('chat'), createPanel('files')),
		isCustom: false
	},
	{
		id: 'top-bottom',
		name: 'Dual Rows',
		description: 'Two equal rows',
		icon: 'lucide:rows-2',
		layout: createSplit('horizontal', 50, createPanel('files'), createPanel('terminal')),
		isCustom: false
	},
	{
		id: 'sidebar-main',
		name: 'Sidebar',
		description: 'Narrow left, wide right',
		icon: 'lucide:panel-left',
		layout: createSplit('vertical', 25, createPanel('chat'), createPanel('files')),
		isCustom: false
	},

	// ============================================
	// C. THREE PANELS (4 presets)
	// ============================================
	{
		id: 'three-columns',
		name: 'Three Columns',
		description: 'Three equal columns',
		icon: 'lucide:columns-3',
		layout: createSplit(
			'vertical',
			33,
			createPanel('chat'),
			createSplit('vertical', 50, createPanel('files'), createPanel('preview'))
		),
		isCustom: false
	},
	{
		id: 'main-stack',
		name: 'Main Stack',
		description: 'Left column, stacked right',
		icon: 'lucide:layout-panel-left',
		layout: createSplit(
			'vertical',
			50,
			createPanel('chat'),
			createSplit('horizontal', 50, createPanel('files'), createPanel('preview'))
		),
		isCustom: false
	},
	{
		id: 'top-split',
		name: 'Top Split',
		description: 'Top row, two bottom columns',
		icon: 'lucide:layout-panel-top',
		layout: createSplit(
			'horizontal',
			50,
			createPanel('files'),
			createSplit('vertical', 50, createPanel('chat'), createPanel('preview'))
		),
		isCustom: false
	},
	{
		id: 'sidebar-stack',
		name: 'Side Stack',
		description: 'Narrow left, two stacked right',
		icon: 'lucide:panel-left-close',
		layout: createSplit(
			'vertical',
			25,
			createPanel('chat'),
			createSplit('horizontal', 50, createPanel('files'), createPanel('preview'))
		),
		isCustom: false
	},

	// ============================================
	// D. FOUR PANELS (3 presets)
	// ============================================
	{
		id: 'quad-grid',
		name: 'Quad Grid',
		description: '2x2 grid layout',
		icon: 'lucide:grid-2x2',
		layout: createSplit(
			'horizontal',
			50,
			createSplit('vertical', 50, createPanel('chat'), createPanel('files')),
			createSplit('vertical', 50, createPanel('preview'), createPanel('terminal'))
		),
		isCustom: false
	},
	{
		id: 'main-triple',
		name: 'Main Triple',
		description: 'Left column, three right panels',
		icon: 'lucide:layout-dashboard',
		layout: createSplit(
			'vertical',
			33,
			createPanel('chat'),
			createSplit(
				'horizontal',
				50,
				createPanel('files'),
				createSplit('vertical', 50, createPanel('preview'), createPanel('terminal'))
			)
		),
		isCustom: false
	},
	{
		id: 'sidebar-main-stack',
		name: 'Classic IDE',
		description: 'Three columns, right stacked',
		icon: 'lucide:layout-template',
		layout: createSplit(
			'vertical',
			20,
			createPanel('files'),
			createSplit(
				'vertical',
				62.5, // 50 / (50 + 30) = 62.5%
				createPanel('chat'),
				createSplit('horizontal', 50, createPanel('preview'), createPanel('terminal'))
			)
		),
		isCustom: false
	},

	// ============================================
	// E. FIVE PANELS (1 preset)
	// ============================================
	{
		id: 'full-grid',
		name: 'Full Grid',
		description: 'Left column, 2x2 right',
		icon: 'lucide:layout-grid',
		layout: createSplit(
			'vertical',
			25,
			createPanel('chat'),
			createSplit(
				'horizontal',
				50,
				createSplit('vertical', 50, createPanel('files'), createPanel('git')),
				createSplit('vertical', 50, createPanel('preview'), createPanel('terminal'))
			)
		),
		isCustom: false
	}
];

// ============================================
// DEFAULT STATE
// ============================================

const defaultPanels: Record<PanelId, PanelConfig> = {
	chat: {
		id: 'chat',
		title: 'AI Assistant',
		icon: 'lucide:bot',
		visible: true,
		minimized: false,
		order: 0
	},
	files: {
		id: 'files',
		title: 'Files',
		icon: 'lucide:folder',
		visible: true,
		minimized: false,
		order: 1
	},
	git: {
		id: 'git',
		title: 'Source Control',
		icon: 'lucide:git-branch',
		visible: true,
		minimized: false,
		order: 2
	},
	terminal: {
		id: 'terminal',
		title: 'Terminal',
		icon: 'lucide:terminal',
		visible: true,
		minimized: false,
		order: 3
	},
	preview: {
		id: 'preview',
		title: 'Preview',
		icon: 'lucide:globe',
		visible: true,
		minimized: false,
		order: 4
	}
};

export const PANEL_OPTIONS: { id: PanelId; title: string; icon: IconName }[] = [
	{ id: 'chat', title: 'AI Assistant', icon: 'lucide:bot' },
	{ id: 'files', title: 'Files', icon: 'lucide:folder' },
	{ id: 'git', title: 'Source Control', icon: 'lucide:git-branch' },
	{ id: 'terminal', title: 'Terminal', icon: 'lucide:terminal' },
	{ id: 'preview', title: 'Preview', icon: 'lucide:globe' }
];

// Default: Sidebar layout (chat narrow left, files wide right)
const defaultPreset = builtInPresets.find((p) => p.id === 'sidebar-main')!;

// ============================================
// CORE STATE
// ============================================

export const workspaceState = $state<WorkspaceState>({
	panels: { ...defaultPanels },
	layout: defaultPreset.layout,
	activePresetId: 'sidebar-main',
	navigatorCollapsed: false,
	navigatorWidth: 200,
	activeMobilePanel: 'chat'
});

// ============================================
// PANEL VISIBILITY
// ============================================

export function togglePanel(panelId: PanelId): void {
	const visiblePanels = getVisiblePanels(workspaceState.layout);
	const isVisible = visiblePanels.includes(panelId);

	if (isVisible) {
		// Hide panel by replacing with null
		workspaceState.layout = updatePanelInTree(workspaceState.layout, panelId, null);
	} else {
		// Show panel - toggle panel config minimized state
		workspaceState.panels[panelId].minimized = !workspaceState.panels[panelId].minimized;
	}

	saveWorkspaceState();
	debug.log('workspace', `Panel ${panelId} visibility toggled`);
}

export function showPanel(panelId: PanelId): void {
	workspaceState.panels[panelId].minimized = false;
	saveWorkspaceState();
}

export function hidePanel(panelId: PanelId): void {
	workspaceState.layout = updatePanelInTree(workspaceState.layout, panelId, null);
	saveWorkspaceState();
}

export function minimizePanel(panelId: PanelId): void {
	workspaceState.panels[panelId].minimized = true;
	saveWorkspaceState();
}

export function restorePanel(panelId: PanelId): void {
	workspaceState.panels[panelId].minimized = false;
	saveWorkspaceState();
}

export function isPanelVisible(panelId: PanelId): boolean {
	const visiblePanels = getVisiblePanels(workspaceState.layout);
	return visiblePanels.includes(panelId) && !workspaceState.panels[panelId].minimized;
}

// ============================================
// SPLIT PANE OPERATIONS
// ============================================

/**
 * Update split ratio at a specific path in the tree
 */
export function setSplitRatio(path: number[], ratio: number): void {
	const clampedRatio = Math.max(10, Math.min(90, ratio));
	workspaceState.layout = updateSplitRatio(workspaceState.layout, path, clampedRatio);
	saveWorkspaceState();
	debug.log('workspace', `Split ratio updated at path ${path.join('.')}: ${clampedRatio}%`);
}

// ============================================
// PANEL MANIPULATION
// ============================================

/**
 * Swap a panel's content with another panel type.
 * If the new panel is already visible, swap their positions.
 */
export function swapPanel(currentPanelId: PanelId, newPanelId: PanelId): void {
	if (currentPanelId === newPanelId) return;

	const visiblePanels = getVisiblePanels(workspaceState.layout);

	if (visiblePanels.includes(newPanelId)) {
		workspaceState.layout = swapPanelsInTree(workspaceState.layout, currentPanelId, newPanelId);
	} else {
		workspaceState.layout = updatePanelInTree(workspaceState.layout, currentPanelId, newPanelId);
	}

	workspaceState.activePresetId = undefined;
	saveWorkspaceState();
	debug.log('workspace', `Swapped panel ${currentPanelId} → ${newPanelId}`);
}

/**
 * Split a panel into two, with the original panel on the first side
 * and a new panel (or empty slot) on the second side.
 */
export function splitPanel(
	panelId: PanelId,
	direction: SplitDirection,
	newPanelId: PanelId | null = null
): void {
	workspaceState.layout = splitPanelInTree(workspaceState.layout, panelId, direction, newPanelId);
	workspaceState.activePresetId = undefined;
	saveWorkspaceState();
	debug.log('workspace', `Split panel ${panelId} ${direction} with ${newPanelId ?? 'empty'}`);
}

/**
 * Close a panel and collapse its parent split.
 * Returns false if the panel is the last one (minimum 1 panel required).
 */
export function closePanel(panelId: PanelId): boolean {
	const visiblePanels = getVisiblePanels(workspaceState.layout);
	if (visiblePanels.length <= 1) {
		debug.log('workspace', 'Cannot close last panel');
		return false;
	}

	const result = removePanelFromTree(workspaceState.layout, panelId);
	if (result) {
		workspaceState.layout = result;
		workspaceState.activePresetId = undefined;
		saveWorkspaceState();
		debug.log('workspace', `Closed panel ${panelId}`);
		return true;
	}
	return false;
}

/**
 * Check if a panel can be closed (more than 1 panel visible)
 */
export function canClosePanel(): boolean {
	return getVisiblePanels(workspaceState.layout).length > 1;
}

/**
 * Set the panel type at a specific path (used for empty slot panel picker).
 * If the panel is already visible elsewhere, it gets moved here
 * and the old position is cleaned up.
 */
export function setPanelAtPath(path: number[], panelId: PanelId): void {
	let layout = workspaceState.layout;
	const visiblePanels = getVisiblePanels(layout);

	if (visiblePanels.includes(panelId)) {
		// Panel already visible — move it here, clean up old position
		layout = updatePanelInTree(layout, panelId, null);
		layout = setNodeAtPath(layout, path, createPanel(panelId));
		const cleaned = cleanupEmptyNodes(layout);
		if (cleaned) layout = cleaned;
	} else {
		layout = setNodeAtPath(layout, path, createPanel(panelId));
	}

	workspaceState.layout = layout;
	workspaceState.activePresetId = undefined;
	saveWorkspaceState();
	debug.log('workspace', `Set panel at path ${path.join('.')} to ${panelId}`);
}

/**
 * Close a panel at a specific path by collapsing its parent split.
 * The sibling takes the parent's place. Used for empty slot cancel.
 */
export function closePanelAtPath(path: number[]): boolean {
	if (path.length === 0) {
		// Root node — can't close the only thing in the layout
		return false;
	}

	const totalLeaves = countLeafNodes(workspaceState.layout);
	if (totalLeaves <= 1) return false;

	const parentPath = path.slice(0, -1);
	const childIndex = path[path.length - 1];
	const siblingIndex = childIndex === 0 ? 1 : 0;

	const parentNode = getNodeAtPath(workspaceState.layout, parentPath);
	if (!parentNode || parentNode.type !== 'split') return false;

	const sibling = parentNode.children[siblingIndex];
	workspaceState.layout = setNodeAtPath(workspaceState.layout, parentPath, sibling);
	workspaceState.activePresetId = undefined;
	saveWorkspaceState();
	debug.log('workspace', `Closed panel at path ${path.join('.')}`);
	return true;
}

// ============================================
// LAYOUT PRESETS
// ============================================

export function applyLayoutPreset(preset: LayoutPreset): void {
	workspaceState.layout = JSON.parse(JSON.stringify(preset.layout)); // Deep clone
	workspaceState.activePresetId = preset.id;

	// Update panel visibility from layout tree
	const visiblePanels = getVisiblePanels(preset.layout);
	for (const panelId in workspaceState.panels) {
		workspaceState.panels[panelId as PanelId].visible = visiblePanels.includes(
			panelId as PanelId
		);
		workspaceState.panels[panelId as PanelId].minimized = false;
	}

	saveWorkspaceState();
	debug.log('workspace', `Applied layout preset: ${preset.name}`);
}

export function resetToDefault(): void {
	applyLayoutPreset(defaultPreset);
	debug.log('workspace', 'Reset to default layout (Sidebar)');
}

// ============================================
// NAVIGATOR
// ============================================

export function toggleNavigator(): void {
	workspaceState.navigatorCollapsed = !workspaceState.navigatorCollapsed;
	saveWorkspaceState();
}

export function setNavigatorWidth(width: number, fontSize: number = 13): void {
	const scale = fontSize / 13;
	workspaceState.navigatorWidth = Math.max(Math.round(180 * scale), Math.min(Math.round(400 * scale), width));
	saveWorkspaceState();
}

// ============================================
// MOBILE
// ============================================

export function setActiveMobilePanel(panelId: PanelId): void {
	workspaceState.activeMobilePanel = panelId;
	saveWorkspaceState();
}

// ============================================
// PERSISTENCE
// ============================================
//
// The dock layout (split tree, ratios, preset, panel visibility, active mobile
// panel) is now PER-PROJECT — persisted server-side through the project
// workspace coordinator. Only the navigator (sidebar) is global per-user, so it
// stays in localStorage.

const NAV_STORAGE_KEY = 'clopen-workspace-nav';
const LEGACY_STORAGE_KEY = 'clopen-workspace-layout';

/** The per-project slice of workspace state owned by the layout dock. */
interface LayoutSlice {
	layout: WorkspaceLayout;
	activePresetId?: string;
	panels: Record<PanelId, PanelConfig>;
	activeMobilePanel: PanelId;
}

function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** Snapshot the current active project's layout for persistence. */
function snapshotLayoutSlice(): LayoutSlice {
	return {
		layout: deepClone(workspaceState.layout),
		activePresetId: workspaceState.activePresetId,
		panels: deepClone(workspaceState.panels),
		activeMobilePanel: workspaceState.activeMobilePanel
	};
}

/** Apply a restored layout slice (or fall back to defaults when absent). */
function applyLayoutSlice(slice: LayoutSlice | undefined): void {
	if (!slice || !slice.layout) {
		// Project has no saved layout yet — start from the default preset.
		workspaceState.layout = deepClone(defaultPreset.layout);
		workspaceState.activePresetId = defaultPreset.id;
		workspaceState.panels = deepClone(defaultPanels);
		workspaceState.activeMobilePanel = 'chat';
		return;
	}

	// Merge panels with defaults so panels added since the save still exist and
	// always carry up-to-date title/icon.
	const panels = slice.panels ?? ({} as Record<PanelId, PanelConfig>);
	for (const [id, defaultPanel] of Object.entries(defaultPanels)) {
		if (!panels[id as PanelId]) {
			panels[id as PanelId] = { ...defaultPanel };
		} else {
			panels[id as PanelId].title = defaultPanel.title;
			panels[id as PanelId].icon = defaultPanel.icon;
		}
	}

	workspaceState.layout = slice.layout;
	workspaceState.activePresetId = slice.activePresetId;
	workspaceState.panels = panels;
	workspaceState.activeMobilePanel = slice.activeMobilePanel ?? 'chat';
}

/**
 * Persist workspace state. Navigator goes to localStorage (global); the
 * per-project layout is queued for a debounced server save via the coordinator.
 */
export function saveWorkspaceState(): void {
	try {
		localStorage.setItem(
			NAV_STORAGE_KEY,
			JSON.stringify({
				navigatorCollapsed: workspaceState.navigatorCollapsed,
				navigatorWidth: workspaceState.navigatorWidth
			})
		);
	} catch (error) {
		debug.error('workspace', 'Failed to save navigator state:', error);
	}
	requestWorkspaceSave();
}

/** Restore the global navigator state from localStorage (per-user chrome). */
function restoreNavigatorState(): void {
	try {
		const saved =
			localStorage.getItem(NAV_STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
		if (!saved) return;
		const parsed = JSON.parse(saved) as Partial<WorkspaceState>;
		if (typeof parsed.navigatorCollapsed === 'boolean') {
			workspaceState.navigatorCollapsed = parsed.navigatorCollapsed;
		}
		if (typeof parsed.navigatorWidth === 'number') {
			workspaceState.navigatorWidth = parsed.navigatorWidth;
		}
	} catch (error) {
		debug.error('workspace', 'Failed to restore navigator state:', error);
	}
}

// Register the layout as a dock so the coordinator drives its per-project
// persistence and restoration in lockstep with the other docks.
registerDock({
	id: 'layout',
	snapshot: snapshotLayoutSlice,
	restore: (slice) => applyLayoutSlice(slice as LayoutSlice | undefined)
	// No clear(): the incoming layout is applied in restore() before reveal, so
	// there is never a moment where a stale layout is shown without skeletons.
});

// ============================================
// INITIALIZATION
// ============================================

export function initializeWorkspace(): void {
	restoreNavigatorState();
	debug.log('workspace', 'Workspace initialized');
}
