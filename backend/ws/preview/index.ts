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
 * - host.ts: Viewer-answered capabilities (geolocation, camera, clipboard, files)
 *
 * Available endpoints:
 * - preview:browser-tab-open - Open new browser tab (with optional URL)
 * - preview:browser-tab-close - Close browser tab
 * - preview:browser-tab-navigate - Navigate tab to new URL
 * - preview:browser-tab-history-go - Walk the tab's history (back/forward)
 * - preview:browser-tab-history - Read the tab's history entries
 * - preview:browser-host-response - Answer a host-capability request
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
import { hostPreviewHandler } from './browser/host';

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
	.merge(hostPreviewHandler)
	// Server-emitted events (for type safety)
	.emit('preview:browser-tab-opened', t.Object({
		// projectId lets the frontend reject events that belong to a project it has
		// since switched away from (prevents cross-project tab leaks).
		projectId: t.String(),
		tabId: t.String(),
		url: t.String(),
		title: t.String(),
		isActive: t.Boolean(),
		timestamp: t.Number()
	}))
	.emit('preview:browser-tab-closed', t.Object({
		projectId: t.String(),
		tabId: t.String(),
		newActiveTabId: t.Union([t.String(), t.Null()]),
		timestamp: t.Number()
	}))
	.emit('preview:browser-tab-switched', t.Object({
		projectId: t.String(),
		previousTabId: t.String(),
		newTabId: t.String(),
		timestamp: t.Number()
	}))
	.emit('preview:browser-tab-navigated', t.Object({
		projectId: t.String(),
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
				t.Literal('clear'),
				t.Literal('input'),
				t.Literal('result')
			]),
			text: t.String(),
			args: t.Optional(t.Array(t.Any())),
			// Recursive by nature (objects contain objects), which TypeBox cannot
			// express inline; the shape is pinned by BrowserConsoleValue instead.
			values: t.Optional(t.Array(t.Any())),
			location: t.Optional(t.Object({
				url: t.String(),
				lineNumber: t.Number(),
				columnNumber: t.Number()
			})),
			stackTrace: t.Optional(t.String()),
			status: t.Optional(t.Number()),
			count: t.Optional(t.Number()),
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
		browserTabId: t.String(),
		chatSessionId: t.Optional(t.String()),
		projectId: t.Optional(t.String()),
		timestamp: t.Number()
	}))
	.emit('preview:browser-mcp-control-end', t.Object({
		browserTabId: t.String(),
		projectId: t.Optional(t.String()),
		timestamp: t.Number()
	}))
	.emit('preview:browser-mcp-cursor-position', t.Object({
		sessionId: t.String(),
		x: t.Number(),
		y: t.Number(),
		// Button held down: the overlay renders a grab, which is the only
		// on-screen difference between the agent moving and the agent dragging.
		pressed: t.Optional(t.Boolean()),
		timestamp: t.Number(),
		source: t.Literal('mcp')
	}))
	.emit('preview:browser-mcp-cursor-click', t.Object({
		sessionId: t.String(),
		x: t.Number(),
		y: t.Number(),
		button: t.Optional(t.String()),
		timestamp: t.Number(),
		source: t.Literal('mcp')
	}))
	.emit('preview:browser-mcp-test-completed', t.Object({
		sessionId: t.String(),
		timestamp: t.Number(),
		source: t.Literal('mcp')
	}))
	.emit('preview:browser-viewport-changed', t.Object({
		projectId: t.String(),
		tabId: t.String(),
		deviceSize: t.String(),
		rotation: t.String(),
		width: t.Number(),
		height: t.Number(),
		timestamp: t.Number()
	}))
	// Live tab metadata: the page's own title and favicon plus whether
	// Back/Forward have anywhere to go. None of it can be derived from the URL.
	.emit('preview:browser-tab-meta', t.Object({
		projectId: t.String(),
		tabId: t.String(),
		url: t.String(),
		title: t.String(),
		favicon: t.Optional(t.String()),
		canGoBack: t.Boolean(),
		canGoForward: t.Boolean(),
		timestamp: t.Number()
	}))
	// A capability the headless browser cannot satisfy on its own — answered by
	// the viewer's browser and returned via preview:browser-host-response.
	.emit('preview:browser-host-request', t.Object({
		tabId: t.String(),
		requestId: t.String(),
		kind: t.String(),
		payload: t.Any(),
		timestamp: t.Number()
	}))
	// The request has been answered, timed out, or lost its tab. Prompted
	// capabilities raise a prompt on every viewer of the tab, and only the first
	// answer counts — this is what takes the rest of them down.
	.emit('preview:browser-host-request-settled', t.Object({
		tabId: t.String(),
		requestId: t.String()
	}))
	// A file the page downloaded, relayed so it lands on the viewer's machine.
	.emit('preview:browser-download', t.Object({
		tabId: t.String(),
		downloadId: t.String(),
		filename: t.String(),
		url: t.String(),
		state: t.Union([t.Literal('started'), t.Literal('completed'), t.Literal('failed')]),
		data: t.Optional(t.String()),
		totalBytes: t.Optional(t.Number()),
		error: t.Optional(t.String()),
		timestamp: t.Number()
	}));
