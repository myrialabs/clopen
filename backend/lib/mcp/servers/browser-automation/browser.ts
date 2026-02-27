/**
 * Browser Management Handlers for MCP Browser Automation
 *
 * Provides tools for MCP to manage browser:
 * - List and switch tabs
 * - Open and close tabs (auto session management)
 * - Navigate active tab
 *
 * Session management is handled internally - no session tools exposed.
 * All operations work on the active tab automatically.
 */

import { ws } from "$backend/lib/utils/ws";
import { debug } from "$shared/utils/logger";
import { browserMcpControl, browserPreviewServiceManager, type BrowserPreviewService } from "$backend/lib/preview";
import { projectContextService } from "$backend/lib/mcp/project-context";

/**
 * Get BrowserPreviewService for current MCP execution context
 *
 * Uses projectContextService to determine the correct project based on:
 * 1. Explicit projectId parameter (if provided)
 * 2. Current active chat session context
 * 3. Most recent active stream
 * 4. Fallback to first available project
 */
function getPreviewService(projectId?: string): BrowserPreviewService {
	// 1. Use explicit projectId if provided
	if (projectId) {
		debug.log('mcp', `Using explicit projectId: ${projectId}`);
		return browserPreviewServiceManager.getService(projectId);
	}

	// 2. Try to get projectId from current execution context
	const contextProjectId = projectContextService.getCurrentProjectId();
	if (contextProjectId) {
		debug.log('mcp', `Using projectId from context: ${contextProjectId}`);
		return browserPreviewServiceManager.getService(contextProjectId);
	}

	// 3. Fallback: Get first available project's service
	const activeProjects = browserPreviewServiceManager.getActiveProjects();
	if (activeProjects.length > 0) {
		const fallbackProjectId = activeProjects[0];
		debug.warn('mcp', `⚠️ No project context found, falling back to first active project: ${fallbackProjectId}`);
		return browserPreviewServiceManager.getService(fallbackProjectId);
	}

	throw new Error('No active browser preview service found. Project isolation requires projectId.');
}

// Tab response types
interface FrontendTab {
	id: string;
	url: string;
	title: string;
	sessionId: string | null;
	isActive: boolean;
}

interface TabsListResponse {
	tabs: FrontendTab[];
}

interface ActiveTabResponse {
	tab: FrontendTab | null;
}

interface SwitchTabResponse {
	success: boolean;
	tab?: FrontendTab;
	error?: string;
}

interface OpenTabResponse {
	success: boolean;
	tab?: FrontendTab;
	error?: string;
}

interface CloseTabResponse {
	success: boolean;
	closedTabId?: string;
	newActiveTab?: FrontendTab;
	error?: string;
}

/**
 * Internal helper: Get active tab
 * Throws error if no active tab found
 * Automatically acquires MCP control for the active tab to ensure UI sync
 */
export async function getActiveTabSession(projectId?: string) {
	// Get active tab directly from backend tab manager
	const previewService = getPreviewService(projectId);
	const tab = previewService.getActiveTab();

	if (!tab) {
		throw new Error("No active tab found. Open a tab first using 'open_tab'.");
	}

	// Acquire control for active tab (ensures UI sync after idle timeout)
	// This is idempotent - if already controlling this tab, just updates timestamp
	if (!browserMcpControl.isTabControlled(tab.id)) {
		const acquired = browserMcpControl.acquireControl(tab.id);
		if (acquired) {
			debug.log('mcp', `🔄 Auto-acquired control for tab ${tab.id} (resumed after idle)`);
		}
	}

	// For backward compatibility, return both tab and session-like reference
	// Note: In tab-centric architecture, tab IS the session
	return { tab, session: tab };
}

/**
 * List all open tabs in the browser preview
 */
