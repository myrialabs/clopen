/**
 * Browser Host Bridge WebSocket Handler
 *
 * Carries the viewer's answer back to a capability the headless browser asked
 * for — a location fix, a camera stream, clipboard contents, a file selection.
 * The request itself is pushed by BrowserHostBridge; this is the return leg.
 *
 * **PROJECT ISOLATION**: the request id is only meaningful inside the caller's
 * own project service, so a response from one project can never settle
 * another's pending request.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { requireBrowserPreviewAccess } from '../access';

export const hostPreviewHandler = createRouter()
	.on('preview:browser-host-response', {
		data: t.Object({
			requestId: t.String({ minLength: 1 }),
			ok: t.Boolean(),
			result: t.Optional(t.Any()),
			error: t.Optional(
				t.Object({
					name: t.Optional(t.String()),
					message: t.Optional(t.String()),
					code: t.Optional(t.Number())
				})
			)
		})
	}, async ({ data, conn }) => {
		const { projectId, previewService } = requireBrowserPreviewAccess(conn);

		const delivered = previewService.respondToHostRequest(data.requestId, {
			ok: data.ok,
			result: data.result,
			error: data.error
		});

		if (!delivered) {
			// Expected whenever the page gave up first or the tab closed while the
			// viewer was still deciding — not worth surfacing as an error.
			debug.log('preview', `⏭️ Host response for unknown request ${data.requestId} (project: ${projectId})`);
		}
	})

	/**
	 * Push a streamed result into the page.
	 *
	 * Speech recognition does not fit request/response: one `start()` produces a
	 * run of interim and final results, so the viewer keeps sending these until
	 * recognition ends.
	 */
	.on('preview:browser-host-event', {
		data: t.Object({
			tabId: t.String({ minLength: 1 }),
			kind: t.String({ minLength: 1 }),
			payload: t.Optional(t.Any())
		})
	}, async ({ data, conn }) => {
		const { previewService } = requireBrowserPreviewAccess(conn);
		await previewService.dispatchHostEvent(data.tabId, data.kind, data.payload);
	})

	/**
	 * Deliver a value chosen in the viewer's own colour or date picker.
	 */
	.on('preview:browser-native-picker-input', {
		data: t.Object({
			tabId: t.String({ minLength: 1 }),
			pickerId: t.String({ minLength: 1 }),
			value: t.String()
		})
	}, async ({ data, conn }) => {
		const { previewService } = requireBrowserPreviewAccess(conn);
		await previewService.handleNativePickerResponse(data.tabId, data.pickerId, data.value);
	})

	.emit('preview:browser-native-picker', t.Object({
		sessionId: t.String(),
		pickerId: t.String(),
		inputType: t.String(),
		value: t.String(),
		min: t.Optional(t.String()),
		max: t.Optional(t.String()),
		step: t.Optional(t.String()),
		boundingBox: t.Object({
			x: t.Number(),
			y: t.Number(),
			width: t.Number(),
			height: t.Number()
		}),
		timestamp: t.Number()
	}));
