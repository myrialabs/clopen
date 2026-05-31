/**
 * Browser Tab Operations
 *
 * Handles browser session lifecycle (launch, navigate, destroy) via WebSocket.
 * All operations work with active tab on backend (tab-centric architecture).
 *
 * Session Persistence:
 * - Sessions survive page refresh
 * - On page load, existing sessions can be recovered via getExistingTabs()
 * - Frontend reconnects to backend tabs and restarts streaming
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import type { DeviceSize, Rotation } from '$frontend/utils/preview-constants';

export interface BrowserSessionInfo {
	quality: string;
	url: string;
	deviceSize?: DeviceSize;
	rotation?: Rotation;
}

export interface LaunchResult {
	success: boolean;
	sessionId?: string;
	sessionInfo?: BrowserSessionInfo;
	error?: string;
}

export interface NavigateResult {
	success: boolean;
	finalUrl?: string;
	error?: string;
}

export interface ExistingTabInfo {
	tabId: string;
	url: string;
	title: string;
	quality: string;
	isStreaming: boolean;
	deviceSize: string;
	rotation: string;
	isActive: boolean;
	isMcpControlled?: boolean;
}

export interface ExistingTabsResult {
	tabs: ExistingTabInfo[];
	activeTabId: string | null;
	count: number;
}

/**
 * Launch browser for active tab
 */
export async function launchBrowser(
	url: string,
	deviceSize: DeviceSize,
	rotation: Rotation,
	projectId: string,
	mcpSessionId?: string
): Promise<LaunchResult> {
	debug.log('preview', `🌐 launchBrowser - URL: ${url}, device: ${deviceSize}, rotation: ${rotation}, projectId: ${projectId}${mcpSessionId ? `, mcpSessionId: ${mcpSessionId}` : ''}`);

	if (!url) {
		debug.error('preview', '❌ launchBrowser: No URL provided');
		addNotification({
			type: 'error',
			title: 'URL Required',
			message: 'Please enter a URL to launch browser preview'
		});
		return { success: false, error: 'URL is required' };
	}

	if (!projectId) {
		debug.error('preview', '❌ launchBrowser: No projectId provided');
		addNotification({
			type: 'error',
			title: 'Project Required',
			message: 'Please select a project first'
		});
		return { success: false, error: 'Project ID is required' };
	}

	try {
		debug.log('preview', `📡 Sending browser:launch via WebSocket...`);

		// Backend will create tab automatically with projectId
		const data = await ws.http(
			'preview:browser-tab-open',
			{ url, deviceSize, rotation },
			60000
		);

		debug.log('preview', `✅ Browser launched successfully - sessionId: ${data.tabId}`);

		return {
			success: true,
			sessionId: data.tabId,
			sessionInfo: {
				quality: data.quality,
				url: data.url,
				deviceSize,
				rotation
			}
		};
	} catch (error) {
		debug.error('preview', '💥 Error launching browser:', error);
		addNotification({
			type: 'error',
			title: 'Launch Failed',
			message: error instanceof Error ? error.message : 'Failed to launch browser preview'
		});
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error'
		};
	}
}

/**
 * Navigate a specific tab to new URL.
 * Requires explicit tabId to prevent cross-contamination during rapid tab switching.
 */
export async function navigateBrowser(newUrl: string, projectId: string, tabId?: string): Promise<NavigateResult> {
	if (!newUrl) {
		return { success: false, error: 'No URL provided' };
	}

	if (!projectId) {
		return { success: false, error: 'Project ID is required' };
	}

	try {
		// Always send explicit tabId to prevent race conditions during rapid tab switching
		const data = await ws.http('preview:browser-tab-navigate', { url: newUrl, tabId }, 30000);

		return { success: true, finalUrl: data.finalUrl };
	} catch (error) {
		addNotification({
			type: 'error',
			title: 'Navigation Failed',
			message: error instanceof Error ? error.message : 'Failed to navigate'
		});
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error'
		};
	}
}

/**
 * Destroy browser session for active tab
 */
export async function destroyBrowser(projectId: string): Promise<void> {
	if (!projectId) {
		debug.error('preview', `❌ destroyBrowser: No projectId provided`);
		return;
	}

	try {
		// Backend uses active tab automatically
		await ws.http('preview:browser-tab-close', {});
		debug.log('preview', `✅ Browser session destroyed`);
	} catch (error) {
		debug.error('preview', `❌ Error destroying browser:`, error);
	}
}

/**
 * Destroy browser session for a specific tab
 */
export async function destroyBrowserTab(tabId: string, projectId: string): Promise<void> {
	if (!projectId) {
		debug.error('preview', `❌ destroyBrowserTab: No projectId provided`);
		return;
	}

	try {
		await ws.http('preview:browser-tab-close', { tabId });
		debug.log('preview', `✅ Browser tab ${tabId} destroyed`);
	} catch (error) {
		debug.error('preview', `❌ Error destroying browser tab ${tabId}:`, error);
	}
}

/**
 * Get all existing tabs from backend (for session recovery after refresh)
 */
export async function getExistingTabs(projectId: string): Promise<ExistingTabsResult | null> {
	if (!projectId) {
		debug.error('preview', `❌ getExistingTabs: No projectId provided`);
		return null;
	}

	try {
		debug.log('preview', `🔍 Checking for existing browser tabs (project: ${projectId})...`);

		// Pass projectId explicitly: during a project switch the connection's room
		// context may not have caught up, so relying on it could recover the
		// previous project's tabs (cross-project leak).
		const data = await ws.http('preview:browser-tabs-list', { projectId }, 5000);

		if (data.count > 0) {
			debug.log('preview', `✅ Found ${data.count} existing browser tabs`);
		} else {
			debug.log('preview', `📭 No existing browser tabs found`);
		}

		return {
			tabs: data.tabs,
			activeTabId: data.activeTabId,
			count: data.count
		};
	} catch (error) {
		debug.warn('preview', `⚠️ Could not get existing tabs:`, error);
		return null;
	}
}

/**
 * Switch to a specific tab on backend
 */
export async function switchToBackendTab(tabId: string, projectId: string): Promise<boolean> {
	if (!projectId) {
		debug.error('preview', `❌ switchToBackendTab: No projectId provided`);
		return false;
	}

	try {
		debug.log('preview', `🔄 Switching to backend tab: ${tabId} (project: ${projectId})`);

		await ws.http('preview:browser-tab-switch', { tabId, projectId }, 5000);

		debug.log('preview', `✅ Switched to backend tab: ${tabId}`);
		return true;
	} catch (error) {
		debug.error('preview', `❌ Error switching to backend tab:`, error);
		return false;
	}
}
