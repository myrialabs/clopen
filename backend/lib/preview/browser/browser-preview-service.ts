import { EventEmitter } from 'events';
import type { Page } from 'puppeteer-core';
import { BrowserTabManager } from './browser-tab-manager.js';
import { BrowserConsoleManager } from './browser-console-manager.js';
import { BrowserInteractionHandler } from './browser-interaction-handler.js';
import { BrowserNavigationTracker } from './browser-navigation-tracker.js';
import { BrowserVideoCapture } from './browser-video-capture.js';
import { BrowserDialogHandler } from './browser-dialog-handler.js';
import { BrowserNativeUIHandler } from './browser-native-ui-handler.js';
import { browserMcpControl } from './browser-mcp-control.js';
import { ws } from '$backend/lib/utils/ws';
import { debug } from '$shared/utils/logger';
import type {
	BrowserTab,
	BrowserTabInfo,
	BrowserConsoleMessage,
	BrowserAutonomousAction,
	DeviceSize,
	Rotation,
	BrowserDialogResponse,
	BrowserSelectResponse,
	BrowserContextMenuResponse,
	BrowserContextMenuInfo
} from './types';

/**
 * Browser Preview Service
 *
 * Main orchestrator for browser preview functionality.
 * Tab-centric architecture - all operations work with tabs.
 *
 * Architecture:
 * - Tabs are the primary unit (no separate session concept)
 * - Each tab = isolated browser context + page
 * - Event-driven communication with frontend
 * - Manages all browser operations: streaming, interaction, console, etc.
 * - **PROJECT ISOLATION**: Each instance is isolated per project
 */
export class BrowserPreviewService extends EventEmitter {
	private tabManager: BrowserTabManager;
	private consoleManager: BrowserConsoleManager;
	private interactionHandler: BrowserInteractionHandler;
	private navigationTracker: BrowserNavigationTracker;
	private videoCapture: BrowserVideoCapture;
	private dialogHandler: BrowserDialogHandler;
	private nativeUIHandler: BrowserNativeUIHandler;

	// Store context menu info for later action execution
	private contextMenus = new Map<string, BrowserContextMenuInfo>();

	// Project ID for isolation (REQUIRED)
	private projectId: string;

	constructor(projectId: string) {
		super();

		if (!projectId) {
			throw new Error('projectId is required for BrowserPreviewService');
		}

		this.projectId = projectId;

		// Initialize managers with projectId for isolation
		this.tabManager = new BrowserTabManager(projectId);
		this.consoleManager = new BrowserConsoleManager();
		this.interactionHandler = new BrowserInteractionHandler();
		this.navigationTracker = new BrowserNavigationTracker();
		this.videoCapture = new BrowserVideoCapture();
		this.dialogHandler = new BrowserDialogHandler();
		this.nativeUIHandler = new BrowserNativeUIHandler();

		// Forward events from handlers to main service
		this.setupEventForwarding();
	}

