/**
 * Browser Tab Manager
 * Manages tab state and operations for BrowserPreview
 */

import { debug } from '$shared/utils/logger';
import type { DeviceSize, Rotation } from '$frontend/lib/constants/preview';

// Console message type (temporary placeholder)
type ConsoleMessage = any;

// Tab interface
export interface PreviewTab {
	id: string;
	url: string;
	title: string;
	sessionId: string | null;
	sessionInfo: any;
	isConnected: boolean;
	isStreamReady: boolean;
	isLoading: boolean;
	isLaunchingBrowser: boolean;
	isNavigating: boolean; // True when navigating within same session (e.g., clicking a link)
	deviceSize: DeviceSize;
	rotation: Rotation;
	consoleLogs: ConsoleMessage[];
	canvasAPI: any;
	previewDimensions: any;
	lastFrameData: any;
	errorMessage: string | null;
}

/**
 * Helper function to get tab title from URL
 */
export function getTabTitle(url: string): string {
	if (!url) return 'New Tab';
	try {
		return new URL(url).hostname;
	} catch {
		return url.length > 30 ? url.slice(0, 30) + '...' : url;
	}
}

/**
 * Create browser tab manager state
 */
export function createTabManager() {
	let tabs = $state<PreviewTab[]>([]);
	let activeTabId = $state<string | null>(null);
	let nextTabId = $state(1);

	// Get active tab (derived)
	const activeTab = $derived.by(() => tabs.find(tab => tab.id === activeTabId));

	/**
	 * Create a new tab
	 */
	function createTab(tabUrl: string = ''): string {
		const tabId = `tab-${nextTabId++}`;
		debug.log('preview', `📁 Creating new tab: ${tabId} with URL: ${tabUrl || '(empty)'}`);

		// Default device size is laptop
		const deviceSize: DeviceSize = 'laptop';
		// Default rotation: landscape for laptop (matches new default)
		const rotation: Rotation = 'landscape';

		const newTab: PreviewTab = {
			id: tabId,
			url: tabUrl,
			title: getTabTitle(tabUrl),
			sessionId: null,
			sessionInfo: null,
			isConnected: false,
			isStreamReady: false,
			isLoading: false,
			isLaunchingBrowser: false,
			isNavigating: false,
			deviceSize,
			rotation,
			consoleLogs: [],
			canvasAPI: null,
			previewDimensions: { scale: 1 },
			lastFrameData: null,
			errorMessage: null
		};

		tabs = [...tabs, newTab];
		activeTabId = tabId;

		return tabId;
	}

	/**
	 * Switch to a specific tab
	 */
	function switchTab(tabId: string): PreviewTab | null {
		const tab = tabs.find(t => t.id === tabId);
		if (!tab || activeTabId === tabId) return null;

		debug.log('preview', `🔄 Switching tab from ${activeTabId} to ${tabId}`);
		activeTabId = tabId;

		return tab;
	}

	/**
	 * Close a tab
	 */
	function closeTab(tabId: string): { removedTab: PreviewTab | null; newActiveTab: PreviewTab | null } {
		const tabIndex = tabs.findIndex(tab => tab.id === tabId);
		if (tabIndex === -1) return { removedTab: null, newActiveTab: null };

		const removedTab = tabs[tabIndex];
		tabs = tabs.filter(t => t.id !== tabId);

		let newActiveTab: PreviewTab | null = null;

		// Switch to adjacent tab if closing active tab
		if (activeTabId === tabId && tabs.length > 0) {
			const newIndex = tabIndex < tabs.length ? tabIndex : tabs.length - 1;
			newActiveTab = tabs[newIndex];
			if (newActiveTab) {
				activeTabId = newActiveTab.id;
			}
		} else if (tabs.length === 0) {
			activeTabId = null;
		}

		return { removedTab, newActiveTab };
	}

	/**
	 * Update tab state
	 */
	function updateTab(tabId: string, updates: Partial<PreviewTab>): void {
		tabs = tabs.map(tab => {
			if (tab.id === tabId) {
				return { ...tab, ...updates };
			}
			return tab;
		});
	}

	/**
	 * Update active tab
	 */
	function updateActiveTab(updates: Partial<PreviewTab>): void {
		if (!activeTabId) return;
		updateTab(activeTabId, updates);
	}

	/**
	 * Get tab by ID
	 */
	function getTab(tabId: string): PreviewTab | undefined {
		return tabs.find(t => t.id === tabId);
	}

	/**
	 * Get all tabs
	 */
	function getAllTabs(): PreviewTab[] {
		return tabs;
	}

	/**
	 * Get active tab ID
	 */
	function getActiveTabId(): string | null {
		return activeTabId;
	}

	/**
	 * Set tabs (for external state sync)
	 */
	function setTabs(newTabs: PreviewTab[]): void {
		tabs = newTabs;
	}

	/**
	 * Clear all tabs (used when switching projects)
	 */
	function clearAllTabs(): void {
		debug.log('preview', '🧹 Clearing all tabs');
		tabs = [];
		activeTabId = null;
	}

	return {
		// Getters
		get tabs() { return tabs; },
		get activeTabId() { return activeTabId; },
		get activeTab() { return activeTab; },

		// Methods
		createTab,
		switchTab,
		closeTab,
		updateTab,
		updateActiveTab,
		getTab,
		getAllTabs,
		getActiveTabId,
		setTabs,
		clearAllTabs
	};
}

export type TabManager = ReturnType<typeof createTabManager>;
