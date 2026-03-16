/**
 * Browser Management Handlers for MCP Browser Automation
 *
 * Provides tools for MCP to manage browser:
 * - List and switch tabs
 * - Open and close tabs (auto session management)
 * - Navigate active tab
 *
 * Control model:
 * - Each chat session can control multiple tabs (accumulated via switch/open)
 * - A tab can only be controlled by one chat session at a time
 * - All controlled tabs are released when the chat stream ends
 * - list_tabs shows MCP control status so AI avoids conflicts
 */

import { debug } from "$shared/utils/logger";
import { browserMcpControl, browserPreviewServiceManager, type BrowserPreviewService } from "$backend/preview";
import { projectContextService } from "$backend/mcp/project-context";

/**
 * Get BrowserPreviewService for current MCP execution context
 */
function getPreviewService(projectId?: string): BrowserPreviewService {
	if (projectId) {
		return browserPreviewServiceManager.getService(projectId);
	}

	const contextProjectId = projectContextService.getCurrentProjectId();
	if (contextProjectId) {
		return browserPreviewServiceManager.getService(contextProjectId);
	}

	const activeProjects = browserPreviewServiceManager.getActiveProjects();
	if (activeProjects.length > 0) {
		debug.warn('mcp', `⚠️ No project context found, falling back to first active project: ${activeProjects[0]}`);
		return browserPreviewServiceManager.getService(activeProjects[0]);
	}

	throw new Error('No active browser preview service found. Project isolation requires projectId.');
}

/**
 * Get chatSessionId from current execution context.
 * Required for session-scoped MCP control.
 */
function getChatSessionId(): string {
	const chatSessionId = projectContextService.getCurrentChatSessionId();
	if (!chatSessionId) {
		throw new Error('No chat session context available. Cannot acquire MCP control.');
	}
	return chatSessionId;
}

/**
 * Internal helper: Get active tab for MCP operations.
 * Automatically acquires MCP control for the chat session.
 *
 * If this chat session already controls tabs, uses the most recently
 * controlled tab (not necessarily the frontend's active tab).
 */
export async function getActiveTabSession(projectId?: string) {
	const previewService = getPreviewService(projectId);
	const resolvedProjectId = previewService.getProjectId();
	const chatSessionId = getChatSessionId();

	// Check if this session already controls any tabs — use the last one
	const sessionTabs = browserMcpControl.getSessionTabs(chatSessionId);
	if (sessionTabs.length > 0) {
		// Use the last tab this session was working with
		const lastTabId = sessionTabs[sessionTabs.length - 1];
		const controlledTab = previewService.getTab(lastTabId);
		if (controlledTab) {
			debug.log('mcp', `🎮 Using session-controlled tab: ${controlledTab.id}`);
			return { tab: controlledTab, session: controlledTab };
		}
	}

	// No controlled tab — use the frontend's active tab and acquire control
	const tab = previewService.getActiveTab();
	if (!tab) {
		throw new Error("No active tab found. Open a tab first using 'open_new_tab'.");
	}

	// Acquire control (will fail if another session owns this tab)
	const acquired = browserMcpControl.acquireControl(tab.id, chatSessionId, resolvedProjectId);
	if (!acquired) {
		const owner = browserMcpControl.getTabOwner(tab.id);
		throw new Error(`Tab '${tab.id}' is controlled by another chat session (${owner?.slice(0, 8)}...). Use a different tab.`);
	}

	return { tab, session: tab };
}

/**
 * List all open tabs in the browser preview.
 * Shows MCP control status so AI can avoid conflicts.
 */