	private setupEventForwarding() {
		// Forward console events
		this.consoleManager.on('console-message', (data) => {
			this.emit('preview:browser-console-message', data);
		});
		this.consoleManager.on('console-clear', (data) => {
			this.emit('preview:browser-console-clear', data);
		});

		// Forward interaction events (MCP cursor)
		this.interactionHandler.on('cursor-position', (data) => {
			this.emit('preview:browser-mcp-cursor-position', data);
		});
		this.interactionHandler.on('cursor-click', (data) => {
			this.emit('preview:browser-mcp-cursor-click', data);
		});
		this.interactionHandler.on('test-completed', (data) => {
			this.emit('preview:browser-mcp-test-completed', data);
		});

		// Forward navigation events and handle video streaming restart
		this.navigationTracker.on('navigation', async (data) => {
			this.emit('preview:browser-navigation', data);

			// After navigation completes, restart video streaming for the tab
			// This re-injects the peer script and restarts CDP screencast
			const { sessionId } = data;
			if (this.videoCapture.isStreaming(sessionId)) {
				const tab = this.getTab(sessionId);
				if (tab) {
					// Small delay to ensure page is fully loaded
					setTimeout(async () => {
						try {
							const success = await this.videoCapture.handleNavigation(sessionId, tab);
							if (success) {
								this.emit('preview:browser-navigation-streaming-ready', { sessionId });
							}
						} catch (error) {
							// Silently fail - frontend will request refresh if needed
						}
					}, 100);
				}
			}
		});

		// Forward navigation loading events
		this.navigationTracker.on('navigation-loading', (data) => {
			this.emit('preview:browser-navigation-loading', data);
		});

		// Forward new window events
		this.tabManager.on('new-window', (data) => {
			this.emit('preview:browser-new-window', data);
		});

		// Forward tab events (already have correct event names from tab manager)
		this.tabManager.on('preview:browser-tab-opened', (data) => {
			this.emit('preview:browser-tab-opened', data);
		});
		this.tabManager.on('preview:browser-tab-closed', (data) => {
			this.emit('preview:browser-tab-closed', data);
		});
		this.tabManager.on('preview:browser-tab-switched', (data) => {
			this.emit('preview:browser-tab-switched', data);
		});
		this.tabManager.on('preview:browser-tab-navigated', (data) => {
			this.emit('preview:browser-tab-navigated', data);
		});

		// Forward video capture events
		this.videoCapture.on('ice-candidate', (data) => {
			this.emit('preview:browser-webcodecs-ice-candidate', data);
		});
		this.videoCapture.on('connection-state', (data) => {
			this.emit('preview:browser-webcodecs-connection-state', data);
		});
		this.videoCapture.on('cursor-change', (data) => {
			this.emit('preview:browser-cursor-change', data);
		});
		this.videoCapture.on('navigation-streaming-ready', (data) => {
			this.emit('preview:browser-navigation-streaming-ready', data);
		});

		// Forward dialog events
		this.dialogHandler.on('dialog', (data) => {
			this.emit('preview:browser-dialog', data);
		});
		this.dialogHandler.on('print', (data) => {
			this.emit('preview:browser-print', data);
		});

		// Forward native UI events
		this.nativeUIHandler.on('copy-to-clipboard', (data) => {
			this.emit('preview:browser-copy-to-clipboard', data);
		});
		this.nativeUIHandler.on('open-url-new-tab', (data) => {
			this.emit('preview:browser-open-url-new-tab', data);
		});
		this.nativeUIHandler.on('download-image', (data) => {
			this.emit('preview:browser-download-image', data);
		});
		this.nativeUIHandler.on('copy-image-to-clipboard', (data) => {
			this.emit('preview:browser-copy-image-to-clipboard', data);
		});
	}

	/**
	 * Get project ID for this service instance
	 */
	getProjectId(): string {
		return this.projectId;
	}

	// ============================================================================
	// Tab Management Methods
	// ============================================================================

	/**
	 * Create a new tab with optional URL
	 *
	 * If URL is provided, navigate to it immediately.
	 * If URL is not provided, create blank tab (about:blank).
	 *
	 * Default rotation depends on device size:
	 * - Desktop/laptop: landscape
	 * - Tablet/mobile: portrait
	 */
	async createTab(url?: string, deviceSize: DeviceSize = 'laptop', rotation?: Rotation): Promise<BrowserTab> {
		// Use device-appropriate default rotation if not specified
		const actualRotation = rotation || ((deviceSize === 'desktop' || deviceSize === 'laptop') ? 'landscape' : 'portrait');
		// Pre-navigation setup callback for dialog bindings
		const preNavigationSetup = async (page: Page) => {
			// Note: We'll setup dialog bindings using tabId after tab is created
		};

		// Create tab
		const tab = await this.tabManager.createTab(url, deviceSize, actualRotation, {
			setActive: true,
			preNavigationSetup
		});

		// Setup console and navigation tracking
		await this.consoleManager.setupConsoleLogging(tab.id, tab.page, tab);
		await this.navigationTracker.setupNavigationTracking(tab.id, tab.page, tab);

		// Setup dialog bindings and handling
		await this.dialogHandler.setupDialogBindings(tab.id, tab.page);
		await this.dialogHandler.setupDialogHandling(tab.id, tab.page, tab);

		return tab;
	}

	/**
	 * Navigate tab to a new URL
	 */
	async navigateTab(tabId: string, url: string): Promise<string> {
		const actualUrl = await this.tabManager.navigateTab(tabId, url);

		// Mark navigation for frame deduplication
		this.markNavigation(tabId, url);

		return actualUrl;
	}

