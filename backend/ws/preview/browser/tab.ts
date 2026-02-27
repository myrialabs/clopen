/**
 * Browser Tab Operations WebSocket Handlers
 * Handles tab lifecycle operations: open, navigate, close
 * **PROJECT ISOLATION**: Each project has its own BrowserPreviewService instance
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { browserPreviewServiceManager } from '../../../lib/preview/index';
import { ws } from '$backend/lib/utils/ws';
import { debug } from '$shared/utils/logger';

// Timeout for browser tab open (60 seconds)
const OPEN_TIMEOUT = 60000;

export const tabPreviewHandler = createRouter()
	// Open new browser tab
	.http('preview:browser-tab-open', {
		data: t.Object({
			url: t.Optional(t.String()), // URL is now optional - can create blank tab
			deviceSize: t.Optional(t.Union([
				t.Literal('desktop'),
				t.Literal('laptop'),
				t.Literal('tablet'),
				t.Literal('mobile')
			])),
			rotation: t.Optional(t.Union([
				t.Literal('portrait'),
				t.Literal('landscape')
			])),
		}),
		response: t.Object({
			tabId: t.String(),
			quality: t.String(),
			url: t.String(),
			title: t.String(),
			isActive: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);

		debug.log('preview', `🔴🔴🔴 browser-tab-open - Request received for project: ${projectId} 🔴🔴🔴`);

		const {
			url,
			deviceSize = 'laptop',
			rotation = 'portrait'
		} = data;

		debug.log('preview', `📥 Tab open params - URL: ${url || 'about:blank'}, deviceSize: ${deviceSize}, rotation: ${rotation}`);

		// Get project-specific preview service
		const previewService = browserPreviewServiceManager.getService(projectId);

		// Create browser tab
		const tabPromise = previewService.createTab(
			url, // Can be undefined for blank tab
			deviceSize as 'desktop' | 'laptop' | 'tablet' | 'mobile',
			rotation as 'portrait' | 'landscape'
		);
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(() => reject(new Error('Browser tab open timeout - took longer than 60 seconds')), OPEN_TIMEOUT);
		});

		debug.log('preview', `⏳ Opening browser tab (timeout: ${OPEN_TIMEOUT}ms)...`);
		const tab = await Promise.race([tabPromise, timeoutPromise]) as Awaited<typeof tabPromise>;

		debug.log('preview', `✅ Browser tab opened successfully - tabId: ${tab.id}, URL: ${tab.url}, project: ${projectId}`);

		// Tab activity is marked automatically in tab-manager

		return {
			tabId: tab.id,
			quality: tab.quality,
			url: tab.url,
			title: tab.title,
			isActive: tab.isActive,
			message: `Browser tab opened with ${tab.quality} quality streaming`
		};
	})

	// Navigate browser tab
	.http('preview:browser-tab-navigate', {
		data: t.Object({
			url: t.String({ minLength: 1 }),
			tabId: t.Optional(t.String()) // If not provided, navigate active tab
		}),
		response: t.Object({
			tabId: t.String(),
			finalUrl: t.String(),
			title: t.String(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const { url, tabId } = data;
		const projectId = ws.getProjectId(conn);

		// Get project-specific preview service
		const previewService = browserPreviewServiceManager.getService(projectId);

		// Get tab to navigate (active tab if not specified)
		const tab = tabId ? previewService.getTab(tabId) : previewService.getActiveTab();
		if (!tab) {
			throw new Error(tabId ? `Tab not found: ${tabId}` : 'No active tab');
		}

		debug.log('preview', `🌐 Navigating tab ${tab.id} to: ${url} (project: ${projectId})`);

		const finalUrl = await previewService.navigateTab(tab.id, url);

		debug.log('preview', `✅ Navigation completed - final URL: ${finalUrl}`);

		return {
			tabId: tab.id,
			finalUrl: finalUrl,
			title: tab.title,
			message: 'Navigation completed'
		};
	})

	// Close browser tab
	.http('preview:browser-tab-close', {
		data: t.Object({
			tabId: t.Optional(t.String()) // If not provided, close active tab
		}),
		response: t.Object({
			success: t.Boolean(),
			tabId: t.String(),
			newActiveTabId: t.Union([t.String(), t.Null()]),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const { tabId } = data;
		const projectId = ws.getProjectId(conn);

		// Get project-specific preview service
		const previewService = browserPreviewServiceManager.getService(projectId);

		// Get tab to close (active tab if not specified)
		const tab = tabId ? previewService.getTab(tabId) : previewService.getActiveTab();

		if (!tab) {
			throw new Error(tabId ? `Tab not found: ${tabId}` : 'No active tab');
		}

		const closingTabId = tab.id;

		debug.log('preview', `🗑️ Closing tab: ${closingTabId} (project: ${projectId})`);

		// Close tab
		const result = await previewService.closeTab(closingTabId);

		if (!result.success) {
			throw new Error(`Failed to close tab: ${closingTabId}`);
		}

		debug.log('preview', `✅ Tab closed: ${closingTabId} (new active: ${result.newActiveTabId || 'none'})`);

		return {
			success: true,
			tabId: closingTabId,
			newActiveTabId: result.newActiveTabId,
			message: `Tab ${closingTabId} closed successfully`
		};
	});