export async function listTabsHandler(projectId?: string) {
	try {
		const previewService = getPreviewService(projectId);
		const tabs = previewService.getAllTabs();
		const chatSessionId = projectContextService.getCurrentChatSessionId();

		if (tabs.length === 0) {
			return {
				content: [{
					type: "text" as const,
					text: `No browser tabs are currently open.`
				}]
			};
		}

		const tabList = tabs.map((tab: any, index: number) => {
			const owner = browserMcpControl.getTabOwner(tab.id);
			let status = '';
			if (owner) {
				status = owner === chatSessionId
					? ' (MCP: this session)'
					: ' (MCP: another session)';
			}

			return `${index + 1}. ${tab.isActive ? '* ' : '  '}[${tab.id}] ${tab.title || 'Untitled'}${status}\n   URL: ${tab.url || '(empty)'}`;
		}).join('\n\n');

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
 * Switch to a specific tab by ID.
 * Adds the tab to this session's controlled set (does NOT release other tabs).
 */
export async function switchTabHandler(args: { tabId: string; projectId?: string }) {
	try {
		debug.log('mcp', `🔄 MCP switching to tab: ${args.tabId}`);

		const previewService = getPreviewService(args.projectId);
		const chatSessionId = getChatSessionId();
		const resolvedProjectId = previewService.getProjectId();

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

		// Acquire control of the new tab (adds to session's set, doesn't release others)
		const tab = previewService.getTab(args.tabId);
		if (tab) {
			const acquired = browserMcpControl.acquireControl(tab.id, chatSessionId, resolvedProjectId);
			if (!acquired) {
				const owner = browserMcpControl.getTabOwner(tab.id);
				return {
					content: [{
						type: "text" as const,
						text: `Tab '${args.tabId}' is controlled by another chat session (${owner?.slice(0, 8)}...). Cannot switch to it.`
					}],
					isError: true
				};
			}
		}

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
 * Open a new tab with optional URL and viewport configuration.
 * Auto-acquires MCP control for the new tab.
 */
export async function openNewTabHandler(args: { url?: string; deviceSize?: 'desktop' | 'laptop' | 'tablet' | 'mobile'; rotation?: 'portrait' | 'landscape'; projectId?: string }) {
	try {
		const deviceSize = args.deviceSize || 'laptop';

		let rotation: 'portrait' | 'landscape';
		if (args.rotation) {
			rotation = args.rotation;
		} else {
			rotation = (deviceSize === 'desktop' || deviceSize === 'laptop') ? 'landscape' : 'portrait';
		}

		debug.log('mcp', `📑 MCP opening new tab with URL: ${args.url || '(empty)'}`);

		const previewService = getPreviewService(args.projectId);
		const chatSessionId = getChatSessionId();
		const resolvedProjectId = previewService.getProjectId();

		const tab = await previewService.createTab(args.url || undefined, deviceSize, rotation);
		debug.log('mcp', `✅ Tab created: ${tab.id}`);

		// Acquire control of the new tab (adds to session's set)
		browserMcpControl.acquireControl(tab.id, chatSessionId, resolvedProjectId);

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
 * Close a specific tab by ID.
 * Releases MCP control for the closed tab only.
 */
export async function closeTabHandler(args: { tabId: string; projectId?: string }) {
	try {
		debug.log('mcp', `❌ MCP closing tab: ${args.tabId}`);

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

		// releaseTab is already called by autoReleaseForTab inside closeTab()
		// No need to manually release here

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
 * Navigate active tab to a different URL.
 * Waits for page load. Session state preserved.
 */
export async function navigateHandler(args: { url: string; projectId?: string }) {
	try {
		const { session } = await getActiveTabSession(args.projectId);

		await session.page.goto(args.url, {
			waitUntil: 'domcontentloaded',
			timeout: 30000
		});

		await new Promise(resolve => setTimeout(resolve, 500));

		const finalUrl = session.page.url();

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
 * Change viewport settings (device size and rotation) for active tab.
 */
export async function setViewportHandler(args: { deviceSize?: 'desktop' | 'laptop' | 'tablet' | 'mobile'; rotation?: 'portrait' | 'landscape'; projectId?: string }) {
	try {
		const { tab } = await getActiveTabSession(args.projectId);

		const deviceSize = args.deviceSize || tab.deviceSize;
		const rotation = args.rotation || tab.rotation;

		debug.log('mcp', `📱 MCP changing viewport for tab ${tab.id}: ${deviceSize} (${rotation})`);

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