	/**
	 * Close a tab and cleanup its resources
	 */
	async closeTab(tabId: string): Promise<{ success: boolean; newActiveTabId: string | null }> {
		const tab = this.tabManager.getTab(tabId);
		if (!tab) {
			return { success: false, newActiveTabId: null };
		}

		// Stop WebCodecs streaming first
		await this.stopWebCodecsStreaming(tabId);

		// Clear cursor tracking for this tab
		this.interactionHandler.clearSessionCursor(tabId);

		// Clear dialogs for this tab
		this.dialogHandler.clearSessionDialogs(tabId);

		// Close the tab (this will cleanup context, page, etc.)
		const result = await this.tabManager.closeTab(tabId);

		// Emit tab closed event (for MCP control manager and other listeners)
		this.emit('preview:browser-tab-destroyed', { tabId });

		return result;
	}

	/**
	 * Switch to a specific tab
	 */
	switchTab(tabId: string): boolean {
		return this.tabManager.setActiveTab(tabId);
	}

	/**
	 * Get a tab by ID
	 */
	getTab(tabId: string): BrowserTab | null {
		return this.tabManager.getTab(tabId);
	}

	/**
	 * Get the active tab
	 */
	getActiveTab(): BrowserTab | null {
		return this.tabManager.getActiveTab();
	}

	/**
	 * Get all tabs
	 */
	getAllTabs(): BrowserTab[] {
		return this.tabManager.getAllTabs();
	}

	/**
	 * Change viewport settings (device size and rotation) for an existing tab
	 */
	async setViewport(tabId: string, deviceSize: DeviceSize, rotation: Rotation): Promise<boolean> {
		return await this.tabManager.setViewport(tabId, deviceSize, rotation);
	}

	/**
	 * Get tab count
	 */
	getTabCount(): number {
		return this.tabManager.getTabCount();
	}

	/**
	 * Get tab info
	 */
	getTabInfo(tabId: string): BrowserTabInfo | null {
		return this.tabManager.getTabInfo(tabId);
	}

	/**
	 * Get all tabs info
	 */
	getAllTabsInfo(): BrowserTabInfo[] {
		return this.tabManager.getAllTabsInfo();
	}

	/**
	 * Get available tab IDs
	 */
	getAvailableTabIds(): string[] {
		return this.tabManager.getAvailableTabIds();
	}

	/**
	 * Get tabs status (for admin/debugging)
	 */
	getTabsStatus() {
		return this.tabManager.getTabsStatus();
	}

	/**
	 * Update tab title from URL
	 */
	updateTabTitleFromUrl(tabId: string, url: string): void {
		this.tabManager.updateTabTitleFromUrl(tabId, url);
	}

	/**
	 * Check if tab is valid
	 */
	isValidTab(tabId: string): boolean {
		const tab = this.getTab(tabId);
		return tab !== null && !tab.isDestroyed;
	}

