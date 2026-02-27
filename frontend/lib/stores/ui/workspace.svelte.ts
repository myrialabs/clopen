/**
 * Workspace Layout Store
 * Split pane-based workspace layout with visual preset editor
 */

import { debug } from '$shared/utils/logger';

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

// ============================================
// BUILT-IN PRESETS
// ============================================

export const builtInPresets: LayoutPreset[] = [
	// ============================================
	// A. SINGLE PANEL FOCUS (5 presets)
	// ============================================
	{
		id: 'focus-chat',
		name: 'Focus Chat',
		description: 'Chat only, full screen',
		icon: 'lucide:message-square',
		layout: createPanel('chat'),
		isCustom: false
	},
	{
		id: 'focus-files',
		name: 'Focus Files',
		description: 'File explorer fullscreen',
		icon: 'lucide:folder-open',
		layout: createPanel('files'),
		isCustom: false
	},
	{
		id: 'focus-preview',
		name: 'Focus Preview',
		description: 'Preview fullscreen',
		icon: 'lucide:monitor',
		layout: createPanel('preview'),
		isCustom: false
	},
	{
		id: 'focus-terminal',
		name: 'Focus Terminal',
		description: 'Terminal fullscreen',
		icon: 'lucide:terminal-square',
		layout: createPanel('terminal'),
		isCustom: false
	},
	{
		id: 'focus-git',
		name: 'Focus Git',
		description: 'Source control fullscreen',
		icon: 'lucide:git-branch',
		layout: createPanel('git'),
		isCustom: false
	},

	// ============================================
	// B. TWO PANEL LAYOUTS (6 presets)
	// ============================================
	{
		id: 'chat-files',
		name: 'Chat + Files',
		description: '50/50 vertical split',
		icon: 'lucide:layout-panel-left',
		layout: createSplit('vertical', 50, createPanel('chat'), createPanel('files')),
		isCustom: false
	},
	{
		id: 'chat-preview',
		name: 'Chat + Preview',
		description: 'Live preview development',
		icon: 'lucide:app-window',
		layout: createSplit('vertical', 50, createPanel('chat'), createPanel('preview')),
		isCustom: false
	},
	{
		id: 'chat-terminal',
		name: 'Chat + Terminal',
		description: 'Backend/CLI development',
		icon: 'lucide:square-terminal',
		layout: createSplit('vertical', 50, createPanel('chat'), createPanel('terminal')),
		isCustom: false
	},
	{
		id: 'files-preview',
		name: 'Files + Preview',
		description: 'Manual coding workflow',
		icon: 'lucide:panel-left',
		layout: createSplit('vertical', 50, createPanel('files'), createPanel('preview')),
		isCustom: false
	},
	{
		id: 'files-terminal',
		name: 'Files + Terminal',
		description: 'File management + execution',
		icon: 'lucide:folder-tree',
		layout: createSplit('vertical', 50, createPanel('files'), createPanel('terminal')),
		isCustom: false
	},
	{
		id: 'preview-terminal',
		name: 'Preview + Terminal',
		description: 'Frontend testing',
		icon: 'lucide:layout-panel-top',
		layout: createSplit('horizontal', 50, createPanel('preview'), createPanel('terminal')),
		isCustom: false
	},
	{
		id: 'chat-git',
		name: 'Chat + Git',
		description: 'AI-assisted source control',
		icon: 'lucide:git-merge',
		layout: createSplit('vertical', 50, createPanel('chat'), createPanel('git')),
		isCustom: false
	},
	{
		id: 'files-git',
		name: 'Files + Git',
		description: 'File editing + source control',
		icon: 'lucide:git-compare',
		layout: createSplit('vertical', 50, createPanel('files'), createPanel('git')),
		isCustom: false
	},

	// ============================================
	// C. THREE PANEL LAYOUTS (8 presets)
	// ============================================
	{
		id: 'code-review',
		name: 'Code Review',
		description: 'Chat + Files + Git',
		icon: 'lucide:git-pull-request',
		// Layout: [Chat (33%) | Files/Git (67%)]
		layout: createSplit(
			'vertical',
			33,
			createPanel('chat'),
			createSplit('horizontal', 50, createPanel('files'), createPanel('git'))
		),
		isCustom: false
	},
	{
		id: 'frontend-dev',
		name: 'Frontend Dev',
		description: 'Chat | Files | Preview (3 columns)',
		icon: 'lucide:layout-template',
		// Layout: [Chat (33%) | Files (33%) | Preview (34%)]
		layout: createSplit(
			'vertical',
			33,
			createPanel('chat'),
			createSplit('vertical', 50, createPanel('files'), createPanel('preview'))
		),
		isCustom: false
	},
	{
		id: 'backend-dev',
		name: 'Backend Dev',
		description: 'Chat | Files | Terminal (3 columns)',
		icon: 'lucide:server',
		// Layout: [Chat (33%) | Files (33%) | Terminal (34%)]
		layout: createSplit(
			'vertical',
			33,
			createPanel('chat'),
			createSplit('vertical', 50, createPanel('files'), createPanel('terminal'))
		),
		isCustom: false
	},
	{
		id: 'writing-mode',
		name: 'Writing Mode',
		description: 'Chat | Preview | Files',
		icon: 'lucide:file-edit',
		// Layout: [Chat (40%) | Preview (40%) | Files (20%)]
		layout: createSplit(
			'vertical',
			40,
			createPanel('chat'),
			createSplit('vertical', 66.7, createPanel('preview'), createPanel('files'))
		),
		isCustom: false
	},
	{
		id: 'testing-mode',
		name: 'Testing Mode',
		description: 'Files | Preview | Terminal (stacked)',
		icon: 'lucide:flask-conical',
		// Layout: [Files (top 33%) | Preview (33%) | Terminal (34%)]
		layout: createSplit(
			'horizontal',
			33,
			createPanel('files'),
			createSplit('horizontal', 50, createPanel('preview'), createPanel('terminal'))
		),
		isCustom: false
	},
	{
		id: 'fullstack-lite',
		name: 'Full Stack Lite',
		description: 'Chat (top) | Files + Preview (bottom)',
		icon: 'lucide:layers',
		// Layout: [Chat (top 50%) | Files/Preview (bottom 50%)]
		layout: createSplit(
			'horizontal',
			50,
			createPanel('chat'),
			createSplit('vertical', 50, createPanel('files'), createPanel('preview'))
		),
		isCustom: false
	},
	{
		id: 'devops-mode',
		name: 'DevOps Mode',
		description: 'Terminal (big) | Chat + Files (side)',
		icon: 'lucide:workflow',
		// Layout: [Terminal (70%) | Chat/Files (30%)]
		layout: createSplit(
			'vertical',
			70,
			createPanel('terminal'),
			createSplit('horizontal', 50, createPanel('chat'), createPanel('files'))
		),
		isCustom: false
	},
	{
		id: 'learning-mode',
		name: 'Learning Mode',
		description: 'Chat (big left) | Files + Preview (right)',
		icon: 'lucide:graduation-cap',
		// Layout: [Chat (50%) | Files/Preview (50%)]
		layout: createSplit(
			'vertical',
			50,
			createPanel('chat'),
			createSplit('horizontal', 50, createPanel('files'), createPanel('preview'))
		),
		isCustom: false
	},
	{
		id: 'git-workflow',
		name: 'Git Workflow',
		description: 'Git + Files + Terminal',
		icon: 'lucide:git-fork',
		// Layout: [Git (33%) | Files/Terminal (67%)]
		layout: createSplit(
			'vertical',
			33,
			createPanel('git'),
			createSplit('horizontal', 50, createPanel('files'), createPanel('terminal'))
		),
		isCustom: false
	},

	// ============================================
	// D. FOUR PANEL LAYOUTS (4 presets)
	// ============================================
	{
		id: 'full-dev',
		name: 'Full Development',
		description: 'All panels in optimal layout',
		icon: 'lucide:layout-dashboard',
		// Layout: [Chat (33%) | Files (67%) / (Preview (50%) | Terminal (50%))]
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
		id: 'debug-mode',
		name: 'Debug Mode',
		description: 'Chat + Files/Preview + Terminal',
		icon: 'lucide:bug',
		// Layout: [Chat (35%) | Files/Preview (35%) | Terminal (30%)]
		layout: createSplit(
			'vertical',
			35,
			createPanel('chat'),
			createSplit(
				'vertical',
				53.8, // 35 / (35 + 30) * 100 ≈ 53.8%
				createSplit('horizontal', 60, createPanel('files'), createPanel('preview')),
				createPanel('terminal')
			)
		),
		isCustom: false
	},
	{
		id: 'quad-grid',
		name: 'Quad Grid',
		description: '2x2 grid (25% each)',
		icon: 'lucide:grid-2x2',
		// Layout: [Chat/Files (top) | Preview/Terminal (bottom)]
		layout: createSplit(
			'horizontal',
			50,
			createSplit('vertical', 50, createPanel('chat'), createPanel('files')),
			createSplit('vertical', 50, createPanel('preview'), createPanel('terminal'))
		),
		isCustom: false
	},
	{
		id: 'ide-classic',
		name: 'IDE Classic',
		description: 'Files (left narrow) | Chat/Preview/Terminal (right)',
		icon: 'lucide:panel-right',
		// Layout: [Files (20%) | Chat/Preview/Terminal (80%)]
		layout: createSplit(
			'vertical',
			20,
			createPanel('files'),
			createSplit(
				'horizontal',
				33,
				createPanel('chat'),
				createSplit('horizontal', 50, createPanel('preview'), createPanel('terminal'))
			)
		),
		isCustom: false
	},

	// ============================================
	// E. FIVE PANEL LAYOUTS (2 presets)
	// ============================================
	{
		id: 'full-dev-git',
		name: 'Full Dev + Git',
		description: 'All panels with source control',
		icon: 'lucide:layout-dashboard',
		// Layout: [Chat (25%) | Files/Git (top 50%) | Preview/Terminal (bottom 25%)]
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
	},
	{
		id: 'ide-git',
		name: 'IDE + Git',
		description: 'Classic IDE with source control',
		icon: 'lucide:git-branch',
		// Layout: [Git (20%) | Chat (top 50%) | Files/Terminal (bottom 50%)]
		layout: createSplit(
			'vertical',
			20,
			createPanel('git'),
			createSplit(
				'horizontal',
				50,
				createPanel('chat'),
				createSplit('vertical', 50, createPanel('files'), createPanel('terminal'))
			)
		),
		isCustom: false
	},
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
	preview: {
		id: 'preview',
		title: 'Preview',
		icon: 'lucide:globe',
		visible: true,
		minimized: false,
		order: 1
	},
	files: {
		id: 'files',
		title: 'Files',
		icon: 'lucide:folder',
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
	git: {
		id: 'git',
		title: 'Source Control',
		icon: 'lucide:git-branch',
		visible: true,
		minimized: false,
		order: 4
	}
};

// Default: Full Development layout
const defaultFullDevPreset = builtInPresets.find((p) => p.id === 'full-dev')!;

// ============================================
// CORE STATE
// ============================================

export const workspaceState = $state<WorkspaceState>({
	panels: { ...defaultPanels },
	layout: defaultFullDevPreset.layout,
	activePresetId: 'full-dev',
	navigatorCollapsed: false,
	navigatorWidth: 220,
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
	applyLayoutPreset(defaultFullDevPreset);
	debug.log('workspace', 'Reset to default layout (Full Development)');
}

// Shortcuts for built-in presets
export function applyFocusChatLayout(): void {
	const preset = builtInPresets.find((p) => p.id === 'focus-chat')!;
	applyLayoutPreset(preset);
}

export function applyCodeReviewLayout(): void {
	const preset = builtInPresets.find((p) => p.id === 'code-review')!;
	applyLayoutPreset(preset);
}

export function applyFullDevLayout(): void {
	const preset = builtInPresets.find((p) => p.id === 'full-dev')!;
	applyLayoutPreset(preset);
}

export function applyDebugLayout(): void {
	const preset = builtInPresets.find((p) => p.id === 'debug-mode')!;
	applyLayoutPreset(preset);
}

// ============================================
// NAVIGATOR
// ============================================

export function toggleNavigator(): void {
	workspaceState.navigatorCollapsed = !workspaceState.navigatorCollapsed;
	saveWorkspaceState();
}

export function setNavigatorWidth(width: number): void {
	workspaceState.navigatorWidth = Math.max(200, Math.min(400, width));
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

const STORAGE_KEY = 'claude-workspace-layout';

export function saveWorkspaceState(): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaceState));
	} catch (error) {
		debug.error('workspace', 'Failed to save workspace state:', error);
	}
}

export function restoreWorkspaceState(): void {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			const parsed = JSON.parse(saved) as WorkspaceState;
			// Merge panels: ensure all default panels exist (new panels added after save are preserved)
			if (parsed.panels) {
				for (const [id, defaultPanel] of Object.entries(defaultPanels)) {
					if (!parsed.panels[id as PanelId]) {
						parsed.panels[id as PanelId] = defaultPanel;
					} else {
						// Ensure title and icon are always up-to-date from defaults
						parsed.panels[id as PanelId].title = defaultPanel.title;
						parsed.panels[id as PanelId].icon = defaultPanel.icon;
					}
				}
			}
			Object.assign(workspaceState, parsed);
			debug.log('workspace', 'Workspace state restored');
		} else {
			debug.log('workspace', 'No saved state found, using defaults');
		}
	} catch (error) {
		debug.error('workspace', 'Failed to restore workspace state:', error);
	}
}

// ============================================
// INITIALIZATION
// ============================================

export function initializeWorkspace(): void {
	restoreWorkspaceState();
	debug.log('workspace', 'Workspace initialized');
}