export async function listTabsHandler(projectId?: string) {
	try {
		debug.log('mcp', '📋 MCP requesting tab list');
		debug.log('mcp', `🔍 Input projectId: ${projectId || '(none)'}`);

		// Get all tabs directly from backend
		const previewService = getPreviewService(projectId);
		debug.log('mcp', `✅ Using service for project: ${previewService.getProjectId()}`);

		const tabs = previewService.getAllTabs();
		debug.log('mcp', `📊 Found ${tabs.length} tabs`);

		if (tabs.length === 0) {
			return {
				content: [{
					type: "text" as const,
					text: `No browser tabs are currently open.`
				}]
			};
		}

		const tabList = tabs.map((tab: any, index: number) =>
			`${index + 1}. ${tab.isActive ? '* ' : '  '}[${tab.id}] ${tab.title || 'Untitled'}\n   URL: ${tab.url || '(empty)'}`
		).join('\n\n');

		// Update last action to keep control alive
		browserMcpControl.updateLastAction();

		return {
			content: [{
				type: "text" as const,
				text: `Browser Tabs (${tabs.length}):\n\n${tabList}`
			}]
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return {
			content: [{
				type: "text" as const,
				text: `Failed to list tabs: ${errorMessage}`
			}],
			isError: true
		};
	}
}

/**
 * Switch to a specific tab by ID
 */
export async function switchTabHandler(args: { tabId: string; projectId?: string }) {
	try {
		debug.log('mcp', `🔄 MCP switching to tab: ${args.tabId}`);

		// Switch tab directly in backend
		const previewService = getPreviewService(args.projectId);
		const success = previewService.switchTab(args.tabId);

		if (!success) {
			return {
				content: [{
					type: "text" as const,
					text: `Failed to switch tab: Tab '${args.tabId}' not found`
				}],
				isError: true
			};
		}

		// Get the tab that was just activated
		const tab = previewService.getTab(args.tabId);

		// Update MCP control to the new tab
		if (tab) {
			browserMcpControl.releaseControl();
			browserMcpControl.acquireControl(tab.id);
		}

		// Update last action to keep control alive
		browserMcpControl.updateLastAction();

		return {
			content: [{
				type: "text" as const,
				text: `Switched to tab '${args.tabId}'.\n\nTitle: ${tab?.title || 'Untitled'}\nURL: ${tab?.url || '(empty)'}`
			}]
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return {
			content: [{
				type: "text" as const,
				text: `Failed to switch tab: ${errorMessage}`
			}],
			isError: true
		};
	}
}

/**
 * Open a new tab with optional URL and viewport configuration
 * Auto-creates browser session and acquires MCP control
 */
export async function openNewTabHandler(args: { url?: string; deviceSize?: 'desktop' | 'laptop' | 'tablet' | 'mobile'; rotation?: 'portrait' | 'landscape'; projectId?: string }) {
	try {
		const deviceSize = args.deviceSize || 'laptop';

		// Determine default rotation based on device size if not specified
		let rotation: 'portrait' | 'landscape';
		if (args.rotation) {
			rotation = args.rotation;
		} else {
			// Desktop and laptop default to landscape
			// Tablet and mobile default to portrait
			rotation = (deviceSize === 'desktop' || deviceSize === 'laptop') ? 'landscape' : 'portrait';
		}

		debug.log('mcp', `📑 MCP opening new tab with URL: ${args.url || '(empty)'}`);
		debug.log('mcp', `📱 Device: ${deviceSize}, Rotation: ${rotation}`);
		debug.log('mcp', `🔍 Input projectId: ${args.projectId || '(none)'}`);

		// Create tab directly in backend
		const previewService = getPreviewService(args.projectId);
		debug.log('mcp', `✅ Using service for project: ${previewService.getProjectId()}`);

		const tab = await previewService.createTab(args.url || undefined, deviceSize, rotation);
		debug.log('mcp', `✅ Tab created: ${tab.id}`);

		// Auto-acquire control of the new tab
		browserMcpControl.releaseControl();
		browserMcpControl.acquireControl(tab.id);

		// Update last action to keep control alive
		browserMcpControl.updateLastAction();

		return {
			content: [{
				type: "text" as const,
				text: `New tab opened successfully.\n\nTab ID: ${tab.id}\nTitle: ${tab.title}\nURL: ${tab.url || '(empty)'}\nViewport: ${deviceSize} (${rotation})`
			}]
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return {
			content: [{
				type: "text" as const,
				text: `Failed to open new tab: ${errorMessage}`
			}],
			isError: true
		};
	}
}

/**
 * Close a specific tab by ID
 * Auto-destroys browser session and releases MCP control
 */
export async function closeTabHandler(args: { tabId: string; projectId?: string }) {
	try {
		debug.log('mcp', `❌ MCP closing tab: ${args.tabId}`);

		// Close tab directly in backend
		const previewService = getPreviewService(args.projectId);
		const result = await previewService.closeTab(args.tabId);

		if (!result.success) {
			return {
				content: [{
					type: "text" as const,
					text: `Failed to close tab: Tab '${args.tabId}' not found`
				}],
				isError: true
			};
		}

		// Release control of closed tab
		browserMcpControl.releaseControl();

		// If there's a new active tab, acquire control
		if (result.newActiveTabId) {
			const newActiveTab = previewService.getTab(result.newActiveTabId);
			if (newActiveTab) {
				browserMcpControl.acquireControl(newActiveTab.id);
			}
		}

		// Update last action to keep control alive
		browserMcpControl.updateLastAction();

		let responseText = `Tab '${args.tabId}' closed successfully.`;
		if (result.newActiveTabId) {
			const newActiveTab = previewService.getTab(result.newActiveTabId);
			if (newActiveTab) {
				responseText += `\n\nNew active tab: ${newActiveTab.id}\nURL: ${newActiveTab.url || '(empty)'}`;
			}
		} else {
			responseText += `\n\nNo remaining tabs.`;
		}

		return {
			content: [{
				type: "text" as const,
				text: responseText
			}]
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return {
			content: [{
				type: "text" as const,
				text: `Failed to close tab: ${errorMessage}`
			}],
			isError: true
		};
	}
}

/**
 * Navigate active tab to a different URL
 * Waits for page load. Session state preserved.
 */
export async function navigateHandler(args: { url: string; projectId?: string }) {
	try {
		// Get active tab session
		const { session } = await getActiveTabSession(args.projectId);

		// Navigate and wait for page to load
		await session.page.goto(args.url, {
			waitUntil: 'domcontentloaded',
			timeout: 30000
		});

		// Wait a bit for dynamic content to load
		await new Promise(resolve => setTimeout(resolve, 500));

		const finalUrl = session.page.url();
		browserMcpControl.updateLastAction();

		return {
			content: [{
				type: "text" as const,
				text: `Navigation successful.\n\nFinal URL: ${finalUrl}`
			}]
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return {
			content: [{
				type: "text" as const,
				text: `Navigation failed: ${errorMessage}`
			}],
			isError: true
		};
	}
}

/**
 * Change viewport settings (device size and rotation) for active tab
 */
export async function setViewportHandler(args: { deviceSize?: 'desktop' | 'laptop' | 'tablet' | 'mobile'; rotation?: 'portrait' | 'landscape'; projectId?: string }) {
	try {
		// Get active tab
		const { tab } = await getActiveTabSession(args.projectId);

		const deviceSize = args.deviceSize || tab.deviceSize;
		const rotation = args.rotation || tab.rotation;

		debug.log('mcp', `📱 MCP changing viewport for tab ${tab.id}: ${deviceSize} (${rotation})`);

		// Get preview service and update viewport
		const previewService = getPreviewService(args.projectId);
		const success = await previewService.setViewport(tab.id, deviceSize, rotation);

		if (!success) {
			return {
				content: [{
					type: "text" as const,
					text: `Failed to change viewport for tab '${tab.id}'`
				}],
				isError: true
			};
		}

		// Update last action to keep control alive
		browserMcpControl.updateLastAction();

		return {
			content: [{
				type: "text" as const,
				text: `Viewport changed successfully.\n\nTab ID: ${tab.id}\nDevice: ${deviceSize}\nRotation: ${rotation}`
			}]
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return {
			content: [{
				type: "text" as const,
				text: `Failed to change viewport: ${errorMessage}`
			}],
			isError: true
		};
	}
}