	// ============================================================================
	// WebCodecs Streaming Methods (optimized, ~20-40ms, lower bandwidth)
	// ============================================================================
	async startWebCodecsStreaming(tabId: string): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		return await this.videoCapture.startStreaming(
			tabId,
			tab,
			() => this.isValidTab(tabId)
		);
	}

	async stopWebCodecsStreaming(tabId: string): Promise<void> {
		const tab = this.getTab(tabId);
		await this.videoCapture.stopStreaming(tabId, tab ?? undefined);
	}

	async updateWebCodecsScale(tabId: string, newScale: number): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		return await this.videoCapture.updateScale(tabId, tab, newScale);
	}

	async updateWebCodecsViewport(tabId: string, width: number, height: number, newScale: number): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		return await this.videoCapture.updateViewport(tabId, tab, width, height, newScale);
	}

	async getWebCodecsOffer(tabId: string): Promise<RTCSessionDescriptionInit | null> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return null;
		}
		return await this.videoCapture.createOffer(tabId, tab);
	}

	async handleWebCodecsAnswer(tabId: string, answer: RTCSessionDescriptionInit): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		return await this.videoCapture.handleAnswer(tabId, tab, answer);
	}

	async addWebCodecsIceCandidate(tabId: string, candidate: RTCIceCandidateInit): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		return await this.videoCapture.addIceCandidate(tabId, tab, candidate);
	}

	isWebCodecsActive(tabId: string): boolean {
		return this.videoCapture.isStreaming(tabId);
	}

	async getWebCodecsStats(tabId: string) {
		const tab = this.getTab(tabId);
		if (!tab) {
			return null;
		}
		return await this.videoCapture.getStats(tabId, tab);
	}

	markUserInteraction(tabId: string): void {
		this.tabManager.markTabActivity(tabId);
	}

	// Public method to mark tab activity (called from WS handlers)
	markActiveTabActivity(): void {
		const tab = this.getActiveTab();
		if (tab) {
			this.tabManager.markTabActivity(tab.id);
		}
	}

	markNavigation(tabId: string, _newUrl?: string): void {
		// Navigation tracking is now handled by WebCodecs automatically
		// This method is kept for API compatibility
	}

	// ============================================================================
	// Console Management Methods
	// ============================================================================
	getConsoleLogs(tabId: string): BrowserConsoleMessage[] {
		const tab = this.getTab(tabId);
		return tab ? this.consoleManager.getConsoleLogs(tab) : [];
	}

	clearConsoleLogs(tabId: string): boolean {
		const tab = this.getTab(tabId);
		return tab ? this.consoleManager.clearConsoleLogs(tab) : false;
	}

	toggleConsoleLogging(tabId: string, enabled: boolean): boolean {
		const tab = this.getTab(tabId);
		return tab ? this.consoleManager.toggleConsoleLogging(tab, enabled) : false;
	}

	async executeConsoleCommand(tabId: string, command: string): Promise<any> {
		const tab = this.getTab(tabId);
		if (!tab) throw new Error('Tab not found or invalid');
		return this.consoleManager.executeConsoleCommand(tab, command);
	}

	// ============================================================================
	// Interaction & Autonomous Actions Methods
	// ============================================================================
	async performAutonomousActions(tabId: string, actions: BrowserAutonomousAction[]) {
		const tab = this.getTab(tabId);
		if (!tab) throw new Error('Tab not found or invalid');

		const results = await this.interactionHandler.performAutonomousActions(
			tabId,
			tab,
			actions,
			() => this.isValidTab(tabId)
		);

		return results;
	}

	/**
	 * Perform autonomous actions using tab object directly
	 * More efficient when tab is already available
	 */
	async performAutonomousActionsWithTab(tab: BrowserTab, actions: BrowserAutonomousAction[]) {
		const results = await this.interactionHandler.performAutonomousActions(
			tab.id,
			tab,
			actions,
			() => this.isValidTab(tab.id)
		);

		return results;
	}

	// ============================================================================
	// Dialog Management Methods
	// ============================================================================
	async respondToDialog(response: BrowserDialogResponse): Promise<boolean> {
		return await this.dialogHandler.respondToDialog(response);
	}

	// ============================================================================
	// Native UI Methods (Select & Context Menu)
	// ============================================================================
	async checkForSelectElement(tabId: string, x: number, y: number) {
		const tab = this.getTab(tabId);
		if (!tab) return null;

		const selectInfo = await this.nativeUIHandler.checkForSelect(tabId, tab.page, x, y);
		if (selectInfo) {
			this.emit('preview:browser-select', selectInfo);
		}
		return selectInfo;
	}

	async handleSelectResponse(tabId: string, response: BrowserSelectResponse): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) return false;

		return await this.nativeUIHandler.handleSelectResponse(tab.page, response);
	}

	async checkForContextMenu(tabId: string, x: number, y: number) {
		const tab = this.getTab(tabId);
		if (!tab) return null;

		const menuInfo = await this.nativeUIHandler.checkForContextMenu(tabId, tab.page, x, y);
		if (menuInfo) {
			// Store menu info for later action execution
			this.contextMenus.set(menuInfo.menuId, menuInfo);
			this.emit('preview:browser-context-menu', menuInfo);
		}
		return menuInfo;
	}

	async handleContextMenuResponse(tabId: string, response: BrowserContextMenuResponse, clipboardText?: string): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) return false;

		// Get stored menu info
		const menuInfo = this.contextMenus.get(response.menuId);
		if (!menuInfo) return false;

		const result = await this.nativeUIHandler.handleContextMenuResponse(tab.page, response, menuInfo, clipboardText);

		// Clean up stored menu info
		this.contextMenus.delete(response.menuId);

		return result;
	}

	// ============================================================================
	// Cleanup Methods
	// ============================================================================
	async cleanup() {
		// Clear all cursor tracking
		this.interactionHandler.clearAllSessionCursors();
		// Cleanup tabs (this will also cleanup all contexts/pages/browser pool)
		await this.tabManager.cleanup();
	}

	async cleanupInactiveTabs() {
		return this.tabManager.cleanupInactiveTabs();
	}

	async forceCleanupAll() {
		// First try normal cleanup
		await this.cleanup();

		// Cleanup video capture sessions
		await this.videoCapture.cleanup();

		// Clear all dialogs and context menus
		this.dialogHandler.clearAllDialogs();
		this.contextMenus.clear();

		// Remove all listeners to prevent memory leaks
		this.removeAllListeners();
		this.consoleManager.removeAllListeners();
		this.interactionHandler.removeAllListeners();
		this.navigationTracker.removeAllListeners();
		this.videoCapture.removeAllListeners();
		this.dialogHandler.removeAllListeners();
		this.nativeUIHandler.removeAllListeners();
	}
}

