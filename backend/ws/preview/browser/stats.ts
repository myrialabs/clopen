/**
 * Browser Streaming Statistics WebSocket Handler
 * Handles getting browser streaming statistics
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 */

import { t } from 'elysia';
import { cpus, freemem, loadavg, totalmem } from 'os';
import { createRouter } from '$shared/utils/ws-server';
import { requireBrowserPreviewAccess, requireBrowserTabAccess } from '../access';
import { browserPool } from '$backend/preview/browser/browser-pool';
import { availableMemoryBytes, measureProcessTrees } from '$backend/preview/browser/process-usage';

export const statsPreviewHandler = createRouter()
	.http('preview:browser-tab-stats', {
		data: t.Object({
			tabId: t.Optional(t.String()) // If not provided, get active tab stats
		}),
		response: t.Object({
			tabId: t.String(),
			isWebCodecsActive: t.Boolean(),
			streamingMode: t.String(),
			stats: t.Union([
				t.Object({
					videoBytesSent: t.Number(),
					audioBytesSent: t.Number(),
					videoFramesEncoded: t.Number(),
					audioFramesEncoded: t.Number(),
					connectionState: t.String()
				}),
				t.Null()
			]),
			timestamp: t.String()
		})
	}, async ({ data, conn }) => {
		const { tabId } = data;
		const { previewService, tab } = requireBrowserTabAccess(conn, tabId);

		const stats = await previewService.getWebCodecsStats(tab.id);

		return {
			tabId: tab.id,
			isWebCodecsActive: previewService.isWebCodecsActive(tab.id),
			streamingMode: 'webcodecs',
			stats: stats ?? null,
			timestamp: new Date().toISOString()
		};
	})

	/**
	 * Everything the diagnostics panel shows: what the host has left, what
	 * every preview Chrome costs, and what each of this workspace's tabs is
	 * doing. Polled only while the panel is open.
	 */
	.http('preview:browser-diagnostics', {
		data: t.Object({}),
		response: t.Object({
			host: t.Object({
				platform: t.String(),
				cpuCount: t.Number(),
				loadAverage: t.Array(t.Number()),
				totalMemBytes: t.Number(),
				availableMemBytes: t.Number()
			}),
			browsers: t.Array(t.Object({
				current: t.Boolean(),
				tabs: t.Number(),
				pid: t.Union([t.Number(), t.Null()]),
				processes: t.Number(),
				rssBytes: t.Number(),
				cpuPercent: t.Union([t.Number(), t.Null()])
			})),
			tabs: t.Array(t.Object({
				id: t.String(),
				title: t.String(),
				url: t.String(),
				state: t.Union([t.Literal('active'), t.Literal('frozen')]),
				watched: t.Boolean(),
				isLoading: t.Boolean(),
				openedBy: t.Union([t.Literal('agent'), t.Literal('user')]),
				agentHeld: t.Boolean(),
				dialog: t.Union([t.Object({ type: t.String(), message: t.String() }), t.Null()]),
				createdAt: t.Number(),
				lastAccessedAt: t.Number(),
				jsHeapUsedBytes: t.Union([t.Number(), t.Null()]),
				domNodes: t.Union([t.Number(), t.Null()]),
				stream: t.Union([
					t.Object({
						videoBytesSent: t.Number(),
						videoFramesEncoded: t.Number(),
						connectionState: t.String()
					}),
					t.Null()
				])
			})),
			clipboard: t.Object({
				length: t.Number(),
				source: t.Union([t.String(), t.Null()]),
				updatedAt: t.Number()
			}),
			timestamp: t.Number()
		})
	}, async ({ conn }) => {
		const { previewService } = requireBrowserPreviewAccess(conn);
		const scope = previewService.getProjectId();

		const running = browserPool.getRunningBrowsers();
		const usage = measureProcessTrees(running.map((entry) => entry.pid).filter((pid): pid is number => pid !== null));

		// Other workspaces' Chromes are reported without naming them: the cost is
		// shared by the machine, but which projects they belong to is not this
		// viewer's business.
		const browsers = running
			.map((entry) => {
				const tree = entry.pid !== null ? usage.get(entry.pid) : undefined;
				return {
					current: entry.profileKey === scope,
					tabs: entry.sessions,
					pid: entry.pid,
					processes: tree?.processes ?? 0,
					rssBytes: tree?.rssBytes ?? 0,
					cpuPercent: tree?.cpuPercent ?? null
				};
			})
			.sort((a, b) => Number(b.current) - Number(a.current) || b.rssBytes - a.rssBytes);

		const { tabs, clipboard } = await previewService.getDiagnostics();

		return {
			host: {
				platform: process.platform,
				cpuCount: cpus().length,
				loadAverage: loadavg(),
				totalMemBytes: totalmem(),
				availableMemBytes: availableMemoryBytes(freemem())
			},
			browsers,
			tabs,
			clipboard,
			timestamp: Date.now()
		};
	});
