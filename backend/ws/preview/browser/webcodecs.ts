/**
 * Preview Streaming Handlers
 *
 * Handles video/audio streaming for ultra low-latency, low-bandwidth preview.
 * Currently implemented using WebCodecs with DataChannel delivery.
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 */

import { createRouter } from '$shared/utils/ws-server';
import { t } from 'elysia';
import { ws } from '$backend/utils/ws';
import { requireBrowserTabAccess } from '../access';

export const streamPreviewHandler = createRouter()
	// Start streaming
	.http(
		'preview:browser-stream-start',
		{
			data: t.Object({
				tabId: t.Optional(t.String()),
				// Legacy VP9-only capability flag — superseded by `codecs`,
				// kept so an older client can still negotiate.
				vp9: t.Optional(t.Boolean()),
				// Full viewer decode capability. Which codecs the viewer can
				// decode *in hardware* decides the encoder choice: software VP9
				// decode is the main reason phones and low-end laptops drop
				// frames no server-side tuning can recover.
				codecs: t.Optional(
					t.Object({
						vp8: t.Boolean(),
						vp9: t.Boolean(),
						avc: t.Boolean(),
						hardware: t.Array(t.String())
					})
				),
				// Viewer display metrics — capture resolution is derived from
				// these so we never encode pixels the screen cannot show.
				display: t.Optional(
					t.Object({
						scale: t.Optional(t.Number()),
						dpr: t.Optional(t.Number())
					})
				)
			}),
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
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			const sessionId = tab.id;

			// Verify session exists
			if (!previewService.isValidTab(sessionId)) {
				throw new Error('Preview session not found or invalid');
			}

			const codecSupport = data.codecs
				? {
						vp8: data.codecs.vp8,
						vp9: data.codecs.vp9,
						avc: data.codecs.avc,
						hardware: data.codecs.hardware as ('vp8' | 'vp9' | 'avc')[]
					}
				: { vp8: true, vp9: data.vp9 !== false, avc: false, hardware: [] };

			// Start WebCodecs streaming
			const started = await previewService.startWebCodecsStreaming(sessionId, {
				codecSupport,
				display: data.display
			});

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
			data: t.Object({
				tabId: t.Optional(t.String())
			}),
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
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

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
				}),
				tabId: t.Optional(t.String())
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

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
				}),
				tabId: t.Optional(t.String())
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			const { candidate } = data;
			const success = await previewService.addWebCodecsIceCandidate(tab.id, candidate as RTCIceCandidateInit);

			return { success };
		}
	)

	// Client-driven keyframe request (PLI equivalent) — sent when the client
	// decoder errors or joins mid-stream and needs a sync point
	.http(
		'preview:browser-stream-keyframe',
		{
			data: t.Object({
				tabId: t.Optional(t.String())
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			const success = await previewService.requestWebCodecsKeyframe(tab.id);

			return { success };
		}
	)

	// Viewer decoder health, reported periodically while connected.
	//
	// Backpressure used to be network-only: the source watched its own send
	// buffer and nothing else. A viewer that cannot decode fast enough stutters
	// identically with an empty buffer, so its decode queue has to travel back
	// to the source for the adaptation loop to be closed.
	.http(
		'preview:browser-stream-feedback',
		{
			data: t.Object({
				tabId: t.Optional(t.String()),
				decodeQueueSize: t.Number(),
				decodeLatencyMs: t.Number(),
				dropRatio: t.Number()
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			previewService.applyWebCodecsClientFeedback(tab.id, {
				decodeQueueSize: data.decodeQueueSize,
				decodeLatencyMs: data.decodeLatencyMs,
				dropRatio: data.dropRatio
			});

			return { success: true };
		}
	)

	// Viewer display metrics changed (panel resize, device swap, moved to a
	// different-density screen). Capture resolution follows this.
	.http(
		'preview:browser-stream-display',
		{
			data: t.Object({
				tabId: t.Optional(t.String()),
				scale: t.Optional(t.Number()),
				dpr: t.Optional(t.Number())
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			const success = previewService.applyWebCodecsDisplayMetrics(tab.id, {
				scale: data.scale,
				dpr: data.dpr
			});

			return { success };
		}
	)

	// Suspend/resume capture when the preview leaves or re-enters view.
	// An unwatched preview otherwise keeps a headless renderer and an encoder
	// busy indefinitely — the dominant idle cost on a shared host.
	.http(
		'preview:browser-stream-visibility',
		{
			data: t.Object({
				tabId: t.Optional(t.String()),
				visible: t.Boolean()
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

			const success = await previewService.setWebCodecsPaused(tab.id, !data.visible);

			return { success };
		}
	)

	// Stop streaming
	.http(
		'preview:browser-stream-stop',
		{
			data: t.Object({
				tabId: t.Optional(t.String())
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);

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
	)

	// Server → Client: SPA navigation (pushState/replaceState — URL-only update, no page reload)
	.emit(
		'preview:browser-navigation-spa',
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