/**
 * Browser Preview Service Manager
 *
 * Manages BrowserPreviewService instances per project.
 * Provides project isolation - each project has its own browser tabs and state.
 */
class BrowserPreviewServiceManager {
	private services = new Map<string, BrowserPreviewService>();

	/**
	 * Get or create a BrowserPreviewService for a project
	 */
	getService(projectId: string): BrowserPreviewService {
		if (!projectId) {
			throw new Error('projectId is required and cannot be empty');
		}

		if (!this.services.has(projectId)) {
			debug.log('preview', `🆕 Creating new BrowserPreviewService for project: ${projectId}`);
			const service = new BrowserPreviewService(projectId);
			this.services.set(projectId, service);

			// Setup WebSocket event forwarding for this service
			this.setupWebSocketForwarding(service, projectId);
			debug.log('preview', `✅ BrowserPreviewService fully initialized for project: ${projectId}`);
		}

		return this.services.get(projectId)!;
	}

	/**
	 * Setup WebSocket event forwarding for a service instance
	 * Events are emitted to the specific project only
	 */
	private setupWebSocketForwarding(service: BrowserPreviewService, projectId: string): void {
		debug.log('preview', `🔌 Setting up WebSocket forwarding for project: ${projectId}...`);

		// Forward WebCodecs events
		service.on('preview:browser-webcodecs-ice-candidate', (data) => {
			ws.emit.project(projectId, 'preview:browser-stream-ice', {
				sessionId: data.sessionId,
				candidate: data.candidate,
				from: data.from
			});
		});

		service.on('preview:browser-webcodecs-connection-state', (data) => {
			ws.emit.project(projectId, 'preview:browser-stream-state', data);
		});

		service.on('preview:browser-cursor-change', (data) => {
			ws.emit.project(projectId, 'preview:browser-cursor-change', data);
		});

		// Forward navigation events
		service.on('preview:browser-navigation-loading', (data) => {
			ws.emit.project(projectId, 'preview:browser-navigation-loading', data);
		});

		service.on('preview:browser-navigation', (data) => {
			ws.emit.project(projectId, 'preview:browser-navigation', data);
		});

		// Forward tab events
		service.on('preview:browser-tab-opened', (data) => {
			debug.log('preview', `🚀 Forwarding preview:browser-tab-opened to project ${projectId}:`, data);
			ws.emit.project(projectId, 'preview:browser-tab-opened', data);
		});

		service.on('preview:browser-tab-closed', (data) => {
			ws.emit.project(projectId, 'preview:browser-tab-closed', data);
		});

		service.on('preview:browser-tab-switched', (data) => {
			ws.emit.project(projectId, 'preview:browser-tab-switched', data);
		});

		service.on('preview:browser-tab-navigated', (data) => {
			ws.emit.project(projectId, 'preview:browser-tab-navigated', data);
		});

		// Forward console events
		service.on('preview:browser-console-message', (data) => {
			ws.emit.project(projectId, 'preview:browser-console-message', data);
		});

		service.on('preview:browser-console-clear', (data) => {
			ws.emit.project(projectId, 'preview:browser-console-clear', data);
		});

		// Forward MCP events
		service.on('preview:browser-mcp-cursor-position', (data) => {
			ws.emit.project(projectId, 'preview:browser-mcp-cursor-position', data);
		});

		service.on('preview:browser-mcp-cursor-click', (data) => {
			ws.emit.project(projectId, 'preview:browser-mcp-cursor-click', data);
		});

		service.on('preview:browser-mcp-test-completed', (data) => {
			ws.emit.project(projectId, 'preview:browser-mcp-test-completed', data);
		});

		// Forward dialog events
		service.on('preview:browser-dialog', (data) => {
			ws.emit.project(projectId, 'preview:browser-dialog', data);
		});

		service.on('preview:browser-print', (data) => {
			ws.emit.project(projectId, 'preview:browser-print', data);
		});

		// Forward native UI events
		service.on('preview:browser-select', (data) => {
			ws.emit.project(projectId, 'preview:browser-select', data);
		});

		service.on('preview:browser-context-menu', (data) => {
			ws.emit.project(projectId, 'preview:browser-context-menu', data);
		});

		service.on('preview:browser-copy-to-clipboard', (data) => {
			ws.emit.project(projectId, 'preview:browser-copy-to-clipboard', data);
		});

		service.on('preview:browser-open-url-new-tab', (data) => {
			ws.emit.project(projectId, 'preview:browser-open-url-new-tab', data);
		});

		service.on('preview:browser-download-image', (data) => {
			ws.emit.project(projectId, 'preview:browser-download-image', data);
		});

		service.on('preview:browser-copy-image-to-clipboard', (data) => {
			ws.emit.project(projectId, 'preview:browser-copy-image-to-clipboard', data);
		});

		// Forward new window events
		service.on('preview:browser-new-window', (data) => {
			ws.emit.project(projectId, 'preview:browser-new-window', data);
		});

		// Forward MCP control events (from singleton browserMcpControl)
		browserMcpControl.on('control-start', (data) => {
			debug.log('preview', `🚀 Forwarding mcp-control-start to project ${projectId}:`, data);
			ws.emit.project(projectId, 'preview:browser-mcp-control-start', {
				browserSessionId: data.browserTabId,
				mcpSessionId: data.mcpSessionId,
				timestamp: data.timestamp
			});
		});

		browserMcpControl.on('control-end', (data) => {
			debug.log('preview', `🚀 Forwarding mcp-control-end to project ${projectId}:`, data);
			ws.emit.project(projectId, 'preview:browser-mcp-control-end', {
				browserSessionId: data.browserTabId,
				timestamp: data.timestamp
			});
		});

		// Forward MCP cursor events
		browserMcpControl.on('cursor-position', (data) => {
			ws.emit.project(projectId, 'preview:browser-mcp-cursor-position', {
				sessionId: data.tabId,
				x: data.x,
				y: data.y,
				timestamp: data.timestamp,
				source: 'mcp'
			});
		});

		browserMcpControl.on('cursor-click', (data) => {
			ws.emit.project(projectId, 'preview:browser-mcp-cursor-click', {
				sessionId: data.tabId,
				x: data.x,
				y: data.y,
				timestamp: data.timestamp,
				source: 'mcp'
			});
		});

		browserMcpControl.on('test-completed', (data) => {
			ws.emit.project(projectId, 'preview:browser-mcp-test-completed', {
				sessionId: data.tabId,
				timestamp: data.timestamp,
				source: 'mcp'
			});
		});

		debug.log('preview', `🎉 All WebSocket event listeners registered for project: ${projectId}`);
	}

