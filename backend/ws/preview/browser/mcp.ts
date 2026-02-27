/**
 * MCP Tab Handlers
 *
 * HTTP endpoints for MCP tab coordination between backend and frontend.
 */

import { createRouter } from '$shared/utils/ws-server';
import { t } from 'elysia';
import { browserMcpControl } from '$backend/lib/preview';
import { debug } from '$shared/utils/logger';

// Tab response types
const TabSchema = t.Object({
	id: t.String(),
	url: t.String(),
	title: t.String(),
	sessionId: t.Union([t.String(), t.Null()]),
	isActive: t.Boolean()
});

export const mcpPreviewHandler = createRouter()
	// Tabs list
	.http('preview:mcp-tab-list', {
		data: t.Object({
			requestId: t.String(),
			tabs: t.Array(TabSchema)
		}),
		response: t.Object({
			success: t.Boolean()
		})
	}, async ({ data }) => {
		debug.log('mcp', `📋 Received tabs list for request: ${data.requestId}`);

		const resolved = browserMcpControl.resolveTabRequest(data.requestId, {
			tabs: data.tabs
		});

		return { success: resolved };
	})

	// Active tab
	.http('preview:mcp-active-tab', {
		data: t.Object({
			requestId: t.String(),
			tab: t.Union([TabSchema, t.Null()])
		}),
		response: t.Object({
			success: t.Boolean()
		})
	}, async ({ data }) => {
		debug.log('mcp', `📋 Received active tab for request: ${data.requestId}`);

		const resolved = browserMcpControl.resolveTabRequest(data.requestId, {
			tab: data.tab
		});

		return { success: resolved };
	})

	// Switch tab
	.http('preview:mcp-switch-tab', {
		data: t.Object({
			requestId: t.String(),
			success: t.Boolean(),
			tab: t.Optional(TabSchema),
			error: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean()
		})
	}, async ({ data }) => {
		debug.log('mcp', `📋 Received switch tab for request: ${data.requestId}`);

		const resolved = browserMcpControl.resolveTabRequest(data.requestId, {
			success: data.success,
			tab: data.tab,
			error: data.error
		});

		return { success: resolved };
	})

	// Open tab
	.http('preview:mcp-open-tab', {
		data: t.Object({
			requestId: t.String(),
			success: t.Boolean(),
			tab: t.Optional(TabSchema),
			error: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean()
		})
	}, async ({ data }) => {
		debug.log('mcp', `📋 Received open tab for request: ${data.requestId}`);

		const resolved = browserMcpControl.resolveTabRequest(data.requestId, {
			success: data.success,
			tab: data.tab,
			error: data.error
		});

		return { success: resolved };
	})

	// Close tab
	.http('preview:mcp-close-tab', {
		data: t.Object({
			requestId: t.String(),
			success: t.Boolean(),
			closedTabId: t.Optional(t.String()),
			newActiveTab: t.Optional(TabSchema),
			error: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean()
		})
	}, async ({ data }) => {
		debug.log('mcp', `📋 Received close tab for request: ${data.requestId}`);

		const resolved = browserMcpControl.resolveTabRequest(data.requestId, {
			success: data.success,
			closedTabId: data.closedTabId,
			newActiveTab: data.newActiveTab,
			error: data.error
		});

		return { success: resolved };
	});
