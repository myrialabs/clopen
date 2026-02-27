/**
 * Preview Streaming Handlers
 *
 * Handles video/audio streaming for ultra low-latency, low-bandwidth preview.
 * Currently implemented using WebCodecs with DataChannel delivery.
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 */

import { createRouter } from '$shared/utils/ws-server';
import { t } from 'elysia';
import { browserPreviewServiceManager } from '$backend/lib/preview';
import { ws } from '$backend/lib/utils/ws';

export const streamPreviewHandler = createRouter()
	// Start streaming
	.http(
		'preview:browser-stream-start',
		{
			data: t.Object({}),
			response: t.Object({
				success: t.Boolean(),
				message: t.Optional(t.String()),
				offer: t.Optional(
					t.Object({
						type: t.String(),
						sdp: t.Optional(t.String())
					})
				)
			})
		},
		async ({ data, conn }) => {
			const projectId = ws.getProjectId(conn);

			// Get project-specific preview service
			const previewService = browserPreviewServiceManager.getService(projectId);

			const tab = previewService.getActiveTab();
			if (!tab) {
				throw new Error('No active tab');
			}

			const sessionId = tab.id;

			// Verify session exists
			if (!previewService.isValidTab(sessionId)) {
				throw new Error('Preview session not found or invalid');
			}

			// Start WebCodecs streaming
			const started = await previewService.startWebCodecsStreaming(sessionId);

			if (!started) {
				throw new Error('Failed to start WebCodecs streaming');
			}

			// Get offer from headless browser
			const offer = await previewService.getWebCodecsOffer(sessionId);

			return {
				success: true,
				message: 'WebCodecs streaming started',
				offer: offer
					? {
							type: offer.type as string,
							sdp: offer.sdp
						}
					: undefined
			};
		}
	)

	// Get SDP offer from headless browser
	.http(
		'preview:browser-stream-offer',
		{
			data: t.Object({}),
			response: t.Object({
				success: t.Boolean(),
				offer: t.Optional(
					t.Object({
						type: t.String(),
						sdp: t.Optional(t.String())
					})
				)
			})
		},
		async ({ data, conn }) => {
			const projectId = ws.getProjectId(conn);

			// Get project-specific preview service
			const previewService = browserPreviewServiceManager.getService(projectId);

			const tab = previewService.getActiveTab();
			if (!tab) {
				throw new Error('No active tab');
			}

			const offer = await previewService.getWebCodecsOffer(tab.id);

			return {
				success: !!offer,
				offer: offer
					? {
							type: offer.type as string,
							sdp: offer.sdp
						}
					: undefined
			};
		}
	)

	// Handle SDP answer from client
	.http(
		'preview:browser-stream-answer',
		{
			data: t.Object({
				answer: t.Object({
					type: t.String(),
					sdp: t.Optional(t.String())
				})
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const projectId = ws.getProjectId(conn);

			// Get project-specific preview service
			const previewService = browserPreviewServiceManager.getService(projectId);

			const tab = previewService.getActiveTab();
			if (!tab) {
				throw new Error('No active tab');
			}

			const { answer } = data;
			const success = await previewService.handleWebCodecsAnswer(tab.id, answer as RTCSessionDescriptionInit);

			return { success };
		}
	)

	// Exchange ICE candidates
	.http(
		'preview:browser-stream-ice',
		{
			data: t.Object({
				candidate: t.Object({
					candidate: t.Optional(t.String()),
					sdpMid: t.Optional(t.Union([t.String(), t.Null()])),
					sdpMLineIndex: t.Optional(t.Union([t.Number(), t.Null()]))
				})
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const projectId = ws.getProjectId(conn);

			// Get project-specific preview service
			const previewService = browserPreviewServiceManager.getService(projectId);

			const tab = previewService.getActiveTab();
			if (!tab) {
				throw new Error('No active tab');
			}

			const { candidate } = data;
			const success = await previewService.addWebCodecsIceCandidate(tab.id, candidate as RTCIceCandidateInit);

			return { success };
		}
	)

	// Stop streaming
	.http(
		'preview:browser-stream-stop',
		{
			data: t.Object({}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const projectId = ws.getProjectId(conn);

			// Get project-specific preview service
			const previewService = browserPreviewServiceManager.getService(projectId);

			const tab = previewService.getActiveTab();
			if (!tab) {
				throw new Error('No active tab');
			}

			await previewService.stopWebCodecsStreaming(tab.id);

			return { success: true };
		}
	)

	// Server → Client: ICE candidate from headless browser
	.emit(
		'preview:browser-stream-ice',
		t.Object({
			sessionId: t.String(), // Internal session ID (kept for routing)
			candidate: t.Object({
				candidate: t.Optional(t.String()),
				sdpMid: t.Optional(t.Union([t.String(), t.Null()])),
				sdpMLineIndex: t.Optional(t.Union([t.Number(), t.Null()]))
			}),
			from: t.String() // 'headless' or 'client'
		})
	)

	// Server → Client: Connection state update
	.emit(
		'preview:browser-stream-state',
		t.Object({
			sessionId: t.String(), // Internal session ID (kept for routing)
			state: t.String()
		})
	)

	// Server → Client: Cursor style update
	.emit(
		'preview:browser-cursor-change',
		t.Object({
			sessionId: t.String(), // Internal session ID (kept for routing)
			cursor: t.String()
		})
	)

	// Server → Client: Navigation started (loading)
	.emit(
		'preview:browser-navigation-loading',
		t.Object({
			sessionId: t.String(),
			type: t.String(),
			url: t.String(),
			timestamp: t.Number()
		})
	)

	// Server → Client: Navigation completed
	.emit(
		'preview:browser-navigation',
		t.Object({
			sessionId: t.String(),
			type: t.String(),
			url: t.String(),
			timestamp: t.Number()
		})
	);

// Setup event forwarding from preview service to WebSocket
// This needs to be done per-project service instance
// We'll set up a helper function that the service manager can call

/**
 * Setup event forwarding for a preview service instance
 * Should be called when a new service is created
 */
export function setupEventForwarding(previewService: any, projectId: string) {
	previewService.on('webcodecs-ice-candidate', (data: { sessionId: string; candidate: RTCIceCandidateInit; from: string }) => {
		ws.emit.project(projectId, 'preview:browser-stream-ice', {
			sessionId: data.sessionId,
			candidate: data.candidate,
			from: data.from
		});
	});

	previewService.on('webcodecs-connection-state', (data: { sessionId: string; state: string }) => {
		ws.emit.project(projectId, 'preview:browser-stream-state', data);
	});

	previewService.on('cursor-change', (data: { sessionId: string; cursor: string }) => {
		ws.emit.project(projectId, 'preview:browser-cursor-change', data);
	});

	// Forward navigation events
	previewService.on('preview:browser-navigation-loading', (data: { sessionId: string; type: string; url: string; timestamp: number }) => {
		ws.emit.project(projectId, 'preview:browser-navigation-loading', data);
	});

	previewService.on('preview:browser-navigation', (data: { sessionId: string; type: string; url: string; timestamp: number }) => {
		ws.emit.project(projectId, 'preview:browser-navigation', data);
	});
}

// Note: Event forwarding is now set up per-project in BrowserPreviewService constructor
// via the setupProjectEventForwarding method
