/**
 * Preview Router
 *
 * Combines all preview WebSocket handlers into a single router.
 *
 * Tab-centric architecture - all operations work with browser tabs.
 *
 * Structure:
 * - tab.ts: Tab lifecycle operations (open, navigate, close)
 * - interact.ts: Mouse/keyboard interaction handlers
 * - tab-info.ts: Tab information endpoints
 * - stats.ts: Streaming statistics endpoints
 * - console.ts: Console operations (get, clear, execute, toggle)
 * - cleanup.ts: Admin cleanup endpoints (status, perform)
 * - webcodecs.ts: WebCodecs streaming handlers
 * - native-ui.ts: Native UI handlers (dialogs, print, select, context menu)
 * - mcp.ts: MCP tab coordination response handlers
 *
 * Available endpoints:
 * - preview:browser-tab-open - Open new browser tab (with optional URL)
 * - preview:browser-tab-close - Close browser tab
 * - preview:browser-tab-navigate - Navigate tab to new URL
 * - preview:browser-interact - Execute mouse/keyboard interactions
 * - preview:browser-tab-info - Get tab information
 * - preview:browser-tab-stats - Get streaming statistics
 * - preview:browser-console-get - Get console logs
 * - preview:browser-console-clear - Clear console logs
 * - preview:browser-console-execute - Execute console command
 * - preview:browser-console-toggle - Toggle console logging
 * - preview:browser-cleanup-status - Get cleanup status
 * - preview:browser-cleanup-perform - Perform cleanup
 * - preview:browser-stream-start - Start streaming
 * - preview:browser-stream-offer - Get stream offer
 * - preview:browser-stream-answer - Send stream answer
 * - preview:browser-stream-ice - Exchange ICE candidates
 * - preview:browser-stream-stop - Stop streaming
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { tabPreviewHandler } from './browser/tab';
import { interactPreviewHandler } from './browser/interact';
import { tabInfoPreviewHandler } from './browser/tab-info';
import { statsPreviewHandler } from './browser/stats';
import { consolePreviewHandler } from './browser/console';
import { cleanupPreviewHandler } from './browser/cleanup';
import { streamPreviewHandler } from './browser/webcodecs';
import { nativeUIPreviewHandler } from './browser/native-ui';
import { mcpPreviewHandler } from './browser/mcp';

export const previewRouter = createRouter()
	.merge(tabPreviewHandler)
	.merge(interactPreviewHandler)
	.merge(tabInfoPreviewHandler)
	.merge(statsPreviewHandler)
	.merge(consolePreviewHandler)
	.merge(cleanupPreviewHandler)
	.merge(streamPreviewHandler)
	.merge(nativeUIPreviewHandler)
	.merge(mcpPreviewHandler)
	// Server-emitted events (for type safety)
	.emit('preview:browser-tab-opened', t.Object({
		tabId: t.String(),
		url: t.String(),
		title: t.String(),
		isActive: t.Boolean(),
		timestamp: t.Number()
	}))
	.emit('preview:browser-tab-closed', t.Object({
		tabId: t.String(),
		newActiveTabId: t.Union([t.String(), t.Null()]),
		timestamp: t.Number()
	}))
	.emit('preview:browser-tab-switched', t.Object({
		previousTabId: t.String(),
		newTabId: t.String(),
		timestamp: t.Number()
	}))
	.emit('preview:browser-tab-navigated', t.Object({
		tabId: t.String(),
		url: t.String(),
		title: t.String(),
		timestamp: t.Number()
	}))
	.emit('preview:browser-console-message', t.Object({
		sessionId: t.String(),
		message: t.Object({
			id: t.String(),
			type: t.Union([
				t.Literal('log'),
				t.Literal('info'),
				t.Literal('warn'),
				t.Literal('error'),
				t.Literal('debug'),
				t.Literal('trace'),
				t.Literal('clear')
			]),
			text: t.String(),
			args: t.Optional(t.Array(t.Any())),
			location: t.Optional(t.Object({
				url: t.String(),
				lineNumber: t.Number(),
				columnNumber: t.Number()
			})),
			stackTrace: t.Optional(t.String()),
			timestamp: t.Number()
		})
	}))
	.emit('preview:browser-console-clear', t.Object({
		sessionId: t.String(),
		timestamp: t.Number()
	}))
	.emit('preview:browser-new-window', t.Object({
		tabId: t.String(),
		url: t.String(),
		timestamp: t.Number()
	}))
	// MCP control events
	.emit('preview:browser-mcp-control-start', t.Object({
		browserSessionId: t.String(),
		mcpSessionId: t.Optional(t.String()),
		timestamp: t.Number()
	}))
	.emit('preview:browser-mcp-control-end', t.Object({
		browserSessionId: t.String(),
		timestamp: t.Number()
	}))
	.emit('preview:browser-mcp-cursor-position', t.Object({
		sessionId: t.String(),
		x: t.Number(),
		y: t.Number(),
		timestamp: t.Number(),
		source: t.Literal('mcp')
	}))
	.emit('preview:browser-mcp-cursor-click', t.Object({
		sessionId: t.String(),
		x: t.Number(),
		y: t.Number(),
		timestamp: t.Number(),
		source: t.Literal('mcp')
	}))
	.emit('preview:browser-mcp-test-completed', t.Object({
		sessionId: t.String(),
		timestamp: t.Number(),
		source: t.Literal('mcp')
	}));
