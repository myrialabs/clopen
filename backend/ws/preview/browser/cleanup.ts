/**
 * Browser Cleanup WebSocket Handler
 * Handles browser tab cleanup operations (admin feature)
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { browserPreviewServiceManager } from '../../../lib/preview/index';
import { ws } from '$backend/lib/utils/ws';
import { debug } from '$shared/utils/logger';

export const cleanupPreviewHandler = createRouter()
	// Get cleanup status
	.http('preview:browser-cleanup-status', {
		data: t.Object({}),
		response: t.Object({
			totalTabs: t.Number(),
			activeTabs: t.Number(),
			inactiveTabs: t.Number(),
			tabs: t.Any(),
			cleanupModes: t.Array(t.Object({
				mode: t.String(),
				description: t.String(),
				recommended: t.Boolean()
			}))
		})
	}, async ({ conn }) => {
		const projectId = ws.getProjectId(conn);

		// Get project-specific preview service
		const previewService = browserPreviewServiceManager.getService(projectId);
		const status = previewService.getTabsStatus();

		return {
			totalTabs: status.totalTabs || 0,
			activeTabs: status.activeTabs || 0,
			inactiveTabs: status.inactiveTabs || 0,
			tabs: status.tabs || [],
			cleanupModes: [
				{
					mode: 'inactive',
					description: 'Clean up only inactive/zombie tabs (SAFE - preserves active tabs)',
					recommended: true
				},
				{
					mode: 'all',
					description: 'Clean up ALL tabs (NORMAL - use when no active users)',
					recommended: false
				},
				{
					mode: 'force',
					description: 'Force cleanup everything (DANGEROUS - destroys all including active)',
					recommended: false
				}
			]
		};
	})

	// Perform cleanup
	.http('preview:browser-cleanup-perform', {
		data: t.Object({
			mode: t.Optional(t.Union([
				t.Literal('inactive'),
				t.Literal('all'),
				t.Literal('force')
			]))
		}),
		response: t.Object({
			mode: t.String(),
			message: t.String(),
			before: t.Any(),
			after: t.Any(),
			result: t.Any()
		})
	}, async ({ data, conn }) => {
		const mode = data.mode || 'inactive';
		const projectId = ws.getProjectId(conn);

		// Get project-specific preview service
		const previewService = browserPreviewServiceManager.getService(projectId);

		// Get tab status before cleanup
		const statusBefore = previewService.getTabsStatus();

		let result;

		switch (mode) {
			case 'inactive':
				result = await previewService.cleanupInactiveTabs();
				break;

			case 'all':
				const activeTabIds = previewService.getAvailableTabIds();
				await previewService.cleanup();
				result = {
					activeTabsCount: 0,
					inactiveTabsDestroyed: activeTabIds.length,
					activeTabs: [],
					cleanedTabs: activeTabIds
				};
				break;

			case 'force':
				const allTabIds = previewService.getAvailableTabIds();
				await previewService.forceCleanupAll();
				result = {
					activeTabsCount: 0,
					inactiveTabsDestroyed: allTabIds.length,
					activeTabs: [],
					cleanedTabs: allTabIds
				};
				break;

			default:
				throw new Error(`Invalid cleanup mode: ${mode}. Use 'inactive', 'all', or 'force'`);
		}

		// Get final tab status
		const statusAfter = previewService.getTabsStatus();

		return {
			mode,
			message: `Browser cleanup completed in ${mode.toUpperCase()} mode for project: ${projectId}`,
			before: statusBefore,
			after: statusAfter,
			result
		};
	});