	/**
	 * Check if a service exists for a project
	 */
	hasService(projectId: string): boolean {
		if (!projectId) {
			throw new Error('projectId is required and cannot be empty');
		}
		return this.services.has(projectId);
	}

	/**
	 * Remove a service for a project (cleanup)
	 */
	async removeService(projectId: string): Promise<void> {
		if (!projectId) {
			throw new Error('projectId is required and cannot be empty');
		}

		const service = this.services.get(projectId);

		if (service) {
			await service.forceCleanupAll();
			this.services.delete(projectId);
		}
	}

	/**
	 * Cleanup all services
	 */
	async cleanup(): Promise<void> {
		const cleanupPromises = Array.from(this.services.values()).map(service =>
			service.forceCleanupAll().catch(error => {
				console.error('Error cleaning up service:', error);
			})
		);

		await Promise.all(cleanupPromises);
		this.services.clear();
	}

	/**
	 * Get all active project IDs
	 */
	getActiveProjects(): string[] {
		return Array.from(this.services.keys());
	}

	/**
	 * Get stats for all services
	 */
	getStats() {
		const stats = new Map<string, any>();

		for (const [projectId, service] of this.services.entries()) {
			stats.set(projectId, {
				projectId,
				tabs: service.getTabsStatus()
			});
		}

		return stats;
	}
}

// Service manager instance (singleton)
export const browserPreviewServiceManager = new BrowserPreviewServiceManager();

// Graceful shutdown handlers
const gracefulShutdown = async (signal: string) => {
	try {
		await browserPreviewServiceManager.cleanup();
		process.exit(0);
	} catch (error) {
		process.exit(1);
	}
};

// Handle various termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Handle Windows-specific signals
if (process.platform === 'win32') {
	process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
}

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', async (error) => {
	await browserPreviewServiceManager.cleanup();
	process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
	await browserPreviewServiceManager.cleanup();
	process.exit(1);
});

// Handle process exit
process.on('exit', (code) => {
});
